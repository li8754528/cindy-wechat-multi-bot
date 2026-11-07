const channel = new BroadcastChannel('wechat-companion-control-v1'), pending = new Map();
let view = { config: { bots: [] }, runtime: { bots: [] }, companions: [] }, loginId = null, loginGeneration = 0;
const $ = id => document.getElementById(id);
const labels = { disconnected: '未登录', waiting_scan: '等待扫码', scanned: '已扫码，等待确认', connected: '已连接',
  paused: '已登录，收发停用', qr_expired: '二维码已过期', error: '连接出错', reconnecting: '正在重连', needs_login: '请重新登录', login_requires_action: '需要微信侧处理', storage_error: '保存失败，请检查存储权限', saving_login: '正在安全保存登录', disconnecting: '正在清理保存的登录' };
const messageErrors = { VOICE_TRANSCRIPT_MISSING: '微信未返回语音识别文字，请重新发语音或改发文字',
  TOO_MANY_IMAGES: '单条最多 4 张图片，请分开发送', MEDIA_INBOX_FULL: '等待处理的图片过多，请稍后重发',
  INVALID_IMAGE: '图片无效或解密失败，请重发 PNG/JPEG/WebP 图片', IMAGE_TOO_LARGE: '图片超过 5 MiB，请压缩后重发',
  IMAGE_UPLOAD_FAILED: '图片上传失败，尚未发送回复，请重新发送请求', IMAGE_DOWNLOAD_FAILED: '图片下载失败，请重新发送图片',
  MEDIA_NETWORK_ERROR: '图片传输中断，请检查网络后重发', MEDIA_HTTP_ERROR: '微信图片接口出错，请稍后重发',
  DELIVERY_UNCERTAIN: '回复发送结果不确定，请在微信检查，不能自动重发', UNSUPPORTED_MESSAGE: '消息包含不支持的内容，请改发文字或图片' };
