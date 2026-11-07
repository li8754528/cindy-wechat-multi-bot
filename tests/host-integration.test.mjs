import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BotManager } = require('../src/worker.cjs');
const code = () => readFileSync('wechat-companion/main.js', 'utf8');
function makeHost(shared) {
  if (!shared.legacyGuides && !shared.config.bindingGuides) shared.config.bindingGuides = shared.config.bots.filter(bot => bot.companionId).map(bot =>
    ({ botId: bot.id, companionId: bot.companionId, key: `wx-guide-fixture-${bot.id}`, state: 'ready', sessionId: 'session-a' }));
  const handlers = [], results = [], dispatches = [], guideDispatches = [], deliveries = [], notifications = [], timers = [], receiptQueries = [], channels = []; let qrCalls = 0, sequence = 0;
  const manager = new BotManager({ clientFactory: opts => ({
    begin: async () => { qrCalls++; return { qrcode: `test-${sequence++}`, qrcode_img_content: 'https://ilinkai.weixin.qq.com/scan' }; },
    pollQr: async () => ({ status: 'confirmed', bot_token: 'private-token-test', ilink_bot_id: 'wx-test', ilink_user_id: 'owner-test', baseurl: 'https://ilinkai.weixin.qq.com' }),
    lifecycle: async () => ({}), updates: (_cursor, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ msgs: [] }), { once: true })),
    downloadImage: async () => ({ base64: shared.imageBase64, name: 'wechat-image.png' }),
    uploadImage: async (peerId, bytes) => { deliveries.push({ kind: 'upload', peerId, base64: bytes.toString('base64') }); return { media: { encrypt_query_param: 'private-image-query' } }; },
    send: async req => deliveries.push({ kind: 'text', ...req }), sendImage: async req => deliveries.push({ kind: 'image', ...req }),
  }), encodeQr: async () => Buffer.from('png'), notify: (method, params) => {
    assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', method, params })) <= 1024 * 1024, 'Host stdout line limit');
    for (const handler of handlers) notifications.push(handler({ type: 'event', name: 'node-notification', method, params }));
  }, checkpoint: async () => {
    for (const handler of handlers) await handler({ type: 'event', name: 'node-notification', method: 'wechat/state-changed', params: { checkpointId: 'test-checkpoint', instanceId: manager.instanceId } });
  } });
  const fetchImpl = async (path, init) => {
    if (path === '/kv') { if (init) shared.config = JSON.parse(init.body); return init ? new Response(null, { status: 204 }) : new Response(JSON.stringify(shared.config)); }
    if (path === '/secrets') return new Response(JSON.stringify([{ key: 'wechat_vault_key', saved: !!shared.key }]));
    if (path === '/secrets/wechat_vault_key' && init?.method === 'PUT') { shared.key = JSON.parse(init.body).value; return new Response(null, { status: 204 }); }
    if (path.startsWith('/media/')) {
      shared.mediaReads = (shared.mediaReads ?? 0) + 1;
      const data = shared.grants?.[path]; return data ? new Response(Buffer.from(data, 'base64')) : new Response(null, { status: 404 });
    }
    throw new Error('Unexpected simulated Host URL');
  };
  const cindy = {
    onHostMessage: handler => handlers.push(handler), send: async msg => { results.push(msg); return {}; },
    tasks: { capabilities: async () => ({ messageContext: shared.messageContext ?? true, messageAttachments: { kinds: ['image'] } }) },
    companions: { reply: () => { throw new Error('Must not read companion replies'); }, history: () => { throw new Error('Must not read companion history'); } },
    targets: { capabilities: async () => ({ delegation: { execution: true, receiptQuery: shared.receiptQuery ?? true, settled: shared.receiptQuery ?? true } }),
      resolve: async ({ target }) => target, list: async () => ({ targets: [{ id: 'buddy-a', label: 'A' }] }),
      send: async req => { (req.requestKey.startsWith('wx-guide-') ? guideDispatches : dispatches).push(req);
        if (!req.requestKey.startsWith('wx-guide-') && shared.failDispatchCount > 0) { shared.failDispatchCount--; throw Object.assign(new Error('host not ready'), { code: 'HOST_NOT_READY' }); }
        return { accepted: true, taskId: 'session-a', executionId: `execution-${req.requestKey}` }; },
      get: async ({ requestKey }) => { if (requestKey.startsWith('wx-guide-')) return { found: true, requestKey, taskId: 'session-a',
        target: { kind: 'bot', id: guideDispatches.find(req => req.requestKey === requestKey)?.target.id ?? 'buddy-a' },
        settled: shared.guideSettled !== false, result: { outcome: shared.guideOutcome ?? 'completed' } };
        receiptQueries.push(requestKey); return { found: true, requestKey, taskId: 'session-a', executionId: `execution-${requestKey}`,
        target: { kind: 'bot', id: 'buddy-a' }, status: 'accepted', settled: shared.settled === true,
        result: Object.hasOwn(shared, 'terminalResult') ? shared.terminalResult : { outcome: 'completed', outputMessageId: 'desktop-output' } }; } },
    fs: async req => {
      if (req.op === 'read') return shared.file ? { ok: true, content: shared.file } : { ok: false, errorCode: 'NOT_FOUND' };
      if (req.op === 'delete' && shared.failDelete) return { ok: false, message: 'test deletion failed' };
      if (req.op === 'write') shared.file = req.content; if (req.op === 'delete') shared.file = null; return { ok: true };
    },
    node: { request: async ({ method, params, timeoutMs, maxTotalMs }) => {
      assert.ok(Buffer.byteLength(JSON.stringify(params)) <= 256 * 1024, 'Host params size limit');
      assert.ok(timeoutMs >= 1000 && timeoutMs <= 120000, 'Host timeout range');
      if (maxTotalMs) assert.ok(maxTotalMs >= timeoutMs && maxTotalMs <= 900000, 'Host total timeout range');
      try { let result;
        switch (method) {
          case 'configure': result = manager.configure(params.bots); break;
          case 'status': result = manager.status(); break;
          case 'state/load': result = manager.load(params.envelope, shared.key); break;
          case 'state/initialize': result = manager.initializeEmpty(); break;
          case 'state/seal': result = manager.seal(shared.key); break;
          case 'state/saved': result = manager.saved(); break;
          case 'state/ack': result = {}; break;
          case 'disconnect': result = manager.disconnect(params.id); break;
          case 'disconnect/prepare': result = manager.prepareDisconnect(params.id); break;
          case 'disconnect/rollback': result = manager.rollbackDisconnect(params.id); break;
          case 'auth/cancel': result = manager.cancelAuth(params.id); break;
          case 'reject': result = manager.reject(params.requestId, params.code); break;
          case 'reply': result = await manager.reply(params); break;
          case 'send/prepare': result = manager.prepareSend(params); break;
          case 'reply/images/begin': result = manager.stageBegin(params); break;
          case 'reply/images/chunk': result = manager.stageChunk(params); break;
          case 'reply/images/clear': manager.clearStaged(manager.stagedEntry(params)); result = { cleared: true }; break;
          case 'auth/begin': result = await manager.beginAuth(params.id); break;
          case 'auth/check': result = await manager.checkAuth(params.id); break;
          default: throw new Error('Unexpected simulated Node method');
        }
        return { ok: true, result };
      } catch (error) { return { ok: false, errorCode: 'NODE_WORKER_ERROR', message: error.message, data: { code: error.code } }; }
    } },
  };
  runInNewContext(code(), { cindy, fetch: fetchImpl, crypto: webcrypto, btoa, AbortSignal,
    BroadcastChannel: class { constructor() { channels.push(this); } postMessage(message) { this.last = message; } }, Uint8Array, console,
    // Browser timers reject an arbitrary receiver, unlike Node timers or arrow mocks.
    setTimeout(callback, delay) {
      if (this?.cindy !== cindy) throw new TypeError('Illegal invocation');
      const timer = { callback, delay }; timers.push(timer); return timer;
    },
    clearTimeout(timer) {
      if (this?.cindy !== cindy) throw new TypeError('Illegal invocation');
      const index = timers.indexOf(timer); if (index !== -1) timers.splice(index, 1);
    } });
  return { manager, dispatches, guideDispatches, deliveries, receiptQueries, timers,
    tickReceipt: async () => { const timer = timers.shift(); assert.ok(timer); await timer.callback(); },
    hostMessage: async msg => { for (const handler of handlers) await handler(msg); },
    drainEvents: async () => { await Promise.all(notifications.splice(0)); }, event: async (method, params) => { for (const handler of handlers) await handler({ type: 'event', name: 'node-notification', method, params }); },
    get qrCalls() { return qrCalls; }, ui: async (action, args = {}) => {
      const id = webcrypto.randomUUID(); await channels[0].onmessage({ data: { type: 'ui-request', id, action, args } });
      assert.equal(channels[0].last.id, id); return channels[0].last;
    }, tool: async (tool, args = {}) => {
    const callId = `call-${sequence++}`; for (const handler of handlers) await handler({ type: 'tool-call', tool, args, callId });
    const response = results.find(result => result.callId === callId); assert.ok(response, 'tool receipt exists'); return response;
  } };
}
const binding = { id: 'a', name: 'A', companionId: 'buddy-a', enabled: false };

