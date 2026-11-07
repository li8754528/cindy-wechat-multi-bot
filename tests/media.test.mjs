import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { ReplyRouter, validateConfig } from '../src/core.mjs';
import { readGrantedImages } from '../src/handoff.mjs';
import { InboundImages, IMAGE_CHUNK_CHARS, replyWithImages } from '../src/transfer.mjs';
const require = createRequire(import.meta.url);
const { IlinkClient, decodeMessage } = require('../src/ilink.cjs');
const { BotManager } = require('../src/worker.cjs');
const { MAX_IMAGE_BYTES, imageBytes } = require('../src/media.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYv0AAAAASUVORK5CYII=', 'base64');
const key = Buffer.alloc(16, 3), keyHex = key.toString('hex');
const encrypt = bytes => { const cipher = createCipheriv('aes-128-ecb', key, null); return Buffer.concat([cipher.update(bytes), cipher.final()]); };
const bot = (id = 'a', companionId = 'buddy-a') => ({ id, name: id, companionId, enabled: true });
const wire = (id = 1, items = []) => ({ message_id: id, message_type: 1, from_user_id: 'peer-a', context_token: 'private-context', item_list: items });
const imageItem = () => ({ type: 2, image_item: { aeskey: keyHex, media: { encrypt_query_param: 'private-download' } } });
function managerFixture(client = {}) {
  const events = [], manager = new BotManager({ notify: (method, params) => events.push({ method, params }) });
  manager.configure([bot(), bot('b', 'buddy-b')]);
  for (const state of manager.bots.values()) { state.client = client; state.status = 'connected'; }
  return { manager, events, state: manager.bot('a') };
}
function routerFixture({ imageSupport = true, readImages } = {}) {
  const sends = [], replies = [], rejected = [];
  const router = new ReplyRouter({ targets: { capabilities: async () => ({ delegation: { execution: true } }), resolve: async () => ({}),
    send: async req => { sends.push(req); return { accepted: true, taskId: 'session-a' }; } },
    tasks: { capabilities: async () => ({ messageAttachments: { kinds: imageSupport ? ['image'] : [] } }) },
    readImages: readImages ?? (async () => [png.toString('base64')]),
    nodeReply: async req => { replies.push(req); return { delivered: true }; }, rejectInbound: async (...args) => rejected.push(args) });
  router.setConfig(validateConfig({ bots: [bot()] })); return { router, sends, replies, rejected };
}
const inbound = (id = 'request-a') => ({ requestId: id, botConfigId: 'a', generation: 1, text: '描述图片' });

test('all voice items reject the whole message even with a transcript; converted text remains supported', () => {
  for (const voice_item of [{}, { text: '' }, { text: '语音内容' }]) {
    const decoded = decodeMessage(wire(1, [{ type: 1, text_item: { text: '问题' } }, { type: 3, voice_item }, imageItem()]));
    assert.equal(decoded.unsupported, true); assert.equal(decoded.hasVoice, true); assert.equal(decoded.errorCode, 'VOICE_UNSUPPORTED');
    assert.equal(decoded.text, '问题');
  }
  const decoded = decodeMessage(wire(2, [{ type: 1, text_item: { text: '微信语音转文字后发送的内容' } }, imageItem()]));
  assert.equal(decoded.unsupported, false); assert.equal(decoded.hasVoice, false); assert.equal(decoded.images.length, 1);
  assert.equal(decoded.text, '微信语音转文字后发送的内容');
});