channel.onmessage = ({ data }) => {
  if (data?.type !== 'ui-response') return; const item = pending.get(data.id); if (!item) return;
  clearInterval(item.resend); clearTimeout(item.timeout); pending.delete(data.id);
  if (data.ok) item.resolve(data.result); else item.reject(new Error(data.message ?? '请求失败，请稍后重试。'));
};
async function request(action, args = {}) {
  const wake = await fetch('/wake'); if (!wake.ok) throw new Error('无法唤醒插件，请在 Cindy 插件页启用它。');
  const id = crypto.randomUUID(), data = { type: 'ui-request', id, action, args };
  return new Promise((resolve, reject) => {
    const resend = setInterval(() => channel.postMessage(data), 1500);
    const timeout = setTimeout(() => { clearInterval(resend); pending.delete(id); reject(new Error('请求尚未返回，请刷新状态确认结果。')); }, 180000);
    pending.set(id, { resolve, reject, resend, timeout }); channel.postMessage(data);
  });
}
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
function element(tag, text, cls) { const item = document.createElement(tag); item.textContent = text; if (cls) item.className = cls; return item; }
function resetForm() { $('binding-form').reset(); $('binding-id').value = ''; }
async function refresh() { view = await request('list_bindings'); render(); return view; }
function render() {
  const selected = $('companion').value; $('companion').replaceChildren();
  for (const c of view.companions) { const option = element('option', c.label); option.value = c.id; $('companion').append(option); }
  for (const bot of view.config.bots) if (!view.companions.some(c => c.id === bot.companionId)) {
    const option = element('option', `${bot.name} 的伙伴（暂不可用，可停用或删除）`); option.value = bot.companionId; $('companion').append(option);
  }
  if (view.companions.some(c => c.id === selected)) $('companion').value = selected;
  $('bots').replaceChildren();
  if (!view.config.bots.length) $('bots').append(element('p', '还没有绑定。先选择伙伴并保存，再扫码登录。'));
  for (const bot of view.config.bots) {
    const state = view.runtime.bots.find(item => item.id === bot.id), companion = view.companions.find(item => item.id === bot.companionId);
    const box = element('div', '', 'bot'); box.append(element('strong', bot.name));
    box.append(element('p', `伙伴：${companion?.label ?? '伙伴不可用'} · ${labels[state?.status] ?? state?.status ?? '未登录'}`, 'meta'));
    box.append(element('p', `收到 ${state?.stats?.received ?? 0} · 回传 ${state?.stats?.delivered ?? 0}${state?.lastErrorCode ? ` · ${state.lastErrorCode}` : ''}`, 'meta'));
    if (messageErrors[state?.lastErrorCode]) box.append(element('p', messageErrors[state.lastErrorCode], 'meta'));
    const actions = element('div', '', 'actions');
    const add = (name, handler) => { const button = element('button', name); button.type = 'button'; button.onclick = async () => {
      button.disabled = true; try { await run(() => handler(button)); } finally { button.disabled = false; }
    }; actions.append(button); };
    add('编辑', () => { $('binding-id').value = bot.id; $('binding-name').value = bot.name; $('companion').value = bot.companionId; $('enabled').checked = bot.enabled; $('binding-name').focus(); });
    add('扫码登录', () => beginLogin(bot.id));
    add('断开', async () => { if (loginId === bot.id) cancelPolling(); await request('disconnect_bot', { id: bot.id }); await refresh(); notice('本组连接已断开。'); });
    add('删除绑定', async () => { if (!confirm(`删除“${bot.name}”的绑定并断开连接？`)) return;
      if (loginId === bot.id) cancelPolling(); await request('save_config', { bots: view.config.bots.filter(item => item.id !== bot.id) }); await refresh(); notice('绑定已删除。'); });
    box.append(actions); $('bots').append(box);
  }
}
function cancelPolling() { loginGeneration++; loginId = null; $('login').hidden = true; $('qr').removeAttribute('src'); }
async function beginLogin(id) {
  if (loginId) { const old = loginId; cancelPolling(); await request('cancel_login', { id: old }); }
  const generation = ++loginGeneration; loginId = id;
  const result = await request('begin_login', { id });
  if (generation !== loginGeneration) return;
  $('login').hidden = false; $('qr').src = `data:image/png;base64,${result.qrPngBase64}`;
  $('login-status').textContent = '用微信扫码并确认登录，此二维码五分钟后过期。'; notice('二维码已生成，登录尚未完成。');
  while (loginId === id && generation === loginGeneration) {
    const result = await request('check_login', { id }); if (generation !== loginGeneration) return;
    $('login-status').textContent = labels[result.status] ?? result.status;
    if (['connected', 'paused', 'qr_expired', 'login_requires_action', 'disconnected', 'needs_login', 'error', 'storage_error'].includes(result.status)) {
      cancelPolling(); await refresh(); notice(result.connected && ['connected', 'paused'].includes(result.status) ?
        '登录已确认并安全保存，重启会自动恢复；启用本组后可收发文字。' : `${labels[result.status]}${result.connected ? '，原连接仍保留。' : ''}`); return;
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
}
async function run(fn) { try { await fn(); } catch (err) { notice(err.message, true); } }
$('binding-form').onsubmit = event => { event.preventDefault(); run(async () => {
  const bot = { id: $('binding-id').value || crypto.randomUUID(), name: $('binding-name').value.trim(), companionId: $('companion').value, enabled: $('enabled').checked };
  await request('save_config', { bots: [...view.config.bots.filter(item => item.id !== bot.id), bot] }); await refresh(); resetForm();
  notice(view.recoveryError ? `绑定已保存；${view.recoveryError.message}` : '绑定已保存。', !!view.recoveryError);
}); };
$('reset-form').onclick = resetForm; $('refresh').onclick = () => run(async () => { await refresh(); notice('状态已刷新。'); });
$('retry-save').onclick = () => run(async () => { await request('retry_save'); await refresh(); notice('登录记录已安全保存。'); });
$('cancel-login').onclick = () => run(async () => { const id = loginId; cancelPolling(); if (id) await request('cancel_login', { id }); await refresh(); notice('本次扫码已取消，已有登录不变。'); });
window.addEventListener('pagehide', () => { cancelPolling(); channel.close(); for (const item of pending.values()) { clearInterval(item.resend); clearTimeout(item.timeout); } pending.clear(); });
run(async () => { await refresh(); if (view.recoveryError) notice(view.recoveryError.message, true);
  else if (view.capabilityError) notice(view.capabilityError.message, true);
  else if (view.storageWarning) notice('登录记录已保存，但后台状态未同步，请刷新检查。', true);
  else notice('配置已读取，保存的登录会自动恢复。'); });