test('packaged main proactively sends without a current request, including after encrypted restart', async t => {
  const shared = { config: { bots: [binding] }, key: null, file: null };
  const first = makeHost(shared); t.after(() => first.manager.close());
  await first.tool('list_bindings');
  await first.tool('begin_login', { id: 'a' }); await first.tool('check_login', { id: 'a' });
  await first.tool('upsert_binding', { id: 'a', name: 'A', companion_id: 'buddy-a', enabled: true });
  const state = first.manager.bot('a');
  first.manager.ingest(state, state.generation, { message_id: 700, message_type: 1, from_user_id: 'wechat-peer', context_token: 'private-proactive-context',
    item_list: [{ type: 1, text_item: { text: 'hello' } }] });
  await first.drainEvents();
  const session_context = { session_id: 'session-a' };
  assert.equal((await first.tool('reply_to_wechat', { text: 'answer', session_context })).ok, true);
  await first.event('wechat/state-changed', { checkpointId: 'save-peers', instanceId: first.manager.instanceId });
  assert.equal((await first.tool('reply_to_wechat', { text: 'no current', session_context })).errorCode, 'NO_CURRENT_REQUEST');
  const sent = await first.tool('send_to_wechat', { text: 'notification', session_context });
  assert.equal(sent.ok, true); assert.equal(sent.result.peerId, 'wechat-peer');
  assert.equal(first.deliveries.at(-1).contextToken, 'private-proactive-context');
  first.manager.close();
  const second = makeHost(shared); t.after(() => second.manager.close());
  // No status refresh or new inbound message is needed to rebind the host session.
  const restored = await second.tool('send_to_wechat', { text: 'after restart', session_context });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(second.dispatches.length, 0); assert.equal(second.guideDispatches.length, 0);
  assert.equal(second.deliveries[0].peerId, 'wechat-peer');
  assert.equal(second.deliveries[0].contextToken, 'private-proactive-context');
  assert.equal(shared.file.includes('private-proactive-context'), false);
});

