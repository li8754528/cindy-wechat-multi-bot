import test from 'node:test';
import assert from 'node:assert/strict';
import { BindingGuides, BINDING_GUIDE_TEXT } from '../src/binding-guides.mjs';
const bot = { id: 'a', name: 'A', companionId: 'buddy-a', enabled: true };
function fixture({ sendError = false, acceptedBeforeError = false, settled = true, outcome = 'completed' } = {}) {
  const sends = [], receipts = new Map(), binds = []; let saved = [], sequence = 0, guide;
  const targets = { capabilities: async () => ({ delegation: { receiptQuery: true, settled: true } }), resolve: async ({ target }) => target,
    send: async request => {
      sends.push(request);
      if (!sendError || acceptedBeforeError) receipts.set(request.requestKey, { found: true, requestKey: request.requestKey, target: request.target, taskId: 'session-a', settled, result: { outcome } });
      if (sendError) throw new Error('uncertain acknowledgement');
      return { accepted: true, taskId: 'session-a' };
    }, get: async ({ requestKey }) => receipts.get(requestKey) ?? { found: false } };
  const options = { targets, uuid: () => `test-${++sequence}`, persist: async () => { saved = JSON.parse(JSON.stringify(guide.serialize({ bots: [bot] }))); },
    wait: async () => { throw Object.assign(new Error('simulated guide wait timeout'), { code: 'GUIDE_PENDING' }); },
    bindSession: (...args) => binds.push(args) };
  guide = new BindingGuides(options);
  return { guide, targets, sends, receipts, binds, get saved() { return saved; }, restart: () => { guide = new BindingGuides(options); guide.load(saved, { bots: [bot] }); return guide; } };
}

test('binding guide is a separate source-aware configuration message, sent once across save and restart', async () => {
  const f = fixture(); await f.guide.prepare(bot); await f.guide.requireReady(bot); await f.guide.prepare({ ...bot, name: 'Renamed' });
  await f.restart().prepare(bot);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].text, BINDING_GUIDE_TEXT);
  assert.equal('context' in f.sends[0], false); assert.equal('delegation' in f.sends[0], false);
  assert.match(f.sends[0].text, /不是微信用户消息/); assert.match(f.sends[0].text, /不要对此说明调用 reply_to_wechat/);
  assert.ok(f.sends[0].text.includes('[消息来源]')); assert.match(f.sends[0].text, /可以省略 request_id/);
  assert.match(f.sends[0].text, /plugin_id/);
  assert.match(f.sends[0].text, /长期记忆/); assert.deepEqual(f.binds[0], ['a', 'buddy-a', 'session-a']);
});

test('legacy binding requires explicit preparation; rebind gets a distinct guide and incomplete guide cannot unlock WeChat', async () => {
  const f = fixture({ settled: false });
  await assert.rejects(f.guide.requireReady(bot), { code: 'GUIDE_REQUIRED' }); assert.equal(f.sends.length, 0);
  f.guide.assertIdle = () => { throw Object.assign(new Error('current WeChat request'), { code: 'GUIDE_BUSY' }); };
  await assert.rejects(f.guide.prepare(bot), { code: 'GUIDE_BUSY' }); assert.equal(f.sends.length, 0);
  f.guide.assertIdle = () => {};
  await f.guide.prepare(bot); await assert.rejects(f.guide.requireReady(bot), { code: 'GUIDE_PENDING' });
  await f.guide.prepare(bot); assert.equal(f.sends.length, 1);
  let waits = 0; f.guide.wait = async () => { waits++; f.receipts.get(f.sends[0].requestKey).settled = true; };
  await Promise.all([f.guide.requireReady(bot), f.guide.requireReady(bot)]); assert.equal(waits, 1);
  await f.guide.prepare({ ...bot, companionId: 'buddy-b' }); assert.equal(f.sends.length, 2);
  assert.notEqual(f.sends[0].requestKey, f.sends[1].requestKey); assert.equal(f.sends[1].target.id, 'buddy-b');
});

test('uncertain guide acknowledgement is reconciled with its original key rather than resending on restart', async () => {
  const f = fixture({ sendError: true, acceptedBeforeError: true });
  await assert.rejects(f.guide.prepare(bot), { code: 'GUIDE_STATUS_UNKNOWN' });
  const key = f.saved[0].key; const restarted = f.restart(); await restarted.prepare(bot);
  assert.equal(f.sends.length, 1); assert.equal(restarted.records.get('a').key, key); assert.equal(restarted.info(bot).state, 'ready');
});

test('only explicit retry can recover an undispatched or definitively failed guide; unknown terminal result cannot be guessed', async () => {
  const f = fixture({ sendError: true }); await assert.rejects(f.guide.prepare(bot), { code: 'GUIDE_STATUS_UNKNOWN' });
  const key = f.saved[0].key; await f.guide.prepare(bot); assert.equal(f.sends.length, 1);
  f.targets.send = async request => { f.sends.push(request); f.receipts.set(request.requestKey, { found: true, requestKey: request.requestKey, target: request.target, taskId: 'session-a', settled: true, result: { outcome: 'failed' } }); return { accepted: true, taskId: 'session-a' }; };
  await f.guide.prepare(bot, true); assert.equal(f.sends[1].requestKey, key);
  await assert.rejects(f.guide.requireReady(bot), { code: 'GUIDE_FAILED' });
  await f.guide.prepare(bot); assert.equal(f.sends.length, 2);
  await f.guide.prepare(bot, true); assert.notEqual(f.sends[2].requestKey, key);
  const latest = f.guide.records.get('a').key; f.receipts.get(latest).result = { outcome: 'unknown' };
  await assert.rejects(f.guide.requireReady(bot), { code: 'GUIDE_STATUS_UNKNOWN' });
  await assert.rejects(f.guide.prepare(bot, true), { code: 'GUIDE_STATUS_UNKNOWN' }); assert.equal(f.sends.length, 3);
});
