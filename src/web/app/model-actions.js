// app/model-actions.js —— 模型选择 / 资源根装载 / 名册联动
//
// 这里只做"选中一个模型之后发生什么"：装载 → 刷新皮肤与动作列表 → 更新面板只读行 → 舞台状态。
// 具体怎么画由渲染器负责；本模块不碰引擎内部。

import { dom, stage, state } from './context.js';
import { resetMotionState } from './anim-list.js';
import { refreshStage } from './memory-bars.js';
import { markModelFailed } from '../infra/ready.js';
import { buildDocument } from '../infra/document.js';
import { getSharedVirtualFS } from '../infra/vfs.js';
import { diagEvent, stageLog, stageStatus } from './status.js';
// "受支持的渲染面"由元数据表判定（不在这里写死 spine/live2d 枚举）
import { isKnownKind } from '../render/surfaces.js';
import { formatError, getJson } from '../infra/api.js';
import { createRootManager } from './root-manager.js';
// 装载结果上报服务端（契约《条目状态与展示归属》§三）：成功/失败都报，
//   响应带回重算后的三字段 ⇒ 就地更新那一行（不重拉 catalog、不整表重建）。
//   前端不再自己存"装载失败记忆"（原 roster/bundle-failures.js 的 localStorage 层已删）。
import { reportEntryResult } from './entry-report.js';
import { createDirPicker } from './dir-picker.js';

/**
 * 本次装载实际命中的提供者 id（容器由 resolve 给出，目录型为 builtin-*；都没有则 null）。
 * 由 loadModel 在 mount 之前写入，mountEntry 的成功/失败回调读它去上报 loadResult.provider。
 * 为什么不塞进 loadModel 的返回值：那个返回值是"渲染器 info"，形状被多处消费，
 *   加私货会污染契约；而这个值只有"上报"一处用得上。
 */
let lastMountProvider = null;

async function loadWebConfig() {
  try {
    const cfg = await getJson('/api/web-config');
    // 服务端下发的前端准入参数（前端读不到 env）：拿到就应用，缺省值保持在 memory-budget.js
    try { applyAdmitConfig(cfg); } catch { /* 应用失败不该影响装载 */ }
    if (cfg && typeof cfg.autoRestoreLast === 'boolean') return cfg.autoRestoreLast;
    return true;
  } catch {
    return true;
  }
}
import { createRosterView } from '../roster/view.js';
import { fillTransportOptions } from './transport-actions.js';
import { connectPanelRefresh, connectReloadApp, rebuildPanelFor, refreshPanelAnimations } from '../panel/panel-settings.js';
import { applyAdmitConfig } from './memory-budget.js';

