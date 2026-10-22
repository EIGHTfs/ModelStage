// app/model-actions.js —— 模型选择 / 资源根装载 / 名册联动
//
// 这里只做"选中一个模型之后发生什么"：装载 → 刷新皮肤与动作列表 → 更新面板只读行 → 舞台状态。
// 具体怎么画由渲染器负责；本模块不碰引擎内部。

import { dom, stage, state } from './context.js';
import { buildDocument } from '../infra/document.js';
import { diagEvent, stageStatus } from './status.js';
import { formatError, getJson } from '../infra/api.js';
import { createRootManager } from './root-manager.js';
import { createDirPicker } from './dir-picker.js';

async function loadWebConfig() {
  try {
    const cfg = await getJson('/api/web-config');
    if (cfg && typeof cfg.autoRestoreLast === 'boolean') return cfg.autoRestoreLast;
    return true;
  } catch {
    return true;
  }
}
import { createRosterView } from '../roster/view.js';
import { fillTransportOptions } from './transport-actions.js';
import { connectPanelRefresh, connectReloadApp, rebuildPanelFor, refreshPanelAnimations } from '../panel/panel-settings.js';

/** 加载模型后刷新皮肤列表（换模型必须重建，不能停在上一个模型的皮肤） */
function refreshSkinList() {
  if (!state.panel || !stage) return;
  const skins = stage.getSkins ? stage.getSkins() : ['default'];
  const current = skins.includes('default') ? 'default' : skins[0];
  state.panel.setOptions('ctl-skin-list', skins.map((s) => ({ text: s, value: s })), current);
  if (state.transport) state.transport.setOptions('transport-skin', skins.map((s) => ({ text: s, value: s })), current);
  try { refreshPanelAnimations(); } catch { /* 动作列表刷新失败不影响主流程 */ }
  document.documentElement.dataset.skinCount = String(skins.length);
}
/** 在左栏顶部插一条错误横幅（替代抛异常到控制台） */
function showRootsError(message) {
  const banner = document.createElement('p');
  banner.className = 'error-banner';
  banner.id = 'roots-error';
  banner.textContent = `读取资源根失败：${message}`;
  dom.rosterList.replaceChildren(banner);
}
/** 选中变体的回调：M2 只记状态（M4 用它去渲染舞台） */
function onSelectModel(model) {
  state.selectedModel = model;
  const name = model ? (model.name || model.id) : '无';
  if (!stage) { stageStatus(`已选中 ${name}（渲染器不可用）`, 'error'); return; }
  if (!model) { stage.unload(); return; }

  // 只有 Spine 走本路径；Live2D 与资源包由 M5 的插件管线接管
  const kind = model.kind || 'spine';
  if (kind !== 'spine' && kind !== 'live2d') {
    // 资源包（bundle）仍未接入：保持明确提示，不做"看着能选却渲不出来"
    stage.unload();
    stageStatus(`已选中 ${name}（资源包渲染未接入）`, 'warn');
    return;
  }

  // Live2D 与 Spine 共用同一装载入口：引擎在 loadModel 里认出 kind==="live2d" 后

  stageStatus(`正在加载 ${name}…`, 'info');
  // 走当前渲染器装载：Live2D 必须由 renderer 分流到覆盖层，
  //   否则会落到舞台的 Spine 前置流程（取骨架/图集）并 404。
  const loadDoc = {
    ...model,
    kind,
    rootId: model.rootId,
    rootName: model.rootName,
    entry: model.entry || (model.modelUrl ? { url: model.modelUrl } : null),
  };
  // 装载前先组装 Document（Assets 层）：非 ready 就不进渲染层，把原因直接告诉用户
  const loadPromise = buildDocument(loadDoc)
    .then((doc) => {
      if (!doc || doc.state !== 'ready') {
        const why = (doc && (doc.warnings || []).join('；')) || '原因未知';
        stageStatus(`无法装载 ${name}：${why}`, 'error');
        return null;
      }
      return state.currentRenderer ? state.currentRenderer.mount(doc) : stage.load({ document: doc });
    });
  loadPromise
    .then((info) => {
      // null = 本次请求被排队/被更新的选择取代（Surface 的 last-wins 语义）：
      //   不能当成功读结果字段，否则出现"旧面已释放 + 新面没装"的空白 + TypeError
      if (!info) return; // 被排队/被取代：由真正生效的那次装载负责状态文案
      diagEvent('model.mount', {
        root: loadDoc.rootId || null,
        model: loadDoc.name || null,
        kind: loadDoc.kind || null,
        version: info.version || null,
        animations: Array.isArray(info.animations) ? info.animations.length : 0,
        skins: Array.isArray(info.skins) ? info.skins.length : 0,
      }, { level: 'info', src: 'app' });
      const isL2D = /^Live2D/.test(String(info.version || ''));
      const anims = Array.isArray(info.animations) ? info.animations : [];
      const motion = info.motion || anims[0] || '（无动作）';
      const head = isL2D ? String(info.version) : `Spine ${info.version}`;
      stageStatus(`${model.name} · ${head} · ${anims.length} 动作 · 播放 ${motion}`, 'info');
      // 运行时组只读：显示本次实际使用的运行时版本（引擎按骨架版本自动选，不可手切）
      if (state.panel) state.panel.setReadonly('ctl-runtime', `Spine ${info.version}`);
      refreshSkinList();
      fillTransportOptions(info);
      document.documentElement.dataset.stageReady = '1';
    })
    .catch((err) => {
      // 被取代属正常竞态结果（不是故障）：只记一条 info，不显示红色错误
      if (err && err.aborted) return; // 被取代是正常竞态结果，不报故障（真生效的那次会写状态）
      // 渲染失败属业务错误：显示在舞台提示与 __WEB__ 里，不抛到控制台（验收要求零错误）
      const msg = formatError(err);
      state.stageError = msg;
      stageStatus(`渲染失败：${msg}`, 'error');
      document.documentElement.dataset.stageReady = 'error';
    });
}
/** 拉资源根并把名册三级树挂到左栏（并按配置决定是否恢复上次选中） */
/**
 * 装载资源根与名册。
 * @param {{skipRestore?: boolean}} [opts] skipRestore=true 时只刷新树，不重新恢复上次模型
 *   （资源根增删改后走这条：用户正在看的内容不该因为改配置被重载一遍）
 */
