import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyRouter, validateConfig } from '../src/core.mjs';

const inbound = (requestId, botConfigId = 'a', text = '你好') => ({ requestId, botConfigId, text, generation: 1 });
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture({ messageContext = true, messageCaps, caps = { execution: true, receiptQuery: true, settled: true },
  get, nodeReply, readImages, noGet = false } = {}) {
  const sends = [], replies = [], rejected = [], queries = [], timers = [], delays = []; let time = 0;
  const receipt = (requestId, extra = {}) => ({ found: true, requestKey: `wx-${requestId}`, executionId: `execution-${requestId}`,
    target: { kind: 'bot', id: requestId.startsWith('b') ? 'buddy-b' : 'buddy-a' },
    taskId: requestId.startsWith('b') ? 'session-buddy-b' : 'session-buddy-a', status: 'accepted', settled: true, ...extra });
  const targets = { capabilities: async () => ({ delegation: caps }), resolve: async ({ target }) => target,
    send: async request => { sends.push(request); return { accepted: true, taskId: `session-${request.target.id}`, executionId: `execution-${request.requestKey.slice(3)}` }; },
    ...(!noGet ? { get: async request => { queries.push(request); return get ? get(request) : receipt(request.requestKey.slice(3), { settled: false }); } } : {}) };
  const router = new ReplyRouter({ targets, tasks: { capabilities: messageCaps ?? (async () => ({ messageContext, messageAttachments: { kinds: ['image'] } })) },
    nodeReply: async request => { replies.push(request); return nodeReply ? nodeReply(request) : { delivered: true }; },
    rejectInbound: async (...args) => { rejected.push(args); }, readImages, now: () => time,
    setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); delays.push(delay); return timer; },
    clearTimer: timer => { const index = timers.indexOf(timer); if (index !== -1) timers.splice(index, 1); } });
  router.setConfig(validateConfig({ bots: ['a', 'b'].map(id => ({ id, name: id, enabled: true, companionId: `buddy-${id}` })) }));
  return { router, sends, replies, rejected, queries, timers, delays, receipt, setTime: value => { time = value; },
    tick: async () => { const timer = timers.shift(); assert.ok(timer, 'one scheduled query'); await timer.callback(); } };
}

test('Host receives exactly the original WeChat text without prefix, context, request number or image instruction prose', async () => {
  const f = fixture(); const message = { ...inbound('a1', 'a', '  原始\n内容🙂  '), attachments: [{ name: 'image.png', base64: 'test' }] };
  await f.router.receive(message);
  assert.equal(f.sends[0].text, message.text); assert.equal('context' in f.sends[0], false);
  assert.deepEqual(f.sends[0].attachments, message.attachments);
  await f.router.reply('a1', '本次回答', 'session-buddy-a');
  assert.equal(f.replies.length, 1); assert.equal(f.timers.length, 0);
});

test('absent, false, nonboolean or failed messageContext capability never changes text-only body or its reply', async () => {
  for (const messageCaps of [async () => ({}), async () => ({ messageContext: false }), async () => ({ messageContext: 'true' }), async () => { throw new Error('offline'); }]) {
    const f = fixture({ messageCaps }); await f.router.receive(inbound('a1'));
    assert.equal('context' in f.sends[0], false); assert.equal(f.sends[0].text, '你好');
    await f.router.reply('a1', '答案', 'session-buddy-a'); assert.equal(f.replies.length, 1);
  }
});

test('without both receipt capabilities or get, no polling occurs and original TTL still rejects old replies', async () => {
  for (const options of [{ caps: { execution: true } }, { caps: { execution: true, receiptQuery: true, settled: false } },
    { caps: { execution: true, settled: true, receiptQuery: 'true' } }, { noGet: true }]) {
    const f = fixture(options); await f.router.receive(inbound('a1'));
    assert.equal(f.timers.length, 0); assert.equal(f.queries.length, 0);
    f.setTime(30 * 60000 + 1);
    await assert.rejects(f.router.reply('a1', '迟到', 'session-buddy-a'), { code: 'REQUEST_EXPIRED' });
    assert.equal(f.replies.length, 0);
  }
});

