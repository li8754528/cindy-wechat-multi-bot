import { fail } from './core.mjs';
export const VAULT_KEY = 'wechat_vault_key';
const PATH = 'credentials-v1.json';
export function unwrapNode(response) {
  if (response?.ok !== true) {
    let code = response?.data?.code ?? response?.errorCode ?? 'NODE_FAILED';
    if (['TIMEOUT', 'INTERNAL', 'GHOST_NOT_FOUND', 'GHOST_ASLEEP', 'GHOST_CRASHED'].includes(code)) code = `NODE_${code}`;
    fail(code, response?.message ?? '微信工作进程请求失败，请查看连接状态。');
  }
  return response.result;
}
// The generated key is immediately handed to Host safeStorage; never sent to Node as params.
export async function ensureVault(fetchImpl, cryptoImpl = crypto) {
  const response = await fetchImpl('/secrets');
  if (!response.ok) fail('VAULT_UNAVAILABLE', '无法读取登录保险库状态，请打开插件设置。');
  const states = await response.json();
  if (!Array.isArray(states)) fail('VAULT_UNAVAILABLE', '登录保险库状态无效。');
  if (states.some(item => item.key === VAULT_KEY && item.saved)) return;
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(32));
  let value = btoa(String.fromCharCode(...bytes)); bytes.fill(0);
  try {
    const result = await fetchImpl(`/secrets/${VAULT_KEY}`, { method: 'PUT', body: JSON.stringify({ value }) });
    if (!result.ok) fail('VAULT_UNAVAILABLE', '无法初始化登录保险库，请打开插件设置后再登录。');
  } finally { value = ''; }
}
export class StateStore {
  constructor({ fs, node }) { this.fs = fs; this.node = node; this.tail = Promise.resolve(); this.lastWarning = null; }
  async read() {
    const result = await this.fs({ op: 'read', root: 'data', path: PATH });
    if (result.errorCode === 'NOT_FOUND') return null;
    if (!result.ok) fail('PERSISTENCE_FAILED', '读取保存的微信登录失败。');
    try { return JSON.parse(result.content); } catch { fail('STATE_CORRUPT', '保存的微信登录记录损坏，请重新登录。'); }
  }
  async restore() { const envelope = await this.read(); return envelope ? this.node('state/load', { envelope }) : this.node('state/initialize'); }
  async clear() {
    const result = await this.fs({ op: 'delete', root: 'data', path: PATH });
    if (!result.ok) fail('PERSISTENCE_FAILED', '清除保存的登录失败，请检查插件存储权限。');
  }
  async writeSnapshot() {
      const state = await this.node('state/seal');
      if (!state.hasCredentials) {
        const result = await this.fs({ op: 'delete', root: 'data', path: PATH });
        if (!result.ok) fail('PERSISTENCE_FAILED', '删除保存的登录失败，请在设置页检查。');
      } else {
        const result = await this.fs({ op: 'write', root: 'data', path: PATH, content: JSON.stringify(state.envelope) });
        if (!result.ok) fail('PERSISTENCE_FAILED', '微信已登录但保存失败，请检查插件存储权限。');
      }
      // File write/delete is the commit boundary. A lost status ACK cannot undo it.
      try { await this.node('state/saved', {}); this.lastWarning = null; return { saved: true }; }
      catch { this.lastWarning = 'STATE_SYNC_FAILED'; return { saved: true, warning: this.lastWarning }; }
  }
  enqueue(work) {
    const pending = this.tail.then(work);
    this.tail = pending.catch(() => {}); return pending;
  }
  flush() { return this.enqueue(() => this.writeSnapshot()); }
  disconnect(id, onPrepared, callContext) {
    return this.enqueue(async () => {
      try {
        const prepared = await this.node('disconnect/prepare', { id }, callContext);
        onPrepared(prepared); await this.writeSnapshot();
      }
      catch {
        try { const restored = await this.node('disconnect/rollback', { id }); onPrepared(restored); } catch { fail('DISCONNECT_UNCERTAIN', '保存清理失败且连接状态不确定，请刷新检查；重启可能恢复原登录。'); }
        fail('PERSISTENCE_FAILED', '断开未完成：保存记录清理失败，当前连接仍保留；保存文件可能受损，重启后请检查登录状态，必要时重新扫码。');
      }
      try { return await this.node('disconnect', { id }, callContext); }
      catch { fail('DISCONNECT_UNCERTAIN', '保存的登录已清除，但当前连接关闭结果未知，请刷新检查；重启不会恢复此组。'); }
    });
  }
}
