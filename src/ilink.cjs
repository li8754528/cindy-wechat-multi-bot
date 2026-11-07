const { randomBytes } = require('node:crypto');
const { MAX_IMAGE_BYTES, CDN_ORIGIN, imageExtension, readBounded, prepareImage, decryptImage } = require('./media.cjs');
const VERSION = '0.2.0';
const AUTH_ORIGIN = 'https://ilinkai.weixin.qq.com';
function error(code, message) { return Object.assign(new Error(message), { code }); }
function tencentUrl(value, originOnly = false) {
  let url; try { url = new URL(value); } catch { throw error('BAD_RESPONSE', '微信返回了无效地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com')) ||
      (originOnly && (url.pathname !== '/' || url.search || url.hash)))
    throw error('BAD_RESPONSE', '微信地址必须是腾讯的 HTTPS 域名。');
  return url;
}
class IlinkClient {
  constructor({ baseUrl = AUTH_ORIGIN, token, fetchImpl = fetch } = {}) {
    this.origin = tencentUrl(baseUrl, true).origin; this.token = token; this.fetch = fetchImpl;
  }
  async request(path, { body, signal, timeout = 35000, authenticated = !!this.token } = {}) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '259',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers.AuthorizationType = 'ilink_bot_token'; }
    if (authenticated) { if (!this.token) throw error('NOT_CONNECTED', '请先扫码登录。'); headers.Authorization = `Bearer ${this.token}`; }
    const deadline = AbortSignal.timeout(timeout);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response;
    try { response = await this.fetch(new URL(path, `${this.origin}/`), { method: body === undefined ? 'GET' : 'POST',
      headers, body: body === undefined ? undefined : JSON.stringify(body), signal: combined, redirect: 'manual' }); }
    catch (err) { const code = signal?.aborted ? 'CANCELLED' : deadline.aborted || err?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      throw error(code, code === 'TIMEOUT' ? '微信请求等待超时。' : '微信请求中断，请查看连接状态。'); }
    if (!response.ok) throw error('HTTP_ERROR', `微信接口返回 HTTP ${response.status}。`);
    if (!response.body) throw error('BAD_RESPONSE', '微信返回空响应。');
    const reader = response.body.getReader(); let bytes = 0; const chunks = [];
    try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
      if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw error('BAD_RESPONSE', '微信响应过大。'); } chunks.push(Buffer.from(part.value)); } }
    catch (err) { if (err.code) throw err; throw error('NETWORK_ERROR', '微信响应读取中断。'); }
    let result; try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw error('BAD_RESPONSE', '微信返回了无效数据。'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw error('BAD_RESPONSE', '微信响应不是对象。');
    for (const key of ['ret', 'errcode']) {
      if (result[key] !== undefined && (typeof result[key] !== 'number' || result[key] !== 0))
        throw error(result[key] === -14 ? 'AUTH_EXPIRED' : 'PROTOCOL_ERROR', '微信拒绝请求，请查看连接状态，必要时重新扫码。');
    }
    return result;
  }
  begin(signal) { return this.request('ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] }, authenticated: false, signal, timeout: 15000 }); }
  async pollQr(qrCode, signal) {
    try { return await this.request(`ilink/bot/get_qrcode_status?${new URLSearchParams({ qrcode: qrCode })}`, { authenticated: false, signal }); }
    catch (err) { if (err.code === 'TIMEOUT') return { status: 'wait' }; throw err; }
  }
  baseInfo() { return { channel_version: VERSION, bot_agent: `CindyWechatCompanion/${VERSION}` }; }
  lifecycle(action, signal) { return this.request(`ilink/bot/msg/notify${action}`, { body: { base_info: this.baseInfo() }, signal, timeout: 5000 }); }
  updates(cursor, signal) { return this.request('ilink/bot/getupdates', { body: { get_updates_buf: cursor, base_info: this.baseInfo() }, signal }); }
  send({ peerId, contextToken, clientId, text }, signal) {
    return this.request('ilink/bot/sendmessage', { signal, body: { base_info: this.baseInfo(), msg: {
      from_user_id: '', to_user_id: peerId, client_id: clientId, message_type: 2, message_state: 2,
      item_list: [{ type: 1, text_item: { text } }], context_token: contextToken } } });
  }
  async cdn(url, init, signal) {
    const deadline = AbortSignal.timeout(20000);
    try {
      const response = await this.fetch(tencentUrl(url), { ...init, redirect: 'manual', signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      if (!response.ok) throw error('MEDIA_HTTP_ERROR', `微信图片接口返回 HTTP ${response.status}。`);
      return response;
    } catch (err) { if (err.code) throw err; throw error(signal?.aborted ? 'CANCELLED' : 'MEDIA_NETWORK_ERROR', '微信图片传输中断，请检查连接。'); }
  }
  async downloadImage(item, signal) {
    const media = item.media; let url;
    if (typeof media?.full_url === 'string' && media.full_url) url = tencentUrl(media.full_url);
    else {
      if (typeof media?.encrypt_query_param !== 'string' || !media.encrypt_query_param || media.encrypt_query_param.length > 8192)
        throw error('INVALID_IMAGE', '微信图片缺少下载信息。');
      url = new URL('/c2c/download', CDN_ORIGIN); url.searchParams.set('encrypted_query_param', media.encrypt_query_param);
    }
    const response = await this.cdn(url, { method: 'GET' }, signal);
    const bytes = decryptImage(await readBounded(response, MAX_IMAGE_BYTES + 16), item);
    return { base64: bytes.toString('base64'), name: `wechat-image.${imageExtension(bytes)}` };
  }
  async uploadImage(peerId, bytes, signal) {
    const prepared = prepareImage(bytes);
    const result = await this.request('ilink/bot/getuploadurl', { signal, timeout: 15000, body: {
      filekey: prepared.fileKey, media_type: 1, to_user_id: peerId, rawsize: bytes.length, rawfilemd5: prepared.md5,
      filesize: prepared.ciphertext.length, no_need_thumb: true, aeskey: prepared.keyHex, base_info: this.baseInfo() } });
    let url;
    if (typeof result.upload_full_url === 'string' && result.upload_full_url.trim()) url = tencentUrl(result.upload_full_url);
    else {
      if (typeof result.upload_param !== 'string' || !result.upload_param || result.upload_param.length > 8192)
        throw error('INVALID_IMAGE', '微信未返回图片上传地址。');
      url = new URL('/c2c/upload', CDN_ORIGIN); url.searchParams.set('encrypted_query_param', result.upload_param); url.searchParams.set('filekey', prepared.fileKey);
    }
    const response = await this.cdn(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: prepared.ciphertext }, signal);
    const query = response.headers.get('x-encrypted-param'); await response.body?.cancel();
    if (response.status !== 200 || !query || query.length > 8192) throw error('INVALID_IMAGE', '微信图片上传回执不完整。');
    return { media: { encrypt_query_param: query, aes_key: Buffer.from(prepared.keyHex).toString('base64'), encrypt_type: 1 }, mid_size: prepared.ciphertext.length };
  }
  sendImage({ peerId, contextToken, clientId, image }, signal) {
    return this.request('ilink/bot/sendmessage', { signal, body: { base_info: this.baseInfo(), msg: {
      from_user_id: '', to_user_id: peerId, client_id: clientId, message_type: 2, message_state: 2,
      item_list: [{ type: 2, image_item: image }], context_token: contextToken } } });
  }
}
function decodeMessage(message) {
  if (!message || typeof message !== 'object' || (message.message_type != null && message.message_type !== 1)) return null;
  const id = typeof message.client_id === 'string' && message.client_id ? `client:${message.client_id}` :
    typeof message.message_id === 'string' && message.message_id ? `message:${message.message_id}` :
    Number.isSafeInteger(message.message_id) ? `message:${message.message_id}` :
    Number.isSafeInteger(message.seq) ? `seq:${message.seq}` : '';
  if (!id || typeof message.from_user_id !== 'string' || !message.from_user_id ||
      typeof message.context_token !== 'string' || !message.context_token) return null;
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  if (items.length > 20) throw error('BAD_RESPONSE', '单条微信消息包含过多内容。');
  let unsupported = false, hasVoice = false, errorCode; const parts = [], images = [];
  for (const item of items) {
    if (item?.type === 1 && typeof item.text_item?.text === 'string') parts.push(item.text_item.text);
    else if (item?.type === 2 && item.image_item?.media && (item.image_item.media.full_url || item.image_item.media.encrypt_query_param)) images.push(item.image_item);
    else if (item?.type === 3) hasVoice = true;
    else unsupported = true;
  }
  if (images.length > 4) { unsupported = true; errorCode = 'TOO_MANY_IMAGES'; }
  if (hasVoice) { unsupported = true; errorCode = 'VOICE_UNSUPPORTED'; }
  const text = parts.join('\n');
  return { id, text, images, hasVoice, unsupported, errorCode, peerId: message.from_user_id, contextToken: message.context_token };
}
module.exports = { IlinkClient, decodeMessage, tencentUrl, error, AUTH_ORIGIN };
