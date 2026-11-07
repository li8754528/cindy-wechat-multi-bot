const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { error, tencentUrl } = require('./ilink.cjs');
const AAD = Buffer.from('wechat-companion:credentials:v1', 'utf8');
function decodeKey(secret) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(secret)) throw error('VAULT_KEY_INVALID', '登录保险库密钥缺失或损坏，请检查插件设置。');
  const key = Buffer.from(secret, 'base64');
  if (key.length !== 32) throw error('VAULT_KEY_INVALID', '登录保险库密钥无效。');
  return key;
}
function sealState(records, secret) {
  const key = decodeKey(secret), iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(AAD);
    const plaintext = Buffer.from(JSON.stringify({ version: 1, bots: records }));
    try {
      if (plaintext.length > 128 * 1024) throw error('PERSISTENCE_TOO_LARGE', '登录记录超过宿主单次传输上限，请减少 Bot 配置。');
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    } finally { plaintext.fill(0); }
  } finally { key.fill(0); }
}
function openState(envelope, secret) {
  const key = decodeKey(secret);
  try {
    if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm' ||
        !['iv', 'tag', 'ciphertext'].every(name => typeof envelope[name] === 'string') || envelope.ciphertext.length > 1024 * 1024)
      throw error('STATE_CORRUPT', '保存的登录记录格式无效，请在设置中重新登录。');
    const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw error('STATE_CORRUPT', '保存的登录记录损坏。');
    const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(AAD); decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
    let value; try { value = JSON.parse(plaintext.toString('utf8')); } finally { plaintext.fill(0); }
    if (!value || value.version !== 1 || !Array.isArray(value.bots) || value.bots.length > 32) throw error('STATE_CORRUPT', '保存的登录记录无效。');
    const ids = new Set(), accountIds = new Set();
    for (const row of value.bots) {
      if (!row || !/^[a-zA-Z0-9_-]{1,48}$/.test(row.id) || typeof row.companionId !== 'string' ||
          !row.credentials || !['token', 'botId', 'userId', 'baseUrl'].every(name => typeof row.credentials[name] === 'string' && row.credentials[name].trim() && row.credentials[name].length <= 8192) ||
          typeof row.cursor !== 'string' || row.cursor.length > 32768 || !Array.isArray(row.seen) || row.seen.length > 512 ||
          row.seen.some(id => typeof id !== 'string' || id.length > 512) || ids.has(row.id) || accountIds.has(row.credentials.botId))
        throw error('STATE_CORRUPT', '保存的登录绑定无效。');
      tencentUrl(row.credentials.baseUrl, true); ids.add(row.id); accountIds.add(row.credentials.botId);
      // Missing peers is the legacy v1 login format; it remains loadable.
      if (row.peers !== undefined && (!Array.isArray(row.peers) || row.peers.length > 8 ||
          new Set(row.peers.map(peer => peer?.peerId)).size !== row.peers.length ||
          row.peers.some(peer => !peer || typeof peer.peerId !== 'string' || !peer.peerId || peer.peerId.length > 512 ||
            typeof peer.contextToken !== 'string' || !peer.contextToken || peer.contextToken.length > 8192 ||
            !Number.isSafeInteger(peer.receivedAt) || peer.receivedAt < 0)))
        throw error('STATE_CORRUPT', '保存的微信联系人上下文无效。');
    }
    return value.bots;
  } catch (err) { if (err.code === 'VAULT_KEY_INVALID') throw err; throw error('STATE_CORRUPT', '保存的登录记录无法解密；请在插件设置中重新登录。'); }
  finally { key.fill(0); }
}
module.exports = { sealState, openState };
