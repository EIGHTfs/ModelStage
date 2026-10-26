// app/model-actions.js —— 模型选择 / 资源根装载 / 名册联动
//
// 这里只做"选中一个模型之后发生什么"：装载 → 刷新皮肤与动作列表 → 更新面板只读行 → 舞台状态。
// 具体怎么画由渲染器负责；本模块不碰引擎内部。

import { dom, stage, state } from './context.js';
import { refreshStage } from './memory-bars.js';
import { markModelFailed } from '../infra/ready.js';
import { buildDocument } from '../infra/document.js';
import { getSharedVirtualFS } from '../infra/vfs.js';
import { diagEvent, stageLog, stageStatus } from './status.js';
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

/**
 * 把"当前动作"缓存对齐到底栏下拉的实际值。
 *
 * 为什么要这一步：`state.transportMotion` 是"当前动作"的**副本**（唯一真相是底栏下拉，契约 §七），
 *   但它只在"用户手动选动作"时被写入。装载新模型时动作清单整体换掉、底栏被重置到新清单的首项，
 *   缓存却还停在上一个模型的 id —— 右栏按这个陈旧 id 去高亮就一条都匹配不上（实测：底栏显示 idle、
 *   缓存仍是上一模型的 "3"，右栏 0 个选中）。装载完成后立刻对齐，缓存与真实播放项就不会分叉。
 * @returns {string} 对齐后的当前动作 id（取不到则为空串）
 */
function syncTransportMotionCache() {
  const transport = state.transport;
  if (!transport || typeof transport.picker !== 'function') return '';
  const pk = transport.picker('transport-motion');
  const value = pk && typeof pk.value === 'function' ? String(pk.value() || '') : '';
  if (value) state.transportMotion = value;
  return value;
}
/** 在左栏顶部插一条错误横幅（替代抛异常到控制台） */
function showRootsError(message) {
  const banner = document.createElement('p');
  banner.className = 'error-banner';
  banner.id = 'roots-error';
  banner.textContent = `读取资源根失败：${message}`;
  dom.rosterList.replaceChildren(banner);
}
/**
 * 释放当前 Document 持有的 VFS 前缀（幂等；只撤自己注册过的那个）。
 *
 * 为什么不再叫 bundle 前缀：前缀是「当前 Document 的资产来源」带来的，与来源是容器还是目录无关
 *   —— 目录型模型将来若也走 VFS（或插件产出别的容器类型）同样适用。
 * @param {string|null} keep 要保留的前缀（换到另一个容器时传新前缀；切到不再用 VFS 的模型时传 null）
 */
function releaseVfsPrefix(keep) {
  const prev = state.vfsPrefix;
  if (!prev || prev === keep) return;
  try { getSharedVirtualFS().revoke(prev); } catch { /* 已撤销或不存在：忽略 */ }
  state.vfsPrefix = null;
}

/**
 * 把条目归一成 `{ kind, container? }`。
 *   · kind      = 内容类型（spine / live2d）—— 只决定渲染分支
 *   · container = 容器标记（如 'unityfs'）—— 只决定"要不要先解包"，由发现阶段给出
 * 旧条目（localStorage 里存的"上次选中"可能仍是 kind:'bundle'）在这里就地纠正，
 *   避免刷新恢复时走进已废弃的分支。
 * @param {object} model 名册条目
 * @returns {object} 归一后的条目（新对象）
 */
function normalizeEntry(model) {
  const legacyBundle = model && model.kind === 'bundle';
  const kind = model && (model.kind === 'spine' || model.kind === 'live2d')
    ? model.kind
    : (legacyBundle ? 'live2d' : 'spine');
  const container = (model && model.container) || (legacyBundle ? 'unityfs' : null);
  return { ...model, kind, ...(container ? { container } : {}) };
}

