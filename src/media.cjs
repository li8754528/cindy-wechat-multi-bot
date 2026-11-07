const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('node:crypto');
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const CDN_ORIGIN = 'https://novac2c.cdn.weixin.qq.com';
const error = (code, message) => Object.assign(new Error(message), { code });
function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw error('INVALID_IMAGE', '仅支持 PNG、JPEG 或 WebP 图片。');
}
function imageBytes(base64) {
  if (typeof base64 !== 'string' || !base64 || base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
    throw error('INVALID_IMAGE', '每张图片须为 1 字节至 5 MiB。');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== base64)
    throw error('INVALID_IMAGE', '图片数据无效或超过 5 MiB。');
  imageExtension(bytes); return bytes;
}
function imageKey(item) {
  if (typeof item.aeskey === 'string' && /^[a-f\d]{32}$/i.test(item.aeskey)) return Buffer.from(item.aeskey, 'hex');
  const encoded = item.media?.aes_key;
  if (typeof encoded !== 'string' || encoded.length > 64) throw error('INVALID_IMAGE', '微信图片缺少解密密钥。');
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) throw error('INVALID_IMAGE', '微信图片密钥编码无效。');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[a-f\d]{32}$/i.test(decoded.toString('ascii'))) return Buffer.from(decoded.toString('ascii'), 'hex');
  throw error('INVALID_IMAGE', '微信图片密钥编码无效。');
}
async function readBounded(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw error('IMAGE_TOO_LARGE', '微信图片超过 5 MiB。'); }
  if (!response.body) throw error('INVALID_IMAGE', '微信图片内容为空。');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw error('IMAGE_TOO_LARGE', '微信图片超过 5 MiB。'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
function prepareImage(bytes) {
  const key = randomBytes(16), cipher = createCipheriv('aes-128-ecb', key, null);
  return { keyHex: key.toString('hex'), fileKey: randomBytes(16).toString('hex'),
    md5: createHash('md5').update(bytes).digest('hex'), ciphertext: Buffer.concat([cipher.update(bytes), cipher.final()]) };
}
function decryptImage(bytes, item) {
  try {
    const decipher = createDecipheriv('aes-128-ecb', imageKey(item), null);
    const plain = Buffer.concat([decipher.update(bytes), decipher.final()]);
    if (!plain.length || plain.length > MAX_IMAGE_BYTES) throw error('INVALID_IMAGE', '微信图片大小无效。');
    imageExtension(plain); return plain;
  } catch (err) { if (err.code === 'INVALID_IMAGE') throw err; throw error('INVALID_IMAGE', '微信图片解密失败，请重新发送。'); }
}
module.exports = { MAX_IMAGE_BYTES, CDN_ORIGIN, imageBytes, imageExtension, readBounded, prepareImage, decryptImage };