test('matching settled receipt closes only its request, releases its Bot lane and rejects a late tool reply', async () => {
  let f; f = fixture({ get: async ({ requestKey }) => f.receipt(requestKey.slice(3), { result: { outcome: 'completed', outputMessageId: 'output', outputText: 'never forward this' } }) });
  await f.router.receive(inbound('a1')); await f.router.receive(inbound('a2')); await f.router.receive(inbound('b1', 'b'));
  assert.deepEqual(f.sends.map(send => send.requestKey), ['wx-a1', 'wx-b1']);
  await f.tick(); await f.router.requests.get('a2').accepted;
  assert.deepEqual(f.queries, [{ requestKey: 'wx-a1' }]);
  assert.equal(f.router.requests.get('a1').state, 'settled');
  assert.equal(f.router.current.get('a'), 'a2'); assert.equal(f.router.current.get('b'), 'b1');
  assert.deepEqual(f.rejected, [['a1', 'COMPLETED_WITHOUT_REPLY']]); assert.equal(f.replies.length, 0);
  await assert.rejects(f.router.reply('a1', '迟到答案', 'session-buddy-a'), { code: 'REQUEST_SETTLED' });
  await assert.rejects(f.router.reply('a2', '错伙伴', 'session-buddy-b'), { code: 'WRONG_COMPANION' });
  await Promise.all([f.router.reply('a2', '答案 A', 'session-buddy-a'), f.router.reply('b1', '答案 B', 'session-buddy-b')]);
  assert.deepEqual(f.replies.map(reply => reply.requestId), ['a2', 'b1']);
});

test('terminal outcome selects request-level errors, while absent or unknown outcomes stay neutral and never send success', async () => {
  for (const [outcome, code] of [['completed', 'COMPLETED_WITHOUT_REPLY'], ['failed', 'FAILED_WITHOUT_REPLY'],
    ['cancelled', 'CANCELLED_WITHOUT_REPLY'], ['interrupted', 'INTERRUPTED_WITHOUT_REPLY'],
    [undefined, 'ENDED_WITHOUT_REPLY'], ['future-outcome', 'ENDED_WITHOUT_REPLY']]) {
    let f; f = fixture({ get: async () => f.receipt('a1', { result: { outcome } }) });
    await f.router.receive(inbound('a1')); await f.tick();
    assert.equal(f.router.requests.get('a1').state, 'settled'); assert.equal(f.router.current.size, 0);
    assert.equal(f.replies.length, 0); assert.equal(f.timers.length, 0);
    assert.deepEqual(f.rejected, [['a1', code]]);
  }
});

test('pending, unknown, mismatched or failed queries never imply completion; polling uses bounded backoff', async () => {
  let f; const responses = [() => ({ found: false }), () => f.receipt('a1', { settled: undefined }),
    () => f.receipt('a1', { settled: false }), () => f.receipt('different'),
    () => f.receipt('a1', { executionId: 'other-execution' }), () => f.receipt('a1', { taskId: 'desktop-session' }),
    () => f.receipt('a1', { target: { kind: 'bot', id: 'buddy-b' } }), () => { throw new Error('query timeout'); }];
  f = fixture({ get: async () => responses.shift()() }); await f.router.receive(inbound('a1'));
  while (responses.length) { await f.tick(); assert.equal(f.router.requests.get('a1').state, 'accepted'); assert.equal(f.router.current.get('a'), 'a1'); }
  assert.deepEqual(f.delays.slice(0, 4), [1000, 5000, 15000, 15000]); assert.equal(f.rejected.length, 0);
  await f.router.reply('a1', '正常回答', 'session-buddy-a'); assert.equal(f.replies.length, 1);
});