/**
 * 解析资产来源（**全流程唯一按「是不是容器单文件」分流的地方**）。
 *
 * 容器单文件：插件解包 → 注册 VFS 前缀 → 入口地址用 `vfs://…`（Document 组装与 Live2D 内部相对引用
 *   都要经 VirtualFS；blob 不能当基址，`new URL(rel, 'blob:…')` 直接非法）。
 * 普通条目：直接用条目里的地址。
 * 下游（Document 组装 / 渲染装载 / 动作列表 / 清理）**一律不知道"这是资源包"**。
 *
 * @returns {Promise<{ok:boolean, entryUrl:string|null, prefix:string|null, provider:string|null, message:string}>}
 */
async function resolveAssetSource(model, name) {
  // 发现阶段给的是"这个条目是不是容器单文件"（container 标记），不是内容类型：
  //   是容器 ⇒ 先解包注册 VFS 前缀；否则直接用条目自带地址。
  if (!model.container) {
    const url = (model.entry && model.entry.url) || model.modelUrl || null;
    if (!url) return { ok: false, entryUrl: null, prefix: null, provider: null, message: '条目缺少资产地址' };
    return { ok: true, entryUrl: url, prefix: null, provider: null, message: '' };
  }
  const host = state.pluginHost;
  if (!host) {
    return { ok: false, entryUrl: null, prefix: null, provider: null, message: '插件宿主未就绪（页面刚启动时可稍等再试）' };
  }
  // 宿主对象启动时就创建了，但插件脚本可能还在注入：装载入口自己等一次。
  //   loadAll 幂等（已装载直接返回，进行中复用同一个 Promise），热路径上就是立即 resolve。
  await host.loadAll();
  const providers = typeof host.providersFor === 'function' ? host.providersFor(['bundle']) : [];
  if (!providers.length) {
    // 与"宿主未就绪"分开报：此时是真的没有能处理容器的插件（配置/目录问题）
    return {
      ok: false, entryUrl: null, prefix: null, provider: null,
      message: '没有能处理 bundle 容器的插件（检查 config/plugins.json 与 plugins/ 目录）',
    };
  }
  stageStatus(`正在解包 ${name}…（首次约 3~4 秒）`, 'info');
  const mat = await host.materialize({
    rootId: model.rootId,
    rel: model.rel,
    name: model.name,
    size: model.size,
    rootKind: 'bundle',   // 容器类型（插件能力声明用它判"能不能读"），不是内容类型
  });
  if (!mat.ok) return { ok: false, entryUrl: null, prefix: null, provider: null, message: mat.message || '解包失败' };
  const entryUrl = `${mat.prefix}${String(mat.entry).replace(/^\.?\//, '')}`;
  return { ok: true, entryUrl, prefix: mat.prefix, provider: mat.provider, message: '' };
}

/**
 * **唯一的装载通路**：解析资产来源 → 组装 Document → 交给当前渲染器。
 *
 * 用户定的原则：资源包解包后文件就在 VFS 里，`buildDocument + mount` 只该有一条路，
 *   差异只存在于「资产地址是 vfs:// 还是 http://」。所以本函数不再按 kind 分支，
 *   kind 只作为 Document 的内容类型（选渲染面）。
 *
 * @param {object} model 名册条目（已归一）
 * @param {string} name 显示名
 * @returns {Promise<object|null>} 渲染器返回的 info（失败为 null）
 */