test('packaged main reports both pending retry stages, preserves Node input and cancels retry on worker stop', async t => {
  for (const stop of [false, true]) {
    const shared = { config: { bots: [{ ...binding, enabled: true }] }, key: null, file: null, receiptQuery: false, failDispatchCount: 2 };
    const host = makeHost(shared); t.after(() => host.manager.close());
    await host.tool('list_bindings'); await host.tool('begin_login', { id: 'a' }); await host.tool('check_login', { id: 'a' });
    const state = host.manager.bot('a');
    const event = host.manager.ingest(state, state.generation, { message_id: 500, message_type: 1, from_user_id: 'wechat-peer', context_token: 'private-context',
      item_list: [{ type: 1, text_item: { text: '重试时保留原文' } }] }, false);
    host.manager.notifyInbound(await host.manager.prepareInbound(event)); await host.drainEvents();
    const first = (await host.ui('list_bindings')).result;
    assert.equal(first.dispatchRetries[0].attempt, 1); assert.equal(host.timers[0].delay, 180000);
    assert.ok(renderSettings(first).error.includes('第 1/2 次')); assert.equal(state.stats.rejected, 0);
    assert.equal(host.manager.requests.get(event.requestId).state, 'pending');
    if (stop) {
      const timer = host.timers[0]; await host.hostMessage({ type: 'event', name: 'node-status', state: 'stopped' });
      assert.equal(host.timers.length, 0); await timer.callback(); assert.equal(host.dispatches.length, 1);
    } else {
      await host.tickReceipt(); const second = (await host.ui('list_bindings')).result;
      assert.equal(second.dispatchRetries[0].attempt, 2); assert.equal(host.timers[0].delay, 600000);
      assert.ok(renderSettings(second).error.includes('第 2/2 次')); await host.tickReceipt();
      assert.equal(host.dispatches.length, 3);
      assert.ok(host.dispatches.every(req => req.text === '重试时保留原文' && req.requestKey === `wx-${event.requestId}`));
      assert.equal((await host.ui('list_bindings')).result.dispatchRetries.length, 0);
      const reply = await host.tool('reply_to_wechat', { text: '仅本次回答', session_context: { session_id: 'session-a' } });
      assert.equal(reply.ok, true); assert.equal(state.stats.delivered, 1); assert.equal(state.stats.rejected, 0);
      assert.equal(host.deliveries[0].peerId, 'wechat-peer'); assert.equal(host.timers.length, 0);
    }
  }
});

