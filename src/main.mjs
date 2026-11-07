import { ReplyRouter, validateConfig, fail } from './core.mjs';
import { StateStore, ensureVault, unwrapNode } from './persistence.mjs';
import { readGrantedImages } from './handoff.mjs';
import { InboundImages, replyWithImages } from './transfer.mjs';
import { BindingGuides } from './binding-guides.mjs';
const inboundImages = new InboundImages();
const channel = new BroadcastChannel('wechat-companion-control-v1');
let config = { schemaVersion: 1, bots: [] };
let controlTail = Promise.resolve();
let startup, booting = false, restoreWanted = true, recoveryError = null;
let activeInstance = null;
const uiCalls = new Map();
async function node(method, params = {}, msg) {
  const response = await cindy.node.request({ method, params, timeoutMs: method === 'reply' || method === 'auth/check' ? 120000 : 45000,
    ...(method === 'reply' ? { maxTotalMs: 240000 } : {}),
    ...(msg ? { callId: msg.callId, cancelWithCall: true } : {}) });
  return unwrapNode(response);
}
const router = new ReplyRouter({ targets: cindy.targets, tasks: cindy.tasks, readImages: readGrantedImages,
  nodeReply: (params, msg) => replyWithImages(node, params, msg), rejectInbound: (requestId, code) => node('reject', { requestId, code }) });
const store = new StateStore({ fs: request => cindy.fs(request), node });
const guides = new BindingGuides({ targets: cindy.targets, persist: () => writeConfig(config),
  bindSession: (...args) => router.bindSession(...args),
  assertIdle: bot => { if (router.current.has(bot.id)) fail('GUIDE_BUSY', '请等当前微信请求结束，再发送伙伴说明。'); } });
async function writeConfig(next) {
  const response = await fetch('/kv', { method: 'PUT', body: JSON.stringify({ ...next, bindingGuides: guides.serialize(next) }) });
  if (!response.ok) fail('CONFIG_SAVE_FAILED', '配置或伙伴说明回执保存失败，请刷新状态。');
}
async function targetsReady() {
  if (typeof cindy.targets?.capabilities !== 'function') fail('UNSUPPORTED_CAPABILITY', '当前 Cindy 不支持指定伙伴，请更新宿主。');
  const caps = await cindy.targets.capabilities({});
  if (caps?.delegation?.execution !== true) fail('UNSUPPORTED_CAPABILITY', '伙伴委派执行接口不可用，请检查宿主版本与授权。');
}
async function boot() {
  const response = await fetch('/kv'); if (!response.ok) fail('CONFIG_READ_FAILED', '无法读取插件配置。');
  const saved = await response.json(); config = validateConfig(saved); router.reset(); router.setConfig(config); guides.load(saved.bindingGuides, config);
  const configured = await node('configure', { bots: config.bots }); await bindInstance(configured, true);
}
async function bindInstance(state, force = false) {
  if (!force && state.instanceId === activeInstance) return;
  activeInstance = state.instanceId; router.reset(); router.setConfig(config); inboundImages.clear();
  await node('configure', { bots: config.bots });
  try { await ensureVault(fetch); await store.restore(); recoveryError = null; }
  catch (err) { recoveryError = { code: err.code ?? 'PERSISTENCE_FAILED', message: err.code ? err.message : '恢复登录失败，请检查插件设置。' }; }
}
async function init() {
  if (!startup || restoreWanted && !booting) {
    booting = true; restoreWanted = false;
    startup = boot().finally(() => { booting = false; });
  }
  await startup;
}
async function save(next, prepareIds = []) {
  next = validateConfig(next);
  if (next.bots.some(bot => bot.enabled)) await targetsReady();
  for (const bot of next.bots.filter(bot => bot.enabled)) await cindy.targets.resolve({ target: { kind: 'bot', id: bot.companionId } });
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
    if (bot?.companionId && !router.current.has(bot.id)) try { await guides.prepare(bot); } catch { /* Saved binding remains; card offers explicit recovery. */ } }
  return snapshot();
}
async function snapshot() {
  let runtime = await node('status');
  if (runtime.instanceId !== activeInstance) { await bindInstance(runtime); runtime = await node('status'); }
  let companions = [], capabilityError = null;
  try { companions = (await cindy.targets.list({ targetKind: 'bot' })).targets; }
  catch (err) { capabilityError = { code: err.code ?? 'TARGET_UNAVAILABLE', message: '伙伴列表不可用，仍可停用或删除已有绑定。' }; }
  const bindingGuides = [];
  for (const bot of config.bots) bindingGuides.push(await guides.refresh(bot));
  return { plugin: { id: 'wechat-companion', name: '微信伙伴', version: '0.3.2' }, config, runtime, companions, bindingGuides, recoveryError, capabilityError, storageWarning: store.lastWarning };
}
async function command(action, args = {}, msg) {
  await init();
  switch (action) {
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
      const bot = { id: crypto.randomUUID(), name: `微信 Bot ${index}`, companionId: '', enabled: false };
      return { ...await save({ bots: [...config.bots, bot] }), addedBotId: bot.id };
    }
    case 'upsert_binding': {
      const previous = config.bots.find(bot => bot.id === args.id);
      const bot = { id: args.id, name: args.name, companionId: args.companion_id, enabled: args.enabled ?? previous?.enabled ?? false };
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
  if (!['list_bindings', 'save_config', 'prepare_binding', 'add_bot', 'upsert_binding', 'delete_binding', 'begin_login', 'check_login', 'disconnect_bot', 'cancel_login', 'retry_save'].includes(data.action)) return;
  if (!uiCalls.has(data.id)) {
    const pending = controlled(data.action, data.args).then(result => ({ ok: true, result }),
      error => ({ ok: false, code: error.code ?? 'PLUGIN_FAILED', message: error.code ? error.message : '插件请求失败，请稍后重试。' }));
    uiCalls.set(data.id, pending); if (uiCalls.size > 128) uiCalls.delete(uiCalls.keys().next().value);
  }
  channel.postMessage({ type: 'ui-response', id: data.id, ...await uiCalls.get(data.id) });
};
cindy.onHostMessage(async msg => {
  if (msg.type === 'event' && msg.name === 'node-status') {
    if (msg.state === 'crashed' || msg.state === 'stopped') { restoreWanted = true; activeInstance = null; inboundImages.clear(); }
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
      await guides.requireReady(bot);
      await router.receive(event);
    } catch (err) {
      inboundImages.drop(msg.params?.requestId);
      try { await node('reject', { requestId: msg.params?.requestId, code: err.code ?? 'DISPATCH_FAILED' }); } catch {}
    }
    return;
  }
  if (msg.type !== 'tool-call') return;
  try {
    await init(); let result;
    if (msg.tool === 'reply_to_wechat') {
      result = await router.reply(msg.args.request_id, msg.args.text, msg.args.session_context?.session_id, msg, msg.args.attachments);
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
