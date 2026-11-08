const channel = new BroadcastChannel('wechat-companion-control-v1'), pending = new Map();
let view = { config: { bots: [] }, runtime: { bots: [] }, companions: [] };
let editor = null, loginGeneration = 0, busy = false, loaded = false, disposed = false;
const $ = id => document.getElementById(id);
const labels = { disconnected: '未登录', waiting_scan: '等待扫码', scanned: '已扫码，请在微信确认', connected: '聊天中',
  paused: '已暂停聊天', qr_expired: '二维码已过期', error: '连接出错', reconnecting: '正在重连', needs_login: '需要重新登录',
  login_requires_action: '需要微信侧处理', storage_error: '登录保存失败', saving_login: '正在保存登录', disconnecting: '正在退出登录' };
const messageErrors = { VOICE_UNSUPPORTED: '暂不支持语音，请使用微信语音转文字后发送',
  VOICE_TRANSCRIPT_MISSING: '暂不支持语音，请使用微信语音转文字后发送',
  TOO_MANY_IMAGES: '单条最多 4 张图片，请分开发送', MEDIA_INBOX_FULL: '等待处理的图片过多，请稍后重发',
  INVALID_IMAGE: '图片无效或解密失败，请重发 PNG/JPEG/WebP 图片', IMAGE_TOO_LARGE: '图片超过 5 MiB，请压缩后重发',
  IMAGE_UPLOAD_FAILED: '图片上传失败，尚未发送回复，请重新发送请求', IMAGE_DOWNLOAD_FAILED: '图片下载失败，请重新发送图片',
  MEDIA_NETWORK_ERROR: '图片传输中断，请检查网络后重发', MEDIA_HTTP_ERROR: '微信图片接口出错，请稍后重发',
  DELIVERY_UNCERTAIN: '回复发送结果不确定，请在微信检查，不能自动重发', UNSUPPORTED_MESSAGE: '消息包含不支持的内容，请改发文字或图片',
  PERSISTENCE_FAILED: '登录或消息进度保存失败，请重试保存登录', AUTH_EXPIRED: '微信登录已失效，请重新扫码',
  NETWORK_ERROR: '微信连接中断，请检查网络', INBOX_FULL: '等待处理的消息过多，请稍后重发',
  COMPLETED_WITHOUT_REPLY: '最近微信请求：伙伴已完成处理，但未回传答案。请在微信重新发送请求',
  FAILED_WITHOUT_REPLY: '最近微信请求：伙伴处理失败，未回传答案。请在 Cindy 查看原因，再在微信重新发送请求',
  CANCELLED_WITHOUT_REPLY: '最近微信请求：伙伴处理已取消，未回传答案。需要继续时请在微信重新发送请求',
  INTERRUPTED_WITHOUT_REPLY: '最近微信请求：伙伴处理被中断，未回传答案。请在 Cindy 查看状态，再在微信重新发送请求',
  ENDED_WITHOUT_REPLY: '最近微信请求：伙伴已结束本次处理，未回传答案。请在 Cindy 查看状态，需要时在微信重新发送请求',
  REQUEST_EXPIRED: '最近微信请求：请求已过期，不能补发回复。请在微信重新发送请求',
  REQUEST_SUPERSEDED: '这条旧请求已由同一用户的新消息替换或合并',
  REQUEST_SETTLED: '最近微信请求：请求已结束，不能补发旧回复。请在微信重新发送请求',
  DISPATCH_RETRY_EXHAUSTED: '最近微信请求：转交伙伴失败，已用完两次自动重试，请在微信重新发送',
  DISPATCH_DELIVERY_UNCERTAIN: '最近微信请求：转交伙伴结果仍不确定，已结束两次重试，请先在 Cindy 检查',
  DISPATCH_FAILED: '最近微信请求：未能转交伙伴，请在微信重新发送',
  GUIDE_REQUIRED: '最近微信请求：请先发送一次伙伴说明，再从微信重发请求',
  GUIDE_PENDING: '最近微信请求：伙伴说明正在处理，请完成后从微信重发请求',
  GUIDE_FAILED: '最近微信请求：伙伴说明处理未成功，请重试伙伴说明后重发请求',
  GUIDE_STATUS_UNKNOWN: '最近微信请求：伙伴说明状态未知，请先刷新并核实说明状态',
  GUIDE_BUSY: '请等当前微信请求结束，再发送伙伴说明',
  BINDING_CHANGED: '最近微信请求：绑定已停用或改变，旧消息不能转交，请恢复后从微信重发',
  STALE_CONNECTION: '最近微信请求：消息来自旧连接，已拒绝，请稍后从微信重发',
  INVALID_INPUT: '最近微信请求：消息无法受理，请检查绑定并重新发送文字或图片' };
