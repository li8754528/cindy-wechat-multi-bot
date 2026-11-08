import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyRouter, validateConfig } from '../src/core.mjs';

const inbound = (requestId, botConfigId = 'a', text = '你好') => ({ requestId, botConfigId, text, generation: 1 });
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture({ messageContext = true, messageCaps, caps = { execution: true, receiptQuery: true, settled: true },
  get, send, cancel, beforeDispatch, nodeReply, readImages, noGet = false } = {}) {
  const sends = [], replies = [], rejected = [], queries = [], timers = [], delays = []; let time = 0;
  const receipt = (requestId, extra = {}) => ({ found: true, requestKey: `wx-${requestId}`, executionId: `execution-${requestId}`,
    target: { kind: 'bot', id: requestId.startsWith('b') ? 'buddy-b' : 'buddy-a' },
    taskId: requestId.startsWith('b') ? 'session-buddy-b' : 'session-buddy-a', status: 'accepted', settled: true, ...extra });
  const targets = { ...(cancel ? { cancel } : {}), capabilities: async () => ({ delegation: caps }), resolve: async ({ target }) => target,
    send: async request => { sends.push(request); return send ? send(request) : { accepted: true, taskId: `session-${request.target.id}`, executionId: `execution-${request.requestKey.slice(3)}` }; },
    ...(!noGet ? { get: async request => { queries.push(request); return get ? get(request) : receipt(request.requestKey.slice(3), { settled: false }); } } : {}) };
  const router = new ReplyRouter({ targets, tasks: { capabilities: messageCaps ?? (async () => ({ messageContext, messageAttachments: { kinds: ['image'] } })) },
    nodeReply: async request => { replies.push(request); return nodeReply ? nodeReply(request) : { delivered: true }; },
    rejectInbound: async (...args) => { rejected.push(args); }, readImages, beforeDispatch, now: () => time,
    setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); delays.push(delay); return timer; },
    clearTimer: timer => { const index = timers.indexOf(timer); if (index !== -1) timers.splice(index, 1); } });
  router.setConfig(validateConfig({ bots: ['a', 'b'].map(id => ({ id, name: id, enabled: true, companionId: `buddy-${id}` })) }));
  return { router, sends, replies, rejected, queries, timers, delays, receipt, setTime: value => { time = value; },
    tick: async () => { const timer = timers.shift(); assert.ok(timer, 'one scheduled query'); await timer.callback(); } };
}

test('failed companion dispatch retries after 3 then 10 minutes with identical image payload and preserves Bot ordering', async () => {
  let attempts = 0; const f = fixture({ caps: { execution: true }, send: async request => {
    if (request.requestKey === 'wx-a1' && ++attempts < 3) throw Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' });
    return { accepted: true, taskId: `session-${request.target.id}` };
  } });
  const message = { ...inbound('a1'), attachments: [{ name: 'image.png', base64: 'test' }] };
  await f.router.receive(message); await f.router.receive(inbound('a2')); await f.router.receive(inbound('b1', 'b'));
  assert.deepEqual(f.sends.map(request => request.requestKey), ['wx-a1', 'wx-b1']);
  assert.deepEqual(f.router.pendingRetries(), [{ botConfigId: 'a', attempt: 1, retryAt: 180000 }]);
  assert.equal(f.rejected.length, 0); f.setTime(180000); await f.tick();
  assert.equal(f.router.requests.get('a1').state, 'retry_wait');
  assert.deepEqual(f.router.pendingRetries(), [{ botConfigId: 'a', attempt: 2, retryAt: 780000 }]);
  f.setTime(780000); await f.tick();
  assert.deepEqual(f.delays, [180000, 600000]);
  assert.equal(f.router.requests.get('a1').state, 'accepted'); assert.equal(f.timers.length, 0);
  assert.deepEqual(f.sends[0], f.sends[2]); assert.deepEqual(f.sends[0], f.sends[3]);
  assert.equal(f.router.requests.get('a1').attachments, undefined);
  await f.router.reply('a1', '本次答案', 'session-buddy-a'); await f.router.requests.get('a2').accepted;
  assert.equal(f.sends.at(-1).requestKey, 'wx-a2'); f.router.reset();
});

test('first retry success stops retrying; a lost acceptance receipt uses the same key without a second logical delivery', async () => {
  let logicalDeliveries = 0; const accepted = new Set();
  const f = fixture({ caps: { execution: true }, send: async request => {
    if (!accepted.has(request.requestKey)) { accepted.add(request.requestKey); logicalDeliveries++; throw Object.assign(new Error('receipt lost'), { code: 'DELIVERY_UNCERTAIN' }); }
    return { accepted: true, taskId: 'session-buddy-a' };
  } });
  await f.router.receive(inbound('a1')); f.setTime(180000); await f.tick();
  assert.equal(logicalDeliveries, 1); assert.equal(f.sends.length, 2); assert.deepEqual(f.sends[0], f.sends[1]);
  assert.deepEqual(f.delays, [180000]); assert.equal(f.timers.length, 0); assert.equal(f.router.pendingRetries().length, 0);
  await f.router.reply('a1', '答案', 'session-buddy-a'); assert.equal(f.replies.length, 1); f.router.reset();
});