function renderSettings(snapshot) {
  class Element {
    constructor(tag, text = '') { this.tag = tag; this.textContent = text; this.children = []; this.dataset = {}; this.value = ''; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    querySelectorAll(tag) { return this.children.flatMap(child => [child, ...child.querySelectorAll(tag)]).filter(child => child.tag === tag); }
    querySelector() { return null; }
  }
  const nodes = new Map();
  const document = {
    getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Element('div')); return nodes.get(id); },
    createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text),
    querySelectorAll: tag => [...nodes.values()].flatMap(node => [node, ...node.querySelectorAll(tag)]).filter(node => node.tag === tag),
  };
  const script = readFileSync('wechat-companion/settings.js', 'utf8') + String.fromCharCode(10) + 'view = snapshot; render();';
  runInNewContext(script, { snapshot, document, window: { addEventListener() {} },
    BroadcastChannel: class { close() {} }, fetch: () => new Promise(() => {}) });
  const card = nodes.get('bots').children[0];
  return { error: card.querySelectorAll('p').find(node => node.className === 'bot-error')?.textContent,
    status: card.querySelectorAll('span').find(node => node.className === 'status-pill')?.textContent };
}
test('UI adds an unpaired Bot, saves QR login, then starts chatting without another QR after restart', async () => {
  const shared = { config: { bots: [] }, key: null, file: null };
  const first = makeHost(shared);
  const added = await first.ui('add_bot'); assert.equal(added.ok, true);
  const id = added.result.addedBotId;
  assert.equal(shared.config.bots[0].companionId, ''); assert.equal(shared.config.bots[0].enabled, false);
  assert.equal((await first.ui('begin_login', { id })).ok, true);
  const login = await first.ui('check_login', { id }); assert.equal(login.ok, true); assert.equal(login.result.status, 'paused');
  assert.ok(shared.file); assert.equal(first.dispatches.length, 0); first.manager.close();
  const second = makeHost(shared), resumed = await second.ui('list_bindings');
  assert.equal(resumed.result.runtime.bots[0].connected, true); assert.equal(second.qrCalls, 0);
  const ready = await second.ui('upsert_binding', { id, name: '家人的助理', companion_id: 'buddy-a', enabled: true });
  assert.equal(ready.ok, true); assert.equal(ready.result.runtime.bots[0].status, 'connected');
  assert.equal(shared.config.bots[0].companionId, 'buddy-a'); assert.equal(second.qrCalls, 0); second.manager.close();
  const third = makeHost(shared), restored = await third.ui('list_bindings');
  assert.equal(restored.result.runtime.bots[0].status, 'connected'); assert.equal(third.qrCalls, 0);
  const state = third.manager.bot(id);
  third.manager.ingest(state, state.generation, { message_id: 1, message_type: 1, from_user_id: 'family', context_token: 'private-context', item_list: [{ type: 1, text_item: { text: '你好' } }] });
  await third.drainEvents(); assert.equal(third.dispatches[0].target.id, 'buddy-a'); third.manager.close();
});
test('UI creates distinct drafts and names, and cancels one without removing another Bot', async () => {
  const shared = { config: { bots: [] }, key: null, file: null }, host = makeHost(shared);
  const first = await host.ui('add_bot'), second = await host.ui('add_bot');
  assert.equal(second.ok, true); assert.notEqual(first.result.addedBotId, second.result.addedBotId);
  assert.deepEqual(shared.config.bots.map(bot => bot.name), ['微信 Bot 1', '微信 Bot 2']);
  await host.ui('begin_login', { id: first.result.addedBotId });
  await host.ui('cancel_login', { id: first.result.addedBotId });
  const removed = await host.ui('delete_binding', { id: first.result.addedBotId }); assert.equal(removed.ok, true);
  assert.equal(shared.config.bots.length, 1); assert.equal(shared.config.bots[0].id, second.result.addedBotId); host.manager.close();
});
test('packaged main follows Host vault/fs/Node contracts and restores login across fresh runtimes', async () => {
  const shared = { config: { bots: [binding] }, key: null, file: null };
  const first = makeHost(shared); assert.equal((await first.tool('list_bindings')).ok, true);
  assert.equal((await first.tool('begin_login', { id: 'a' })).ok, true);
  const login = await first.tool('check_login', { id: 'a' }); assert.equal(login.ok, true);
  assert.equal(login.result.connected, true); assert.ok(shared.file); assert.ok(shared.key);
  assert.equal(shared.file.includes('private-token-test'), false); assert.equal(JSON.stringify(login).includes('private-token-test'), false);
  first.manager.close();
  const second = makeHost(shared), restored = await second.tool('list_bindings');
  assert.equal(restored.ok, true); assert.equal(restored.result.runtime.bots[0].connected, true);
  assert.equal(restored.result.runtime.credentialStorage, 'sealed'); assert.equal(second.qrCalls, 0);
  const disconnected = await second.tool('disconnect_bot', { id: 'a' }); assert.equal(disconnected.ok, true); assert.equal(shared.file, null); second.manager.close();
});