async function loadRoots(opts = {}) {
  try {
    // 资源根与恢复开关互不依赖：并行取，任一失败都不影响另一条（开关失败按"恢复"处理）
    const [data, autoRestore] = await Promise.all([getJson('/api/roots'), loadWebConfig()]);
    const roots = Array.isArray(data?.roots) ? data.roots : [];
    state.roots = roots;
    // 语义上报：资源根即"渲染能力来源"，其就绪对应旧端的 plugin.load
    diagEvent('plugin.load', {
      roots: roots.length,
      kinds: [...new Set(roots.map((r) => r.kind || 'spine'))],
      ids: roots.map((r) => r.id).slice(0, 12),
    }, { level: 'info', src: 'app' });
    const roster = createRosterView({
      listEl: dom.rosterList,
      countEl: dom.rosterCount,
      searchEl: dom.rosterSearch,
      collapseBtn: dom.btnCollapse,
      onSelect: onSelectModel,
    });
    state.roster = roster;
    // 关闭自动恢复时，连"上次展开的节点"也不还原：保持空舞台、空展开
    await roster.mount(roots, { restoreExpanded: autoRestore });
    state.autoRestore = autoRestore;
    state.restore = (autoRestore && !opts.skipRestore)
      ? await roster.restoreLast()
      : { restored: false, reason: opts.skipRestore ? 'roots-changed' : 'config-off' };
    // 资源根管理（F4）：首次建实例并渲染；之后每次刷新都用最新列表重画
    if (!state.rootManager) {
      state.rootManager = createRootManager({
        els: {
          list: dom.rootList, msg: dom.rootMsg, count: dom.rootCount,
          triggerBtn: dom.btnAddRoot, toggleBtn: dom.btnRootToggle, body: dom.rootManagerBody,
          // 目录浏览器：点「选择目录」弹出，选完把 {path,name} 交给 submitAdd
          picker: createDirPicker({
            formatError,
            onPick: ({ path, name }) => state.rootManager.submitAdd(path, name),
          }),
        },
        formatError,
        onChanged: () => { loadRoots({ skipRestore: true }); },
      });
      window.__WEB__ && (window.__WEB__.rootManager = state.rootManager);
    }
    // 只在首次用 GET 的列表渲染：GET 只返回启用项，之后任何刷新都不能拿它覆盖
    //   "含停用项"的完整列表（停用的根会从管理区凭空消失，用户就再也启用不回来）
    if (!state.rootManagerRendered) {
      state.rootManager.render(roots);
      state.rootManagerRendered = true;
    }
    // 目录浏览器默认起点：最后一个已有根所在的父目录（没有就从 / 开始）
    if (state.rootManager && roots.length && typeof state.rootManager.setPickerStart === 'function') {
      const last = roots[roots.length - 1].path || '';
      const idx = Math.max(last.lastIndexOf('/'), last.lastIndexOf('\\'));
      state.rootManager.setPickerStart(idx > 0 ? last.slice(0, idx) : '');
    }
    // 供自动化断言：资源根 id 序列 + 恢复结果
    document.documentElement.dataset.rootsIds = roots.map((r) => r.id).join(',');
    document.documentElement.dataset.rootsReady = '1';
    document.documentElement.dataset.restore = JSON.stringify(state.restore);
    if (!state.restore.restored) {
      stageStatus(autoRestore ? `M2 名册 · ${roots.length} 个资源根 · 暂无上次选中的模型` : `M2 名册 · ${roots.length} 个资源根 · 已按配置关闭自动恢复`, 'info');
    }
  } catch (err) {
    state.rootsError = formatError(err);
    document.documentElement.dataset.rootsReady = 'error';
    showRootsError(state.rootsError);
  }
}

export { refreshSkinList, showRootsError, onSelectModel, loadRoots };

// 面板重建后需要按当前模型重刷皮肤列表：把本模块的实现注入回去（避免循环依赖）
connectPanelRefresh(refreshSkinList);

// 导入项目配置后重载资源根与名册树：注入本模块的 loadRoots（不重载当前模型）
connectReloadApp(() => loadRoots({ skipRestore: true }));
