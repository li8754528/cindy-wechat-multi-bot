import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { ReplyRouter } from '../src/core.mjs';
import { replyWithImages } from '../src/transfer.mjs';
const require = createRequire(import.meta.url);
const { BotManager } = require('../src/worker.cjs');
const { openState, sealState } = require('../src/state.cjs');
const bots = ['a', 'b'].map(id => ({ id, name: id, companionId: `buddy-${id}`, enabled: true }));
const wire = (id, peer = 'peer-a', context = `secret-${peer}`) => ({ message_id: id, message_type: 1,
  from_user_id: peer, context_token: context, item_list: [{ type: 1, text_item: { text: '你好' } }] });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYv0AAAAASUVORK5CYII=';
function fixture({ failSend = false, readImages } = {}) {
  const deliveries = [], prepared = [], events = [];
  const client = { send: async req => { deliveries.push(req); if (failSend) throw new Error('timeout'); },
    uploadImage: async (peerId, bytes) => { deliveries.push({ upload: true, peerId, bytes }); return { uploaded: true }; },
    sendImage: async req => deliveries.push({ image: true, ...req }) };
  const manager = new BotManager({ notify: (method, params) => events.push({ method, params }), clientFactory: () => client });
  manager.configure(bots);
  for (const state of manager.bots.values()) { state.client = client; state.status = 'connected'; }
  const node = async (method, args) => {
    if (method === 'reply') return manager.reply(args);
    if (method === 'reply/images/begin') return manager.stageBegin(args);
    if (method === 'reply/images/chunk') return manager.stageChunk(args);
    if (method === 'reply/images/clear') return manager.clearStaged(manager.stagedEntry(args));
    if (method === 'reject') return manager.reject(args.requestId, args.code);
    throw new Error(method);
  };
  const router = new ReplyRouter({ readImages: readImages ?? (async () => [png]),
    nodeReply: (params, context) => replyWithImages(node, params, context) });
  router.setConfig({ bots });
  for (const bot of bots) router.bindSession(bot.id, bot.companionId, `session-${bot.id}`);
  const prepare = args => { prepared.push(args); return manager.prepareSend(args); };
  const send = (args, sessionId = 'session-a', callId = randomUUID()) => router.send(args, sessionId, { callId }, prepare);
  return { manager, router, deliveries, prepared, events, send };
}
test('proactive send needs no active request and uses the latest known context for each Bot', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  f.manager.ingest(f.manager.bot('a'), 1, wire(1, 'old-peer'));
  f.manager.ingest(f.manager.bot('a'), 1, wire(2, 'new-peer', 'new-context'));
  f.manager.ingest(f.manager.bot('b'), 1, wire(3, 'peer-b'));
  f.manager.requests.clear();
  const result = await f.send({ text: '主动通知' });
  assert.equal(result.delivered, true); assert.equal(result.peerId, 'new-peer');
  await f.send({ text: '指定已有联系人', peer_id: 'old-peer' });
  await f.send({ text: 'B 通知' }, 'session-b');
  assert.deepEqual(f.deliveries.map(req => [req.peerId, req.contextToken]),
    [['new-peer', 'new-context'], ['old-peer', 'secret-old-peer'], ['peer-b', 'secret-peer-b']]);
  assert.equal(f.router.current.size, 0);
  assert.ok(!JSON.stringify(f.manager.status()).includes('secret-'));
  assert.ok(!JSON.stringify(f.prepared).includes('contextToken'));
});
test('missing/unknown peer, paused Bot and another companion binding cannot send', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  await assert.rejects(f.send({ text: 'no peer' }), { code: 'WECHAT_PEER_NOT_KNOWN' });
  f.manager.ingest(f.manager.bot('a'), 1, wire(1));
  await assert.rejects(f.send({ text: 'unknown', peer_id: 'stranger' }), { code: 'WECHAT_PEER_NOT_KNOWN' });
  await assert.rejects(f.send({ id: 'b', text: 'cross bot' }), { code: 'WRONG_COMPANION' });
  await assert.rejects(f.send({ text: 'desktop' }, 'desktop-session'), { code: 'BOT_NOT_AVAILABLE' });
  await f.send({ id: 'a', text: 'desktop notification' }, 'desktop-session');
  f.manager.configure([{ ...bots[0], enabled: false }, bots[1]]);
  await assert.rejects(f.send({ text: 'paused' }), { code: 'BOT_NOT_AVAILABLE' });
  assert.equal(f.deliveries.length, 1);
});
test('same call is sent once, cannot switch content and does not retry uncertain delivery', async t => {
  for (const failSend of [false, true]) {
    const f = fixture({ failSend }); t.after(() => f.manager.close());
    f.manager.ingest(f.manager.bot('a'), 1, wire(1));
    const attempt = () => f.send({ text: 'once' }, 'session-a', 'same-call');
    if (failSend) {
      await assert.rejects(attempt(), { code: 'DELIVERY_UNCERTAIN' });
      await assert.rejects(attempt(), { code: 'DELIVERY_UNCERTAIN' });
    } else await Promise.all([attempt(), attempt()]);
    await assert.rejects(f.send({ text: 'different' }, 'session-a', 'same-call'), { code: 'REPLY_CONFLICT' });
    assert.equal(f.deliveries.length, 1); assert.equal(f.prepared.length, 1);
  }
});
test('images use the original selected peer even when a newer message arrives during attachment reading', async t => {
  let f; f = fixture({ readImages: async () => {
    f.manager.ingest(f.manager.bot('a'), 1, wire(2, 'new-peer')); return [png];
  } }); t.after(() => f.manager.close());
  f.manager.ingest(f.manager.bot('a'), 1, wire(1, 'original-peer'));
  const result = await f.send({ attachments: ['f'.repeat(64)] });
  assert.equal(result.images, 1); assert.equal(result.peerId, 'original-peer');
  assert.deepEqual(f.deliveries.map(item => item.peerId), ['original-peer', 'original-peer']);
  assert.equal(f.manager.pendingImageBytes, 0);
});
test('proactive sending neither consumes nor changes the inbound request', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  const event = f.manager.ingest(f.manager.bot('a'), 1, wire(1));
  await f.send({ text: 'notification' });
  assert.equal(f.manager.requests.get(event.requestId).state, 'pending');
  await f.manager.reply({ ...event, text: 'answer' });
  assert.deepEqual(f.deliveries.map(item => item.text), ['notification', 'answer']);
});
test('peer contexts are encrypted, restored across restart and cleared by rebind/disconnect', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  const state = f.manager.bot('a');
  state.credentials = { token: 'private-token', botId: 'wx-a', userId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com' };
  f.manager.initializeEmpty(); f.manager.ingest(state, 1, wire(1, 'peer-a', 'secret-context'));
  const key = randomBytes(32).toString('base64'), { envelope } = f.manager.seal(key);
  assert.ok(!JSON.stringify(envelope).includes('secret-context'));
  const after = new BotManager({ clientFactory: () => state.client }); t.after(() => after.close());
  after.configure(bots.map(bot => ({ ...bot, enabled: false }))); after.load(envelope, key);
  assert.equal(after.bot('a').peers.get('peer-a').contextToken, 'secret-context');
  after.configure(bots.map(bot => ({ ...bot, enabled: false, companionId: `new-${bot.id}` })));
  assert.equal(after.bot('a').peers.size, 0);
  f.manager.disconnect('a'); assert.equal(state.peers.size, 0);
  const legacy = openState(envelope, key); delete legacy[0].peers;
  assert.equal(openState(sealState(legacy, key), key)[0].peers, undefined);
  const invalid = structuredClone(openState(envelope, key)); invalid[0].peers[0].contextToken = '';
  assert.throws(() => openState(sealState(invalid, key), key), { code: 'STATE_CORRUPT' });
});
test('confirmed login retains peers for the same account and clears them for a different account', async t => {
  for (const sameAccount of [true, false]) {
    const f = fixture(); t.after(() => f.manager.close());
    const state = f.manager.bot('a');
    f.manager.ingest(state, state.generation, wire(1));
    state.credentials = { token: 'old-token', botId: 'wx-old', userId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com' };
    f.manager.configure(bots.map(bot => ({ ...bot, enabled: false })));
    state.authAbort = new AbortController();
    state.auth = { createdAt: Date.now(), qrCode: 'test', client: { pollQr: async () => ({ status: 'confirmed',
      bot_token: 'new-token', ilink_bot_id: sameAccount ? 'wx-old' : 'wx-new',
      ilink_user_id: 'owner', baseurl: 'https://ilinkai.weixin.qq.com' }) } };
    await f.manager.checkAuth('a');
    assert.equal(state.peers.size, sameAccount ? 1 : 0);
  }
});
test('a binding change while reading proactive images prevents sending', async t => {
  let f; f = fixture({ readImages: async () => {
    const replacement = [{ ...bots[0], companionId: 'new-buddy' }, bots[1]];
    f.router.setConfig({ bots: replacement }); f.manager.configure(replacement); return [png];
  } }); t.after(() => f.manager.close());
  f.manager.ingest(f.manager.bot('a'), 1, wire(1));
  await assert.rejects(f.send({ attachments: ['f'.repeat(64)] }), { code: 'BINDING_CHANGED' });
  assert.equal(f.deliveries.length, 0); assert.equal(f.manager.bot('a').peers.size, 0);
});