test('packaged main uses bounded chunks for 5 MiB incoming/outgoing image bytes and enforces Host RPC limits', async () => {
  const imageBytes = Buffer.alloc(5 * 1024 * 1024); Buffer.from([137,80,78,71,13,10,26,10]).copy(imageBytes);
  const imageBase64 = imageBytes.toString('base64'), hash = 'a'.repeat(64);
  const shared = { config: { bots: [{ ...binding, enabled: true }] }, key: null, file: null, imageBase64, grants: { [`/media/${hash}.png`]: imageBase64 } };
  const host = makeHost(shared); await host.tool('list_bindings'); await host.tool('begin_login', { id: 'a' }); await host.tool('check_login', { id: 'a' });
  const state = host.manager.bot('a');
  const event = host.manager.ingest(state, state.generation, { message_id: 10, message_type: 1, from_user_id: 'original-peer', context_token: 'private-context',
    item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'private-download-query' }, aeskey: 'a'.repeat(32) } }] }, false);
  host.manager.notifyInbound(await host.manager.prepareInbound(event)); await host.drainEvents();
  assert.equal(host.dispatches.length, 1); assert.equal(host.dispatches[0].target.id, 'buddy-a'); assert.equal(host.dispatches[0].attachments[0].base64, imageBase64);
  assert.equal(JSON.stringify(host.dispatches).includes('private-download-query'), false);
  const args = { request_id: event.requestId, attachments: [hash], session_context: { session_id: 'wrong' } };
  const wrong = await host.tool('reply_to_wechat', args); assert.equal(wrong.ok, false); assert.equal(wrong.errorCode, 'WRONG_COMPANION'); assert.equal(shared.mediaReads ?? 0, 0);
  args.session_context.session_id = 'session-a';
  const reply = await host.tool('reply_to_wechat', args); assert.equal(reply.ok, true); assert.equal(reply.result.images, 1);
  await host.tool('reply_to_wechat', args);
  assert.equal(host.deliveries.filter(item => item.kind === 'image').length, 1); assert.equal(shared.mediaReads, 1);
  const image = host.deliveries.find(item => item.kind === 'image'); assert.equal(image.peerId, 'original-peer'); assert.equal(image.contextToken, 'private-context');
  assert.equal(JSON.stringify(reply).includes('private-context'), false); host.manager.close();
});
test('packaged main keeps configuration usable if saved login is corrupt', async () => {
  const shared = { config: { bots: [binding] }, key: Buffer.alloc(32, 7).toString('base64'), file: '{"invalid":true}' };
  const host = makeHost(shared), result = await host.tool('list_bindings');
  assert.equal(result.ok, true); assert.equal(result.result.recoveryError.code, 'STATE_CORRUPT');
  const removed = await host.tool('delete_binding', { id: 'a' }); assert.equal(removed.ok, true); assert.equal(shared.file, null); host.manager.close();
});
test('updating an existing binding without enabled keeps its activation', async () => {
  const shared = { config: { bots: [{ ...binding, enabled: true }] }, key: null, file: null };
  const host = makeHost(shared), result = await host.tool('upsert_binding', { id: 'a', name: 'Renamed', companion_id: 'buddy-a' });
  assert.equal(result.ok, true); assert.equal(shared.config.bots[0].enabled, true); host.manager.close();
});
test('failed durable disconnect rolls back immediately and clearly preserves the original login', async () => {
  const shared = { config: { bots: [binding] }, key: null, file: null };
  const host = makeHost(shared); await host.tool('begin_login', { id: 'a' }); await host.tool('check_login', { id: 'a' });
  const saved = shared.file; shared.failDelete = true;
  const result = await host.tool('disconnect_bot', { id: 'a' });
  assert.equal(result.ok, false); assert.equal(result.errorCode, 'PERSISTENCE_FAILED');
  assert.match(result.message, /断开未完成.*当前连接仍保留.*保存文件可能受损.*检查登录状态/);
  assert.equal(host.manager.status().bots[0].connected, true); assert.equal(shared.file, saved); host.manager.close();
  const restarted = makeHost(shared); assert.equal((await restarted.tool('list_bindings')).result.runtime.bots[0].connected, true); restarted.manager.close();
});
test('starting and cancelling a replacement QR preserves the old saved login', async () => {
  const shared = { config: { bots: [binding] }, key: null, file: null };
  const host = makeHost(shared); await host.tool('begin_login', { id: 'a' }); await host.tool('check_login', { id: 'a' });
  const saved = shared.file; await host.tool('begin_login', { id: 'a' });
  assert.equal(shared.file, saved); assert.equal(host.manager.status().bots[0].connected, true);
  assert.equal((await host.tool('cancel_login', { id: 'a' })).ok, true);
  assert.equal(shared.file, saved); assert.equal(host.manager.status().bots[0].connected, true); host.manager.close();
});
test('config edits remain successful with a recovery warning when saved login is corrupt', async () => {
  const shared = { config: { bots: [binding] }, key: Buffer.alloc(32, 4).toString('base64'), file: '{"invalid":true}' };
  const host = makeHost(shared); const result = await host.tool('upsert_binding', { id: 'a', name: 'Edited', companion_id: 'buddy-a', enabled: false });
  assert.equal(result.ok, true); assert.equal(result.result.recoveryError.code, 'STATE_CORRUPT');
  assert.equal(shared.config.bots[0].name, 'Edited'); host.manager.close();
});
test('late events from another Node instance cannot dispatch or overwrite saved data', async () => {
  const shared = { config: { bots: [{ ...binding, enabled: true }] }, key: null, file: null };
  const host = makeHost(shared); await host.tool('list_bindings');
  await host.event('wechat/inbound', { instanceId: 'old-instance', requestId: 'late', botConfigId: 'a', generation: 1, text: 'must not dispatch' });
  await host.event('wechat/state-changed', { instanceId: 'old-instance', checkpointId: 'old-checkpoint' });
  assert.equal(host.dispatches.length, 0); assert.equal(shared.file, null); host.manager.close();
});