test('poll saves voice messages before replying once to their original peer without companion or image dispatch', { timeout: 3000 }, async t => {
  const order = [], sends = [], events = []; let done, polls = 0;
  const delivered = new Promise(resolve => { done = resolve; });
  const voices = [wire(1, [{ type: 3, voice_item: {} }]),
    { ...wire(2, [{ type: 3, voice_item: { text: '识别文字' } }]), from_user_id: 'peer-b', context_token: 'context-b' },
    wire(3, [{ type: 1, text_item: { text: '不要部分转交' } }, imageItem(), { type: 3, voice_item: {} }])];
  const manager = new BotManager({ checkpoint: async () => { order.push('checkpoint'); assert.equal(manager.bot('a').cursor, 'voice-cursor'); },
    notify: (method, params) => { events.push({ method, params }); if (method === 'wechat/inbound') { order.push('inbound'); done(params); } } });
  t.after(() => manager.close()); manager.configure([bot(), bot('b', 'buddy-b')]); const state = manager.bot('a');
  state.client = { lifecycle: async () => ({}),
    updates: (_cursor, signal) => ++polls === 1 ? Promise.resolve({ get_updates_buf: 'voice-cursor', msgs: [...voices, voices[0], wire(4, [{ type: 1, text_item: { text: '转换后发送的文字' } }])] }) :
      new Promise(resolve => signal.addEventListener('abort', () => resolve({ msgs: [] }), { once: true })),
    send: async req => { order.push('send'); sends.push(req); }, downloadImage: async () => { assert.fail('Rejected mixed voice must not download images'); } };
  manager.start(state); const event = await delivered;
  assert.deepEqual(order, ['checkpoint', 'send', 'send', 'send', 'inbound']);
  assert.equal(event.text, '转换后发送的文字'); assert.equal(events.length, 1);
  assert.deepEqual(sends.map(req => [req.peerId, req.contextToken, req.text]), [
    ['peer-a', 'private-context', '暂不支持语音，请使用微信语音转文字后发送。'],
    ['peer-b', 'context-b', '暂不支持语音，请使用微信语音转文字后发送。'],
    ['peer-a', 'private-context', '暂不支持语音，请使用微信语音转文字后发送。']]);
  assert.equal(new Set(sends.map(req => req.clientId)).size, 3);
  for (const raw of voices) manager.ingest(state, state.generation, raw);
  const rejected = [...manager.requests.values()].find(entry => entry.hasVoice);
  await manager.sendVoiceNotice({ requestId: rejected.requestId, botConfigId: 'a', generation: state.generation });
  await assert.rejects(manager.reply({ requestId: rejected.requestId, generation: state.generation, text: '不能额外回传' }), { code: 'REQUEST_REJECTED' });
  assert.equal(sends.length, 3); assert.deepEqual(state.stats, { received: 4, delivered: 3, rejected: 3 });
  assert.equal(state.lastErrorCode, 'VOICE_UNSUPPORTED'); assert.equal(manager.bot('b').stats.delivered, 0);
  assert.equal(manager.pendingImageBytes, 0);
});

test('uncertain voice notice is not retried and does not block the next text or mark the connection broken', { timeout: 3000 }, async t => {
  let done, sends = 0, polls = 0; const delivered = new Promise(resolve => { done = resolve; });
  const voice = wire(1, [{ type: 3, voice_item: {} }]);
  const manager = new BotManager({ notify: (method, params) => { if (method === 'wechat/inbound') done(params); } });
  t.after(() => manager.close()); manager.configure([bot()]); const state = manager.bot('a');
  state.client = { lifecycle: async () => ({}),
    updates: (_cursor, signal) => ++polls === 1 ? Promise.resolve({ get_updates_buf: 'cursor', msgs: [voice, voice, wire(2, [{ type: 1, text_item: { text: '下一条文字' } }])] }) :
      new Promise(resolve => signal.addEventListener('abort', () => resolve({ msgs: [] }), { once: true })),
    send: async () => { sends++; throw new Error('response lost'); } };
  manager.start(state); assert.equal((await delivered).text, '下一条文字');
  const entry = [...manager.requests.values()].find(item => item.hasVoice);
  await manager.sendVoiceNotice({ requestId: entry.requestId, botConfigId: 'a', generation: state.generation });
  assert.equal(sends, 1); assert.equal(state.stats.delivered, 0); assert.equal(state.lastErrorCode, 'DELIVERY_UNCERTAIN');
  assert.equal(state.status, 'connected');
});

