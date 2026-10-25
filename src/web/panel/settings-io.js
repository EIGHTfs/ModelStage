// panel/settings-io.js —— 设置导出 / 导入（右栏「设置」组底部那三个按钮的后两个）
//
// 导出：一个 JSON 同时带走「服务端配置原文」（GET /api/config/export）与「前端偏好」（localStorage）。
// 导入：项目配置交给 POST /api/config/import（校验→备份→写→回读自检），偏好写回 localStorage 并立即生效。
//
// 依赖注入的原因：面板桥（重载名册/应用偏好）与状态行都在装配层，这里不反向 import，避免环。
import { formatError } from '../infra/api.js';
import { readViewSettings, VIEW_SETTINGS_KEY } from '../app/view-settings.js';
import { stageLog, stageStatus } from '../app/status.js';
import { state } from '../app/context.js';

/** 装配层注入：面板设置回放、导入后重载、偏好应用 */
let ioBridge = {
  applyPanelSetting: null,
  applyViewerPrefs: null,
  reloadApp: null,
  panelSettings: () => ({}),
};

export function connectSettingsIo(bridge) {
  ioBridge = { ...ioBridge, ...(bridge || {}) };
}

/** 取服务端项目配置原文（失败不抛出，返回 error 供状态行提示） */
async function fetchProjectFiles() {
  try {
    const res = await fetch('/api/config/export');
    const data = await res.json();
    if (res.ok && data && data.files) return { files: data.files, error: null };
    return { files: null, error: (data && data.error) || `HTTP ${res.status}` };
  } catch (err) {
    return { files: null, error: (err && err.message) || String(err) };
  }
}

/** 触发浏览器下载（内容同时留在 dataset 供断言） */
function downloadJson(text, fileName) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 导出：一个 JSON 文件同时带走「服务端配置原文」+「前端偏好」。
 * 结构：{ _meta, schema, project:{files}, panel, view }
 * 项目配置取不到时仍导出偏好，并在状态行注明（一半失败不牵连整体）。
 */
export async function exportSettingsFile() {
  const project = await fetchProjectFiles();
  const payload = {
    _meta: {
      app: 'modelstage',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      note: 'project=服务端配置原文（资源根+名表）；panel/view=前端偏好',
    },
    schema: 'modelstage-settings/v2',
    project: project.files ? { files: project.files } : null,
    panel: { ...(ioBridge.panelSettings() || {}) },
    view: readViewSettings(),
  };
  const text = JSON.stringify(payload, null, 2);
  const panelCount = Object.keys(payload.panel).length;
  const projectCount = project.files ? Object.keys(project.files).length : 0;
  window.__WEB__ && (window.__WEB__.settingsExport = {
    text, panelCount, projectFiles: projectCount, projectError: project.error,
  });
  document.documentElement.dataset.settingsExport = String(text.length);
  try {
    downloadJson(text, `modelstage-settings-${payload._meta.exportedAt.slice(0, 10)}.json`);
    stageStatus(
      `已导出设置：前端偏好 ${panelCount} 项`
      + (projectCount ? ` + 项目配置 ${projectCount} 个文件` : `（项目配置未取到：${project.error}）`)
      + `，${text.length} 字节`, 'info', { show: true });
    return true;
  } catch (err) {
    stageLog('error', `导出设置失败：${formatError(err)}`, { err: formatError(err) });
    return false;
  }
}

/**
 * 打开导入文件选择器。
 * 说明：浏览器不允许脚本直接读本地文件，只能由用户选文件；所以这里造一个隐藏 input，
 *   选完立刻移除，文本交给 importSettingsFromText 处理（该函数也可被自动化直接调用）。
 */
export function openImportPicker() {
  // <label> 包 <input type="file">：点 label 即触发选择框（原生行为，不靠 JS 绑 click）
  const label = document.createElement('label');
  label.classList.add('file-picker-hidden');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  label.append(input);
  document.body.append(label);
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    label.remove();
    if (!file) return;
    let text = '';
    try { text = await file.text(); } catch (err) {
      stageLog('error', `读取文件失败：${formatError(err)}`, { err: formatError(err) });
      return;
    }
    await importSettingsFromText(text);
  }, { once: true });
  label.click();   // 点 label 等价于点 input（原生行为）
  stageStatus('已打开导入文件选择器：选一个之前导出的 JSON', 'info', { show: true });
  return true;
}