/** 加载模型后刷新皮肤列表（换模型必须重建，不能停在上一个模型的皮肤） */
function refreshSkinList() {
  if (!state.panel || !stage) return;
  const skins = stage.getSkins ? stage.getSkins() : ['default'];
  // 当前项取**引擎实际生效的那个**，不要用"列表里有没有 default"去猜：
  //   装载时会自动挑一个"能画出东西"的皮肤（有些资源的 default 是空壳），
  //   猜成 default 就会出现"下拉显示 default、画面其实是 00"这种自相矛盾的显示。
  const active = typeof stage.getActiveSkin === 'function' ? stage.getActiveSkin() : null;
  const current = (active && skins.includes(active))
    ? active
    : (skins.includes('default') ? 'default' : skins[0]);
  state.panel.setOptions('ctl-skin-list', skins.map((s) => ({ text: s, value: s })), current);
  if (state.transport) state.transport.setOptions('transport-skin', skins.map((s) => ({ text: s, value: s })), current);
  // 注意：**不把皮肤记进值工厂**（不持久化）。皮肤名是"模型局部语义"——
  //   当前模型的 "00" 换个模型可能根本不存在，记住它只会让下次装载按一个不存在的名字去设，
  //   还会盖掉"装载时自动挑一个能画出东西的皮肤"这条逻辑（表现为刷新后又空白）。
  //   与动作列表同一条思路：这类"取值域随模型变"的项，每次装载重新来。
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
  // 只做"已知值归一"，**不再瞎兜底**：
  //   以前非 spine/live2d 一律当 'spine' —— 而容器条目的 kind 可能为 null
  //   （多个 bundle 插件并存时，解包前无法确定内容类型）⇒ live2d 容器会被当成 spine 走错分支。
  //   现在未知就是 null，由解包产物判（见 expandContainerEntry）；判不出来就明确报错。
  //   判据改成查渲染面元数据表（加新面时这里不用改）。
  const known = isKnownKind(model && model.kind) ? model.kind : null;
  // container 是"这是容器"的事实，但**不假定它一定在**：旧条目可能只有 kind:'bundle'
  const container = (model && model.container) || (legacyBundle ? 'unityfs' : null);
  return { ...model, kind: known, ...(container ? { container } : {}) };
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
      // 与 plugin-host 的 reason 同口径：no-provider 是**真实存在**的分类，可直接进文案映射表
      reason: 'no-provider',
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
  // mat.reason 是 plugin-host 给出的结构化原因（no-provider / resolve-failed / memory-guard …），
  //   原样透出给上层记缓存用；没有被编造的分类，缺就是 null
  if (!mat.ok) return { ok: false, entryUrl: null, prefix: null, provider: null, reason: mat.reason || null, message: mat.message || '解包失败' };
  const entryUrl = joinPrefix(mat.prefix, mat.entry);
  // files 只带**路径清单**（不带 Blob）：产物已经由 materialize 注册进 VFS，
  //   上层判断"有没有 entry.json"只需要名字，不需要字节。
  return {
    ok: true, entryUrl, prefix: mat.prefix, provider: mat.provider, message: '',
    files: mat.files && typeof mat.files.keys === 'function' ? [...mat.files.keys()] : [],
  };
}

/**
 * 拼 VFS 地址：prefix + 相对路径。
 * 只此一处实现 —— 解包产物（entry.json 里的相对名）与其它容器文件都走它，
 *   避免"同一个拼接规则写两遍"，将来 prefix 形态变了漏改一处就会静默取不到文件。
 * @param {string} prefix 形如 'vfs://xxx/'
 * @param {string} rel 相对路径（允许以 ./ 或 / 开头）
 * @returns {string}
 */
function joinPrefix(prefix, rel) {
  return `${prefix}${String(rel || '').replace(/^\.?\//, '')}`;
}

/** 取路径末段（entry.json 里的文件名 → 展示用名字） */
function baseName(p) {
  return String(p || '').split('/').pop() || '';
}

/**
 * 从 skel 字节里读出版本号（如 '4.1.20'）。
 *
 * 二进制 skel 的布局：`[8 字节 hash][1 字节长度 N][N 字节 UTF-8 版本串]`（实测 4.1.20 完全吻合）。
 * 为什么必须读出来：引擎用 `doc.meta.version`（= entry.version）选运行时；缺它会选"最新一档"，
 *   而 spine 运行时不校验版本兼容性 ⇒ 用新版读旧格式只会读错位，报 `String in string table must not be null`。
 * 读不到就返回 null（交给引擎的兜底分支），不编造。
 * @param {string} url 骨架地址（vfs:// 或 http）
 * @returns {Promise<string|null>}
 */
