// app/model-actions.js —— 模型选择 / 资源根装载 / 名册联动
//
// 这里只做"选中一个模型之后发生什么"：装载 → 刷新皮肤与动作列表 → 更新面板只读行 → 舞台状态。
// 具体怎么画由渲染器负责；本模块不碰引擎内部。

import { dom, stage, state } from './context.js';
import { stageStatus } from './status.js';
import { formatError, getJson } from '../infra/api.js';
import { createRootManager } from './root-manager.js';

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
import { connectPanelRefresh, rebuildPanelFor } from '../panel/panel-settings.js';

/** 加载模型后刷新皮肤列表（换模型必须重建，不能停在上一个模型的皮肤） */
function refreshSkinList() {
  if (!state.panel || !stage) return;
  const skins = stage.getSkins ? stage.getSkins() : ['default'];
  const current = skins.includes('default') ? 'default' : skins[0];
  state.panel.setOptions('ctl-skin-list', skins.map((s) => ({ text: s, value: s })), current);
  if (state.transport) state.transport.setOptions('transport-skin', skins.map((s) => ({ text: s, value: s })), current);
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
  const loadPromise = state.currentRenderer
    ? state.currentRenderer.mount(loadDoc)
    : stage.load({ root: model.rootId, model });
  loadPromise
    .then((info) => {
      // null = 本次请求被排队/被更新的选择取代（Surface 的 last-wins 语义）：
      //   不能当成功读结果字段，否则出现"旧面已释放 + 新面没装"的空白 + TypeError
      if (!info) return; // 被排队/被取代：由真正生效的那次装载负责状态文案
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
          list: dom.rootList, form: dom.rootAddForm, pathInput: dom.rootAddPath,
          nameInput: dom.rootAddName, msg: dom.rootMsg, count: dom.rootCount,
          toggleBtn: dom.btnRootToggle, body: dom.rootManagerBody,
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
    // 已有根当作"路径提示"：绝大多数新增都发生在已有根的同级目录
    if (dom.rootPathHints) {
      dom.rootPathHints.replaceChildren();
      for (const r of roots) {
        const opt = document.createElement('option');
        opt.value = r.path || '';
        dom.rootPathHints.append(opt);
      }
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