/**
 * 把导入文本解析成对象（不做语义判断，只回答"能不能读成对象"）。
 * @param {string} text
 * @returns {{ok: boolean, value?: object, error?: string}}
 */
function parseImportText(text) {
  let value = null;
  try { value = JSON.parse(String(text || '')); } catch (err) {
    return { ok: false, error: `不是合法 JSON（${(err && err.message) || err}）` };
  }
  if (!value || typeof value !== 'object') return { ok: false, error: '内容为空或不是对象' };
  return { ok: true, value };
}

/**
 * 从解析结果里认出三类内容。
 * 兼容三种来源：本项目导出（view/panel）、旧版实现导出（viewer）、最早期的"顶层直接是偏好"。
 * @param {object} parsed
 * @returns {{projectFiles: object|null, viewPrefs: object|null, panelPrefs: object|null}}
 */
/** 取"对象型字段"的值；不是对象就当年没有 */
function objectField(value) {
  return value && typeof value === 'object' ? value : null;
}

/** 这份对象看起来是不是"视图偏好本体"（最早期导出没有包装层） */
function looksLikePrefs(obj) {
  if (!obj) return false;
  // 只认"确实还在用"的偏好字段；已下线的字段不再参与识别
  //   （否则一份只剩 partFilter* 的旧导出会被误当成偏好本体）
  return !!(obj.uiTheme || obj.background);
}

/** 已下线的设置字段：导入时**忽略并记一条 warn**，绝不因此中断整份导入 */
const DEPRECATED_PREF_FIELDS = ['partFilterEnabled', 'partFilterKeywords'];


function classifyImportPayload(parsed) {
  const obj = objectField(parsed) || {};
  // 向后兼容：老导出文件里可能带已下线的字段（如 partFilter*）。
  //   这里只提示一句、照常继续导入 —— 不能因为一个废弃字段让整份配置导入失败。
  const deprecated = DEPRECATED_PREF_FIELDS.filter((k) => obj[k] !== undefined
    || (obj.view && obj.view[k] !== undefined) || (obj.viewer && obj.viewer[k] !== undefined));
  if (deprecated.length) {
    try {
      stageLog('warn', `导入配置里含已下线字段（${deprecated.join('、')}），已忽略，其余设置照常导入`, { deprecated });
    } catch { /* 状态行不可用不影响导入 */ }
    document.documentElement.dataset.settingsImportDeprecated = deprecated.join(',');
  }
  const projectFiles = obj.project && obj.project.files ? obj.project.files : null;
  const viewer = objectField(obj.viewer);
  const viewPrefs = objectField(obj.view) || viewer || (looksLikePrefs(obj) ? obj : null);
  return { projectFiles, viewPrefs, panelPrefs: objectField(obj.panel) };
}

/** 后端拒绝时拼一句可读原因（成功返回 null） */
function rejectReason(res, data) {
  if (res && res.ok && data && data.ok === true) return null;
  const details = Array.isArray(data && data.details) ? data.details : [];
  const why = (data && data.error) || `HTTP ${res ? res.status : 'unknown'}`;
  return `项目配置被拒绝（${why}）${details.length ? `：${details.join('；')}` : ''}`;
}

/** 统一的失败出口：状态行 + dataset 标记 + 返回值，三处口径一致 */
function importFail(stage, error) {
  const msg = `导入失败：${error}`;
  stageLog('error', msg, { source: 'import-config' });
  document.documentElement.dataset.settingsImport = `fail|${msg}`;
  return { ok: false, mode: stage, error: msg };
}

/**
 * 项目配置落地：交给后端自己校验/备份/写/回读。
 * @param {object} files 相对 config/ 的路径 → 文件文本
 * @returns {Promise<{ok: boolean, written?: string[], backup?: string|null, mode?: string, error?: string}>}
 */
