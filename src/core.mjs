export function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}
export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_CONFIG', '配置必须是对象。');
  const bots = value.bots ?? [];
  if (!Array.isArray(bots) || bots.length > 32) fail('INVALID_CONFIG', '最多配置 32 组 Bot。');
  const ids = new Set(), companions = new Set();
  return { schemaVersion: 1, bots: bots.map(bot => {
    if (!bot || !/^[a-zA-Z0-9_-]{1,48}$/.test(bot.id ?? '') ||
        typeof bot.name !== 'string' || !bot.name.trim() || bot.name.length > 60 ||
        typeof bot.companionId !== 'string' || bot.companionId.length > 200 ||
        (bot.companionId !== '' && !bot.companionId.trim()) || (bot.enabled && !bot.companionId) ||
        typeof bot.enabled !== 'boolean') fail('INVALID_CONFIG', '每组需要有效的标识、名称、伙伴和启用状态。');
    if (ids.has(bot.id) || bot.companionId && companions.has(bot.companionId)) fail('DUPLICATE_BINDING', '每个 Bot 和每个伙伴只能出现在一组绑定中。');
    ids.add(bot.id); if (bot.companionId) companions.add(bot.companionId);
    // Whitelist persisted fields: tokens and arbitrary extra fields never reach /kv.
    return { id: bot.id, name: bot.name.trim(), companionId: bot.companionId, enabled: bot.enabled };
  }) };
}

// Reply routing uses only the original request and host-stamped session context.
// No permission to read companion history and no arbitrary recipient input.
const DISPATCH_RETRY_DELAYS = [3 * 60000, 10 * 60000];
const NON_RETRYABLE_DISPATCH = new Set(['PERMISSION_DENIED', 'UNSUPPORTED_CAPABILITY', 'INVALID_PARAMS',
  'INVALID_INPUT', 'BINDING_CHANGED', 'STALE_CONNECTION', 'REQUEST_EXPIRED', 'REQUEST_KEY_CONFLICT', 'SUPERSEDED']);