test('packaged main polls and clears browser timers while replying to consecutive WeChat requests', async () => {
  const shared = { config: { bots: [{ ...binding, enabled: true }] }, key: null, file: null };
  const host = makeHost(shared);
  try {
    await host.tool('list_bindings'); await host.tool('begin_login', { id: 'a' }); await host.tool('check_login', { id: 'a' });
    const state = host.manager.bot('a');
    for (const messageId of [201, 202]) {
      const event = host.manager.ingest(state, state.generation, { message_id: messageId, message_type: 1, from_user_id: 'wechat-peer', context_token: 'private-context',
        item_list: [{ type: 1, text_item: { text: 'hi' } }] }, false);
      host.manager.notifyInbound(await host.manager.prepareInbound(event)); await host.drainEvents();
      assert.equal(host.dispatches.length, messageId - 200);
      assert.equal(host.timers.length, 1, 'accepted input keeps its completion poll');
      assert.equal(state.stats.rejected, 0);
      await host.tickReceipt();
      assert.equal(host.receiptQueries.at(-1), `wx-${event.requestId}`);
      assert.equal(host.timers.length, 1, 'unfinished input schedules the next poll');
      const args = { request_id: event.requestId, text: `reply-${messageId}`, session_context: { session_id: 'session-a' } };
      assert.equal((await host.tool('reply_to_wechat', args)).ok, true);
      assert.equal(host.timers.length, 0, 'reply cancels its completion poll');
      assert.equal((await host.tool('reply_to_wechat', args)).ok, true);
      assert.equal(state.stats.delivered, messageId - 200);
      assert.equal(state.stats.rejected, 0);
    }
    assert.equal(host.deliveries.length, 2, 'repeated replies are not sent again');
    assert.ok(host.deliveries.every(item => item.peerId === 'wechat-peer'));
  } finally { host.manager.close(); }
});