test('three failed attempts reject once, release retained images and let the next message run', async () => {
  for (const code of ['NETWORK_ERROR', 'DELIVERY_UNCERTAIN']) {
    const f = fixture({ caps: { execution: true }, send: async request => {
      if (request.requestKey === 'wx-a1') throw Object.assign(new Error('unavailable'), { code });
      return { accepted: true, taskId: 'session-buddy-a' };
    } });
    await f.router.receive({ ...inbound('a1'), attachments: [{ base64: 'test' }] }); await f.router.receive(inbound('a2'));
    f.setTime(180000); await f.tick(); f.setTime(780000); await f.tick(); await f.router.requests.get('a2').accepted;
    assert.deepEqual(f.rejected, [['a1', code === 'DELIVERY_UNCERTAIN' ? 'DISPATCH_DELIVERY_UNCERTAIN' : 'DISPATCH_RETRY_EXHAUSTED']]);
    assert.equal(f.router.requests.get('a1').attachments, undefined); assert.equal(f.router.current.get('a'), 'a2');
    assert.equal(f.sends.filter(request => request.requestKey === 'wx-a1').length, 3);
    await f.router.receive(inbound('a1')); assert.equal(f.sends.length, 4); assert.equal(f.timers.length, 0); f.router.reset();
  }
});

test('stop, rebind, reset and connection replacement cancel dispatch retry timers including late callbacks', async () => {
  for (const action of ['stop', 'rebind', 'reset', 'connection']) {
    const f = fixture({ caps: { execution: true }, send: async () => { throw new Error('offline'); } });
    await f.router.receive(inbound('a1')); const timer = f.timers[0];
    if (action === 'reset') f.router.reset();
    else if (action === 'connection') f.router.cancelBot('a', 2);
    else f.router.setConfig(validateConfig({ bots: [{ id: 'a', name: 'a', enabled: action !== 'stop', companionId: action === 'rebind' ? 'new-buddy' : 'buddy-a' }] }));
    assert.equal(f.timers.length, 0); assert.equal(f.router.pendingRetries().length, 0);
    await timer.callback(); assert.equal(f.sends.length, 1); assert.equal(f.rejected.length, 0); f.router.reset();
  }
});

test('authorization, invalid requests and unsupported capability do not retry; expired delayed input cannot dispatch', async () => {
  for (const code of ['PERMISSION_DENIED', 'UNSUPPORTED_CAPABILITY', 'INVALID_PARAMS', 'REQUEST_KEY_CONFLICT']) {
    const f = fixture({ beforeDispatch: async () => { throw Object.assign(new Error('blocked'), { code }); } });
    await f.router.receive(inbound('a1')); assert.equal(f.sends.length, 0); assert.equal(f.timers.length, 0);
    assert.deepEqual(f.rejected, [['a1', code]]); f.router.reset();
  }
  const f = fixture({ caps: { execution: true }, send: async () => { throw new Error('offline'); } });
  await f.router.receive(inbound('a1')); f.setTime(30 * 60000 + 1); await f.tick();
  assert.equal(f.sends.length, 1); assert.deepEqual(f.rejected, [['a1', 'REQUEST_EXPIRED']]);
  assert.equal(f.timers.length, 0); f.router.reset();
});

test('a temporarily pending binding guide is checked again before retry dispatch', async () => {
  let checks = 0; const f = fixture({ caps: { execution: true }, beforeDispatch: async () => {
    if (++checks === 1) throw Object.assign(new Error('guide pending'), { code: 'GUIDE_PENDING' });
  } });
  await f.router.receive(inbound('a1')); assert.equal(f.sends.length, 0); assert.equal(f.rejected.length, 0);
  f.setTime(180000); await f.tick(); assert.equal(checks, 2); assert.equal(f.sends.length, 1);
  assert.equal(f.router.requests.get('a1').state, 'accepted'); f.router.reset();
});

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


const peerInput = (id, text = '你好', extra = {}) => ({ ...inbound(id, 'a', text), peerId: 'peer-a', ...extra });
const pendingReceipt = requestKey => ({ found: true, requestKey, target: { kind: 'bot', id: 'buddy-a' }, status: 'pending', taskId: 'session-buddy-a' });