test('voice notice is not sent when saving fails or the binding stops during saving', { timeout: 3000 }, async t => {
  for (const stopBinding of [false, true]) {
    let entered, finishSave, sends = 0; const saving = new Promise(resolve => { entered = resolve; });
    const manager = new BotManager({ checkpoint: () => { entered(); return new Promise((resolve, reject) => { finishSave = stopBinding ? resolve : () => reject(new Error('save failed')); }); } });
    t.after(() => manager.close()); manager.configure([bot()]); const state = manager.bot('a');
    state.client = { lifecycle: async () => ({}), updates: async () => ({ get_updates_buf: 'cursor', msgs: [wire(1, [{ type: 3, voice_item: {} }])] }),
      send: async () => { sends++; } };
    manager.start(state); const loop = state.loop; await saving;
    if (stopBinding) manager.stop(state); finishSave(); await loop;
    assert.equal(sends, 0); if (!stopBinding) assert.equal(state.lastErrorCode, 'PERSISTENCE_FAILED');
  }
});
test('encrypted image download supports hex, base64 raw key, and base64 hex-text without sending Bot token to CDN', async () => {
  const calls = [], client = new IlinkClient({ token: 'private-token', fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(encrypt(png)); } });
  for (const item of [imageItem().image_item, { media: { encrypt_query_param: 'q', aes_key: key.toString('base64') } }, { media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?x=1', aes_key: Buffer.from(keyHex).toString('base64') } }]) {
    const result = await client.downloadImage(item); assert.equal(result.base64, png.toString('base64')); assert.equal(result.name, 'wechat-image.png');
  }
  assert.equal(calls[0].url.searchParams.get('encrypted_query_param'), 'private-download');
  assert.ok(calls.every(call => call.init.redirect === 'manual' && !call.init.headers?.Authorization));
});
test('image transfer rejects unsafe CDN URLs, redirects, oversized responses, bad keys and non-images', async () => {
  let calls = 0; const client = new IlinkClient({ fetchImpl: async () => { calls++; return new Response(encrypt(png)); } });
  for (const full_url of ['https://evil.example/file', 'http://novac2c.cdn.weixin.qq.com/file', 'https://user:pass@cdn.weixin.qq.com/file'])
    await assert.rejects(client.downloadImage({ aeskey: keyHex, media: { full_url } }), { code: 'BAD_RESPONSE' });
  assert.equal(calls, 0);
  await assert.rejects(new IlinkClient({ fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }) }).downloadImage(imageItem().image_item), { code: 'MEDIA_HTTP_ERROR' });
  await assert.rejects(new IlinkClient({ fetchImpl: async () => new Response(png, { headers: { 'content-length': String(MAX_IMAGE_BYTES + 17) } }) }).downloadImage(imageItem().image_item), { code: 'IMAGE_TOO_LARGE' });
  await assert.rejects(client.downloadImage({ media: { encrypt_query_param: 'q', aes_key: 'bad' } }), { code: 'INVALID_IMAGE' });
  await assert.rejects(new IlinkClient({ fetchImpl: async () => new Response(encrypt(Buffer.from('not an image'))) }).downloadImage(imageItem().image_item), { code: 'INVALID_IMAGE' });
  assert.throws(() => imageBytes(png.toString('base64') + '!'), { code: 'INVALID_IMAGE' });
  assert.throws(() => imageBytes(Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')), { code: 'INVALID_IMAGE' });
});
test('image upload follows Tencent getuploadurl, AES/MD5/CDN headers and image send wire format', async () => {
  const calls = []; let uploadBody;
  const client = new IlinkClient({ token: 'private-token', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.pathname === '/ilink/bot/getuploadurl') { uploadBody = JSON.parse(init.body); return new Response(JSON.stringify({ upload_param: 'up-secret' })); }
    if (url.pathname === '/c2c/upload') return new Response(null, { headers: { 'x-encrypted-param': 'down-secret' } });
    return new Response('{"ret":0}');
  } });
  const image = await client.uploadImage('peer-a', png);
  await client.sendImage({ peerId: 'peer-a', contextToken: 'private-context', clientId: 'client-a', image });
  assert.equal(uploadBody.media_type, 1); assert.equal(uploadBody.rawsize, png.length);
  assert.equal(uploadBody.rawfilemd5, createHash('md5').update(png).digest('hex')); assert.equal(uploadBody.filesize, encrypt(png).length);
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(uploadBody.aeskey, 'hex'), null);
  assert.deepEqual(Buffer.concat([decipher.update(calls[1].init.body), decipher.final()]), png);
  assert.equal(calls[1].init.headers.Authorization, undefined); assert.equal(calls[1].init.redirect, 'manual');
  const msg = JSON.parse(calls[2].init.body).msg;
  assert.equal(msg.context_token, 'private-context'); assert.equal(msg.to_user_id, 'peer-a'); assert.equal(msg.item_list[0].type, 2);
  assert.equal(Buffer.from(msg.item_list[0].image_item.media.aes_key, 'base64').toString(), uploadBody.aeskey);
  assert.equal(msg.item_list[0].image_item.mid_size, uploadBody.filesize);
});
test('image-only inbound reaches companion as Host attachments; keys, URLs and context stay inside Node', async () => {
  const client = new IlinkClient({ fetchImpl: async () => new Response(encrypt(png)) });
  const { manager, state } = managerFixture(client), { router, sends } = routerFixture();
  const event = manager.ingest(state, state.generation, wire(1, [imageItem()]), false);
  await router.receive(await manager.prepareInbound(event));
  assert.equal(sends[0].attachments[0].base64, png.toString('base64'));
  const serialized = JSON.stringify(sends); for (const secret of [keyHex, 'private-download', 'private-context']) assert.equal(serialized.includes(secret), false);
  assert.equal(router.requests.get(event.requestId).attachments, undefined); manager.close();
});
test('old Host without image attachment capability fails without dropping the image', async () => {
  const { router, sends, rejected } = routerFixture({ imageSupport: false });
  await router.receive({ ...inbound(), attachments: [{ base64: png.toString('base64') }] });
  assert.equal(sends.length, 0); assert.deepEqual(rejected, [['request-a', 'UNSUPPORTED_CAPABILITY']]);
  assert.equal(router.requests.get('request-a').attachments, undefined);
});
test('dispatch retries retain image content, then exhaustion or cancellation releases it', async () => {
  const attachment = { base64: png.toString('base64') };
  const { router, rejected } = routerFixture();
  const timers = []; router.setTimer = callback => { timers.push(callback); return callback; };
  router.clearTimer = callback => { const index = timers.indexOf(callback); if (index !== -1) timers.splice(index, 1); };
  router.targets.send = async () => { throw Object.assign(new Error('busy'), { code: 'TASK_BUSY' }); };
  await router.receive({ ...inbound(), attachments: [attachment] });
  assert.equal(router.requests.get('request-a').state, 'retry_wait');
  assert.deepEqual(router.requests.get('request-a').attachments, [attachment]); assert.equal(rejected.length, 0);
  await timers.shift()(); await timers.shift()();
  assert.equal(router.requests.get('request-a').state, 'rejected'); assert.equal(router.requests.get('request-a').attachments, undefined);
  assert.deepEqual(rejected, [['request-a', 'DISPATCH_RETRY_EXHAUSTED']]);
  for (const cancel of [r => r.setConfig(validateConfig({ bots: [{ ...bot(), enabled: false }] })), r => r.cancelBot('a'), r => r.reset()]) {
    const { router: pending } = routerFixture(); let finishResolve;
    pending.targets.resolve = () => new Promise(resolve => { finishResolve = resolve; });
    const received = pending.receive({ ...inbound(), attachments: [attachment] });
    while (!finishResolve) await Promise.resolve();
    const entry = pending.requests.get('request-a'); cancel(pending); assert.equal(entry.attachments, undefined);
    finishResolve({}); await received;
  }
});
test('mixed image and whitespace text becomes an image prompt; whitespace alone still rejects', async () => {
  const { manager, state, events } = managerFixture({ downloadImage: async () => ({ base64: png.toString('base64') }) });
  const item = { type: 1, text_item: { text: ' \n\t' } };
  const event = manager.ingest(state, state.generation, wire(1, [item, imageItem()]), false);
  assert.equal(event.text, '请查看微信用户发送的图片。');
  const { router, sends } = routerFixture(); await router.receive(await manager.prepareInbound(event));
  assert.equal(sends.length, 1); assert.equal(sends[0].attachments.length, 1);
  manager.ingest(state, state.generation, wire(2, [item])); assert.equal(events.length, 0); assert.equal(state.stats.rejected, 1); manager.close();
});
test('stopping a Bot during image download prevents late dispatch and frees the media budget', async () => {
  let resolve; const { manager, state, events } = managerFixture({ downloadImage: () => new Promise(done => { resolve = done; }) });
  const event = manager.ingest(state, state.generation, wire(1, [imageItem()]), false);
  const pending = manager.prepareInbound(event); assert.equal(manager.pendingImageBytes, MAX_IMAGE_BYTES);
  manager.disconnect('a'); resolve({ base64: png.toString('base64') });
  await assert.rejects(pending, { code: 'BINDING_CHANGED' }); assert.equal(events.length, 0); assert.equal(manager.pendingImageBytes, 0); manager.close();
});
test('image budget is shared across Bots and recovered when a request is rejected', async () => {
  const { manager, state } = managerFixture({ downloadImage: async () => ({ base64: png.toString('base64') }) });
  const events = [];
  for (const id of [1, 2]) { const event = manager.ingest(state, state.generation, wire(id, Array.from({ length: 4 }, imageItem)), false); events.push(event); await manager.prepareInbound(event); }
  const other = manager.bot('b'), overflow = manager.ingest(other, other.generation, wire(3, [imageItem()]), false);
  await assert.rejects(manager.prepareInbound(overflow), { code: 'MEDIA_INBOX_FULL' });
  manager.reject(events[0].requestId, 'DISPATCH_FAILED'); await manager.prepareInbound(overflow);
  manager.close(); assert.equal(manager.pendingImageBytes, 0);
});
test('image replies authenticate before reading files and compare image hashes for idempotency', async () => {
  let reads = 0; const { router, replies } = routerFixture({ readImages: async () => { reads++; return [png.toString('base64')]; } });
  await router.receive(inbound()); const hash = 'a'.repeat(64);
  await assert.rejects(router.reply('request-a', '', 'wrong-session', {}, [hash]), { code: 'WRONG_COMPANION' }); assert.equal(reads, 0);
  await Promise.all([router.reply('request-a', '', 'session-a', {}, [hash]), router.reply('request-a', '', 'session-a', {}, [hash])]);
  assert.equal(reads, 1); assert.equal(replies.length, 1); assert.equal(replies[0].images[0], png.toString('base64'));
  await assert.rejects(router.reply('request-a', '', 'session-a', {}, ['b'.repeat(64)]), { code: 'REPLY_CONFLICT' });
});
test('same-origin granted image reads are bounded, reject arbitrary refs and can be retried before submission', async () => {
  const hash = 'a'.repeat(64), paths = [];
  assert.deepEqual(await readGrantedImages([hash], async path => { paths.push(path); return path.endsWith('.jpg') ? new Response(png) : new Response(null, { status: 404 }); }), [png.toString('base64')]);
  assert.deepEqual(paths, [`/media/${hash}.png`, `/media/${hash}.jpg`]);
  await assert.rejects(readGrantedImages(['https://evil.example']), { code: 'INVALID_IMAGE' });
  await assert.rejects(readGrantedImages([hash], async () => new Response(Buffer.alloc(MAX_IMAGE_BYTES + 1))), { code: 'INVALID_IMAGE' });
  let failRead = true; const { router, replies } = routerFixture({ readImages: async () => { if (failRead) throw Object.assign(new Error('unavailable'), { code: 'IMAGE_UNAVAILABLE' }); return [png.toString('base64')]; } });
  await router.receive(inbound()); await assert.rejects(router.reply('request-a', '', 'session-a', {}, [hash]), { code: 'IMAGE_UNAVAILABLE' });
  failRead = false; await router.reply('request-a', '', 'session-a', {}, [hash]); assert.equal(replies.length, 1);
});
test('Node uploads all images before any message and repeated image replies never resend', async () => {
  const calls = [], { manager, state } = managerFixture({ uploadImage: async peer => { calls.push(['upload', peer]); return { media: {} }; },
    send: async req => calls.push(['text', req.peerId, req.contextToken]), sendImage: async req => calls.push(['image', req.peerId, req.contextToken]) });
  const event = manager.ingest(state, state.generation, wire(1, [{ type: 1, text_item: { text: 'hello' } }]), false);
  const req = { ...event, text: 'caption', images: [png.toString('base64'), png.toString('base64')] };
  const receipt = await manager.reply(req); await manager.reply(req);
  assert.equal(receipt.images, 2); assert.deepEqual(calls.map(x => x[0]), ['upload', 'upload', 'text', 'image', 'image']);
  assert.ok(calls.slice(2).every(x => x[1] === 'peer-a' && x[2] === 'private-context'));
  await assert.rejects(manager.reply({ ...req, images: [] }), { code: 'REPLY_CONFLICT' }); manager.close();
});
test('image upload failures send no text; uncertain image delivery is never retried', async () => {
  for (const uploadFails of [true, false]) {
    let sends = 0; const { manager, state } = managerFixture({ uploadImage: async () => { if (uploadFails) throw new Error('upload interrupted'); return {}; },
      sendImage: async () => { sends++; throw new Error('send interrupted'); }, send: async () => { sends++; } });
    const event = manager.ingest(state, state.generation, wire(1, [{ type: 1, text_item: { text: 'hi' } }]), false);
    const req = { ...event, text: uploadFails ? 'caption' : '', images: [png.toString('base64')] };
    await assert.rejects(manager.reply(req), { code: uploadFails ? 'IMAGE_UPLOAD_FAILED' : 'DELIVERY_UNCERTAIN' });
    await assert.rejects(manager.reply(req), { code: uploadFails ? 'IMAGE_UPLOAD_FAILED' : 'DELIVERY_UNCERTAIN' });
    assert.equal(sends, uploadFails ? 0 : 1); manager.close();
  }
});

