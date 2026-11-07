import { fail } from './core.mjs';
const LIMIT = 5 * 1024 * 1024;
// Only Host-granted hashes are accepted. The same-origin media endpoint checks ownership.
export async function readGrantedImages(refs, fetchImpl = fetch) {
  if (!Array.isArray(refs) || refs.length > 4 || refs.some(ref => typeof ref !== 'string' || !/^[a-f0-9]{64}$/.test(ref)))
    fail('INVALID_IMAGE', '请通过 ghost_call 顶层 attachments 交接 1–4 张图片。');
  const images = [];
  for (const ref of refs) {
    let response;
    for (const ext of ['png', 'jpg', 'webp', 'jpeg']) {
      const candidate = await fetchImpl(`/media/${ref}.${ext}`, { signal: AbortSignal.timeout(15000) });
      if (candidate.ok) { response = candidate; break; }
      if (candidate.status !== 404) fail('IMAGE_READ_FAILED', '读取交接图片失败，请检查插件授权。');
    }
    if (!response) fail('IMAGE_UNAVAILABLE', '图片未交给当前插件或已不可用，请重新交接。');
    if (Number(response.headers.get('content-length')) > LIMIT || !response.body) { await response.body?.cancel(); fail('INVALID_IMAGE', '每张图片须为 1 字节至 5 MiB。'); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > LIMIT) { await reader.cancel(); fail('INVALID_IMAGE', '图片超过 5 MiB。'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (!size) fail('INVALID_IMAGE', '图片内容为空。');
    let binary = '';
    for (const chunk of chunks) for (let i = 0; i < chunk.length; i += 32768) binary += String.fromCharCode(...chunk.subarray(i, i + 32768));
    images.push(btoa(binary));
  }
  return images;
}