test('packaged main forwards pure text, closes settled input and never mirrors desktop output to WeChat', async () => {
  const shared = { config: { bots: [{ ...binding, enabled: true }] }, key: null, file: null };
  const host = makeHost(shared); await host.tool('list_bindings'); await host.tool('begin_login', { id: 'a' }); await host.tool('check_login', { id: 'a' });
  const state = host.manager.bot('a');
  const event = host.manager.ingest(state, state.generation, { message_id: 101, message_type: 1, from_user_id: 'wechat-peer', context_token: 'private-context',
    item_list: [{ type: 1, text_item: { text: '微信原文' } }] }, false);
  host.manager.notifyInbound(await host.manager.prepareInbound(event));
  await host.drainEvents();
  assert.equal(host.dispatches[0].text, '微信原文'); assert.equal('context' in host.dispatches[0], false);
  const wrong = await host.tool('reply_to_wechat', { request_id: event.requestId, text: 'wrong', session_context: { session_id: 'desktop-other' } });
  assert.equal(wrong.errorCode, 'WRONG_COMPANION');
  await host.hostMessage({ type: 'event', name: 'will-assistant-message', sessionId: 'session-a', text: 'private desktop answer' });
  await host.hostMessage({ type: 'event', name: 'did-turn-complete', sessionId: 'session-a', text: 'private desktop answer' });
  assert.equal(host.deliveries.length, 0);
  shared.settled = true; await host.tickReceipt();
  assert.deepEqual(host.receiptQueries, [`wx-${event.requestId}`]);
  assert.equal(host.manager.requests.get(event.requestId).state, 'rejected');
  const late = await host.tool('reply_to_wechat', { request_id: event.requestId, text: 'private desktop answer', session_context: { session_id: 'session-a' } });
  assert.equal(late.ok, false); assert.equal(late.errorCode, 'REQUEST_SETTLED');
  assert.equal(host.deliveries.length, 0); host.manager.close();
});

test('packaged main keeps pure text and explicit-ID compatibility without optional messageContext capability', async () => {
  const shared = { config: { bots: [{ ...binding, enabled: true }] }, key: null, file: null, messageContext: false, receiptQuery: false };
  const host = makeHost(shared); await host.tool('list_bindings'); await host.tool('begin_login', { id: 'a' }); await host.tool('check_login', { id: 'a' });
  const state = host.manager.bot('a');
  const event = host.manager.ingest(state, state.generation, { message_id: 102, message_type: 1, from_user_id: 'wechat-peer', context_token: 'private-context',
    item_list: [{ type: 1, text_item: { text: '旧宿主消息' } }] }, false);
  host.manager.notifyInbound(await host.manager.prepareInbound(event));
  await host.drainEvents();
  assert.equal('context' in host.dispatches[0], false); assert.equal(host.dispatches[0].text, '旧宿主消息');
  assert.equal(host.timers.length, 0);
  const args = { request_id: event.requestId, text: '仅本次回答', session_context: { session_id: 'session-a' } };
  assert.equal((await host.tool('reply_to_wechat', args)).ok, true); assert.equal((await host.tool('reply_to_wechat', args)).ok, true);
  assert.equal(host.deliveries.length, 1); assert.equal(host.deliveries[0].peerId, 'wechat-peer'); host.manager.close();
});