test('poll loop checkpoints before media dispatch and continues past a failed image download', async () => {
  const order = []; let resolveEvent, pollCount = 0;
  const delivered = new Promise(resolve => { resolveEvent = resolve; });
  const manager = new BotManager({ checkpoint: async () => order.push('checkpoint'),
    notify: (method, params) => { if (method === 'wechat/inbound') { order.push('inbound'); resolveEvent(params); } } });
  manager.configure([bot()]); const state = manager.bot('a');
  state.client = { lifecycle: async () => ({}),
    updates: (_cursor, signal) => ++pollCount === 1 ? Promise.resolve({ get_updates_buf: 'cursor-1', msgs: [wire(1, [imageItem()]), wire(2, [{ type: 1, text_item: { text: '下一条文字' } }])] }) :
      new Promise(resolve => signal.addEventListener('abort', () => resolve({ msgs: [] }), { once: true })),
    downloadImage: async () => { order.push('download'); throw Object.assign(new Error('bad image'), { code: 'INVALID_IMAGE' }); } };
  manager.start(state); const event = await delivered;
  assert.deepEqual(order, ['checkpoint', 'download', 'inbound']); assert.match(event.text, /下一条文字/);
  assert.equal(state.stats.rejected, 1); assert.equal(state.lastErrorCode, 'INVALID_IMAGE'); assert.equal(manager.pendingImageBytes, 0); manager.close();
});
test('rebinding during upload cancels image reply before any WeChat send', async () => {
  let finishUpload, sends = 0; const { manager, state } = managerFixture({ uploadImage: async () => new Promise(resolve => { finishUpload = resolve; }),
    sendImage: async () => { sends++; } });
  const event = manager.ingest(state, state.generation, wire(1, [{ type: 1, text_item: { text: 'hi' } }]), false);
  const pending = manager.reply({ ...event, images: [png.toString('base64')] }); manager.disconnect('a'); finishUpload({});
  await assert.rejects(pending, { code: 'IMAGE_UPLOAD_FAILED' }); assert.equal(sends, 0); manager.close();
});