async function probeSkelVersion(url) {
  try {
    const vfs = getSharedVirtualFS();
    const real = (vfs && typeof vfs.resolve === 'function' ? vfs.resolve(url) : null) || url;
    // 归 **B 类（只加超时，不走 api.js）**：这里要的是二进制头，不是 JSON —— getJson 会 res.json() 解坏。
    //   注意 `.slice(0,32)` 是在**已拿到的 blob** 上切，不是 HTTP Range ⇒ 实际仍下载整个 .skel，
    //   所以超时按"整文件下载"给：20s（CIFS 上几 MB 骨架可能数秒，实测运行时脚本读取同量级）。
    const res = await fetch(real, { signal: AbortSignal.timeout(20000) });
    if (!res || !res.ok) return null;
    // 读前 64 字节：3.8 格式是「hash 串 + 版本串」，两段加起来可能 40+ 字节（实测 1+27+1+7=36）
    const head = new Uint8Array(await (await res.blob()).slice(0, 64).arrayBuffer());

    const printable = (bytes) => new TextDecoder().decode(bytes).replace(/[^\x20-\x7e]/g, '').trim();
    const looksLikeVersion = (s) => /^[34]\.\d{1,2}(\.\d{1,2})?/.test(s);

    // ── 格式 ①：spine **4.x** —— `hashLow:int32 + hashHigh:int32 + version:readString`
    //    版本串长度字节落在 head[8]；编码仍带 1 字节偏移（见下）。
    const len4 = head[8];
    if (len4 > 1 && len4 <= 25) {
      const ver4 = printable(head.slice(9, 9 + (len4 - 1)));
      if (looksLikeVersion(ver4)) return ver4;
    }

    // ── 格式 ②：spine **3.8** —— `hash:readString + version:readString`（**没有** 8 字节 int32 hash）
    //    实测 3.8.96 的包：head[0]=0x1c(28) ⇒ hash 27 字节；接着 0x08(8) ⇒ 版本串 7 字节 "3.8.96"。
    //    ⚠️ spine 的 readString 长度**含 1 字节偏移**（源码 `byteCount--`）：少减 1 会整体错位，
    //    读成 ".8.96hDE01_eyeclos" —— 那正是本轮踩到的坑，也是"页面装载这类包必然失败"的根因。
    let i = 0;
    const readVarint = () => {
      let result = 0;
      let shift = 0;
      for (;;) {
        const b = head[i++];
        if (b === undefined) throw new Error('越界');
        result |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
        if (shift > 28) throw new Error('varint 过长');
      }
      return result;
    };
    try {
      const hashLen = readVarint();
      if (hashLen > 1 && hashLen < 64 && i + (hashLen - 1) <= head.length) {
        i += (hashLen - 1);
        const verLen = readVarint();
        if (verLen > 1 && verLen <= 25 && i + (verLen - 1) <= head.length) {
          const ver3 = printable(head.slice(i, i + (verLen - 1)));
          if (looksLikeVersion(ver3)) return ver3;
        }
      }
    } catch { /* 3.8 判据不成立就返回 null，让调用方走"最新一档" */ }

    return null;
  } catch { return null; }
}

/**
 * 容器解包产物 → 展开成 spine 三件套（entry.json 是唯一权威）。
 *
 * 三种输入的处置：
 *   1. 有 entry.json 且含 skeletonFile  ⇒ 补齐 {skeletonFile, atlasFile, textureFiles}
 *   2. 是 live2d 容器（entry.json 是 model3.json，没有 skeletonFile）⇒ 原样返回，走原来的 live2d 路
 *   3. 产物里有 .skel/.atlas 却没有 entry.json ⇒ **明确报错**，不按扩展名猜：
 *      多页 atlas 时"页面名 ↔ png"只能靠 atlas 首行解析，猜错会静默显示错图，
 *      那种"看着正常但是错的"比直接报错难查得多。
 * @param {{prefix:string, entryUrl:string, files:string[]}} src
 * @param {string} name 显示名（只用于日志）
 * @returns {Promise<{entry?:object, error?:string}>}
 */