async function loadModel(model, name) {
  const src = await resolveAssetSource(model, name);
  if (!src.ok) {
    stage.unload();
    stageLog('error', `无法装载 ${name}：${src.message}`, { model: name, kind: model && model.kind, reason: src.message });
    markModelFailed(`无法装载 ${name}：${src.message}`);
    return null;
  }
  const doc = await buildDocument({
    ...model,
    kind: model.kind,                                   // 只表达内容类型
    provider: src.provider || model.provider || null,
    entry: { url: src.entryUrl },                       // 是 vfs:// 还是 http:// 由发现阶段决定
  });
  if (!doc || doc.state !== 'ready') {
    const why = (doc && (doc.warnings || []).join('；')) || '原因未知';
    stageLog('error', `无法装载 ${name}：${why}`, { model: name, kind, reason: why });
    markModelFailed(`无法装载 ${name}：${why}`);
    return null;
  }
  // 统一清理：新 Document 不用旧前缀就释放（换容器/切到目录型模型都走这一句）
  releaseVfsPrefix(src.prefix);
  state.vfsPrefix = src.prefix || null;
  // 形态 C 的空闲预热：装载成功后让服务端把这个**容器包**解包落盘，供下次命中。
  //   放在装载之后（不是之前）：预热要给首屏让路；warmup 内部自己找 idle + 延迟 2s，上限由服务端 /api/unpack/capacity 下发（CPU 维度与内存维度取小）。
  //   仅容器单文件需要（目录型模型没有解包这件事）。
  if (model && model.container && state.pluginHost && typeof state.pluginHost.warmup === 'function') {
    try { state.pluginHost.warmup({ rootId: model.rootId, rel: model.rel, size: model.size }); } catch { /* 预热失败不影响播放 */ }
  }
  return state.currentRenderer ? state.currentRenderer.mount(doc) : stage.load({ document: doc });
}

/** 选中变体的回调：M2 只记状态（M4 用它去渲染舞台） */
/**
 * 真正装载一个条目（**唯一装载实现**）：onSelectModel 判完资产残缺后交给它。
 * @param {object} entry 已 normalizeEntry 的条目
 * @param {string} name 展示名
 */
function mountEntry(entry, name) {
  const kind = entry.kind;
  if (kind !== 'spine' && kind !== 'live2d') {
    stage.unload();
    stageLog('warn', `已选中 ${name}（未知内容类型：${kind}）`, { model: name, kind });
    return;
  }

  // Live2D 与 Spine 共用同一装载入口：引擎在 loadModel 里认出 kind==="live2d" 后

  stageStatus(`正在加载 ${name}…`, 'info');
  // 走当前渲染器装载：Live2D 必须由 renderer 分流到覆盖层，
  //   否则会落到舞台的 Spine 前置流程（取骨架/图集）并 404。
  const loadDoc = {
    ...entry,
    rootId: entry.rootId,
    rootName: entry.rootName,
    entry: entry.entry || (entry.modelUrl ? { url: entry.modelUrl } : null),
  };

  // 唯一的装载通路：来源解析在 loadModel 内部完成，这里不再按 kind/source 分支
  const loadPromise = loadModel(entry, name);
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
      // 抽成 mountEntry 后没有 model 参数：这里用 name（调用方传入的展示名）
      stageStatus(`${name} · ${head} · ${anims.length} 动作 · 播放 ${motion}`, 'info');
      // 运行时组只读：显示本次实际使用的运行时版本（引擎按骨架版本自动选，不可手切）
      if (state.panel) state.panel.setReadonly('ctl-runtime', `Spine ${info.version}`);
      // 模型加载成功 = "现在真的有资源在用内存了" ⇒ 刷新内存三色条（事件驱动，不轮询）
      refreshStage().catch(() => { /* 取不到数据时组件内部已记 warn 并隐藏 */ });
      refreshSkinList();
      fillTransportOptions(info);
      // 底栏已按新清单落到首项（或模型自报的 motion）⇒ 立刻把"当前动作"缓存对齐，
      //   否则右栏刷新会读到上一个模型的 id（换模型后右栏无选中项的真因）
      syncTransportMotionCache();
      // 缓存对齐后再刷一次右栏，保证"底栏 == 右栏高亮"（两处逐项一致，契约 §一/§七）
      try { refreshPanelAnimations(); } catch { /* 动作列表刷新失败不影响主流程 */ }
      document.documentElement.dataset.stageReady = '1';
    })
    .catch((err) => {
      // 被取代属正常竞态结果（不是故障）：只记一条 info，不显示红色错误
      if (err && err.aborted) return; // 被取代是正常竞态结果，不报故障（真生效的那次会写状态）
      // 渲染失败属业务错误：显示在舞台提示与 __WEB__ 里，不抛到控制台（验收要求零错误）
      const msg = formatError(err);
      state.stageError = msg;
      stageLog('error', `渲染失败：${msg}`, { model: name, err: msg });
      document.documentElement.dataset.stageReady = 'error';
    });
}