test('incoming image chunks reject missing/out-of-order generations and release assembler storage', () => {
  const buffers = new InboundImages(), metadata = inbound();
  buffers.add({ ...metadata, index: 0, seq: 0, base64: png.toString('base64') });
  assert.ok(buffers.chars > 0);
  assert.throws(() => buffers.take({ ...metadata, imageParts: [{ chunks: 2, chars: png.toString('base64').length }] }), { code: 'INVALID_IMAGE' });
  assert.equal(buffers.chars, 0);
  assert.throws(() => buffers.add({ ...metadata, index: 0, seq: 1, base64: 'AAAA' }), { code: 'INVALID_IMAGE' }); buffers.drop(metadata.requestId);
  buffers.add({ ...metadata, index: 0, seq: 0, base64: png.toString('base64') });
  assert.throws(() => buffers.take({ ...metadata, generation: 2, imageParts: [{ chunks: 1, chars: png.toString('base64').length }] }), { code: 'INVALID_IMAGE' });
  assert.equal(buffers.chars, 0); buffers.clear();
});
test('outbound chunk staging is request-bound, rejects malformed chunks and serves an identical final retry once', async () => {
  let sends = 0; const { manager, state } = managerFixture({ uploadImage: async () => ({}), sendImage: async () => { sends++; } });
  const event = manager.ingest(state, state.generation, wire(1, [{ type: 1, text_item: { text: 'hi' } }]), false), data = png.toString('base64');
  await assert.rejects(replyWithImages(async (method, args) => {
    assert.ok(Buffer.byteLength(JSON.stringify(args)) <= 256 * 1024);
    if (method === 'reply/images/begin') { manager.stageBegin(args); return {}; }
    if (method === 'reply/images/chunk') throw new Error('transport unavailable');
    if (method === 'reply/images/clear') { manager.clearStaged(manager.stagedEntry(args)); return {}; }
    if (method === 'reject') return manager.reject(args.requestId, args.code);
  }, { ...event, images: [data] }, {}), { code: 'IMAGE_UPLOAD_FAILED' });
  assert.equal(sends, 0); assert.equal(manager.pendingImageBytes, 0);
  const next = manager.ingest(state, state.generation, wire(2, [{ type: 1, text_item: { text: 'hi' } }]), false);
  manager.stageBegin({ ...next, lengths: [data.length] });
  assert.throws(() => manager.stageChunk({ ...next, index: 0, seq: 1, base64: data }), { code: 'INVALID_IMAGE' });
  assert.throws(() => manager.stageChunk({ ...next, generation: 100, index: 0, seq: 0, base64: data }), { code: 'BINDING_CHANGED' });
  manager.stageChunk({ ...next, index: 0, seq: 0, base64: data });
  await manager.reply({ ...next, text: '', useStagedImages: true }); await manager.reply({ ...next, text: '', useStagedImages: true });
  assert.equal(sends, 1); assert.equal(manager.pendingImageBytes, 0); assert.ok(IMAGE_CHUNK_CHARS < 256 * 1024); manager.close();
});
