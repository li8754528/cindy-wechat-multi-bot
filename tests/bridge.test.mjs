import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ReplyRouter, validateConfig } from '../src/core.mjs';
const require = createRequire(import.meta.url);
const { BotManager } = require('../src/worker.cjs');
const { IlinkClient, tencentUrl, decodeMessage } = require('../src/ilink.cjs');
const bot = (id = 'a', companionId = 'buddy-a') => ({ id, name: id, companionId, enabled: true });
const wire = (id, peer = 'peer-a', text = '你好') => ({ message_id: id, message_type: 1, from_user_id: peer, context_token: `private-context-${peer}`, item_list: [{ type: 1, text_item: { text } }] });
const inbound = (requestId, botConfigId = 'a') => ({ requestId, botConfigId, generation: 1, text: '你好' });
function routerFixture({ execution = true } = {}) {
  const sends = [], replies = [], rejected = [];
  const router = new ReplyRouter({ targets: {
    capabilities: async () => ({ delegation: { execution } }), resolve: async ({ target }) => target,
    send: async req => { sends.push(req); return { accepted: true, taskId: `session-${req.target.id}`, delivery: 'queue' }; },
  }, nodeReply: async req => { replies.push(req); return { delivered: true }; }, rejectInbound: async (...args) => rejected.push(args) });
  router.setConfig(validateConfig({ bots: [bot(), bot('b', 'buddy-b')] }));
  return { router, sends, replies, rejected };
}
test('configuration persists multiple one-to-one bindings and strips credentials', () => {
  const config = validateConfig({ bots: [{ ...bot(), token: 'not-persisted' }, bot('b', 'buddy-b')] });
  assert.equal(config.bots.length, 2); assert.equal('token' in config.bots[0], false);
  assert.throws(() => validateConfig({ bots: [bot(), bot('b')] }), { code: 'DUPLICATE_BINDING' });
  assert.throws(() => validateConfig({ bots: [bot(), bot('a', 'buddy-b')] }), { code: 'DUPLICATE_BINDING' });
});
test('two Bots dispatch to their respective companions without sharing replies', async () => {
  const { router, sends, replies } = routerFixture();
  await router.receive(inbound('request-a')); await router.receive(inbound('request-b', 'b'));
  assert.deepEqual(sends.map(req => req.target.id), ['buddy-a', 'buddy-b']);
  assert.ok(sends.every(req => req.delegation.task && req.delivery === 'queue'));
  await assert.rejects(router.reply('request-a', 'hello', 'session-buddy-b'), { code: 'WRONG_COMPANION' });
  await assert.rejects(router.reply('request-a', 'hello', undefined), { code: 'WRONG_COMPANION' });
  assert.equal(replies.length, 0);
  await router.reply('request-a', '答复 A', 'session-buddy-a'); await router.reply('request-b', '答复 B', 'session-buddy-b');
  assert.deepEqual(replies.map(req => req.requestId), ['request-a', 'request-b']);
});
test('duplicate inbound/reply calls are idempotent and conflicting answers rejected', async () => {
  const { router, sends, replies } = routerFixture();
  await router.receive(inbound('request-a')); await router.receive(inbound('request-a'));
  await Promise.all([router.reply('request-a', 'hello', 'session-buddy-a'), router.reply('request-a', 'hello', 'session-buddy-a')]);
  assert.equal(sends.length, 1); assert.equal(replies.length, 1);
  await assert.rejects(router.reply('request-a', 'different', 'session-buddy-a'), { code: 'REPLY_CONFLICT' });
});
test('rebinding and disabling invalidate old replies', async () => {
  const { router, replies } = routerFixture(); await router.receive(inbound('request-a'));
  router.setConfig(validateConfig({ bots: [bot('a', 'new-buddy')] }));
  await assert.rejects(router.reply('request-a', 'hello', 'session-buddy-a'), { code: 'BINDING_CHANGED' });
  assert.equal(replies.length, 0);
});
test('missing delegation execution fails closed without fallback dispatch', async () => {
  const { router, sends, rejected } = routerFixture({ execution: false });
  await router.receive(inbound('request-a')); assert.equal(sends.length, 0);
  assert.deepEqual(rejected, [['request-a', 'UNSUPPORTED_CAPABILITY']]);
});
function managerFixture({ failSend = false } = {}) {
  const notifications = [], sends = [];
  const manager = new BotManager({ notify: (method, params) => notifications.push({ method, params }) });
  manager.configure([bot(), bot('b', 'buddy-b')]);
  for (const state of manager.bots.values()) {
    state.client = { send: async req => { sends.push(req); if (failSend) throw new Error('simulated timeout'); } };
    state.status = 'connected';
  }
  return { manager, notifications, sends };
}
test('Node retains original peer/context and exposes no credentials in inbound events/status', async () => {
  const { manager, notifications, sends } = managerFixture();
  const a = manager.bot('a'), b = manager.bot('b');
  manager.ingest(a, a.generation, wire(1, 'peer-a')); manager.ingest(b, b.generation, wire(1, 'peer-b'));
  manager.ingest(a, a.generation, wire(1, 'peer-a')); assert.equal(notifications.length, 2);
  assert.equal(JSON.stringify(notifications).includes('private-context'), false);
  for (const { params } of notifications) await manager.reply({ ...params, text: `answer-${params.botConfigId}` });
  assert.deepEqual(sends.map(req => [req.peerId, req.contextToken]), [['peer-a', 'private-context-peer-a'], ['peer-b', 'private-context-peer-b']]);
  assert.deepEqual(manager.status().bots.map(state => state.stats.delivered), [1, 1]); manager.close();
});
test('Node does not retry an uncertain send, including an identical later tool call', async () => {
  const { manager, notifications, sends } = managerFixture({ failSend: true });
  const state = manager.bot('a'); manager.ingest(state, state.generation, wire(1));
  const req = { ...notifications[0].params, text: 'answer' };
  await assert.rejects(manager.reply(req), { code: 'DELIVERY_UNCERTAIN' });
  await assert.rejects(manager.reply(req), { code: 'DELIVERY_UNCERTAIN' }); assert.equal(sends.length, 1);
  assert.equal(manager.status().bots[0].stats.delivered, 0); manager.close();
});
test('disconnecting one Bot cancels its old request but leaves other Bot live', async () => {
  const { manager, notifications, sends } = managerFixture();
  for (const id of ['a', 'b']) { const state = manager.bot(id); manager.ingest(state, state.generation, wire(1, `peer-${id}`)); }
  manager.disconnect('a');
  await assert.rejects(manager.reply({ ...notifications[0].params, text: 'a' }), { code: 'REQUEST_EXPIRED' });
  await manager.reply({ ...notifications[1].params, text: 'b' }); assert.equal(sends[0].peerId, 'peer-b'); manager.close();
});
test('media/oversized messages are not silently forwarded as incomplete text', () => {
  const { manager, notifications } = managerFixture(); const state = manager.bot('a');
  const media = wire(1); media.item_list.push({ type: 2, image_item: {} });
  manager.ingest(state, state.generation, media); manager.ingest(state, state.generation, wire(2, 'peer', 'x'.repeat(16001)));
  assert.equal(notifications.length, 0); assert.equal(state.stats.rejected, 2); manager.close();
});
test('iLink client produces authenticated wire requests and rejects unsafe credential origins', async () => {
  for (const url of ['http://ilinkai.weixin.qq.com', 'https://evil.example', 'https://weixin.qq.com.evil.example', 'https://u:p@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com/path']) assert.throws(() => tencentUrl(url, true));
  let sent; const client = new IlinkClient({ token: 'private-token', fetchImpl: async (url, init) => { sent = { url, init }; return new Response('{"ret":0}', { status: 200 }); } });
  await client.send({ peerId: 'peer', contextToken: 'private-context', clientId: 'uuid', text: '你好' });
  assert.equal(sent.url.pathname, '/ilink/bot/sendmessage'); assert.equal(sent.init.redirect, 'manual');
  assert.equal(sent.init.headers.Authorization, 'Bearer private-token');
  assert.equal(JSON.parse(sent.init.body).msg.context_token, 'private-context');
  assert.equal(decodeMessage({ ...wire(1), message_type: 2 }), null);
});
test('confirmed QR login keeps credentials exclusively inside Node', async () => {
  const credentials = { status: 'confirmed', bot_token: 'private-token', ilink_bot_id: 'wx-a', ilink_user_id: 'u-a', baseurl: 'https://ilinkai.weixin.qq.com' };
  const manager = new BotManager({ clientFactory: () => ({ begin: async () => ({ qrcode: 'qr-secret', qrcode_img_content: 'https://ilinkai.weixin.qq.com/scan?ticket=a' }), pollQr: async () => credentials }), encodeQr: async () => Buffer.from('png') });
  manager.configure([{ ...bot(), enabled: false }]); const begun = await manager.beginAuth('a');
  assert.equal(begun.status, 'waiting_scan'); assert.equal(JSON.stringify(begun).includes('qr-secret'), false);
  const result = await manager.checkAuth('a'); assert.equal(result.connected, true);
  assert.equal(result.status, 'paused'); assert.equal(JSON.stringify(result).includes('private-token'), false); manager.close();
});
