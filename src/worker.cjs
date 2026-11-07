const readline = require('node:readline');
const { randomUUID, createHash } = require('node:crypto');
const QRCode = require('qrcode');
const { IlinkClient, decodeMessage, tencentUrl, error } = require('./ilink.cjs');
const { sealState, openState } = require('./state.cjs');
const { imageBytes, MAX_IMAGE_BYTES } = require('./media.cjs');
const MAX_PENDING_IMAGE_BYTES = 40 * 1024 * 1024;
const IMAGE_CHUNK_CHARS = 192 * 1024;
const VOICE_UNSUPPORTED_REPLY = '暂不支持语音，请使用微信语音转文字后发送。';
const pause = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
});
class BotManager {
  constructor({ notify = () => {}, clientFactory = opts => new IlinkClient(opts), encodeQr = value => QRCode.toBuffer(value, { width: 360, margin: 3 }), checkpoint = async () => {} } = {}) {
    this.bots = new Map(); this.requests = new Map(); this.notify = notify; this.pendingImageBytes = 0;
    this.clientFactory = clientFactory; this.encodeQr = encodeQr;
    this.checkpoint = checkpoint; this.storageStatus = 'not-saved'; this.initialized = false;
    this.instanceId = randomUUID();
  }
  configure(bots) {
    if (!Array.isArray(bots) || bots.length > 32) throw error('INVALID_CONFIG', 'Bot 配置不正确。');
    const ids = new Set(bots.map(bot => bot.id));
    for (const [id, state] of this.bots) if (!ids.has(id)) { this.stop(state); this.bots.delete(id); }
    for (const config of bots) {
      let state = this.bots.get(config.id);
      if (!state) { state = { config: { ...config }, generation: 1, status: 'disconnected', seen: new Set(),
        stats: { received: 0, delivered: 0, rejected: 0 }, cursor: '', peers: new Map() }; this.bots.set(config.id, state); }
      else if (state.config.companionId !== config.companionId || state.config.enabled !== config.enabled) {
        this.stop(state); if (state.config.companionId !== config.companionId) state.peers.clear();
      }
      state.config = { ...config };
      if (this.mayStart(state)) this.start(state);
      else if (!config.enabled && state.client) state.status = 'paused';
    }
    return this.status();
  }
  bot(id) { const state = this.bots.get(id); if (!state) throw error('BOT_NOT_FOUND', '请先添加这组 Bot。'); return state; }
  mayStart(state) { return state.config.enabled && state.client && !state.loop && !['disconnecting', 'saving_login', 'storage_error'].includes(state.status); }
  stop(state) {
    state.generation++; state.abort?.abort(); state.loop = null;
    state.authAbort?.abort(); state.auth = undefined; state.authPoll = undefined;
    state.status = state.client ? 'paused' : 'disconnected';
    for (const [id, entry] of this.requests) if (entry.botConfigId === state.config.id) { this.releaseImages(entry); this.clearStaged(entry); this.requests.delete(id); }
  }
  disconnect(id) {
    const state = this.bot(id);
    if (state.client?.lifecycle) void state.client.lifecycle('stop', new AbortController().signal).catch(() => {});
    this.stop(state); state.client = undefined; state.credentials = undefined;
    state.cursor = ''; state.seen.clear(); state.peers.clear(); state.status = 'disconnected'; return this.publicState(state);
  }
  prepareDisconnect(id) {
    const state = this.bot(id); this.stop(state); state.status = 'disconnecting'; return this.publicState(state);
  }
  rollbackDisconnect(id) {
    const state = this.bot(id); state.status = state.client ? 'paused' : 'disconnected';
    if (this.mayStart(state)) this.start(state); return this.publicState(state);
  }
  cancelAuth(id) {
    const state = this.bot(id); state.authAbort?.abort(); state.auth = undefined; state.authPoll = undefined;
    return this.publicState(state);
  }
  publicState(state) { return { id: state.config.id, status: state.status,
    connected: !!state.client, generation: state.generation, instanceId: this.instanceId, stats: { ...state.stats },
    lastErrorCode: state.lastErrorCode ?? null, ilinkBotId: state.credentials?.botId ?? null,
    peers: [...state.peers.values()].map(({ peerId, receivedAt }) => ({ peerId, receivedAt })),
    defaultPeerId: [...state.peers.keys()].at(-1) ?? null }; }
  status() { return { instanceId: this.instanceId, bots: [...this.bots.values()].map(state => this.publicState(state)), credentialStorage: this.storageStatus }; }
  seal(secret) {
    if (!this.initialized) throw error('STATE_NOT_READY', '登录记录尚未恢复，不能覆盖已保存的状态。');
    const records = [...this.bots.values()].filter(state => state.credentials && state.status !== 'disconnecting').map(state => ({
      id: state.config.id, companionId: state.config.companionId, credentials: state.credentials,
      cursor: state.cursor, seen: [...state.seen].slice(-64), peers: [...state.peers.values()],
    }));
    return { hasCredentials: !!records.length, envelope: records.length ? sealState(records, secret) : null };
  }
  load(envelope, secret) {
    const records = openState(envelope, secret);
    for (const record of records) {
      const state = this.bots.get(record.id);
      if (!state || state.config.companionId !== record.companionId) continue;
      this.stop(state); state.credentials = record.credentials; state.cursor = record.cursor; state.seen = new Set(record.seen);
      state.peers = new Map((record.peers ?? []).map(peer => [peer.peerId, peer]));
      state.client = this.clientFactory({ token: record.credentials.token, baseUrl: record.credentials.baseUrl });
      state.status = 'paused'; if (state.config.enabled) this.start(state);
    }
    this.initialized = true; this.storageStatus = 'sealed'; return this.status();
  }
  initializeEmpty() { this.initialized = true; return this.status(); }
  saved() {
    this.storageStatus = 'sealed';
    for (const state of this.bots.values()) if (state.client && state.status === 'storage_error') {
      state.status = 'paused'; if (state.config.enabled && !state.loop) this.start(state);
    }
    return { saved: true };
  }
  async beginAuth(id) {
    const state = this.bot(id); this.cancelAuth(id);
    const controller = new AbortController(); state.authAbort = controller;
    const client = this.clientFactory({});
    const result = await client.begin(controller.signal);
    if (controller.signal.aborted || this.bots.get(id) !== state) throw error('CANCELLED', '登录已经取消。');
    if (typeof result.qrcode !== 'string' || !result.qrcode) throw error('BAD_RESPONSE', '微信没有返回登录二维码。');
    const qrUrl = tencentUrl(result.qrcode_img_content).toString();
    const png = await this.encodeQr(qrUrl);
    if (controller.signal.aborted) throw error('CANCELLED', '登录已经取消。');
    state.auth = { client, qrCode: result.qrcode, createdAt: Date.now(), status: 'waiting_scan' };
    return { id, status: 'waiting_scan', qrPngBase64: png.toString('base64'), expiresAt: state.auth.createdAt + 5 * 60000 };
  }
  async checkAuth(id) {
    const state = this.bot(id);
    if (!state.auth) return this.publicState(state);
    if (Date.now() - state.auth.createdAt > 5 * 60000) { state.auth = undefined; state.status = 'qr_expired'; return this.publicState(state); }
    if (state.authPoll) return state.authPoll;
    const auth = state.auth, controller = state.authAbort;
    state.authPoll = (async () => {
      const result = await auth.client.pollQr(auth.qrCode, controller.signal);
      if (controller.signal.aborted || state.auth !== auth) throw error('CANCELLED', '登录已经取消。');
      if (result.status === 'confirmed') {
        for (const key of ['bot_token', 'ilink_bot_id', 'ilink_user_id', 'baseurl'])
          if (typeof result[key] !== 'string' || !result[key].trim()) throw error('BAD_RESPONSE', '微信登录信息不完整。');
        tencentUrl(result.baseurl, true);
        for (const other of this.bots.values()) if (other !== state && other.credentials?.botId === result.ilink_bot_id)
          throw error('DUPLICATE_BOT_ACCOUNT', '这个微信 Bot 已经登录到另一组配置，请使用不同的 Bot。');
        const sameAccount = state.credentials?.botId === result.ilink_bot_id;
        this.stop(state); if (!sameAccount) { state.cursor = ''; state.seen.clear(); state.peers.clear(); }
        state.credentials = { token: result.bot_token, botId: result.ilink_bot_id, userId: result.ilink_user_id, baseUrl: result.baseurl };
        state.client = this.clientFactory({ token: result.bot_token, baseUrl: result.baseurl });
        state.auth = undefined; state.status = 'saving_login'; this.storageStatus = 'not-saved';
        this.notify('wechat/connection-reset', { botConfigId: id, generation: state.generation, instanceId: this.instanceId });
        try { await this.checkpoint(); this.storageStatus = 'sealed'; } catch {
          state.status = 'storage_error'; throw error('PERSISTENCE_FAILED', '微信登录已确认但保存失败，请检查插件存储权限后刷新状态。');
        }
        state.status = state.config.enabled ? 'connected' : 'paused';
        if (state.config.enabled) this.start(state);
      } else if (result.status === 'scaned_but_redirect') {
        if (typeof result.redirect_host !== 'string') throw error('BAD_RESPONSE', '微信登录重定向无效。');
        auth.client = this.clientFactory({ baseUrl: tencentUrl(`https://${result.redirect_host}`, true).origin }); auth.status = 'scanned';
      } else if (result.status === 'wait' || result.status === 'scaned') auth.status = result.status === 'wait' ? 'waiting_scan' : 'scanned';
      else if (result.status === 'expired') { state.auth = undefined; state.status = 'qr_expired'; }
      else if (result.status === 'binded_redirect') {
        state.auth = undefined; state.status = 'login_requires_action';
        throw error('AUTH_ALREADY_BOUND', '这个 Bot 已绑定在其他连接（可能是 Cindy 内置微信），请先解绑或换一个 Bot。');
      } else if (result.status === 'need_verifycode' || result.status === 'verify_code_blocked') {
        state.auth = undefined; state.status = 'login_requires_action';
        throw error('LOGIN_REQUIRES_ACTION', '微信要求额外验证；骨架版暂不支持，请完成微信侧验证后重新扫码。');
      } else throw error('BAD_RESPONSE', '微信返回了未知的登录状态。');
      return { ...this.publicState(state), ...(state.auth ? { status: auth.status } : {}) };
    })();
    const pending = state.authPoll;
    try { return await pending; } finally { if (state.authPoll === pending) state.authPoll = undefined; }
  }
  start(state) {
    const controller = new AbortController(), generation = state.generation; state.abort = controller;
    state.status = 'connected';
    state.loop = this.pollLoop(state, generation, controller.signal).catch(err => {
      if (state.generation === generation && !controller.signal.aborted) { state.status = 'error'; state.lastErrorCode = err.code ?? 'CONNECTION_ERROR'; }
    }).finally(() => { if (state.abort === controller) state.loop = null; });
  }
  async pollLoop(state, generation, signal) {
    let failures = 0;
    try { await state.client.lifecycle('start', signal); } catch (err) {
      if (signal.aborted) return; state.lastErrorCode = err.code ?? 'NETWORK_ERROR';
    }
    while (!signal.aborted && state.generation === generation) {
      try {
        const result = await state.client.updates(state.cursor, signal);
        if (signal.aborted || state.generation !== generation) return;
        if (result.msgs !== undefined && (!Array.isArray(result.msgs) || result.msgs.length > 100)) throw error('BAD_RESPONSE', '微信消息列表无效或过大。');
        if (result.msgs?.length || failures) state.lastErrorCode = null;
        const previousCursor = state.cursor, previousPeerRevision = state.peerRevision, batch = [];
        for (const raw of result.msgs ?? []) { const event = this.ingest(state, generation, raw, false); if (event) batch.push(event); }
        if (typeof result.get_updates_buf === 'string') state.cursor = result.get_updates_buf;
        if (batch.length || state.cursor !== previousCursor || state.peerRevision !== previousPeerRevision) {
          try { await this.checkpoint(); } catch {
            state.status = 'storage_error'; state.lastErrorCode = 'PERSISTENCE_FAILED'; return;
          }
        }
        if (signal.aborted || state.generation !== generation) return;
        for (const event of batch) {
          if (event.voiceNotice) { await this.sendVoiceNotice(event, signal); continue; }
          try {
            const prepared = await this.prepareInbound(event, signal);
            if (signal.aborted || state.generation !== generation) return;
            this.notifyInbound(prepared);
          } catch (err) {
            if (signal.aborted || state.generation !== generation) return;
            this.reject(event.requestId, err.code ?? 'IMAGE_DOWNLOAD_FAILED');
          }
        }
        failures = 0; state.status = 'connected';
        await pause(200, signal);
      } catch (err) {
        if (signal.aborted) return;
        state.lastErrorCode = err.code ?? 'NETWORK_ERROR';
        if (err.code === 'AUTH_EXPIRED') {
          this.stop(state); state.credentials = undefined; state.client = undefined; state.cursor = ''; state.seen.clear(); state.peers.clear(); state.status = 'needs_login';
          this.notify('wechat/connection-reset', { botConfigId: state.config.id, generation: state.generation, instanceId: this.instanceId });
          try { await this.checkpoint(); } catch { state.lastErrorCode = 'PERSISTENCE_FAILED'; } return;
        }
        state.status = 'reconnecting'; failures++; await pause(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)), signal);
      }
    }
  }
  ingest(state, generation, raw, emit = true) {
    const message = decodeMessage(raw); if (!message || state.seen.has(message.id)) return;
    if (state.generation !== generation || !state.config.enabled) return;
    if (message.peerId.length > 512 || message.contextToken.length > 8192) throw error('BAD_RESPONSE', '微信联系人上下文无效或过大。');
    state.peers.delete(message.peerId);
    state.peers.set(message.peerId, { peerId: message.peerId, contextToken: message.contextToken, receivedAt: Date.now() });
    state.peerRevision = (state.peerRevision ?? 0) + 1;
    if (state.peers.size > 8) state.peers.delete(state.peers.keys().next().value);
    for (const [id, entry] of this.requests) if (Date.now() - entry.createdAt > 30 * 60000) { this.releaseImages(entry); this.clearStaged(entry); this.requests.delete(id); }
    const requestId = randomUUID();
    const entry = { ...message, requestId, botConfigId: state.config.id, generation, state: 'pending', createdAt: Date.now() };
    const count = [...this.requests.values()].filter(item => item.botConfigId === state.config.id && item.state === 'pending').length;
    if (count >= 32 || this.requests.size >= 256) { state.lastErrorCode = 'INBOX_FULL'; return; }
    state.seen.add(message.id); if (state.seen.size > 512) state.seen.delete(state.seen.values().next().value);
    this.requests.set(requestId, entry); state.stats.received++;
    if (message.unsupported || (!message.text.trim() && !message.images.length) || message.text.length > 16000) {
      state.stats.rejected++; entry.state = 'rejected'; state.lastErrorCode = message.errorCode ?? 'UNSUPPORTED_MESSAGE';
      this.releaseImages(entry);
      if (!message.hasVoice) return;
      const event = { requestId, botConfigId: state.config.id, generation, voiceNotice: true };
      if (emit) void this.sendVoiceNotice(event, state.abort?.signal);
      return event;
    }
    const event = { requestId, botConfigId: state.config.id, generation, instanceId: this.instanceId, text: message.text.trim() ? message.text : '请查看微信用户发送的图片。' };
    if (emit && !message.images.length) this.notify('wechat/inbound', event);
    else if (emit) void this.prepareInbound(event, state.abort?.signal).then(prepared => this.notifyInbound(prepared), err => this.reject(requestId, err.code ?? 'IMAGE_DOWNLOAD_FAILED'));
    return event;
  }
  async sendVoiceNotice({ requestId, botConfigId, generation }, signal) {
    const entry = this.requests.get(requestId), state = this.bots.get(botConfigId);
    const current = () => this.requests.get(requestId) === entry && state?.config.enabled && state.client &&
      state.generation === generation && entry?.generation === generation && !signal?.aborted;
    if (!entry?.hasVoice || entry.state !== 'rejected' || entry.noticeAttempted || !current()) return;
    // The poll loop saves cursor/seen before this one attempt. Never retry an uncertain send.
    entry.noticeAttempted = true;
    try {
      await state.client.send({ peerId: entry.peerId, contextToken: entry.contextToken, clientId: randomUUID(), text: VOICE_UNSUPPORTED_REPLY }, signal);
      if (current()) state.stats.delivered++;
    } catch {
      if (current()) state.lastErrorCode = 'DELIVERY_UNCERTAIN';
    }
  }
  releaseImages(entry) { this.pendingImageBytes -= entry.mediaBytes ?? 0; entry.mediaBytes = 0; entry.images = []; }
  notifyInbound(event) {
    const { attachments, ...metadata } = event;
    for (let index = 0; index < (attachments?.length ?? 0); index++) {
      const data = attachments[index].base64;
      for (let offset = 0, seq = 0; offset < data.length; offset += IMAGE_CHUNK_CHARS, seq++)
        this.notify('wechat/image-chunk', { requestId: event.requestId, botConfigId: event.botConfigId, generation: event.generation, instanceId: this.instanceId,
          index, seq, base64: data.slice(offset, offset + IMAGE_CHUNK_CHARS) });
    }
    this.notify('wechat/inbound', { ...metadata, ...(attachments?.length ? { imageParts: attachments.map(item => ({ name: item.name, chars: item.base64.length, chunks: Math.ceil(item.base64.length / IMAGE_CHUNK_CHARS) })) } : {}) });
  }
  stagedEntry({ requestId, generation }) {
    const entry = this.requests.get(requestId), state = entry && this.bots.get(entry.botConfigId);
    if (!entry || Date.now() - entry.createdAt > 30 * 60000) throw error('REQUEST_EXPIRED', '图片回传请求已过期。');
    if (!state?.client || !state.config.enabled || state.generation !== generation || entry.generation !== generation) throw error('BINDING_CHANGED', '图片回传绑定已改变。');
    if (entry.state !== 'pending') throw error('REQUEST_REJECTED', '图片回传请求已结束。');
    return entry;
  }
  clearStaged(entry) { this.pendingImageBytes -= entry.stagedBytes ?? 0; entry.stagedBytes = 0; entry.stagedImages = undefined; entry.stagedLengths = undefined; }
  stageBegin(args) {
    const entry = this.stagedEntry(args), lengths = args.lengths;
    if (!Array.isArray(lengths) || !lengths.length || lengths.length > 4 || lengths.some(length => !Number.isInteger(length) || length < 4 || length % 4 || length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4))
      throw error('INVALID_IMAGE', '图片分块长度无效。');
    this.clearStaged(entry);
    this.releaseImages(entry); // Incoming bytes already belong to the companion's durable message.
    if (this.pendingImageBytes + lengths.length * MAX_IMAGE_BYTES > MAX_PENDING_IMAGE_BYTES) throw error('MEDIA_INBOX_FULL', '等待传输的图片过多，请稍后重新发送请求。');
    entry.stagedBytes = lengths.length * MAX_IMAGE_BYTES; this.pendingImageBytes += entry.stagedBytes;
    entry.stagedLengths = lengths; entry.stagedImages = lengths.map(() => []); return { ready: true };
  }
  stageChunk(args) {
    const entry = this.stagedEntry(args), chunks = entry.stagedImages?.[args.index];
    if (!Number.isInteger(args.index) || !chunks || !Number.isInteger(args.seq) || args.seq !== chunks.length ||
        typeof args.base64 !== 'string' || !args.base64 || args.base64.length > IMAGE_CHUNK_CHARS || args.base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(args.base64) ||
        (chunks.length && chunks.at(-1).includes('=')) || chunks.length * IMAGE_CHUNK_CHARS + args.base64.length > entry.stagedLengths[args.index])
      throw error('INVALID_IMAGE', '图片分块顺序或内容无效。');
    chunks.push(args.base64); return { accepted: true };
  }
  async prepareInbound(event, signal) {
    const entry = this.requests.get(event.requestId), state = this.bots.get(event.botConfigId);
    const current = () => entry && entry.state === 'pending' && this.requests.get(event.requestId) === entry &&
      state?.config.enabled && state.generation === event.generation && !signal?.aborted;
    if (!current()) throw error('BINDING_CHANGED', '绑定已改变，不能转交旧图片。');
    const attachments = [];
    // Reserve each download's maximum size before awaiting it; includes concurrent Bots.
    for (const item of entry.images) {
      if (this.pendingImageBytes + MAX_IMAGE_BYTES > MAX_PENDING_IMAGE_BYTES) throw error('MEDIA_INBOX_FULL', '等待处理的微信图片过多，请稍后重新发送。');
      this.pendingImageBytes += MAX_IMAGE_BYTES; entry.mediaBytes = (entry.mediaBytes ?? 0) + MAX_IMAGE_BYTES;
      const attachment = await state.client.downloadImage(item, signal);
      if (!current()) throw error('BINDING_CHANGED', '绑定已改变，不能转交旧图片。');
      attachments.push(attachment);
    }
    return { ...event, ...(attachments.length ? { attachments } : {}) };
  }
  reject(requestId, code) {
    const entry = this.requests.get(requestId); if (!entry) return { rejected: false };
    if (entry.state === 'rejected') return { rejected: false };
    this.releaseImages(entry);
    this.clearStaged(entry);
    entry.state = 'rejected'; const state = this.bots.get(entry.botConfigId);
    if (state) { state.stats.rejected++; state.lastErrorCode = /^[A-Z_]+$/.test(code ?? '') ? code : 'DISPATCH_FAILED'; }
    return { rejected: true };
  }
  async reply({ requestId, generation, text = '', images = [], useStagedImages = false }) {
    const entry = this.requests.get(requestId);
    if (!entry || Date.now() - entry.createdAt > 30 * 60000) throw error('REQUEST_EXPIRED', '回传请求不存在或过期。');
    const state = this.bot(entry.botConfigId);
    if (!state.config.enabled || !state.client || state.generation !== entry.generation || generation !== entry.generation)
      throw error('BINDING_CHANGED', 'Bot 已停用、重连或更换绑定。');
    if (useStagedImages) {
      if (entry.replyKey !== undefined && entry.replyHadStaged) {
        if (entry.replyText !== text) throw error('REPLY_CONFLICT', '不能为同一消息发送不同回复。');
        this.clearStaged(entry);
        return entry.replyPromise;
      }
      if (!entry.stagedImages || entry.stagedImages.some((chunks, index) => chunks.join('').length !== entry.stagedLengths[index]))
        throw error('INVALID_IMAGE', '图片分块尚未完整交接。');
      images = entry.stagedImages.map(chunks => chunks.join(''));
    }
    if (typeof text !== 'string' || text.length > 8000 || !Array.isArray(images) || images.length > 4 || (!text.trim() && !images.length))
      throw error('INVALID_REPLY', '回复须包含文字或 1–4 张图片，文字最多 8000 字符。');
    const buffers = images.map(imageBytes);
    const replyKey = JSON.stringify([text, buffers.map(bytes => createHash('sha256').update(bytes).digest('hex'))]);
    if (entry.replyKey !== undefined) {
      if (entry.replyKey !== replyKey) throw error('REPLY_CONFLICT', '不能为同一消息发送不同回复。');
      return entry.replyPromise;
    }
    if (entry.state !== 'pending') throw error('REQUEST_REJECTED', '这条微信消息未被受理。');
    entry.replyKey = replyKey; entry.replyText = text; entry.replyHadStaged = useStagedImages; entry.state = 'sending';
    const chunks = []; let chunk = '';
    for (const char of text) { if (chunk.length + char.length > 3500) { chunks.push(chunk); chunk = ''; } chunk += char; }
    if (chunk) chunks.push(chunk);
    entry.replyPromise = (async () => {
      let sendAttempted = false;
      const signal = state.abort?.signal ? AbortSignal.any([state.abort.signal, AbortSignal.timeout(210000)]) : AbortSignal.timeout(210000);
      const assertCurrent = () => { if (state.generation !== generation || !state.config.enabled || signal.aborted) throw error('BINDING_CHANGED', '发送期间绑定改变或请求取消。'); };
      try {
      // Upload the complete image set before sending text, avoiding a partial reply on upload failure.
      const uploaded = [];
      for (const bytes of buffers) { assertCurrent(); this.notify('wechat/reply-progress', { requestId, instanceId: this.instanceId }); uploaded.push(await state.client.uploadImage(entry.peerId, bytes, signal)); }
      for (const chunk of chunks) {
        assertCurrent(); sendAttempted = true;
        if (buffers.length) this.notify('wechat/reply-progress', { requestId, instanceId: this.instanceId });
        await state.client.send({ peerId: entry.peerId, contextToken: entry.contextToken, clientId: randomUUID(), text: chunk }, signal);
      }
      for (const image of uploaded) {
        assertCurrent(); sendAttempted = true;
        this.notify('wechat/reply-progress', { requestId, instanceId: this.instanceId });
        await state.client.sendImage({ peerId: entry.peerId, contextToken: entry.contextToken, clientId: randomUUID(), image }, signal);
      }
      entry.state = 'sent'; state.stats.delivered++; return { delivered: true, requestId, botConfigId: entry.botConfigId, peerId: entry.peerId, chunks: chunks.length, images: uploaded.length };
      } catch (err) {
      if (!sendAttempted) { entry.state = 'rejected'; state.lastErrorCode = err.code ?? 'IMAGE_UPLOAD_FAILED'; throw error('IMAGE_UPLOAD_FAILED', '图片准备或上传失败，尚未发送回复，请让微信用户重新发送请求。'); }
      entry.state = 'uncertain'; state.lastErrorCode = 'DELIVERY_UNCERTAIN';
      throw error('DELIVERY_UNCERTAIN', '微信发送结果不确定；请在微信检查，不能自动重发。');
      } finally { this.releaseImages(entry); this.clearStaged(entry); }
    })();
    return entry.replyPromise;
  }
  prepareSend({ id, companionId, sendId, peerId }) {
    const state = this.bot(id);
    if (!state.config.enabled || state.config.companionId !== companionId || !state.client ||
        !['connected', 'reconnecting'].includes(state.status) || state.abort?.signal.aborted)
      throw error('BOT_NOT_AVAILABLE', 'Bot 未启用或连接不可用，请先恢复聊天并检查登录状态。');
    if (typeof sendId !== 'string' || !/^[a-f0-9-]{36}$/.test(sendId) ||
        (peerId !== undefined && (typeof peerId !== 'string' || !peerId || peerId.length > 512)))
      throw error('INVALID_REPLY', '发送标识或联系人无效。');
    const requestId = `out-${sendId}`, previous = this.requests.get(requestId);
    if (previous) {
      if (previous.botConfigId !== id || previous.generation !== state.generation || previous.selectedPeerId !== peerId)
        throw error('REPLY_CONFLICT', '同一发送调用不能改变目标。');
      return { requestId, generation: previous.generation };
    }
    // Like Cindy personal WeChat, default to the most recently received peer.
    const peer = state.peers.get(peerId ?? [...state.peers.keys()].at(-1));
    if (!peer) throw error('WECHAT_PEER_NOT_KNOWN', '没有该微信联系人的发送上下文，请先让对方给这个 Bot 发一条消息。');
    for (const [key, old] of this.requests) if (Date.now() - old.createdAt > 30 * 60000 && old.state !== 'sending') {
      this.releaseImages(old); this.clearStaged(old); this.requests.delete(key);
    }
    if (this.requests.size >= 256) throw error('INBOX_FULL', '等待处理的消息过多，请稍后发送。');
    this.requests.set(requestId, { ...peer, requestId, botConfigId: id, generation: state.generation,
      selectedPeerId: peerId, state: 'pending', createdAt: Date.now(), images: [] });
    return { requestId, generation: state.generation };
  }
  close() { for (const id of this.bots.keys()) this.disconnect(id); this.bots.clear(); this.requests.clear(); }
}
function serve() {
  const write = message => process.stdout.write(JSON.stringify(message) + '\n');
  const checkpoints = new Map();
  const notify = (method, params) => write({ jsonrpc: '2.0', method, params: { ...params, instanceId: manager.instanceId } });
  const manager = new BotManager({ notify, checkpoint: () => new Promise((resolve, reject) => {
    const checkpointId = randomUUID();
    const timer = setTimeout(() => { checkpoints.delete(checkpointId); reject(error('PERSISTENCE_FAILED', '保存登录状态超时。')); }, 30000);
    checkpoints.set(checkpointId, { resolve, reject, timer }); notify('wechat/state-changed', { checkpointId });
  }) });
  readline.createInterface({ input: process.stdin }).on('line', async line => {
    let request; try { request = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '请求格式无效。' } }); return; }
    if (request.id === undefined) return;
    try {
      const args = request.params ?? {}; let result;
      switch (request.method) {
        case 'configure': result = manager.configure(args.bots); break;
        case 'status': result = manager.status(); break;
        case 'state/seal': result = manager.seal(request.cindy?.secrets?.wechat_vault_key); break;
        case 'state/load': result = manager.load(args.envelope, request.cindy?.secrets?.wechat_vault_key); break;
        case 'state/initialize': result = manager.initializeEmpty(); break;
        case 'state/saved': result = manager.saved(); break;
        case 'state/ack': {
          const checkpoint = args.instanceId === manager.instanceId ? checkpoints.get(args.checkpointId) : undefined;
          if (checkpoint) { clearTimeout(checkpoint.timer); checkpoints.delete(args.checkpointId);
            if (args.ok === true) checkpoint.resolve(); else checkpoint.reject(error('PERSISTENCE_FAILED', '登录状态保存失败。')); }
          result = { acknowledged: !!checkpoint }; break;
        }
        case 'auth/begin': result = await manager.beginAuth(args.id); break;
        case 'auth/check': result = await manager.checkAuth(args.id); break;
        case 'disconnect': result = manager.disconnect(args.id); break;
        case 'disconnect/prepare': result = manager.prepareDisconnect(args.id); break;
        case 'disconnect/rollback': result = manager.rollbackDisconnect(args.id); break;
        case 'auth/cancel': result = manager.cancelAuth(args.id); break;
        case 'reply': result = await manager.reply(args); break;
        case 'send/prepare': result = manager.prepareSend(args); break;
        case 'reply/images/begin': result = manager.stageBegin(args); break;
        case 'reply/images/chunk': result = manager.stageChunk(args); break;
        case 'reply/images/clear': { manager.clearStaged(manager.stagedEntry(args)); result = { cleared: true }; break; }
        case 'reject': result = manager.reject(args.requestId, args.code); break;
        default: throw error('METHOD_NOT_FOUND', 'Node 方法不存在。');
      }
      write({ jsonrpc: '2.0', id: request.id, result });
    } catch (err) { write({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: err.code ? err.message : 'Node 请求失败。', data: { code: err.code ?? 'NODE_FAILED' } } }); }
  }).on('close', () => { manager.close(); process.exit(0); });
  process.on('SIGTERM', () => { manager.close(); process.exit(0); });
}
module.exports = { BotManager, serve };
if (require.main === module) serve();