async function importProjectFiles(files) {
  let res = null;
  let data = null;
  try {
    res = await fetch('/api/config/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files }),
    });
    data = await res.json();
  } catch (err) {
    return importFail('network', `项目配置请求失败（${formatError(err)}）`);
  }
  const rejected = rejectReason(res, data);
  if (rejected) return importFail('project', rejected);
  if (typeof ioBridge.reloadApp === 'function') {
    try { await ioBridge.reloadApp(); } catch { /* 重载失败不影响导入结果展示 */ }
  }
  return { ok: true, written: data.written || [], backup: data.backup || null };
}

/**
 * 前端偏好落地：视图偏好写 localStorage 后立刻生效，面板设置逐项回放。
 * @param {object|null} viewPrefs
 * @param {object|null} panelPrefs
 * @returns {number} 实际应用项数
 */
function importPrefs(viewPrefs, panelPrefs) {
  let applied = 0;
  if (viewPrefs) {
    try {
      const merged = { ...readViewSettings(), ...viewPrefs };
      localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify(merged));
      if (typeof ioBridge.applyViewerPrefs === 'function') ioBridge.applyViewerPrefs(merged);
      else applyTheme(merged.uiTheme || 'dark-cyan');
      applied += Object.keys(viewPrefs).length;
    } catch (err) {
      stageLog('warn', `前端偏好写入失败：${formatError(err)}`, { err: formatError(err) });
    }
  }
  if (panelPrefs && typeof ioBridge.applyPanelSetting === 'function') {
    for (const [id, value] of Object.entries(panelPrefs)) {
      try {
        ioBridge.applyPanelSetting(id, value);
        // 面板控件同步：导入只写引擎会出现"设置生效了、读数还是旧值"，
        //   而读数是用户唯一可见的生效出口 —— 必须跟着走到新值（契约：显示值=真实值）
        if (state.panel && typeof state.panel.setValue === 'function') state.panel.setValue(id, value);
        applied += 1;
      } catch { /* 单项失败继续 */ }
    }
  }
  return applied;
}

/**
 * 导入一个导出文件：识别 → 校验 → 项目配置落地 → 偏好落地 → 汇总提示。
 * @param {string} text JSON 文本
 * @returns {Promise<{ok:boolean, mode:string, written?:string[], backup?:string, error?:string}>}
 */
export async function importSettingsFromText(text) {
  const parsed = parseImportText(text);
  if (!parsed.ok) return importFail('parse', parsed.error);
  const { projectFiles, viewPrefs, panelPrefs } = classifyImportPayload(parsed.value);
  if (!projectFiles && !viewPrefs && !panelPrefs) {
    return importFail('shape', '既没有项目配置（project.files）也没有可识别的偏好字段');
  }
  let written = null;
  let backup = null;
  if (projectFiles) {
    const res = await importProjectFiles(projectFiles);
    if (!res.ok) return res;
    written = res.written;
    backup = res.backup;
  }
  const applied = importPrefs(viewPrefs, panelPrefs);
  const parts = [];
  if (projectFiles) parts.push(`项目配置 ${written.length} 个文件${backup ? `（备份 ${backup}）` : ''}`);
  if (applied) parts.push(`前端偏好 ${applied} 项`);
  const msg = `已导入：${parts.join(' + ') || '无变更'}`;
  stageStatus(msg, 'info', { show: true });
  document.documentElement.dataset.settingsImport = `ok|${msg}`;
  return { ok: true, mode: projectFiles ? 'project' : 'prefs', written, backup };
}

// 自动化入口：文件选择器在无头环境里点不了，测试直接喂 JSON 文本。
// 注意 __WEB__ 可能比本模块晚初始化，所以这里"没有就建"（与 app/context.js 同一写法）。
if (typeof window !== 'undefined') {
  window.__WEB__ = window.__WEB__ || {};
  window.__WEB__.settingsIo = { importText: importSettingsFromText, exportNow: exportSettingsFile };
}