/** 选中模型：先做资产残缺预判，再交给 mountEntry 装载 */
function onSelectModel(model) {

  state.selectedModel = model;
  const name = model ? (model.name || model.id) : '无';
  if (!stage) { stageLog('error', `已选中 ${name}（渲染器不可用）`, { model: name, reason: 'no-stage' }); return; }
  if (!model) { stage.unload(); return; }

  const entry = normalizeEntry(model);
  const kind = entry.kind;

  // 资产残缺预判（catalog 的 missingTextures）：声明了但磁盘缺失的纹理 ⇒ 渲染必失败。
  //   **只报明确错误、不自动换源**：同名文件不等于同一份资源（目录版与容器版可能是不同版本），
  //   自动换源会让用户以为"点哪个都一样"，也会掩盖真实的数据问题。
  const missingTex = (entry.meta && entry.meta.missingTextures) || [];
  if (missingTex.length) {
    const msg = `该模型缺纹理文件 ${missingTex.join('、')}（资产残缺，无法渲染）。`;
    state.stageError = msg;
    stageLog('error', msg, { source: 'model-actions' });
    document.documentElement.dataset.stageReady = 'error';
    diagEvent('model.incomplete', { model: entry.name || entry.id, missing: missingTex }, { level: 'warn', src: 'app' });
    return;
  }

  // 无残缺（绝大多数情况）：直接走统一装载入口
  return mountEntry(entry, name);
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
    // 语义上报：资源根即"渲染能力来源"，其就绪对应 plugin.load
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
            // 失败文案由 root-manager 记录（它才知道服务端回了什么），对话框据此显示在自己身上
            getLastError: () => (state.rootManager && typeof state.rootManager.getLastAddError === 'function'
              ? state.rootManager.getLastAddError()
              : ''),
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
    }
  } catch (err) {
    state.rootsError = formatError(err);
    document.documentElement.dataset.rootsReady = 'error';
    showRootsError(state.rootsError);
  }
}

/**
 * 切换模型的**统一入口**（所有"不是用户点左栏"的切换都走这里）。
 *
 * 一次切换要同步的东西不少：装载本身（底栏皮肤/动作、右栏列表、渲染）+ 左栏树的高亮/展开/定位。
 * 分散在各入口手写就会漏（实测：翻页时左栏高亮停在上一个模型）。
 * @param {object} model 模型条目（catalog entry 或补过 entry 的条目）
 * @param {{syncTree?: boolean}} [opts] syncTree=false 时不碰左栏（左栏自己点选时用）
 * @returns {unknown} onSelectModel 的结果
 */
function selectModel(model, opts = {}) {
  if (!model) return null;
  const roster = state.roster;
  if (opts.syncTree !== false && roster && typeof roster.selectById === 'function') {
    // 左栏同步可能要懒加载游戏（异步）：失败不影响装载，只影响高亮
    Promise.resolve(roster.selectById(model.id)).catch(() => { /* 高亮失败不影响播放 */ });
  }
  return onSelectModel(model);
}

export { refreshSkinList, showRootsError, onSelectModel, selectModel, loadRoots };

// 面板重建后需要按当前模型重刷皮肤列表：把本模块的实现注入回去（避免循环依赖）
connectPanelRefresh(refreshSkinList);

// 导入项目配置后重载资源根与名册树：注入本模块的 loadRoots（不重载当前模型）
connectReloadApp(() => loadRoots({ skipRestore: true }));
