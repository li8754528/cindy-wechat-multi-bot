import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { StateStore, ensureVault, unwrapNode } from '../src/persistence.mjs';
import { ReplyRouter } from '../src/core.mjs';
const require = createRequire(import.meta.url);
const { sealState, openState } = require('../src/state.cjs');
const { BotManager } = require('../src/worker.cjs');
const { IlinkClient } = require('../src/ilink.cjs');
const key = randomBytes(32).toString('base64');
const config = [{ id: 'a', name: 'A', companionId: 'buddy-a', enabled: false }, { id: 'b', name: 'B', companionId: 'buddy-b', enabled: false }];
const record = (id = 'a') => ({ id, companionId: `buddy-${id}`, credentials: { token: `private-token-${id}`, botId: `wx-${id}`, userId: `peer-${id}`, baseUrl: 'https://ilinkai.weixin.qq.com' }, cursor: `cursor-${id}`, seen: [`message:${id}`] });
test('a restarted worker cannot overwrite saved logins before state restoration', () => {
  const manager = new BotManager(); manager.configure(config);
  assert.throws(() => manager.seal(key), { code: 'STATE_NOT_READY' });
  manager.load(sealState([record()], key), key); assert.equal(manager.seal(key).hasCredentials, true); manager.close();
});
test('AES-GCM login snapshots protect plaintext and reject wrong keys/tampering', () => {
  const first = sealState([record()], key), second = sealState([record()], key);
  assert.equal(JSON.stringify(first).includes('private-token'), false); assert.notEqual(first.iv, second.iv);
  assert.deepEqual(openState(first, key), [record()]);
  assert.throws(() => openState(first, randomBytes(32).toString('base64')), { code: 'STATE_CORRUPT' });
  assert.throws(() => openState({ ...first, ciphertext: 'AAAA' }, key), { code: 'STATE_CORRUPT' });
});
test('new Node manager restores two Bot credentials/cursors without QR calls', () => {
  const calls = []; const make = opts => { calls.push(opts); return {}; };
  const before = new BotManager({ clientFactory: make }); before.configure(config); before.initializeEmpty();
  for (const row of [record('a'), record('b')]) { const state = before.bot(row.id); state.credentials = row.credentials; state.cursor = row.cursor; state.seen = new Set(row.seen); }
  const sealed = before.seal(key); before.close();
  const after = new BotManager({ clientFactory: make }); after.configure(config); after.load(sealed.envelope, key);
  assert.deepEqual(after.status().bots.map(bot => bot.connected), [true, true]);
  assert.equal(after.status().credentialStorage, 'sealed'); assert.equal(after.bot('b').cursor, 'cursor-b');
  assert.deepEqual([...after.bot('a').seen], ['message:a']); assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(after.status()).includes('private-token'), false);
  after.disconnect('a'); const persisted = after.seal(key); assert.deepEqual(openState(persisted.envelope, key).map(row => row.id), ['b']); after.close();
});
test('pause keeps saved login but removing a Bot removes it from the encrypted snapshot', () => {
  const manager = new BotManager({ clientFactory: () => ({}) }); manager.configure(config);
  manager.load(sealState([record('a'), record('b')], key), key);
  manager.configure([{ ...config[0], enabled: false }, config[1]]);
  assert.equal(manager.bot('a').credentials.token, 'private-token-a');
  manager.configure([config[1]]); assert.deepEqual(openState(manager.seal(key).envelope, key).map(row => row.id), ['b']); manager.close();
});
test('Host private-data storage sees only ciphertext and accepts explicit NOT_FOUND', async () => {
  const files = new Map(), requests = [];
  const store = new StateStore({ fs: async req => {
    requests.push(req);
    if (req.op === 'read') return files.has(req.path) ? { ok: true, content: files.get(req.path) } : { ok: false, errorCode: 'NOT_FOUND' };
    if (req.op === 'write') files.set(req.path, req.content);
    if (req.op === 'delete') files.delete(req.path); return { ok: true };
  }, node: async method => method === 'state/seal' ? { hasCredentials: true, envelope: sealState([record()], key) } : { saved: true } });
  assert.equal(await store.read(), null); await store.flush(); assert.equal(requests.every(req => req.root === 'data'), true);
  assert.equal([...files.values()].some(text => text.includes('private-token')), false);
  assert.deepEqual(openState(await store.read(), key), [record()]);
});
test('generated key goes only to the declared Host vault and is not replaced on restart', async () => {
  let saved = false; const writes = [];
  const fetchImpl = async (path, init) => {
    if (path === '/secrets') return new Response(JSON.stringify([{ key: 'wechat_vault_key', saved }]));
    writes.push({ path, init }); saved = true; return new Response(null, { status: 204 });
  };
  await ensureVault(fetchImpl, webcrypto); await ensureVault(fetchImpl, webcrypto);
  assert.equal(writes.length, 1); assert.equal(writes[0].path, '/secrets/wechat_vault_key');
  assert.equal(Buffer.from(JSON.parse(writes[0].init.body).value, 'base64').length, 32);
});
test('Node RPC errors preserve domain error and user recovery hint', () => {
  assert.throws(() => unwrapNode({ ok: false, errorCode: 'NODE_WORKER_ERROR', message: '发送结果不确定，请在微信检查，不能自动重发。', data: { code: 'DELIVERY_UNCERTAIN' } }),
    { code: 'DELIVERY_UNCERTAIN', message: '发送结果不确定，请在微信检查，不能自动重发。' });
  assert.throws(() => unwrapNode({ ok: false, errorCode: 'TIMEOUT', message: '主机调用超时。' }), { code: 'NODE_TIMEOUT' });
});
test('QR long-poll timeout remains waiting; cancellation is not swallowed', async () => {
  const client = new IlinkClient({ fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); } });
  assert.deepEqual(await client.pollQr('test-qr'), { status: 'wait' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.pollQr('test-qr', controller.signal), { code: 'CANCELLED' });
});
test('stop while waiting for QR does not leave a phantom waiting_scan state', async () => {
  const manager = new BotManager({ clientFactory: () => ({ begin: async () => ({ qrcode: 'test', qrcode_img_content: 'https://ilinkai.weixin.qq.com/scan' }) }), encodeQr: async () => Buffer.from('png') });
  manager.configure(config); await manager.beginAuth('a');
  manager.configure([{ ...config[0], enabled: true }, config[1]]);
  assert.equal((await manager.checkAuth('a')).status, 'disconnected'); manager.close();
});
test('same Bot dispatches one request at a time and rejects queued callback requests', async () => {
  const dispatches = [], replies = [];
  const router = new ReplyRouter({ targets: { capabilities: async () => ({ delegation: { execution: true } }), resolve: async () => ({}),
    send: async req => { dispatches.push(req); return { accepted: true, taskId: 'session-a' }; } }, nodeReply: async req => { replies.push(req); return { delivered: true }; }, rejectInbound: async () => {} });
  router.setConfig({ bots: [{ ...config[0], enabled: true }] });
  const input = requestId => ({ requestId, botConfigId: 'a', generation: 1, text: 'hello' });
  await router.receive(input('a')); await router.receive(input('b')); assert.equal(dispatches.length, 1);
  await assert.rejects(router.reply('b', 'wrong turn', 'session-a'), { code: 'REQUEST_NOT_CURRENT' });
  await router.reply('a', 'answer A', 'session-a'); await router.requests.get('b').accepted;
  assert.equal(dispatches.length, 2); await router.reply('b', 'answer B', 'session-a');
  assert.deepEqual(replies.map(req => req.requestId), ['a', 'b']);
  await assert.rejects(router.reply('a', 'leak B', 'session-a'), { code: 'REPLY_CONFLICT' });
});
test('unknown reply outcome keeps its error receipt but releases the lane for the next request', async () => {
  const dispatches = [];
  const router = new ReplyRouter({ targets: { capabilities: async () => ({ delegation: { execution: true } }), resolve: async () => ({}),
    send: async req => { dispatches.push(req); return { accepted: true, taskId: 'session-a' }; } },
    nodeReply: async () => { throw Object.assign(new Error('unknown'), { code: 'DELIVERY_UNCERTAIN' }); }, rejectInbound: async () => {} });
  router.setConfig({ bots: [{ ...config[0], enabled: true }] });
  const input = requestId => ({ requestId, botConfigId: 'a', generation: 1, text: 'hello' });
  await router.receive(input('a')); await router.receive(input('b'));
  await assert.rejects(router.reply('a', 'answer A', 'session-a'), { code: 'DELIVERY_UNCERTAIN' });
  await router.requests.get('b').accepted; assert.equal(dispatches.length, 2);
  await assert.rejects(router.reply('a', 'answer A', 'session-a'), { code: 'DELIVERY_UNCERTAIN' });
  assert.equal(dispatches.length, 2);
});
test('disconnect or generation change clears old lanes and refuses late old-generation input', async () => {
  const dispatches = [], rejected = [];
  const router = new ReplyRouter({ targets: { capabilities: async () => ({ delegation: { execution: true } }), resolve: async () => ({}),
    send: async req => { dispatches.push(req); return { accepted: true, taskId: 'session-a' }; } }, nodeReply: async () => ({}), rejectInbound: async (...args) => rejected.push(args) });
  router.setConfig({ bots: [{ ...config[0], enabled: true }] });
  const input = (requestId, generation) => ({ requestId, botConfigId: 'a', generation, text: 'hello' });
  await router.receive(input('old', 1)); router.cancelBot('a', 2);
  await router.receive(input('late', 1)); assert.equal(dispatches.length, 1); assert.deepEqual(rejected.at(-1), ['late', 'STALE_CONNECTION']);
  await router.receive(input('new', 3)); assert.equal(dispatches.length, 2);
  await assert.rejects(router.reply('old', 'old answer', 'session-a'), { code: 'REQUEST_EXPIRED' });
});
test('disconnect failure rolls back before the next queued snapshot can run', async () => {
  const manager = new BotManager({ clientFactory: () => ({}) }); manager.configure(config); manager.load(sealState([record('a'), record('b')], key), key);
  let saved = JSON.stringify(manager.seal(key).envelope), failFirst = true, queued;
  const store = new StateStore({ node: async (method, args = {}) => {
    if (method === 'disconnect/prepare') return manager.prepareDisconnect(args.id);
    if (method === 'disconnect/rollback') return manager.rollbackDisconnect(args.id);
    if (method === 'disconnect') return manager.disconnect(args.id);
    if (method === 'state/seal') return manager.seal(key);
    if (method === 'state/saved') return manager.saved();
  }, fs: async req => {
    if (failFirst) { failFirst = false; return { ok: false }; }
    if (req.op === 'write') saved = req.content; return { ok: true };
  } });
  await assert.rejects(store.disconnect('a', () => { queued = store.flush(); }), { code: 'PERSISTENCE_FAILED' });
  await queued; assert.deepEqual(openState(JSON.parse(saved), key).map(row => row.id), ['a', 'b']);
  assert.equal(manager.status().bots[0].connected, true); manager.close();
});
test('post-commit state notification failure does not roll back a completed disconnect', async () => {
  const manager = new BotManager({ clientFactory: () => ({}) }); manager.configure(config); manager.load(sealState([record('a'), record('b')], key), key);
  let saved; const store = new StateStore({ node: async (method, args = {}) => {
    if (method === 'disconnect/prepare') return manager.prepareDisconnect(args.id);
    if (method === 'disconnect/rollback') assert.fail('must not roll back a committed file');
    if (method === 'disconnect') return manager.disconnect(args.id);
    if (method === 'state/seal') return manager.seal(key);
    if (method === 'state/saved') throw new Error('lost post-commit ACK');
  }, fs: async req => { if (req.op === 'write') saved = req.content; return { ok: true }; } });
  const result = await store.disconnect('a', () => {}); assert.equal(result.connected, false);
  assert.equal(store.lastWarning, 'STATE_SYNC_FAILED'); assert.deepEqual(openState(JSON.parse(saved), key).map(row => row.id), ['b']);
  const checkpoint = await store.flush(); assert.equal(checkpoint.saved, true); manager.close();
});
test('removing and readding the same configuration id resets the generation fence', async () => {
  const sent = []; const router = new ReplyRouter({ targets: { capabilities: async () => ({ delegation: { execution: true } }), resolve: async () => ({}),
    send: async req => { sent.push(req); return { accepted: true, taskId: 'session-a' }; } }, nodeReply: async () => ({}), rejectInbound: async () => {} });
  const enabled = { ...config[0], enabled: true }; router.setConfig({ bots: [enabled] });
  await router.receive({ requestId: 'old', botConfigId: 'a', generation: 5, text: 'hello' });
  router.setConfig({ bots: [] }); router.setConfig({ bots: [enabled] });
  await router.receive({ requestId: 'new', botConfigId: 'a', generation: 1, text: 'hello' }); assert.equal(sent.length, 2);
});
test('a partial failed file write cannot claim reboot restoration is guaranteed', async () => {
  const manager = new BotManager({ clientFactory: () => ({}) }); manager.configure(config); manager.load(sealState([record('a'), record('b')], key), key);
  let file = JSON.stringify(manager.seal(key).envelope);
  const store = new StateStore({ node: async (method, args = {}) => {
    if (method === 'disconnect/prepare') return manager.prepareDisconnect(args.id);
    if (method === 'disconnect/rollback') return manager.rollbackDisconnect(args.id);
    if (method === 'state/seal') return manager.seal(key);
  }, fs: async req => { if (req.op === 'write') { file = req.content.slice(0, 20); return { ok: false }; } return { ok: true }; } });
  await assert.rejects(store.disconnect('a', () => {}), error => {
    assert.equal(error.code, 'PERSISTENCE_FAILED'); assert.match(error.message, /保存文件可能受损/); assert.doesNotMatch(error.message, /重启仍会恢复/); return true;
  });
  assert.equal(manager.status().bots[0].connected, true); assert.throws(() => JSON.parse(file)); manager.close();
});
