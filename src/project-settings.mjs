import { fail } from './core.mjs';
export const executionReady = value => !!value?.project?.trim() && !!value?.route;
export function botExecution(bot, defaults) {
  if (bot.mode === 'companion') return undefined;
  const value = { project: bot.execution?.project || defaults?.project || '', route: bot.execution?.route || defaults?.route || null, sessionHours: defaults?.sessionHours ?? 2, permissionMode: defaults?.permissionMode ?? 'bypassPermissions' };
  return executionReady(value) ? value : undefined;
}
export const botProjectMode = (bot, defaults) => bot.mode === 'project' || (!bot.mode && executionReady(defaults));

export function projectSettings(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || typeof value.project !== 'string' ||
      value.project.length > 2000 || value.project.includes('\0'))
    fail('INVALID_CONFIG', '请选择有效的默认项目。');
  const sessionHours = value.sessionHours ?? 2;
  if (!Number.isInteger(sessionHours) || sessionHours < 1 || sessionHours > 24) fail('INVALID_CONFIG', '会话时限须为 1–24 小时。');
  const options = { ...(value.sessionHours !== undefined ? { sessionHours } : {}), ...(value.permissionMode ? { permissionMode: value.permissionMode } : {}) };
  if (value.permissionMode && !['ask','auto','bypassPermissions'].includes(value.permissionMode)) fail('INVALID_CONFIG', '无效权限。');
  const r = value.route;
  if (r === undefined || r === null) return { project: value.project.trim(), route: null, ...options };
  if (!r || !['cc', 'codex', 'pi'].includes(r.agentKind) ||
      typeof r.providerId !== 'string' || typeof r.model !== 'string' || !r.model ||
      typeof r.effort !== 'string' || ![true, false, 'ultrafast'].includes(r.fastMode) || r.agentDeviceId)
    fail('INVALID_CONFIG', '请通过模型选择器选择本机模型和推理档位。');
  return { project: value.project, ...options, route: { agentKind: r.agentKind, providerId: r.providerId,
    model: r.model, effort: r.effort, fastMode: r.fastMode } };
}