test('same-user duplicate replaces failed request immediately, cancels exact key and fences late retry/reply', async () => {
  const cancelled = [];
  const f = fixture({ get: async ({ requestKey }) => pendingReceipt(requestKey),
    cancel: async request => { cancelled.push(request); return { cancelled: true, settled: true }; },
    send: async request => { if (request.requestKey === 'wx-a1') throw new Error('route busy'); return { accepted: true, taskId: 'session-buddy-a' }; } });
  await f.router.receive(peerInput('a1')); const timer = f.timers[0];
  await f.router.receive(peerInput('a2'));
  assert.deepEqual(cancelled, [{ requestKey: 'wx-a1' }]);
  assert.deepEqual(f.sends.map(req => [req.requestKey, req.text]), [['wx-a1', '你好'], ['wx-a2', '你好']]);
  assert.equal(f.router.requests.get('a1').state, 'superseded');
  assert.deepEqual(f.rejected, [['a1', 'REQUEST_SUPERSEDED']]);
  await timer.callback(); assert.equal(f.sends.length, 2);
  await assert.rejects(f.router.reply('a1', 'old', 'session-buddy-a'), { code: 'REQUEST_SUPERSEDED' });
  await f.router.reply(undefined, 'new answer', 'session-buddy-a');
  assert.deepEqual(f.replies.map(req => req.requestId), ['a2']); f.router.reset();
});

test('different failed input accumulates in order, dedupes repeated parts and retains all distinct images', async () => {
  let ready = false;
  const f = fixture({ beforeDispatch: async () => { if (!ready) throw new Error('guide pending'); } });
  const image = base64 => ({ name: 'image.png', base64 });
  await f.router.receive(peerInput('a1', '第一条', { attachments: [image('AAAA')] }));
  await f.router.receive(peerInput('a2', '第二条', { attachments: [image('BBBB')] }));
  assert.equal(f.router.requests.get('a2').text, '第一条\n\n第二条');
  ready = true;
  await f.router.receive(peerInput('a3', '第二条', { attachments: [image('BBBB')] }));
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].text, '第一条\n\n第二条');
  assert.deepEqual(f.sends[0].attachments.map(item => item.base64), ['AAAA', 'BBBB']);
  assert.equal(f.sends[0].requestKey, 'wx-a3'); assert.equal(f.router.requests.get('a1').parts, undefined);
  f.router.reset();
});

test('same text with different images merges; already accepted delivery and different contacts never merge', async () => {
  for (const mode of ['images', 'other-peer', 'accepted', 'missing-cancel', 'query-error', 'too-long', 'too-many-images']) {
    let fail = true;
    const f = fixture({
      get: async ({ requestKey }) => { if (mode === 'query-error') throw new Error('timeout'); return mode === 'accepted' ? { ...pendingReceipt(requestKey), status: 'accepted' } : pendingReceipt(requestKey); },
      ...(mode === 'missing-cancel' ? {} : { cancel: async () => ({ cancelled: true, settled: true }) }),
      send: async () => { if (fail) throw new Error('busy'); return { accepted: true, taskId: 'session-buddy-a' }; } });
    const old = peerInput('a1', mode === 'too-long' ? 'A'.repeat(9000) : '内容', { attachments: [{ base64: 'AAAA' }] });
    if (mode === 'too-many-images') old.attachments = ['A','B','C','D'].map(base64 => ({ base64 }));
    await f.router.receive(old); fail = false;
    await f.router.receive(peerInput('a2', mode === 'too-long' ? 'B'.repeat(9000) : '内容', {
      peerId: mode === 'other-peer' ? 'peer-b' : 'peer-a', attachments: [{ base64: 'BBBB' }] }));
    if (mode === 'images') {
      assert.equal(f.sends.length, 2); assert.equal(f.sends[1].text, '内容\n\n内容');
      assert.equal(f.sends[1].attachments.length, 2);
    } else { assert.equal(f.sends.length, 1, mode); assert.equal(f.router.requests.get('a2').state, 'queued', mode); }
    f.router.reset();
  }
});

test('unsettled withdrawal holds merged input and later arrivals until reliable cancellation settles', async () => {
  let settled = false; const cancelled = [];
  const f = fixture({ get: async ({ requestKey }) => ({ ...pendingReceipt(requestKey), status: cancelled.length ? 'cancelled' : 'pending', settled }),
    cancel: async request => { cancelled.push(request); return { cancelled: true }; },
    send: async request => { if (request.requestKey === 'wx-a1') throw new Error('busy'); return { accepted: true, taskId: 'session-buddy-a' }; } });
  await f.router.receive(peerInput('a1', 'A'));
  await f.router.receive(peerInput('a2', 'B'));
  assert.equal(f.router.requests.get('a1').state, 'withdrawing'); assert.equal(f.sends.length, 1);
  await f.router.receive(peerInput('a3', 'C'));
  assert.equal(f.router.requests.get('a2').state, 'superseded'); assert.equal(f.sends.length, 1);
  await f.tick(); assert.equal(f.sends.length, 1);
  settled = true; await f.tick(); await f.router.requests.get('a3').accepted;
  assert.equal(cancelled.length, 1); assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1].text, 'A\n\nB\n\nC'); f.router.reset();
});