const guideMessages = { required: '升级后的已有绑定需要发送一次伙伴说明。不会自动联系伙伴。',
  accepted: '伙伴说明已送达，正在处理；微信输入等待预算一分钟，包含查询耗时，超时请重发。',
  pending: '伙伴说明投递尚未确认，请刷新状态。',
  failed: '伙伴说明未处理成功，请显式重试；这不会重发微信答案。',
  unknown: '伙伴说明投递或完成状态未知，请先核实，勿反复重发。' };
channel.onmessage = ({ data }) => {
  if (data?.type !== 'ui-response') return;
  const item = pending.get(data.id); if (!item) return;
  clearInterval(item.resend); clearTimeout(item.timeout); pending.delete(data.id);
  if (data.ok) item.resolve(data.result);
  else item.reject(Object.assign(new Error(data.message ?? '请求失败，请稍后重试。'), { code: data.code }));
};
async function request(action, args = {}) {
  const wake = await fetch('/wake');
  if (!wake.ok) throw new Error('无法唤醒插件，请在 Cindy 插件页启用它。');
  const id = crypto.randomUUID(), data = { type: 'ui-request', id, action, args };
  return new Promise((resolve, reject) => {
    const resend = setInterval(() => channel.postMessage(data), 1500);
    const timeout = setTimeout(() => { clearInterval(resend); pending.delete(id); reject(new Error('操作尚未返回，请刷新状态确认结果。')); }, 180000);
    pending.set(id, { resolve, reject, resend, timeout }); channel.postMessage(data);
  });
}
function notice(text = '', error = false) {
  $('notice').textContent = text; $('notice').className = error ? 'error' : ''; $('notice').hidden = !text;
}
function element(tag, text = '', cls) {
  const item = document.createElement(tag); item.textContent = text; if (cls) item.className = cls; return item;
}
const botState = id => view.runtime.bots.find(item => item.id === id);
const selectedPartner = () => $('partners').querySelector('input:checked')?.value ?? '';
function availablePartner(id) {
  return view.companions.some(c => c.id === id) && !view.config.bots.some(bot => bot.id !== editor?.id && bot.companionId === id);
}
function updateControls() {
  for (const button of document.querySelectorAll('button')) button.disabled = busy;
  $('add-bot').disabled = $('empty-add').disabled = busy || !loaded || !!editor || view.config.bots.length >= 32;
  for (const button of $('bots').querySelectorAll('button')) button.disabled = busy || !!editor;
  $('save-binding').disabled = busy || !editor || !availablePartner(selectedPartner()) || !$('binding-name').value.trim();
}
async function run(fn) {
  if (busy || disposed) return;
  busy = true; updateControls();
  try { await fn(); } catch (err) { notice(err.message, true); }
  finally { busy = false; if (!disposed) updateControls(); }
}
async function refresh() {
  view = await request('list_bindings'); loaded = true; render(); return view;
}
function render() {
  const chatting = view.config.bots.filter(bot => bot.enabled && botState(bot.id)?.status === 'connected').length;
  $('fleet-summary').textContent = view.config.bots.length ? `共 ${view.config.bots.length} 个 Bot · ${chatting} 个聊天中` : '每个 Bot 对应一位伙伴，最多添加 32 个';
  $('empty-state').hidden = !!view.config.bots.length || !!editor;
  const recovery = view.recoveryError?.message || (view.storageWarning ? '登录已保存，但后台状态未同步，请刷新状态检查。' : '');
  $('recovery').hidden = !recovery; $('recovery-message').textContent = recovery;
  $('bots').replaceChildren();
  for (const bot of view.config.bots) {
    const state = botState(bot.id), companion = view.companions.find(c => c.id === bot.companionId);
    const box = element('article', '', `bot${editor?.id === bot.id ? ' selected' : ''}`);
    const heading = element('div', '', 'bot-heading'), pill = element('span',
      !bot.companionId && state?.connected && state.status === 'paused' ? '待选择伙伴' : labels[state?.status] ?? '未登录', 'status-pill');
    pill.dataset.state = ['error', 'storage_error', 'needs_login', 'login_requires_action'].includes(state?.status) ? 'error' :
      bot.enabled && state?.status === 'connected' ? 'connected' : !bot.companionId || state?.status === 'reconnecting' ? 'pending' : 'idle';
    heading.append(element('h2', bot.name), pill); box.append(heading);
    box.append(element('p', bot.companionId ? `回答伙伴：${companion?.label ?? '暂不可用'}` : '扫码成功后选择一位伙伴', 'bot-partner'));
    box.append(element('p', !bot.companionId ? '还差一步，就能开始聊天' : !companion ? '请启用原伙伴，或编辑 Bot 选择其他伙伴' :
      state?.connected ? bot.enabled ? '在微信发送消息，伙伴会在微信回复你' : '登录已保留，恢复后即可接收消息' : '扫码登录后即可在微信聊天', 'muted'));
    const stats = element('div', '', 'bot-stats');
    for (const [name, value] of [['收到', state?.stats?.received ?? 0], ['回复', state?.stats?.delivered ?? 0]]) {
      const item = element('span'); item.append(element('strong', String(value)), document.createTextNode(name)); stats.append(item);
    }
    box.append(stats);
    const retry = view.dispatchRetries?.find(item => item.botConfigId === bot.id);
    if (retry) box.append(element('p', retry.withdrawing ? '新消息已合并，正在核实旧投递已撤回，确认后自动转交伙伴' : `最近微信请求：转交伙伴失败，将于 ${new Date(retry.retryAt).toLocaleTimeString()} 自动重试（第 ${retry.attempt}/2 次）`, 'bot-error'));
    else if (state?.lastErrorCode) box.append(element('p', messageErrors[state.lastErrorCode] ?? `最近连接异常：${state.lastErrorCode}，请刷新状态或重新扫码`, 'bot-error'));
    const guideState = view.bindingGuides?.find(item => item.id === bot.id)?.state ?? 'required';
    if (bot.companionId && guideMessages[guideState]) box.append(element('p', guideMessages[guideState], 'muted'));
    const actions = element('div', '', 'actions');
    const add = (container, name, handler, cls) => {
      const button = element('button', name, cls); button.type = 'button'; button.onclick = () => run(handler); container.append(button);
    };
    if (!bot.companionId) add(actions, state?.connected && state.status === 'paused' ? '选择伙伴' : '继续扫码',
      () => state?.connected && state.status === 'paused' ? openBinding(bot.id, true) : beginLogin(bot.id), 'primary');
    else {
      if (state?.connected) add(actions, bot.enabled ? '暂停聊天' : '恢复聊天', async () => {
        view = await request('upsert_binding', { id: bot.id, name: bot.name, companion_id: bot.companionId, enabled: !bot.enabled }); render();
        notice(bot.enabled ? `“${bot.name}”已暂停，登录已保留。` : `“${bot.name}”已恢复聊天。`);
      }, 'primary');
      else add(actions, '扫码登录', () => beginLogin(bot.id), 'primary');
      add(actions, '编辑 Bot', () => openBinding(bot.id, false));
      if (guideState === 'ready' && view.bindingGuides?.find(item => item.id === bot.id)?.updateAvailable)
        add(actions, '更新伙伴说明', async () => {
          view = await request('prepare_binding', { id: bot.id }); render();
          notice('已提交新版伙伴说明，包含主动发送微信的用法。');
        });
      if (['required', 'failed', 'unknown'].includes(guideState)) add(actions, guideState === 'required' ? '发送伙伴说明' : '核实并重试伙伴说明', async () => {
        view = await request('prepare_binding', { id: bot.id, retry: guideState !== 'required' }); render();
        notice('说明回执已更新；只有确认处理完成后才会派发微信消息。并不保证伙伴已写入长期记忆。');
      });
    }
    box.append(actions);
    const manage = element('details'); manage.append(element('summary', '管理 Bot'));
    const management = element('div', '', 'actions');
    if (state?.connected) {
      add(management, '重新扫码', () => beginLogin(bot.id));
      add(management, '退出登录', async () => {
        if (!confirm(`退出“${bot.name}”的微信登录？下次聊天需要重新扫码。`)) return;
        await request('disconnect_bot', { id: bot.id }); await refresh(); notice(`“${bot.name}”已退出登录。`);
      });
    }
    add(management, '删除 Bot', async () => {
      if (!confirm(`删除“${bot.name}”并清除它的微信登录？伙伴会保留。`)) return;
      view = await request('delete_binding', { id: bot.id }); render(); notice(`“${bot.name}”已删除。`);
    }, 'danger');
    manage.append(management); box.append(manage); $('bots').append(box);
  }
  if (editor && !view.config.bots.some(bot => bot.id === editor.id)) hideEditor();
  if (editor && editor.mode !== 'login') renderPartners();
  updateControls();
}
function renderPartners(selected = selectedPartner()) {
  $('partners').replaceChildren();
  let available = 0;
  for (const companion of view.companions) {
    const assigned = view.config.bots.find(bot => bot.id !== editor?.id && bot.companionId === companion.id);
    const label = element('label', '', 'partner'), input = document.createElement('input');
    input.type = 'radio'; input.name = 'companion'; input.value = companion.id; input.required = true;
    input.disabled = !!assigned; input.checked = companion.id === selected && !assigned; input.onchange = updateControls;
    const info = element('div', '', 'partner-info'); info.append(element('div', companion.label, 'partner-name'));
    info.append(element('div', assigned ? `已绑定 ${assigned.name}` : '使用这位伙伴的模型与权限', 'muted'));
    label.append(input, element('span', Array.from(companion.label || '伙伴')[0], 'avatar'), info); $('partners').append(label);
    if (!assigned) available++;
  }
  $('partner-hint').textContent = view.capabilityError?.message ?? (!view.companions.length ?
    '还没有可用伙伴。请先在 Cindy 中创建或启用一位伙伴，再点击“刷新伙伴”。' : !available ?
      '所有伙伴都已绑定其他 Bot。请创建新伙伴，或先删除不再使用的 Bot。' : '每位伙伴只能绑定一个 Bot。选择后，微信消息会直接交给这位伙伴回答。');
}
function hideEditor() {
  loginGeneration++; editor = null; $('editor').hidden = true; $('qr').removeAttribute('src'); $('qr').hidden = true;
}
function showEditor() {
  $('editor').hidden = false; $('empty-state').hidden = true;
  $('editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function openBinding(id, onboarding) {
  const bot = view.config.bots.find(bot => bot.id === id); if (!bot) throw new Error('这个 Bot 已被删除，请刷新状态。');
  loginGeneration++; editor = { id, mode: onboarding ? 'choose' : 'edit' };
  $('editor-title').textContent = onboarding ? '登录成功，选择伙伴' : `编辑 ${bot.name}`;
  $('close-editor').textContent = onboarding ? '稍后选择' : '取消编辑';
  $('setup-steps').hidden = !onboarding; $('step-login').removeAttribute('aria-current'); $('step-partner').setAttribute('aria-current', 'step');
  $('login').hidden = true; $('qr').hidden = true; $('qr').removeAttribute('src'); $('binding-form').hidden = false;
  $('binding-name').value = bot.name;
  $('binding-intro').textContent = onboarding ? '微信登录已安全保存。给 Bot 起个名字，选一位伙伴，就能开始聊天。' : '修改名称或回答伙伴，保存后生效。';
  $('save-binding').textContent = onboarding ? '开始聊天' : '保存修改';
  renderPartners(bot.companionId); showEditor(); render(); $('binding-name').focus();
}
async function beginLogin(id) {
  const bot = view.config.bots.find(bot => bot.id === id); if (!bot) throw new Error('这个 Bot 已被删除，请刷新状态。');
  const generation = ++loginGeneration; editor = { id, mode: 'login' };
  $('editor-title').textContent = bot.companionId ? `扫码登录 ${bot.name}` : '新增 Bot';
  $('close-editor').textContent = bot.companionId ? '取消扫码' : '取消新增';
  $('setup-steps').hidden = !!bot.companionId; $('step-login').setAttribute('aria-current', 'step'); $('step-partner').removeAttribute('aria-current');
  $('login').hidden = false; $('binding-form').hidden = true; $('renew-qr').hidden = true;
  $('qr').hidden = true; $('qr').removeAttribute('src'); $('qr-placeholder').hidden = false; $('qr-placeholder').textContent = '正在生成二维码…';
  $('login-status').textContent = '正在连接微信…';
  $('login-help').textContent = bot.companionId ? '用微信扫码并在手机确认。重新扫码期间，已有登录会保留。' : '用微信扫一扫，再在手机上确认登录。成功后即可选择伙伴。';
  notice(); showEditor(); render();
  try {
    const result = await request('begin_login', { id }); if (generation !== loginGeneration || disposed) return;
    $('qr').src = `data:image/png;base64,${result.qrPngBase64}`; $('qr').hidden = false; $('qr-placeholder').hidden = true;
    $('login-status').textContent = '等待微信扫码 · 二维码 5 分钟内有效';
    void pollLogin(id, generation);
  } catch (err) { if (generation === loginGeneration) loginFailure(err.message); throw err; }
}
function loginFailure(message) {
  $('qr').hidden = true; $('qr').removeAttribute('src'); $('qr-placeholder').hidden = false; $('qr-placeholder').textContent = '请重新扫码';
  $('login-status').textContent = message; $('renew-qr').hidden = false;
}
async function pollLogin(id, generation) {
  try {
    while (editor?.id === id && generation === loginGeneration && !disposed) {
      const result = await request('check_login', { id }); if (generation !== loginGeneration || disposed) return;
      $('login-status').textContent = labels[result.status] ?? '正在确认登录…';
      if (['connected', 'paused'].includes(result.status) && result.connected) {
        await refresh(); if (generation !== loginGeneration || disposed) return;
        const bot = view.config.bots.find(item => item.id === id);
        if (!bot?.companionId) { openBinding(id, true); notice('登录成功，请选择一位回答伙伴。'); }
        else { hideEditor(); render(); notice(bot.enabled ? `“${bot.name}”登录成功，可以在微信聊天了。` : `“${bot.name}”登录成功，点击“恢复聊天”即可开始。`); }
        return;
      }
      if (['qr_expired', 'login_requires_action', 'disconnected', 'needs_login', 'error', 'storage_error'].includes(result.status)) {
        loginFailure(`${labels[result.status] ?? '登录未完成'}，请重试。`); await refresh(); return;
      }
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  } catch (err) {
    if (generation !== loginGeneration || disposed) return;
    loginFailure(err.message); notice(err.message, true);
    try { await refresh(); } catch {}
  }
}
async function addBot() {
  view = await request('add_bot'); loaded = true; render(); await beginLogin(view.addedBotId);
}
$('add-bot').onclick = $('empty-add').onclick = () => run(addBot);
$('binding-name').oninput = updateControls;
$('binding-form').onsubmit = event => {
  event.preventDefault(); void run(async () => {
    const bot = view.config.bots.find(item => item.id === editor?.id), companionId = selectedPartner(), onboarding = editor?.mode === 'choose';
    if (!bot || !availablePartner(companionId)) throw new Error('请选择一位可用且未绑定其他 Bot 的伙伴。');
    if (onboarding && (!botState(bot.id)?.connected || botState(bot.id)?.status !== 'paused')) throw new Error('微信登录尚未保存，请先完成扫码登录。');
    const name = $('binding-name').value.trim(); if (!name) throw new Error('请填写 Bot 名称。');
    const result = await request('upsert_binding', { id: bot.id, name, companion_id: companionId, enabled: onboarding ? true : bot.enabled });
    view = result;
    if (view.recoveryError) { render(); notice(view.recoveryError.message, true); return; }
    hideEditor(); render(); notice(onboarding ? `“${name}”已准备好，现在可以去微信发消息了。` : `“${name}”已保存。`);
  });
};
$('close-editor').onclick = () => run(async () => {
  const current = editor, bot = view.config.bots.find(item => item.id === current?.id);
  if (!current) return;
  hideEditor(); render();
  if (current.mode === 'login') {
    await request('cancel_login', { id: current.id });
    if (bot && !bot.companionId) view = await request('delete_binding', { id: bot.id });
    else await refresh();
    render(); notice(bot?.companionId ? '扫码已取消，已有登录已保留。' : '新增已取消。');
  } else notice(current.mode === 'choose' ? '登录已保留，稍后点击这个 Bot 的“选择伙伴”继续。' : '编辑已取消。');
});
$('renew-qr').onclick = () => run(async () => { if (editor) await beginLogin(editor.id); });
$('refresh').onclick = () => run(async () => { await refresh(); notice(view.capabilityError?.message ?? '状态已刷新。', !!view.capabilityError); });
$('refresh-partners').onclick = () => run(async () => { await refresh(); notice(view.capabilityError?.message ?? '伙伴列表已刷新。', !!view.capabilityError); });
$('retry-save').onclick = () => run(async () => {
  view = await request('retry_save'); render();
  const bot = view.config.bots.find(item => item.id === editor?.id);
  if (editor?.mode === 'login' && bot && !bot.companionId && botState(bot.id)?.connected && botState(bot.id)?.status === 'paused') openBinding(bot.id, true);
  notice('登录记录已安全保存。');
});
window.addEventListener('pagehide', () => {
  disposed = true; loginGeneration++; channel.close();
  for (const item of pending.values()) { clearInterval(item.resend); clearTimeout(item.timeout); } pending.clear();
});
void run(async () => { await refresh(); if (view.capabilityError) notice(view.capabilityError.message, true); });
