// A revision fence prevents an in-flight task from restoring a cleared summary.
export class BotMemory {
  constructor(saved = {}) {
    this.records = Object.create(null);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    for (const [id, record] of Object.entries(saved)) {
      if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id) || !record || typeof record.text !== 'string' || record.text.length > 4000) continue;
      this.records[id] = { text: record.text, revision: Number.isSafeInteger(record.revision) ? record.revision : 0, updatedAt: record.updatedAt ?? null };
    }
  }
  get(id) { return this.records[id] ?? { text: '', revision: 0, updatedAt: null }; }
  set(id, text) { this.records[id] = { text, revision: this.get(id).revision, updatedAt: Date.now() }; }
  clear(id) { this.records[id] = { text: '', revision: this.get(id).revision + 1, updatedAt: Date.now() }; }
  status(id) { const r = this.get(id); return { id, characters: r.text.length, updatedAt: r.updatedAt }; }
}

export const memoryPath = id => {
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id)) throw new Error('无效 Bot 标识');
  return `bot-memory-${id}.json`;
};
export async function loadBotMemory(fs, id, memory) {
  const result = await fs({ op: 'read', root: 'data', path: memoryPath(id) });
  if (result.errorCode === 'NOT_FOUND') return;
  if (!result.ok) throw Object.assign(new Error('读取 Bot 记忆失败，请检查插件文件权限。'), { code: 'MEMORY_READ_FAILED' });
  const saved = JSON.parse(result.content);
  if (!saved || typeof saved.text !== 'string' || saved.text.length > 4000)
    throw Object.assign(new Error('Bot 记忆文件无效，未覆盖原文件。'), { code: 'MEMORY_READ_FAILED' });
  memory.records[id] = new BotMemory({ [id]: saved }).get(id);
}
export async function persistBotMemory(fs, id, memory) {
  const result = await fs({ op: 'write', root: 'data', path: memoryPath(id), content: JSON.stringify(memory.get(id)) });
  if (!result.ok) throw Object.assign(new Error('保存 Bot 记忆失败，请检查插件文件权限。'), { code: 'MEMORY_SAVE_FAILED' });
}
