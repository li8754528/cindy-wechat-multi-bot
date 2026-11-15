import { ReplyRouter, validateConfig, fail } from './core.mjs';
import { StateStore, ensureVault, unwrapNode } from './persistence.mjs';
import { readGrantedImages } from './handoff.mjs';
import { InboundImages, replyWithImages } from './transfer.mjs';
import { BindingGuides } from './binding-guides.mjs';
import { BotMemory, loadBotMemory, persistBotMemory } from './bot-memory.mjs';
import { executionReady, botExecution, botProjectMode } from './project-settings.mjs';
const inboundImages = new InboundImages();
const channel = new BroadcastChannel('wechat-companion-control-v1');
let config = { schemaVersion: 1, bots: [] };
let controlTail = Promise.resolve();
let startup, booting = false, restoreWanted = true, recoveryError = null;
let activeInstance = null;
let memories = new BotMemory(), projectSessions = [], configLoad;
let legacyMemories = {}, memoryErrors = {};
let startupError = null;
let pendingConfiguration = false;
const uiCalls = new Map();
const memoryCalls = new Map();
async function node(method, params = {}, msg) {
  const response = await cindy.node.request({ method, params, timeoutMs: method === 'reply' || method === 'auth/check' ? 120000 : 45000,
    ...(method === 'reply' ? { maxTotalMs: 240000 } : {}),
    ...(msg ? { callId: msg.callId, cancelWithCall: true } : {}) });
  return unwrapNode(response);
}
const router = new ReplyRouter({ targets: cindy.targets, tasks: cindy.tasks, readImages: readGrantedImages,
  onProjectSession: sessionId => {
    const pending = controlTail.then(async () => {
      if (!projectSessions.includes(sessionId)) projectSessions.push(sessionId);
      await writeConfig(config);
    });
    controlTail = pending.catch(() => {}); return pending;
  },
  beforeDispatch: entry => {
    if (entry.execution) {
      if (memoryErrors[entry.botConfigId]) fail('MEMORY_READ_FAILED', '此 Bot 的记忆读取失败，请在插件设置中检查或清空后重发。');
      const memory = memories.get(entry.botConfigId);
      entry.memory ??= memory.text; entry.memoryRevision ??= memory.revision; return;
    }
    return guides.requireReady(config.bots.find(bot => bot.id === entry.botConfigId));
  },
  nodeReply: (params, msg) => replyWithImages(node, params, msg), rejectInbound: (requestId, code) => node('reject', { requestId, code }) });
const store = new StateStore({ fs: request => cindy.fs(request), node });
const guides = new BindingGuides({ targets: cindy.targets, persist: () => writeConfig(config),
  bindSession: (...args) => router.bindSession(...args),
  assertIdle: bot => { if (router.current.has(bot.id)) fail('GUIDE_BUSY', '请等当前微信请求结束，再发送伙伴说明。'); } });