export class ReplyRouter {
  constructor({ targets, tasks, nodeReply, rejectInbound, readImages = async () => [], beforeDispatch = async () => {},
    setTimer = (...args) => globalThis.setTimeout(...args),
    clearTimer = (...args) => globalThis.clearTimeout(...args), now = Date.now }) {
    this.targets = targets; this.nodeReply = nodeReply; this.rejectInbound = rejectInbound;
    this.tasks = tasks; this.readImages = readImages; this.beforeDispatch = beforeDispatch;
    this.setTimer = setTimer; this.clearTimer = clearTimer; this.now = now;
    this.routes = new Map(); this.requests = new Map(); this.lanes = new Map(); this.current = new Map(); this.generations = new Map();
    this.bindingSessions = new Map(); this.replyCalls = new Map();
  }
  setConfig(config) {
    const next = new Map(config.bots.map(bot => [bot.id, bot]));
    for (const id of this.routes.keys()) if (!next.has(id)) { this.cancelBot(id); this.generations.delete(id); }
    for (const entry of this.requests.values()) {
      const route = next.get(entry.botConfigId);
      if (!route?.enabled || route.companionId !== entry.companionId) { entry.state = 'cancelled'; entry.finish?.(); }
    }
    this.routes = next;
  }
  reset() {
    for (const entry of this.requests.values()) { entry.state = 'cancelled'; entry.finish?.(); }
    this.requests.clear(); this.lanes.clear(); this.current.clear(); this.generations.clear();
    this.bindingSessions.clear(); this.replyCalls.clear();
  }
  bindSession(botConfigId, companionId, sessionId) {
    if (this.routes.get(botConfigId)?.companionId === companionId && typeof sessionId === 'string' && sessionId)
      this.bindingSessions.set(botConfigId, { companionId, sessionId });
  }
  rememberReplyCall(callId, record) {
    if (!callId) return; this.replyCalls.set(callId, record);
    if (this.replyCalls.size > 512) this.replyCalls.delete(this.replyCalls.keys().next().value);
  }
  cancelBot(botConfigId, generation) {
    for (const [id, entry] of this.requests) if (entry.botConfigId === botConfigId) {
      entry.state = 'cancelled'; entry.finish?.(); this.requests.delete(id);
    }
    this.lanes.delete(botConfigId); this.current.delete(botConfigId);
    if (Number.isInteger(generation)) this.generations.set(botConfigId, Math.max(generation, this.generations.get(botConfigId) ?? 0));
  }
  async receive(message) {
    const bot = this.routes.get(message.botConfigId);
    if (!bot?.enabled || typeof message.requestId !== 'string' ||
        typeof message.text !== 'string' || !message.text.trim() || message.text.length > 16000) {
      await this.rejectInbound(message.requestId, 'INVALID_INPUT'); return;
    }
    if (this.requests.has(message.requestId)) return;
    const generation = this.generations.get(message.botConfigId) ?? 0;
    if (message.generation < generation) { await this.rejectInbound(message.requestId, 'STALE_CONNECTION'); return; }
    if (message.generation > generation) this.cancelBot(message.botConfigId, message.generation);
    for (const [id, old] of this.requests) if (this.now() - old.createdAt > 30 * 60000 &&
      !(old.state === 'accepted' && old.replyKey !== undefined)) { old.state = 'expired'; old.finish?.(); this.requests.delete(id); }
    if (this.requests.size >= 256) { await this.rejectInbound(message.requestId, 'INBOX_FULL'); return; }
    const entry = { ...message, companionId: bot.companionId, createdAt: this.now(), state: 'queued' };
    this.requests.set(message.requestId, entry);
    const previous = this.lanes.get(entry.botConfigId);
    entry.done = new Promise(resolve => { entry.finish = () => {
      if (entry.receiptTimer !== undefined) this.clearTimer(entry.receiptTimer);
      if (entry.retryTimer !== undefined) this.clearTimer(entry.retryTimer);
      entry.retryTimer = undefined; entry.nextRetryAt = undefined;
      entry.receiptTimer = undefined; entry.monitorReceipt = false;
      entry.attachments = undefined;
      if (this.current.get(entry.botConfigId) === entry.requestId) this.current.delete(entry.botConfigId);
      if (this.lanes.get(entry.botConfigId) === entry.done) this.lanes.delete(entry.botConfigId); resolve();
    }; });
    this.lanes.set(entry.botConfigId, entry.done);
    const start = entry.start = async () => {
      const route = this.routes.get(entry.botConfigId);
      if (entry.state === 'cancelled' || !route?.enabled || route.companionId !== entry.companionId) fail('BINDING_CHANGED', '绑定已改变，不能派发旧消息。');
      if (this.now() - entry.createdAt > 30 * 60000) fail('REQUEST_EXPIRED', '微信请求已过期。');
      this.current.set(entry.botConfigId, entry.requestId); entry.state = 'dispatching'; return this.dispatch(entry);
    };
    entry.accepted = previous ? previous.then(start) : start();
    const handled = entry.accepted.catch(error => this.dispatchFailed(entry, error));
    if (!previous) await handled; else void handled.catch(() => {});
  }
  pendingRetries() {
    return [...this.requests.values()].filter(entry => entry.state === 'retry_wait').map(entry => ({
      botConfigId: entry.botConfigId, attempt: entry.dispatchRetries, retryAt: entry.nextRetryAt,
    }));
  }
  async dispatchFailed(entry, error) {
    if (entry.state === 'cancelled' || this.requests.get(entry.requestId) !== entry) return;
    const route = this.routes.get(entry.botConfigId);
    if (!route?.enabled || route.companionId !== entry.companionId) error = { code: 'BINDING_CHANGED' };
    const retry = entry.dispatchRetries ?? 0, delay = DISPATCH_RETRY_DELAYS[retry];
    if (delay !== undefined && !NON_RETRYABLE_DISPATCH.has(error.code)) {
      if (this.now() + delay < entry.createdAt + 30 * 60000) {
        entry.state = 'retry_wait'; entry.dispatchRetries = retry + 1; entry.nextRetryAt = this.now() + delay;
        entry.retryTimer = this.setTimer(() => {
          entry.retryTimer = undefined; entry.nextRetryAt = undefined;
          entry.accepted = entry.start();
          return entry.accepted.catch(nextError => this.dispatchFailed(entry, nextError));
        }, delay);
        entry.retryTimer?.unref?.(); return;
      }
      error = { code: 'REQUEST_EXPIRED' };
    }
    entry.state = error.code === 'DELIVERY_UNCERTAIN' ? 'uncertain' : 'rejected';
    const code = retry === 2 && !NON_RETRYABLE_DISPATCH.has(error.code)
      ? (error.code === 'DELIVERY_UNCERTAIN' ? 'DISPATCH_DELIVERY_UNCERTAIN' : 'DISPATCH_RETRY_EXHAUSTED')
      : error.code ?? 'DISPATCH_FAILED';
    try { await this.rejectInbound(entry.requestId, code); } catch { /* Locally closed even if Node is unavailable. */ }
    finally { entry.finish(); }
  }
  async dispatch(entry) {
    await this.beforeDispatch(entry);
    const caps = await this.targets.capabilities({});
    if (caps?.delegation?.execution !== true) fail('UNSUPPORTED_CAPABILITY', '宿主没有可执行的伙伴委派接口，请检查 Cindy 版本与授权。');
    if (entry.attachments?.length) {
      const messageCaps = await this.tasks?.capabilities?.({});
      if (!messageCaps?.messageAttachments?.kinds?.includes('image'))
        fail('UNSUPPORTED_CAPABILITY', '当前 Cindy 不支持向伙伴交接图片，请更新宿主后重新发送。');
    }
    const target = { kind: 'bot', id: entry.companionId };
    await this.targets.resolve({ target });
    const requestKey = `wx-${entry.requestId}`;
    const route = this.routes.get(entry.botConfigId);
    if (entry.state !== 'dispatching' || !route?.enabled || route.companionId !== entry.companionId) fail('BINDING_CHANGED', '绑定已改变，不能派发旧消息。');
    const receipt = await this.targets.send({ target, requestKey, text: entry.text, delivery: 'queue',
      ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
      delegation: { task: '处理本次微信用户消息，并且仅将本次回答通过微信伙伴 reply_to_wechat 交回原消息渠道；遵守主人的原有权限与限制。' } });
    if (receipt?.accepted !== true || !receipt.taskId) fail('DELIVERY_UNCERTAIN', '伙伴未返回明确的受理回执，请在 Cindy 中查看。');
    if (entry.state !== 'dispatching') fail('BINDING_CHANGED', '派发期间请求已失效，不能回传旧回复。');
    entry.sessionId = receipt.taskId; entry.state = 'accepted';
    this.bindSession(entry.botConfigId, entry.companionId, receipt.taskId);
    entry.attachments = undefined;
    entry.requestKey = requestKey; entry.executionId = receipt.executionId;
    if (caps.delegation.receiptQuery === true && caps.delegation.settled === true && typeof this.targets.get === 'function') {
      entry.monitorReceipt = true; entry.receiptPoll = 0; this.scheduleReceipt(entry);
    }
    return receipt;
  }
  receiptActive(entry) {
    return entry.monitorReceipt && entry.state === 'accepted' && this.requests.get(entry.requestId) === entry &&
      this.current.get(entry.botConfigId) === entry.requestId;
  }
  scheduleReceipt(entry) {
    if (!this.receiptActive(entry)) return;
    const delay = [1000, 5000, 15000][Math.min(entry.receiptPoll++, 2)];
    entry.receiptTimer = this.setTimer(() => { entry.receiptTimer = undefined; return this.pollReceipt(entry); }, delay);
    entry.receiptTimer?.unref?.();
  }
  async closeUnreplied(entry, state, code) {
    // Reserve replyKey synchronously before any image read/send. A terminal receipt
    // must never cancel a reply already being prepared or sent.
    if (!this.receiptActive(entry) || entry.replyKey !== undefined) return;
    entry.state = state; entry.finish();
    try { await this.rejectInbound(entry.requestId, code); } catch { /* Closed locally; never claim delivery. */ }
  }
  async pollReceipt(entry) {
    if (!this.receiptActive(entry)) return;
    if (this.now() - entry.createdAt > 30 * 60000 && entry.replyKey === undefined) {
      await this.closeUnreplied(entry, 'expired', 'REQUEST_EXPIRED'); return;
    }
    try {
      const receipt = await this.targets.get({ requestKey: entry.requestKey });
      if (!this.receiptActive(entry)) return;
      if (receipt?.found === true && receipt.requestKey === entry.requestKey && receipt.taskId === entry.sessionId &&
          receipt.target?.kind === 'bot' && receipt.target.id === entry.companionId &&
          (!entry.executionId || receipt.executionId === entry.executionId) && receipt.settled === true) {
        let code = 'ENDED_WITHOUT_REPLY';
        switch (receipt.result?.outcome) {
          case 'completed': code = 'COMPLETED_WITHOUT_REPLY'; break;
          case 'failed': code = 'FAILED_WITHOUT_REPLY'; break;
          case 'cancelled': code = 'CANCELLED_WITHOUT_REPLY'; break;
          case 'interrupted': code = 'INTERRUPTED_WITHOUT_REPLY'; break;
        }
        await this.closeUnreplied(entry, 'settled', code);
      }
    } catch (error) {
      // Revoked/unsupported access is not retried to trigger another permission prompt.
      if (['PERMISSION_DENIED', 'UNSUPPORTED_CAPABILITY', 'INVALID_PARAMS'].includes(error.code)) entry.monitorReceipt = false;
      // Unknown, missing and failed queries remain unconfirmed; no reply or redispatch.
    }
    this.scheduleReceipt(entry);
  }
  async reply(requestId, text = '', sessionId, callContext, attachmentRefs = []) {
    if (requestId === undefined) {
      if (!sessionId) fail('WRONG_COMPANION', '回传必须带有宿主校验的伙伴会话身份。');
      const callId = callContext?.callId;
      const deny = (code, message) => { this.rememberReplyCall(callId, { sessionId, errorCode: code, message }); fail(code, message); };
      const previous = callId && this.replyCalls.get(callId);
      if (previous) {
        if (previous.sessionId !== sessionId) fail('WRONG_COMPANION', '不能更换同一调用的伙伴身份。');
        if (previous.errorCode) fail(previous.errorCode, previous.message);
        requestId = previous.requestId;
      } else {
        const bindings = [...this.routes.values()].filter(bot => {
          if (!bot.enabled) return false;
          const active = this.requests.get(this.current.get(bot.id));
          if (active?.companionId === bot.companionId && active.sessionId) return active.sessionId === sessionId;
          const bound = this.bindingSessions.get(bot.id);
          return bound?.companionId === bot.companionId && bound.sessionId === sessionId;
        });
        if (bindings.length > 1) deny('AMBIGUOUS_REQUEST', '伙伴身份对应多组绑定，不能猜测回传目标。');
        if (!bindings.length) deny('WRONG_COMPANION', '没有与宿主伙伴身份匹配的有效绑定。');
        requestId = this.current.get(bindings[0].id);
        const current = this.requests.get(requestId);
        if (!current || !['dispatching', 'accepted'].includes(current.state))
          deny('NO_CURRENT_REQUEST', '这位伙伴没有当前有效的微信请求，不能回传说明、历史或其他对话。');
        this.rememberReplyCall(callId, { sessionId, requestId });
      }
    } else if (typeof requestId !== 'string' || !requestId) fail('INVALID_REPLY', 'request_id 须省略或使用原请求编号。');
    const entry = this.requests.get(requestId);
    if (!entry || this.now() - entry.createdAt > 30 * 60000) fail('REQUEST_EXPIRED', '请求不存在或已过期，请让微信用户重新发送。');
    if (entry.state === 'settled') fail('REQUEST_SETTLED', '伙伴已结束本次请求但未回传，不能补发旧回复，请让微信用户重新发送。');
    const bot = this.routes.get(entry.botConfigId);
    if (!bot?.enabled || bot.companionId !== entry.companionId) fail('BINDING_CHANGED', '原绑定已经停用或改变，不能回传旧回复。');
    if (entry.replyKey === undefined && this.current.get(entry.botConfigId) !== requestId) fail('REQUEST_NOT_CURRENT', '只能回传这组 Bot 当前正在处理的微信请求。');
    await entry.accepted;
    if (!sessionId || sessionId !== entry.sessionId) fail('WRONG_COMPANION', '只有接收这条微信消息的伙伴能回传答案。');
    if (typeof text !== 'string' || text.length > 8000 || !Array.isArray(attachmentRefs) || attachmentRefs.length > 4 ||
        attachmentRefs.some(ref => typeof ref !== 'string' || !/^[a-f0-9]{64}$/.test(ref)) || (!text.trim() && !attachmentRefs.length))
      fail('INVALID_REPLY', '回复须包含文字或通过顶层 attachments 交接的 1–4 张图片，文字最多 8000 字符。');
    const replyKey = JSON.stringify([text, attachmentRefs]);
    if (entry.replyKey !== undefined) {
      if (entry.replyKey !== replyKey) fail('REPLY_CONFLICT', '这条请求已经使用了不同的回复，不能再次发送。');
      return entry.replyPromise;
    }
    if (entry.state !== 'accepted') fail('DELIVERY_UNCERTAIN', '请求没有确定的受理状态，不能发送。');
    entry.replyKey = replyKey; let submitted = false;
    entry.replyPromise = (async () => {
      const images = attachmentRefs.length ? await this.readImages(attachmentRefs) : [];
      const route = this.routes.get(entry.botConfigId);
      if (entry.state !== 'accepted' || !route?.enabled || route.companionId !== entry.companionId || this.current.get(entry.botConfigId) !== requestId)
        fail('BINDING_CHANGED', '读取图片期间绑定已改变，不能发送旧回复。');
      submitted = true;
      return this.nodeReply({ requestId, text, generation: entry.generation, ...(images.length ? { images } : {}) }, callContext);
    })();
    try { const result = await entry.replyPromise; entry.state = 'sent'; entry.finish(); return result; }
    catch (error) {
      if (!submitted && entry.state === 'accepted') { entry.replyKey = undefined; entry.replyPromise = undefined; }
      else { entry.state = error.code === 'IMAGE_UPLOAD_FAILED' ? 'rejected' : 'uncertain'; entry.finish(); }
      throw error;
    }
  }
}
