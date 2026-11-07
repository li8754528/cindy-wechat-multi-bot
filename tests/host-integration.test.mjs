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
  const handlers = [], results = [], dispatches = [], deliveries = [], notifications = []; let qrCalls = 0, sequence = 0;
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
    tasks: { capabilities: async () => ({ messageAttachments: { kinds: ['image'] } }) },
    targets: { capabilities: async () => ({ delegation: { execution: true } }), resolve: async ({ target }) => target, list: async () => ({ targets: [{ id: 'buddy-a', label: 'A' }] }),
      send: async req => { dispatches.push(req); return { accepted: true, taskId: 'session-a' }; } },
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
  runInNewContext(code(), { cindy, fetch: fetchImpl, crypto: webcrypto, btoa, AbortSignal, BroadcastChannel: class { postMessage() {} }, Uint8Array, console });
  return { manager, dispatches, deliveries, drainEvents: async () => { await Promise.all(notifications.splice(0)); }, event: async (method, params) => { for (const handler of handlers) await handler({ type: 'event', name: 'node-notification', method, params }); },
    get qrCalls() { return qrCalls; }, tool: async (tool, args = {}) => {
    const callId = `call-${sequence++}`; for (const handler of handlers) await handler({ type: 'tool-call', tool, args, callId });
    const response = results.find(result => result.callId === callId); assert.ok(response, 'tool receipt exists'); return response;
  } };
}
const binding = { id: 'a', name: 'A', companionId: 'buddy-a', enabled: false };
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