test('terminal request errors pass through Node status to Bot cards without presenting a connection or QR failure', async () => {
  const cases = [
    [{ outcome: 'completed' }, 'COMPLETED_WITHOUT_REPLY', '已完成处理'],
    [{ outcome: 'failed' }, 'FAILED_WITHOUT_REPLY', '处理失败'],
    [{ outcome: 'cancelled' }, 'CANCELLED_WITHOUT_REPLY', '处理已取消'],
    [{ outcome: 'interrupted' }, 'INTERRUPTED_WITHOUT_REPLY', '处理被中断'],
    [undefined, 'ENDED_WITHOUT_REPLY', '已结束本次处理'],
    [{ outcome: 'future-outcome' }, 'ENDED_WITHOUT_REPLY', '已结束本次处理'],
  ];
  for (const [terminalResult, code, expected] of cases) {
    const shared = { config: { bots: [{ ...binding, enabled: true }] }, key: null, file: null, terminalResult, settled: true };
    const host = makeHost(shared); await host.tool('list_bindings'); await host.tool('begin_login', { id: 'a' }); await host.tool('check_login', { id: 'a' });
    try {
      const state = host.manager.bot('a');
      const event = host.manager.ingest(state, state.generation, { message_id: 103, message_type: 1, from_user_id: 'wechat-peer', context_token: 'private-context',
        item_list: [{ type: 1, text_item: { text: '请求正文' } }] }, false);
      host.manager.notifyInbound(await host.manager.prepareInbound(event)); await host.drainEvents(); await host.tickReceipt();
      const snapshot = (await host.ui('list_bindings')).result, bot = snapshot.runtime.bots[0];
      assert.equal(bot.lastErrorCode, code); assert.equal(bot.status, 'connected'); assert.equal(bot.connected, true);
      assert.equal(bot.stats.rejected, 1); assert.equal(bot.stats.delivered, 0); assert.equal(host.deliveries.length, 0);
      const card = renderSettings(snapshot);
      assert.equal(card.status, '聊天中'); assert.ok(card.error.startsWith('最近微信请求：'));
      assert.ok(card.error.includes(expected)); assert.ok(card.error.includes('未回传答案'));
      assert.doesNotMatch(card.error, /连接异常|重新扫码/);
      if (code !== 'COMPLETED_WITHOUT_REPLY') assert.doesNotMatch(card.error, /已完成/);
      for (const errorCode of ['REQUEST_EXPIRED', 'REQUEST_SETTLED']) {
        bot.lastErrorCode = errorCode; const late = renderSettings(snapshot);
        assert.equal(late.status, '聊天中'); assert.ok(late.error.includes('最近微信请求：'));
        assert.doesNotMatch(late.error, /连接异常|重新扫码/);
      }
    } finally { host.manager.close(); }
  }
});

test('existing bindings get an explicit one-time guide; guide confirmation cannot send WeChat and restart does not resend it', async () => {
  const shared = { config: { bots: [{ ...binding, enabled: true }] }, legacyGuides: true, guideSettled: false, key: null, file: null };
  const host = makeHost(shared); const initial = await host.ui('list_bindings');
  assert.equal(initial.result.bindingGuides[0].state, 'required'); assert.equal(host.guideDispatches.length, 0);
  await host.tool('begin_login', { id: 'a' }); await host.tool('check_login', { id: 'a' });
  await host.ui('prepare_binding', { id: 'a' }); assert.equal(host.guideDispatches.length, 1);
  const confirmation = await host.tool('reply_to_wechat', { text: 'remembered', session_context: { session_id: 'session-a' } });
  assert.equal(confirmation.errorCode, 'NO_CURRENT_REQUEST'); assert.equal(host.deliveries.length, 0);
  await host.ui('upsert_binding', { id: 'a', name: 'Renamed', companion_id: 'buddy-a', enabled: true }); assert.equal(host.guideDispatches.length, 1);
  const firstState = host.manager.bot('a');
  const waiting = host.manager.ingest(firstState, firstState.generation, { message_id: 119, message_type: 1, from_user_id: 'wechat-peer', context_token: 'private-context',
    item_list: [{ type: 1, text_item: { text: '说明处理中收到的原文' } }] }, false);
  host.manager.notifyInbound(await host.manager.prepareInbound(waiting)); const draining = host.drainEvents();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(host.dispatches.length, 0);
  shared.guideSettled = true; await host.tickReceipt(); await draining;
  assert.equal(host.dispatches[0].text, '说明处理中收到的原文'); assert.equal('context' in host.dispatches[0], false);
  assert.equal((await host.tool('reply_to_wechat', { text: '等待后的本次回答', session_context: { session_id: 'session-a' } })).ok, true);
  host.manager.close();
  const restarted = makeHost(shared); const restored = await restarted.ui('list_bindings');
  assert.equal(restored.result.bindingGuides[0].state, 'ready'); assert.equal(restarted.guideDispatches.length, 0);
  const state = restarted.manager.bot('a');
  const event = restarted.manager.ingest(state, state.generation, { message_id: 120, message_type: 1, from_user_id: 'wechat-peer', context_token: 'private-context',
    item_list: [{ type: 1, text_item: { text: '只显示用户原文' } }] }, false);
  restarted.manager.notifyInbound(await restarted.manager.prepareInbound(event)); await restarted.drainEvents();
  assert.equal(restarted.dispatches.length, 1); assert.equal(restarted.dispatches[0].text, '只显示用户原文');
  assert.equal('context' in restarted.dispatches[0], false);
  const answer = await restarted.tool('reply_to_wechat', { text: '仅本次回答', session_context: { session_id: 'session-a' } });
  assert.equal(answer.ok, true); assert.equal(restarted.deliveries[0].peerId, 'wechat-peer');
  assert.equal(restarted.deliveries.length, 1); restarted.manager.close();
});