test('new arrivals during initial send serialize, merge after failure and do not dispatch the stale timer', async () => {
  const gate = defer(); const f = fixture({ get: async ({ requestKey }) => pendingReceipt(requestKey),
    cancel: async () => ({ cancelled: true, settled: true }), send: async req => {
      if (req.requestKey === 'wx-a1') return gate.promise;
      throw new Error('still offline');
    } });
  const first = f.router.receive(peerInput('a1', 'A'));
  const second = f.router.receive(peerInput('a2', 'B'));
  const third = f.router.receive(peerInput('a3', 'C'));
  gate.reject(new Error('busy')); await Promise.all([first, second, third]);
  assert.deepEqual(f.sends.map(req => req.text), ['A', 'A\n\nB', 'A\n\nB\n\nC']);
  assert.equal(f.router.pendingRetries().length, 1); f.router.reset();
});

test('reset or rebind during cancellation never dispatches a replacement or revives the old request', async () => {
  for (const reset of [true, false]) {
    const gate = defer(); let cancelStarted; const started = new Promise(resolve => { cancelStarted = resolve; });
    const f = fixture({ get: async ({ requestKey }) => pendingReceipt(requestKey),
      cancel: async () => { cancelStarted(); return gate.promise; }, send: async () => { throw new Error('busy'); } });
    await f.router.receive(peerInput('a1'));
    const replacing = f.router.receive(peerInput('a2', '新内容')); await started;
    if (reset) f.router.reset(); else f.router.setConfig(validateConfig({ bots: [{ id: 'a', name: 'A', enabled: true, companionId: 'other-buddy' }] }));
    gate.resolve({ cancelled: true, settled: true }); await replacing;
    assert.equal(f.sends.length, 1); assert.equal(f.timers.length, 0); assert.equal(f.router.current.size, 0); f.router.reset();
  }
});


test('lost cancellation ACK stays fenced until cancelled receipt settles; reset invalidates late query', async () => {
  let queried = false; const gate = defer();
  const f = fixture({ get: async ({ requestKey }) => { if (queried) return gate.promise; queried = true; return pendingReceipt(requestKey); },
    cancel: async () => { throw new Error('ACK lost'); }, send: async () => { throw new Error('busy'); } });
  await f.router.receive(peerInput('a1', 'A')); await f.router.receive(peerInput('a2', 'B'));
  assert.equal(f.router.requests.get('a1').state, 'withdrawing'); assert.equal(f.sends.length, 1);
  const polling = f.tick(); f.router.reset();
  gate.resolve({ ...pendingReceipt('wx-a1'), status: 'cancelled', settled: true }); await polling;
  assert.equal(f.sends.length, 1); assert.equal(f.timers.length, 0); assert.equal(f.router.current.size, 0);
});


test('connection reset, router reset and rebind detach hung cancellation from new inbound work', async () => {
  for (const action of ['connection', 'reset', 'rebind']) {
    const gate = defer(), begun = defer(); let offline = true;
    const f = fixture({ get: async ({ requestKey }) => pendingReceipt(requestKey),
      cancel: async () => { begun.resolve(); return gate.promise; },
      send: async request => { if (offline) throw new Error('busy'); return { accepted: true, taskId: `session-${request.target.id}` }; } });
    await f.router.receive(peerInput('a1'));
    const blocked = f.router.receive(peerInput('a2', 'stale')); await begun.promise;
    const queued = f.router.receive(peerInput('a3', 'also stale'));
    if (action === 'connection') f.router.cancelBot('a', 2);
    else if (action === 'reset') f.router.reset();
    else f.router.setConfig(validateConfig({ bots: [{ id: 'a', name: 'A', enabled: true, companionId: 'new-buddy' }] }));
    offline = false;
    await f.router.receive(peerInput('a4', 'fresh', { generation: action === 'connection' ? 2 : 1 }));
    assert.equal(f.sends.at(-1).text, 'fresh'); assert.equal(f.router.current.get('a'), 'a4');
    gate.resolve({ cancelled: true, settled: true }); await Promise.all([blocked, queued]);
    assert.equal(f.sends.length, 2); assert.equal(f.router.current.get('a'), 'a4'); f.router.reset();
  }
});