async function expandContainerEntry(src, name) {
  // vfs:// 不能直接 fetch（浏览器不认这个协议，会 net::ERR_FAILED）——
  //   必须先用 VFS 的 resolve 换成 blob: 地址。这与 document.js:33 resolveUrl 是同一套逻辑，
  //   这里复用同一个 VFS 句柄，不另造解析器。
  const fetchUrl = (() => {
    try { return getSharedVirtualFS().resolve(src.entryUrl) || null; } catch { return null; }
  })();
  let meta = null;
  let fetchNote = '';
  try {
    if (fetchUrl) {
      // 归 **B 类（只加超时）**：这里必须保留 `cache: 'no-store'`（entry.json 是解包产物，
      //   读到浏览器缓存会拿到上一版产物）；而 getJson/fetchWithRetry 都不透传 cache 选项，
      //   走 api.js 会静默丢掉这个语义 ⇒ 宁可只补超时。
      //   8.5s 与 api.js 默认一致（entry.json 是小 JSON，实测同量级接口 10~58ms）。
      const res = await fetch(fetchUrl, { cache: 'no-store', signal: AbortSignal.timeout(8500) });
      if (res && res.ok) meta = await res.json();
      else fetchNote = `HTTP ${res && res.status}`;
    } else fetchNote = 'resolve 返回空';
  } catch (e) { meta = null; fetchNote = (e && e.message) || 'fetch 抛错'; }   // 不是 JSON / 取不到 ⇒ 当作"没有 entry.json"走下面的判定

  // 排障：这条把"取到没取到"一次说清（meta 为 null 时整个 skeletonFile 分支根本不会进）
  diagEvent('container.expand', {
    plugin: src.provider || null,
    entryUrl: src.entryUrl,
    resolved: fetchUrl ? String(fetchUrl).slice(0, 48) : null,
    metaKeys: meta && typeof meta === 'object' ? Object.keys(meta).join(',') : null,
    fetchNote: fetchNote || null,
  }, { level: 'info', src: 'app' });

  if (meta && meta.skeletonFile) {
    const join = (rel) => joinPrefix(src.prefix, rel);
    const texFiles = Array.isArray(meta.textureFiles) ? meta.textureFiles : [];
    const built = {
      skeletonFile: { name: baseName(meta.skeletonFile), url: join(meta.skeletonFile) },
      atlasFile: meta.atlasFile
        ? { name: baseName(meta.atlasFile), url: join(meta.atlasFile) }
        : undefined,
      textureFiles: texFiles.map((f) => ({ name: baseName(f), url: join(f) })),
    };
    // skel 版本必须一起带出去：引擎按 doc.meta.version（= entry.version）选运行时，
    //   缺这个值会走 pickRuntimeVersion 的"没版本号 ⇒ 用清单里最新一档"分支。
    //   用新版运行时读旧格式 skel **不会报版本错**（spine 运行时不校验兼容性），只会读错位，
    //   最后在 `String in string table must not be null` 这种地方炸 —— 排查成本极高。
    const version = await probeSkelVersion(built.skeletonFile.url);
    // 排障：三件套的 url 各打一条（拼接用的是什么 prefix、结果长什么样）
    diagEvent('container.assets', {
      prefix: src.prefix || null,
      skeletonUrl: built.skeletonFile.url,
      atlasUrl: built.atlasFile ? built.atlasFile.url : null,
      textureUrls: built.textureFiles.map((t) => t.url).join(' , '),
      skelVersion: version,
    }, { level: 'info', src: 'app' });
    return { kind: 'spine', entry: built, version };
  }

  // 没有 skeletonFile：按产物确定性地判内容类型（kind 可能本来是 null）
  //
  // Live2D 的判据用**入口文件名**，而不是扫描 files 清单：
  //   · 实测容器的入口就叫 `model3.json`（不是 `xxx.model3.json`），endsWith('model3.json') 两种都能覆盖；
  //   · 更关键：materialize 返回的 files 在不同路径下形状不一致（实测拿到过 Number），
  //     拿不到清单时"靠 files 判"必然误判成"判不出"。入口文件则是**一定存在**的。
  const entryName = baseName(src.entryUrl).toLowerCase();
  if (entryName.endsWith('model3.json')) return { kind: 'live2d' };

  const paths = (Array.isArray(src.files) ? src.files : []).map((p) => String(p).toLowerCase());
  const hasSkel = paths.some((p) => p.endsWith('.skel'));
  const hasAtlas = paths.some((p) => p.endsWith('.atlas'));
  const hasModel3 = paths.some((p) => p.endsWith('model3.json'));
  if (hasModel3) return { kind: 'live2d' };

  if (hasSkel && hasAtlas) {
    stageLog('warn', `容器 ${name} 里没有 entry.json（将拒绝装载）`, {
      files: paths.slice(0, 12).join(' / '),
    });
    return {
      reason: 'entry-missing',
      error: '容器内缺少 entry.json：spine 三件套需要 skeletonFile / atlasFile / textureFiles 才能确定'
        + '骨架、atlas 与贴图页的对应关系（不按扩展名猜，多页 atlas 猜错会静默显示错图）',
    };
  }
  // 既没有 spine 清单、也没有 Live2D 定义 ⇒ 无法判定，明确报错（不静默走任何分支）
  return {
    reason: 'kind-undetermined',
    error: '容器内既没有 entry.json（spine 三件套清单）也没有 *.model3.json（Live2D 定义），'
      + '无法判定内容类型；不按扩展名猜（多页 atlas 猜错会静默显示错图）',
  };
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
    reportEntryResult(model, { result: 'failed', reason: src.reason || null, message: src.message });
    markModelFailed(`无法装载 ${name}：${src.message}`);
    return null;
  }
  // 容器解包产物：把 entry.json 展开成 spine 三件套。
  //   为什么必须在这一层做：`buildSpineAssets`（infra/document.js:98）要的是
  //   {skeletonFile, atlasFile, textureFiles} 这个形状，而容器这条路只传了"入口文件的地址"，
  //   没人把 entry.json 读开过；同时 document.js:69 的兜底规则（有 entry.url 就当 live2d）
  //   会把 spine 容器判成 live2d。在进 buildDocument 之前补齐 + 显式给 kind 即可，
  //   **不动 document.js**（那条路与 live2d 分支同族，动它会弄坏已经能用的 live2d）。
  const entry = { url: src.entryUrl };
  let kind = model.kind || null;
  // spine 三件套必须放在**传给 buildDocument 的那个对象的顶层**：
  //   buildSpineAssets(doc, entry, vfs) 读的是 `entry.skeletonFile` / `entry.atlasFile` /
  //   `entry.textureFiles`（document.js:98-105）。塞进嵌套的 `entry.entry.*` 它一个字都读不到，
  //   只会报"缺少骨架地址/缺少 atlas 地址/贴图页为空"—— 而 diag 里那三个 url 明明都拼对了。
  let spineAssets = null;
  let spineVersion = null;
  if (src.prefix) {
    const expanded = await expandContainerEntry(src, name);
    if (expanded.error) {
      stage.unload();
      stageLog('error', `无法装载 ${name}：${expanded.error}`, { model: name, kind: model && model.kind, reason: expanded.error });
      reportEntryResult(model, { result: 'failed', reason: expanded.reason || null, message: expanded.error });
      markModelFailed(`无法装载 ${name}：${expanded.error}`);
      return null;
    }
    // 产物判定优先：容器条目 kind 可能为 null（多个 bundle 插件并存时解包前无法确定内容类型）
    if (expanded.kind) kind = expanded.kind;
    if (expanded.entry) spineAssets = expanded.entry;
    if (expanded.version) spineVersion = expanded.version;
  }
  // 到这里还没确定内容类型 ⇒ 明确报错，不猜也不静默走进某个分支
  if (kind !== 'spine' && kind !== 'live2d') {
    const why = `无法判定内容类型（kind=${kind === null || kind === undefined ? 'null' : kind}）`
      + '：非容器条目没有可判定的产物，容器条目也没有 entry.json(skeletonFile) 或 *.model3.json';
    stage.unload();
    stageLog('error', `无法装载 ${name}：${why}`, { model: name, kind, reason: 'kind-undetermined' });
    reportEntryResult(model, { result: 'failed', reason: 'kind-undetermined', message: why });
    markModelFailed(`无法装载 ${name}：${why}`);
    return null;
  }
  const doc = await buildDocument({
    ...model,
    ...(spineAssets || {}),                             // 三件套放顶层（buildSpineAssets 只认这里）
    // 骨架版本同样放顶层：document.js:87 用 entry.version 填 doc.meta.version，
    //   引擎据此选运行时档位；缺了就选最新档 ⇒ 旧格式 skel 读错位
    version: spineVersion || model.version || null,
    kind,                                               // 只表达内容类型
    provider: src.provider || model.provider || null,
    entry,                                              // 是 vfs:// 还是 http:// 由发现阶段决定
  });
  if (!doc || doc.state !== 'ready') {
    const why = (doc && (doc.warnings || []).join('；')) || '原因未知';
    stageLog('error', `无法装载 ${name}：${why}`, { model: name, kind, reason: why });
    // 这条失败没有结构化 reason（是 Document 组装的 warnings 汇总）⇒ reason 传 null，走 message 兜底
    reportEntryResult(model, { result: 'failed', reason: null, message: why });
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
  // 本次装载**实际命中的提供者**（容器由 resolve 给出；目录型由内置装载器给出）。
  //   记在模块级是为了让 mountEntry 的成功回调能拿到它 —— 那里才有"装上了"的信号。
  //   它只用于上报 loadResult.provider（服务端据此重算 display），不参与选面判定。
  // ⚠ 目录型必须也给出 provider，不能留 null：存储层的规则是"ok 但没有 provider ⇒ 视作
  //   无法确定归属、降格记 failed"（entry-states.mjs 的一致性约束）。实测踩过：
  //   目录型装载全部被误记 failed ⇒ 名册每个模型都挂上 ⚠。
  //   目录型的归属服务端早就算好了（display.provider = 唯一认领它的 builtin-*，来自插件声明），
  //   这里读条目自带的 display.provider 兜底 —— 权威仍在服务端，前端不硬编码任何提供者 id。
  lastMountProvider = (src && src.provider) || (model && model.display && model.display.provider) || null;
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
  // kind 未知时不能一刀切拒绝：
  //   · 容器 ⇒ 放行，解包产物到手后由 expandContainerEntry 判定（kind 可能本来就是 null）
  //   · 非容器 ⇒ 没有任何产物可判，明确拒绝（宁可报错也不走错分支）
  if (kind !== 'spine' && kind !== 'live2d' && !entry.container) {
    stage.unload();
    stageLog('warn', `已选中 ${name}（未知内容类型，且不是容器 ⇒ 没有可判定的产物：kind=${kind === null || kind === undefined ? 'null' : kind}）`, { model: name, kind });
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
      // 走到这里才是**真的装载成功**（resolve 成功但 mount 失败的会落到 .catch 里，到不了这行）。
      // 上报服务端：result:'ok' + 实际命中的 provider（`lastMountProvider` 由 loadModel 在 mount 前写入）。
      //   服务端的响应就是重算后的三字段 ⇒ 这一行当场变色、⚠ 消失（不需要刷新页面）。
      //   前端不再自己维护"失败记忆"（原 localStorage 层已删）。
      reportEntryResult(entry, { result: 'ok', provider: lastMountProvider || null });
    })
    .catch((err) => {
      // 被取代属正常竞态结果（不是故障）：只记一条 info，不显示红色错误
      if (err && err.aborted) return; // 被取代是正常竞态结果，不报故障（真生效的那次会写状态）
      // 渲染失败属业务错误：显示在舞台提示与 __WEB__ 里，不抛到控制台（验收要求零错误）
      const msg = formatError(err);
      state.stageError = msg;
      stageLog('error', `渲染失败：${msg}`, { model: name, err: msg });
      document.documentElement.dataset.stageReady = 'error';
      // 失败也上报：reason 用渲染器给的结构化码（没有就用 null），文案与列表悬浮提示同源
      reportEntryResult(entry, { result: 'failed', reason: (err && err.reason) || null, message: msg, provider: lastMountProvider || null });
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

  // 换模型 = 换内容：先把「当前动作」的副本清掉（动作是模型属性，见设计 §1.9）。
  //   必须在这里清而不是装载成功后清：装载失败/被拒时也不该残留上一个模型的动作名，
  //   否则新模型的清单里只要恰好有同名项（碧蓝航线 live2d 全都叫 idle/home/…）就会被继续播。
  resetMotionState();
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