test('permission denial stops receipt queries without sending, closing or reopening a permission prompt', async () => {
  const f = fixture({ get: async () => { throw Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' }); } });
  await f.router.receive(inbound('a1')); await f.tick();
  assert.equal(f.timers.length, 0); assert.equal(f.router.requests.get('a1').state, 'accepted'); assert.equal(f.rejected.length, 0);
});

test('a terminal query arriving during a send preserves the lane and the cached identical reply', async () => {
  const query = defer(), sending = defer(); const f = fixture({ get: () => query.promise, nodeReply: () => sending.promise });
  await f.router.receive(inbound('a1')); await f.router.receive(inbound('a2'));
  const poll = f.tick(); const reply = f.router.reply('a1', 'answer', 'session-buddy-a');
  const repeated = f.router.reply('a1', 'answer', 'session-buddy-a');
  await Promise.resolve(); query.resolve(f.receipt('a1')); await poll;
  assert.equal(f.router.current.get('a'), 'a1'); assert.equal(f.sends.length, 1); assert.equal(f.rejected.length, 0);
  sending.resolve({ delivered: true }); await Promise.all([reply, repeated]); await f.router.requests.get('a2').accepted;
  assert.equal(f.replies.length, 1); assert.equal(f.router.requests.get('a1').state, 'sent');
  await f.router.reply('a1', 'answer', 'session-buddy-a'); assert.equal(f.replies.length, 1);
  await assert.rejects(f.router.reply('a1', 'other', 'session-buddy-a'), { code: 'REPLY_CONFLICT' });
});

test('terminal receipt cannot interrupt image preparation; a failed read may be closed on the next query', async () => {
  for (const fails of [false, true]) {
    const reading = defer(); let f; f = fixture({ get: async () => f.receipt('a1'), readImages: () => reading.promise });
    await f.router.receive(inbound('a1')); const reply = f.router.reply('a1', '', 'session-buddy-a', {}, ['a'.repeat(64)]);
    const outcome = reply.then(value => value, error => error); await Promise.resolve(); await f.tick();
    assert.equal(f.router.requests.get('a1').state, 'accepted'); assert.equal(f.rejected.length, 0);
    if (fails) {
      reading.reject(Object.assign(new Error('invalid image'), { code: 'INVALID_IMAGE' })); assert.equal((await outcome).code, 'INVALID_IMAGE');
      await f.tick(); assert.equal(f.router.requests.get('a1').state, 'settled'); assert.equal(f.replies.length, 0);
    } else {
      reading.resolve([{ base64: 'test' }]); assert.equal((await outcome).delivered, true); assert.equal(f.replies.length, 1);
    }
  }
});

test('a send with unknown delivery keeps the original error even when a terminal query completes later', async () => {
  const query = defer(), sending = defer(); const f = fixture({ get: () => query.promise, nodeReply: () => sending.promise });
  await f.router.receive(inbound('a1')); await f.router.receive(inbound('a2'));
  const poll = f.tick(); const reply = f.router.reply('a1', 'answer', 'session-buddy-a');
  const expected = assert.rejects(reply, { code: 'DELIVERY_UNCERTAIN' }); await Promise.resolve();
  sending.reject(Object.assign(new Error('send timeout'), { code: 'DELIVERY_UNCERTAIN' })); await expected;
  await f.router.requests.get('a2').accepted; query.resolve(f.receipt('a1')); await poll;
  assert.equal(f.router.requests.get('a1').state, 'uncertain'); assert.equal(f.router.current.get('a'), 'a2');
  await assert.rejects(f.router.reply('a1', 'answer', 'session-buddy-a'), { code: 'DELIVERY_UNCERTAIN' });
  assert.equal(f.replies.length, 1); assert.equal(f.rejected.length, 0);
});

test('late receipt after cancel/reset cannot reject a replacement request or resume polling', async () => {
  for (const reset of [false, true]) {
    const query = defer(); const f = fixture({ get: () => query.promise }); await f.router.receive(inbound('a1'));
    const poll = f.tick(); if (reset) f.router.reset(); else f.router.cancelBot('a', 1);
    await f.router.receive(inbound('a2')); query.resolve(f.receipt('a1')); await poll;
    assert.equal(f.router.current.get('a'), 'a2'); assert.equal(f.rejected.length, 0); assert.equal(f.timers.length, 1);
    f.router.reset(); assert.equal(f.timers.length, 0);
  }
});

test('receipt monitoring expires unreplied requests at TTL but does not cancel a send when newer messages arrive', async () => {
  const f = fixture(); await f.router.receive(inbound('a1')); f.setTime(30 * 60000 + 1); await f.tick();
  assert.equal(f.router.current.size, 0); assert.deepEqual(f.rejected, [['a1', 'REQUEST_EXPIRED']]);
  const sending = defer(); const active = fixture({ nodeReply: () => sending.promise });
  await active.router.receive(inbound('a1')); const reply = active.router.reply('a1', 'answer', 'session-buddy-a'); await Promise.resolve();
  active.setTime(30 * 60000 + 1); await active.router.receive(inbound('a2')); await active.tick();
  assert.equal(active.router.current.get('a'), 'a1'); assert.equal(active.rejected.length, 0);
  sending.resolve({ delivered: true }); await reply; await active.router.requests.get('a2').accepted;
  assert.equal(active.router.current.get('a'), 'a2');
});

test('implicit reply selects only the unique Host-verified binding/current request and retains call-ID idempotency', async () => {
  const f = fixture(); f.router.bindSession('a', 'buddy-a', 'session-buddy-a');
  const guideCall = { callId: 'guide-call' };
  await assert.rejects(f.router.reply(undefined, 'guide confirmation', 'session-buddy-a', guideCall), { code: 'NO_CURRENT_REQUEST' });
  await assert.rejects(f.router.reply(undefined, 'bad identity', undefined), { code: 'WRONG_COMPANION' });
  await f.router.receive(inbound('a1')); await f.router.receive(inbound('a2')); await f.router.receive(inbound('b1', 'b'));
  await assert.rejects(f.router.reply(undefined, 'guide confirmation', 'session-buddy-a', guideCall), { code: 'NO_CURRENT_REQUEST' });
  f.router.bindSession('a', 'buddy-a', 'stale-guide-session');
  await assert.rejects(f.router.reply(undefined, 'stale identity', 'stale-guide-session'), { code: 'WRONG_COMPANION' });
  const call = { callId: 'stable-tool-call' };
  await f.router.reply(undefined, 'answer-a1', 'session-buddy-a', call); await f.router.requests.get('a2').accepted;
  await f.router.reply(undefined, 'answer-a1', 'session-buddy-a', call); assert.equal(f.replies.length, 1);
  await assert.rejects(f.router.reply(undefined, 'different', 'session-buddy-a', call), { code: 'REPLY_CONFLICT' });
  await f.router.reply(undefined, 'answer-b1', 'session-buddy-b', { callId: 'b-call' });
  assert.deepEqual(f.replies.map(reply => reply.requestId), ['a1', 'b1']);
  f.router.bindSession('b', 'buddy-b', 'session-buddy-a');
  await assert.rejects(f.router.reply(undefined, 'ambiguous', 'session-buddy-a'), { code: 'AMBIGUOUS_REQUEST' });
});

test('implicit reply cannot revive a settled or expired request, while explicit old-ID compatibility stays guarded', async () => {
  let f; f = fixture({ get: async () => f.receipt('a1', { result: { outcome: 'completed' } }) });
  await f.router.receive(inbound('a1')); await f.tick();
  await assert.rejects(f.router.reply(undefined, 'late', 'session-buddy-a'), { code: 'NO_CURRENT_REQUEST' });
  await assert.rejects(f.router.reply('a1', 'late', 'session-buddy-a'), { code: 'REQUEST_SETTLED' });
  await f.router.receive(inbound('a2')); f.setTime(30 * 60000 + 1);
  await assert.rejects(f.router.reply(undefined, 'expired', 'session-buddy-a'), { code: 'REQUEST_EXPIRED' });
  assert.equal(f.replies.length, 0);
});