async function writeConfig(next) {
  const response = await fetch('/kv', { method: 'PUT', body: JSON.stringify({ ...next, botMemories: legacyMemories, projectSessions, bindingGuides: guides.serialize(next) }) });
  if (!response.ok) fail('CONFIG_SAVE_FAILED', '配置或伙伴说明回执保存失败，请刷新状态。');
}
async function targetsReady() {
  if (typeof cindy.targets?.capabilities !== 'function') fail('UNSUPPORTED_CAPABILITY', '当前 Cindy 不支持指定伙伴，请更新宿主。');
  const caps = await cindy.targets.capabilities({});
  if (caps?.delegation?.execution !== true) fail('UNSUPPORTED_CAPABILITY', '伙伴委派执行接口不可用，请检查宿主版本与授权。');
}
async function readConfig() {
  const response = await fetch('/kv'); if (!response.ok) fail('CONFIG_READ_FAILED', '无法读取插件配置。');
  const saved = await response.json(); config = validateConfig(saved); router.reset(); router.setConfig(config); guides.load(saved.bindingGuides, config);
  memories = new BotMemory(saved.botMemories); legacyMemories = { ...memories.records }; memoryErrors = {}; projectSessions = saved.projectSessions ?? [];
  for (const bot of config.bots) {
    try { await loadBotMemory(request => cindy.fs(request), bot.id, memories); }
    catch (error) { memoryErrors[bot.id] = '记忆读取失败，可清空此 Bot 的记忆后重试。'; }
  }
  if (saved.botMemories && Object.keys(saved.botMemories).length) {
    for (const id of Object.keys(legacyMemories)) if (!memoryErrors[id]) {
      try { await persistBotMemory(request => cindy.fs(request), id, memories); delete legacyMemories[id]; }
      catch { memoryErrors[id] = '旧记忆迁移失败，原内容仍保留，请检查文件权限。'; }
    }
    await writeConfig(config);
  }
}
function loadConfig() { return configLoad ??= readConfig().catch(e => { configLoad = null; throw e; }); }
async function boot() {
  await loadConfig();
  const configured = await node('configure', { bots: config.bots }); await bindInstance(configured, true);
}
async function bindInstance(state, force = false) {
  if (!force && state.instanceId === activeInstance) return;
  activeInstance = state.instanceId; router.reset(); router.setConfig(config); inboundImages.clear();
  // Resetting the worker must retain the host-issued companion session mapping.
  guides.load(guides.serialize(config), config);
  await node('configure', { bots: config.bots });
  try { await ensureVault(fetch); await store.restore(); recoveryError = null; }
  catch (err) { recoveryError = { code: err.code ?? 'PERSISTENCE_FAILED', message: err.code ? err.message : '恢复登录失败，请检查插件设置。' }; }
}
async function init() {
  if (!startup || restoreWanted && !booting) {
    booting = true; restoreWanted = false;
    startup = boot().then(() => { startupError = null; }).catch(error => {
      restoreWanted = true; startupError = { code: error.code ?? 'NODE_START_FAILED', message: error.message }; throw error;
    }).finally(() => { booting = false; });
  }
  await startup;
  if (pendingConfiguration) {
    const next = config;
    const applied = await node('configure', { bots: next.bots });
    if (applied.instanceId !== activeInstance) await bindInstance(applied);
    if (config === next) pendingConfiguration = false;
  }
}
async function save(next, prepareIds = []) {
  next = { ...config, ...next };
  next = validateConfig(next);
  for (const bot of next.bots.filter(bot => bot.enabled)) {
    const execution = botExecution(bot, next.execution);
    if (execution) await cindy.targets.resolve({ target: { kind: 'project', id: execution.project } });
    else if (!botProjectMode(bot, next.execution)) { await targetsReady(); await cindy.targets.resolve({ target: { kind: 'bot', id: bot.companionId } }); }
  }
  await writeConfig(next);
  for (const bot of config.bots) {
    const replacement = next.bots.find(item => item.id === bot.id);
    if (!replacement?.enabled || replacement.companionId !== bot.companionId) inboundImages.clear(bot.id);
  }
  config = next; router.setConfig(config); const applied = await node('configure', { bots: config.bots }); await bindInstance(applied);
  for (const [id, record] of guides.records) if (!config.bots.some(bot => bot.id === id && bot.companionId === record.companionId)) guides.records.delete(id);
  if (recoveryError && !config.bots.length) { await store.clear(); await node('state/initialize'); }
  else if (recoveryError) return snapshot();
  await ensureVault(fetch); await store.flush(); recoveryError = null;
  for (const id of prepareIds) { const bot = config.bots.find(bot => bot.id === id);
    if (bot && botProjectMode(bot, config.execution)) continue;
    if (bot?.companionId && !router.current.has(bot.id)) try { await guides.prepare(bot); } catch { /* Saved binding remains; card offers explicit recovery. */ } }
  return snapshot();
}
async function snapshot() {
  if (booting && startup) {
    let timer;
    try { await Promise.race([startup.catch(() => {}), new Promise(resolve => { timer = globalThis.setTimeout(resolve, 250); })]); }
    finally { if (timer !== undefined) globalThis.clearTimeout(timer); }
  }
  let runtime = { bots: config.bots.map(bot => ({ id: bot.id, status: 'starting', connected: false })) };
  if (activeInstance && !booting) {
    try { runtime = await node('status'); if (runtime.instanceId !== activeInstance) { await bindInstance(runtime); runtime = await node('status'); } }
    catch (error) { startupError = { code: error.code ?? 'NODE_START_FAILED', message: error.message }; activeInstance = null; restoreWanted = true; }
  }
  if (!activeInstance && !booting && !startupError) void init().catch(() => {});
  let companions = [], capabilityError = null;
  try { companions = (await cindy.targets.list({ targetKind: 'bot' })).targets; }
  catch (err) { capabilityError = { code: err.code ?? 'TARGET_UNAVAILABLE', message: '伙伴列表不可用，仍可停用或删除已有绑定。' }; }
  const bindingGuides = [];
  for (const bot of config.bots) if (!botProjectMode(bot, config.execution)) bindingGuides.push(await guides.refresh(bot));
  return { plugin: { id: 'wechat-companion', name: '微信伙伴', version: '0.4.3' }, config, runtime, nodeStarting: booting, companions, bindingGuides, memories: config.bots.map(bot => ({ ...memories.status(bot.id), error: memoryErrors[bot.id] })), startupError, dispatchRetries: router.pendingRetries(), recoveryError, capabilityError, storageWarning: store.lastWarning };
}
async function command(action, args = {}, msg) {
  await loadConfig();
  if (!['save_bot_route', 'retry_connection', 'pick_project', 'list_projects', 'pick_model', 'save_execution', 'clear_memory', 'list_bindings'].includes(action)) await init();
  switch (action) {
    case 'retry_connection': startupError = null; restoreWanted = true; void init().catch(() => {}); return snapshot();
    case 'list_projects': return cindy.targets.list({ targetKind: 'project' });
    case 'pick_project': {
      if (typeof cindy.workspace !== 'function') fail('UNSUPPORTED_CAPABILITY', '当前 Cindy 不支持选择项目目录，请更新后重试。');
      const picked = await cindy.workspace({ kind: 'ensure-session', mode: 'pick', title: '微信伙伴默认项目', focus: false, ...(msg?.mobilePageId ? { mobilePageId: msg.mobilePageId } : {}) });
      if (!picked.ok) return picked;
      const listed = await cindy.targets.list({ targetKind: 'task' });
      const project = listed.targets.find(target => target.id === picked.sessionId)?.detail;
      if (!project) fail('TARGET_UNAVAILABLE', '目录已选择，但项目尚未登记。请在 Cindy 添加该项目后刷新列表。');
      for (let attempt = 0; attempt < 3; attempt++) {
        try { const result = await command('save_execution', { project }, msg); return { ok: true, ...result }; }
        catch (error) {
          if (error.code !== 'TARGET_UNAVAILABLE') throw error;
          if (attempt === 2) fail('TARGET_UNAVAILABLE', `目录已选中但尚未登记为可用项目：${project}。请在 Cindy 中添加该项目后刷新列表。`);
          await new Promise(resolve => globalThis.setTimeout(resolve, 200));
        }
      }
    }
    case 'pick_model': {
      if (typeof cindy.pickModel !== 'function') fail('UNSUPPORTED_CAPABILITY', '当前 Cindy 不支持模型选择器，请更新后重试。');
      const bot = args.id ? config.bots.find(bot => bot.id === args.id) : null;
      if (args.id && !bot) fail('BOT_NOT_FOUND', 'Bot 不存在。');
      const route = bot?.execution?.route || config.execution?.route;
      return cindy.pickModel({ allowRemote: false, ...(route ? { initial: route } : {}), ...(msg?.mobilePageId ? { mobilePageId: msg.mobilePageId } : {}) });
    }
    case 'save_bot_route': {
      const previous = config.bots.find(bot => bot.id === args.id);
      if (!previous) fail('BOT_NOT_FOUND', 'Bot 不存在。');
      if (router.current.has(previous.id)) fail('ROUTE_BUSY', '请等此 Bot 当前请求结束，再修改回答方式或模型。');
      const bot = { ...previous, ...(args.mode !== undefined ? { mode: args.mode } : {}),
        ...(args.companionId !== undefined ? { companionId: args.companionId } : {}),
        ...(args.execution !== undefined ? { execution: args.execution } : {}) };
      if (bot.mode === 'project' && !bot.companionId) bot.companionId = `project-${bot.id}`;
      if (bot.mode === 'companion' && (!bot.companionId || bot.companionId === `project-${bot.id}`)) fail('INVALID_CONFIG', '请先选择一位回答伙伴。');
      const next = validateConfig({ ...config, bots: config.bots.map(item => item.id === bot.id ? bot : item) });
      if (bot.mode === 'companion') await cindy.targets.resolve({ target: { kind: 'bot', id: bot.companionId } });
      const execution = botExecution(bot, next.execution);
      if (execution) await cindy.targets.resolve({ target: { kind: 'project', id: execution.project } });
      await writeConfig(next); config = next; router.setConfig(config);
      if (previous.companionId !== bot.companionId || previous.enabled !== next.bots.find(item => item.id === bot.id).enabled) pendingConfiguration = true;
      return { config };
    }
    case 'save_execution': {
      const next = validateConfig({ ...config, execution: { project: '', route: null, ...config.execution, ...args } });
      if (next.execution.project) await cindy.targets.resolve({ target: { kind: 'project', id: next.execution.project } });
      let needsConfigure = false;
      if (executionReady(next.execution)) for (const bot of next.bots) if (!bot.companionId && bot.mode !== 'companion') {
        bot.companionId = `project-${bot.id}`; needsConfigure = true;
      }
      await writeConfig(next); config = next; router.setConfig(config);
      if (needsConfigure) pendingConfiguration = true;
      return { config };
    }
    case 'clear_memory': {
      if (!config.bots.some(bot => bot.id === args.id)) fail('BOT_NOT_FOUND', '请选择已有 Bot。');
      const previous = memories.records[args.id]; memories.clear(args.id);
      try { await persistBotMemory(request => cindy.fs(request), args.id, memories); } catch (e) { if (previous) memories.records[args.id] = previous; else delete memories.records[args.id]; throw e; }
      delete memoryErrors[args.id]; delete legacyMemories[args.id];
      return { memory: memories.status(args.id) };
    }
    case 'read_wechat_memory':
    case 'remember_wechat': {
      const sessionId = msg?.args?.session_context?.session_id;
      const candidates = [...router.current.values()].map(id => router.requests.get(id)).filter(entry => entry?.execution && entry.state === 'accepted' && entry.sessionId === sessionId);
      if (!sessionId || candidates.length !== 1) fail('WRONG_COMPANION', '当前会话没有唯一有效的微信请求。');
      const entry = candidates[0];
      if (Date.now() - entry.createdAt > 30 * 60000) fail('REQUEST_EXPIRED', '当前微信请求已过期。');
      if (msg?.callId) {
        const pinned = memoryCalls.get(msg.callId);
        if (pinned && (pinned.requestId !== entry.requestId || pinned.sessionId !== sessionId)) fail('WRONG_COMPANION', '不能将旧调用转到新的微信请求。');
        memoryCalls.set(msg.callId, { requestId: entry.requestId, sessionId });
        if (memoryCalls.size > 512) memoryCalls.delete(memoryCalls.keys().next().value);
      }
      if (args.request_id !== undefined && args.request_id !== entry.requestId) fail('WRONG_COMPANION', '只能操作本轮微信请求的记忆。');
      if (!entry?.execution || entry.state !== 'accepted' || entry.sessionId !== msg?.args?.session_context?.session_id || router.current.get(entry.botConfigId) !== entry.requestId)
        fail('WRONG_COMPANION', '只能更新当前微信请求所属 Bot 的记忆。');
      if (action === 'read_wechat_memory') return { text: memories.get(entry.botConfigId).text };
      if (typeof args.text !== 'string' || args.text.length > 4000) fail('INVALID_INPUT', '记忆最多 4000 字符。');
      if (entry.memoryRevision !== memories.get(entry.botConfigId).revision) fail('MEMORY_CLEARED', '此 Bot 的记忆已被手动清空，旧请求不能重新写回。');
      const previous = memories.records[entry.botConfigId]; memories.set(entry.botConfigId, args.text);
      try { await persistBotMemory(request => cindy.fs(request), entry.botConfigId, memories); } catch (e) { if (previous) memories.records[entry.botConfigId] = previous; else delete memories.records[entry.botConfigId]; throw e; }
      return { saved: true };
    }
    case 'list_bindings': return snapshot();
    case 'save_config': return save(args, args.bots?.filter(bot => bot.companionId).map(bot => bot.id));
    case 'prepare_binding': {
      const bot = config.bots.find(bot => bot.id === args.id);
      if (!bot) fail('BOT_NOT_FOUND', '请先选择一组已保存的 Bot。');
      await guides.prepare(bot, args.retry === true); return snapshot();
    }
    case 'add_bot': {
      if (config.bots.length >= 32) fail('INVALID_CONFIG', '最多添加 32 个 Bot，请先删除不再使用的 Bot。');
      let index = 1;
      while (config.bots.some(bot => bot.name === `微信 Bot ${index}`)) index++;
      const id = crypto.randomUUID();
      const bot = { id, name: `微信 Bot ${index}`, companionId: executionReady(config.execution) ? `project-${id}` : '', enabled: executionReady(config.execution) };
      return { ...await save({ bots: [...config.bots, bot] }), addedBotId: bot.id };
    }
    case 'upsert_binding': {
      const previous = config.bots.find(bot => bot.id === args.id);
      const bot = { ...previous, id: args.id, name: args.name, companionId: args.companion_id, enabled: args.enabled ?? previous?.enabled ?? false };
      return save({ bots: [...config.bots.filter(item => item.id !== bot.id), bot] }, [bot.id]);
    }
    case 'delete_binding': return save({ bots: config.bots.filter(bot => bot.id !== args.id) });
    case 'begin_login': {
      if (!config.bots.some(bot => bot.id === args.id)) fail('BOT_NOT_FOUND', '请先添加 Bot 配置。');
      await ensureVault(fetch);
      const recovering = !!recoveryError;
      if (recovering) await node('state/initialize');
      return node('auth/begin', { id: args.id }, msg);
    }
    case 'check_login': {
      const result = await node('auth/check', { id: args.id }, msg);
      if (result.status === 'storage_error') { await store.flush(); return (await node('status')).bots.find(bot => bot.id === args.id); }
      return result;
    }
    case 'disconnect_bot':
      inboundImages.clear(args.id);
      return store.disconnect(args.id, state => router.cancelBot(args.id, state.generation), msg);
    case 'cancel_login': return node('auth/cancel', { id: args.id }, msg);
    case 'retry_save': await ensureVault(fetch); await store.flush(); recoveryError = null; return snapshot();
    default: fail('UNKNOWN_ACTION', '此操作不存在。');
  }
}
// Configuration mutations and QR steps serialize; signed reply tools remain independent.
function controlled(action, args, msg) {
  const pending = controlTail.then(() => command(action, args, msg));
  controlTail = pending.catch(() => {}); return pending;
}
channel.onmessage = async ({ data }) => {
  if (data?.type !== 'ui-request' || typeof data.id !== 'string') return;
  if (!['save_bot_route', 'retry_connection', 'pick_project', 'clear_memory', 'list_projects', 'pick_model', 'save_execution', 'list_bindings', 'save_config', 'prepare_binding', 'add_bot', 'upsert_binding', 'delete_binding', 'begin_login', 'check_login', 'disconnect_bot', 'cancel_login', 'retry_save'].includes(data.action)) return;
  if (!uiCalls.has(data.id)) {
    const pending = controlled(data.action, data.args, { mobilePageId: data.mobilePageId }).then(result => ({ ok: true, result }),
      error => ({ ok: false, code: error.code ?? 'PLUGIN_FAILED', message: error.code ? error.message : '插件请求失败，请稍后重试。' }));
    uiCalls.set(data.id, pending); if (uiCalls.size > 128) uiCalls.delete(uiCalls.keys().next().value);
  }
  channel.postMessage({ type: 'ui-response', id: data.id, ...await uiCalls.get(data.id) });
};
cindy.onHostMessage(async msg => {
  if (msg.type === 'event' && msg.name === 'node-status') {
    if (msg.state === 'crashed' || msg.state === 'stopped') { restoreWanted = true; activeInstance = null; inboundImages.clear(); router.reset(); }
    if (msg.state === 'starting' && restoreWanted && !booting) void init().catch(() => {});
    return;
  }
  if (msg.type === 'event' && msg.name === 'node-notification' && msg.params?.instanceId !== activeInstance) return;
  if (msg.type === 'event' && msg.name === 'node-notification' && msg.method === 'wechat/connection-reset') {
    router.cancelBot(msg.params.botConfigId, msg.params.generation); inboundImages.clear(msg.params.botConfigId); return;
  }
  if (msg.type === 'event' && msg.name === 'node-notification' && msg.method === 'wechat/image-chunk') {
    try { inboundImages.add(msg.params); } catch (err) {
      inboundImages.drop(msg.params.requestId);
      try { await node('reject', { requestId: msg.params.requestId, code: err.code ?? 'INVALID_IMAGE' }); } catch {}
    }
    return;
  }
  if (msg.type === 'event' && msg.name === 'node-notification' && msg.method === 'wechat/state-changed') {
    let ok = false;
    try { await store.flush(); ok = true; recoveryError = null; }
    catch (err) { recoveryError = { code: err.code ?? 'PERSISTENCE_FAILED', message: '微信登录或游标保存失败，请检查插件存储权限。' }; }
    try { await node('state/ack', { checkpointId: msg.params.checkpointId, instanceId: activeInstance, ok }); } catch {}
    return;
  }
  if (msg.type === 'event' && msg.name === 'node-notification' && msg.method === 'wechat/inbound') {
    try {
      await init();
      const { imageParts, ...event } = msg.params;
      if (imageParts) event.attachments = inboundImages.take(msg.params);
      const bot = config.bots.find(bot => bot.id === event.botConfigId);
      if (!bot?.enabled) fail('BINDING_CHANGED', 'Bot 未启用聊天。');
      await router.receive(event);
    } catch (err) {
      inboundImages.drop(msg.params?.requestId);
      try { await node('reject', { requestId: msg.params?.requestId, code: err.code ?? 'DISPATCH_FAILED' }); } catch {}
    }
    return;
  }
  if (msg.type !== 'tool-call') return;
  try {
    await loadConfig(); let result;
    if (projectSessions.includes(msg.args.session_context?.session_id) && !['reply_to_wechat', 'remember_wechat', 'read_wechat_memory'].includes(msg.tool))
      fail('WRONG_COMPANION', '微信项目任务只能回传当前请求或更新自身记忆。');
    if (msg.tool === 'reply_to_wechat') {
      await init();
      result = await router.reply(msg.args.request_id, msg.args.text, msg.args.session_context?.session_id, msg, msg.args.attachments);
    } else if (msg.tool === 'send_to_wechat') {
      await init();
      if (projectSessions.includes(msg.args.session_context?.session_id)) fail('WRONG_COMPANION', '微信项目任务只能回传当前请求，不能主动发送。');
      result = await router.send(msg.args, msg.args.session_context?.session_id, msg,
        (params, context) => node('send/prepare', params, context));
    } else result = await controlled(msg.tool, msg.args, msg);
    const images = result?.qrPngBase64 ? [{ data: result.qrPngBase64 }] : undefined;
    if (images) { const { qrPngBase64, ...metadata } = result; result = metadata; }
    await cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result, ...(images ? { images } : {}) });
  } catch (error) {
    await cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, errorCode: error.code ?? 'PLUGIN_FAILED',
      message: error.code ? error.message : '微信伙伴请求失败，请查看插件连接状态。' });
  }
});
void init().catch(() => {});
