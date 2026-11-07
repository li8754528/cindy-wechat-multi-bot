const { randomBytes } = require('node:crypto');
const VERSION = '0.1.3';
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
  baseInfo() { return { channel_version: VERSION, bot_agent: 'CindyWechatCompanion/0.1.3' }; }
  lifecycle(action, signal) { return this.request(`ilink/bot/msg/notify${action}`, { body: { base_info: this.baseInfo() }, signal, timeout: 5000 }); }
  updates(cursor, signal) { return this.request('ilink/bot/getupdates', { body: { get_updates_buf: cursor, base_info: this.baseInfo() }, signal }); }
  send({ peerId, contextToken, clientId, text }, signal) {
    return this.request('ilink/bot/sendmessage', { signal, body: { base_info: this.baseInfo(), msg: {
      from_user_id: '', to_user_id: peerId, client_id: clientId, message_type: 2, message_state: 2,
      item_list: [{ type: 1, text_item: { text } }], context_token: contextToken } } });
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
  const unsupported = items.some(item => item?.type !== 1);
  const text = items.filter(item => item?.type === 1 && typeof item.text_item?.text === 'string').map(item => item.text_item.text).join('\n');
  return { id, text, unsupported, peerId: message.from_user_id, contextToken: message.context_token };
}
module.exports = { IlinkClient, decodeMessage, tencentUrl, error, AUTH_ORIGIN };
