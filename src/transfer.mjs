import { fail } from './core.mjs';
export const IMAGE_CHUNK_CHARS = 192 * 1024; // < Host's 256 KiB request / 1 MiB stdout limits.
const MAX_BYTES = 5 * 1024 * 1024, MAX_BUFFER_CHARS = Math.ceil(40 * 1024 * 1024 / 3) * 4;
export class InboundImages {
  constructor() { this.pending = new Map(); this.chars = 0; }
  drop(requestId) { const entry = this.pending.get(requestId); if (entry) this.chars -= entry.chars; this.pending.delete(requestId); }
  clear(botConfigId) { for (const [id, entry] of this.pending) if (!botConfigId || entry.botConfigId === botConfigId) this.drop(id); }
  add(event) {
    for (const [id, old] of this.pending) if (Date.now() - old.createdAt > 30 * 60000) this.drop(id);
    if (typeof event.requestId !== 'string' || typeof event.botConfigId !== 'string' || !Number.isInteger(event.generation) ||
        !Number.isInteger(event.index) || event.index < 0 || event.index >= 4 || !Number.isInteger(event.seq) || event.seq < 0 || event.seq >= 36 ||
        typeof event.base64 !== 'string' || !event.base64 || event.base64.length > IMAGE_CHUNK_CHARS || event.base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.base64))
      fail('INVALID_IMAGE', '微信图片分块数据无效，请重新发送。');
    let entry = this.pending.get(event.requestId);
    if (!entry) {
      if (this.pending.size >= 256) fail('MEDIA_INBOX_FULL', '等待处理的微信图片过多，请稍后重新发送。');
      entry = { botConfigId: event.botConfigId, generation: event.generation, chunks: [], chars: 0, createdAt: Date.now() }; this.pending.set(event.requestId, entry);
    }
    if (entry.botConfigId !== event.botConfigId || entry.generation !== event.generation) fail('BINDING_CHANGED', '图片连接代次不一致，请重新发送。');
    const chunks = entry.chunks[event.index] ??= [];
    if (event.seq !== chunks.length || (chunks.length && chunks.at(-1).includes('=')) || this.chars + event.base64.length > MAX_BUFFER_CHARS ||
        chunks.length * IMAGE_CHUNK_CHARS + event.base64.length > Math.ceil(MAX_BYTES / 3) * 4)
      fail('INVALID_IMAGE', '微信图片分块顺序或大小无效，请重新发送。');
    chunks.push(event.base64); entry.chars += event.base64.length; this.chars += event.base64.length;
  }
  take(event) {
    const entry = this.pending.get(event.requestId);
    try {
      if (!Array.isArray(event.imageParts) || event.imageParts.length < 1 || event.imageParts.length > 4 || !entry ||
          entry.botConfigId !== event.botConfigId || entry.generation !== event.generation || entry.chunks.length !== event.imageParts.length)
        fail('INVALID_IMAGE', '微信图片分块不完整，请重新发送。');
      return event.imageParts.map((part, index) => {
        const chunks = entry.chunks[index];
        if (!chunks || !Number.isInteger(part.chars) || part.chars < 4 || part.chars > Math.ceil(MAX_BYTES / 3) * 4 ||
            !Number.isInteger(part.chunks) || chunks.length !== part.chunks || chunks.join('').length !== part.chars)
          fail('INVALID_IMAGE', '微信图片分块不完整，请重新发送。');
        return { base64: chunks.join(''), name: part.name };
      });
    } finally { this.drop(event.requestId); }
  }
}
export async function replyWithImages(node, params, msg) {
  if (!params.images?.length) return node('reply', params, msg);
  const { images, ...request } = params;
  try {
    await node('reply/images/begin', { requestId: request.requestId, generation: request.generation, lengths: images.map(image => image.length) }, msg);
    for (let index = 0; index < images.length; index++) {
      const image = images[index];
      for (let offset = 0, seq = 0; offset < image.length; offset += IMAGE_CHUNK_CHARS, seq++)
        await node('reply/images/chunk', { requestId: request.requestId, generation: request.generation, index, seq, base64: image.slice(offset, offset + IMAGE_CHUNK_CHARS) }, msg);
    }
  } catch (err) {
    try { await node('reply/images/clear', { requestId: request.requestId, generation: request.generation }, msg); } catch {}
    try { await node('reject', { requestId: request.requestId, code: 'IMAGE_UPLOAD_FAILED' }, msg); } catch {}
    fail('IMAGE_UPLOAD_FAILED', '图片分块交接失败，尚未发送回复，请让微信用户重新发送请求。');
  }
  try { return await node('reply', { ...request, useStagedImages: true }, msg); }
  catch (err) {
    if (err.code !== 'INVALID_IMAGE') throw err;
    try { await node('reply/images/clear', { requestId: request.requestId, generation: request.generation }, msg); } catch {}
    try { await node('reject', { requestId: request.requestId, code: 'IMAGE_UPLOAD_FAILED' }, msg); } catch {}
    fail('IMAGE_UPLOAD_FAILED', '图片分块校验失败，尚未发送回复，请让微信用户重新发送请求。');
  }
}
