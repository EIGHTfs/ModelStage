// roster.js —— 名册数据层：资源根 → 模型列表 → 角色归并（M2）
//
// 做什么：
//   1. 按资源根取模型清单（三类来源，按根的 kind 与扫描结果选择）；
//   2. 取该根的角色名表并与其它根合并（同一份名表只取一次）；
//   3. 把模型归并成「角色 → 变体」，归并规则**逐条照 legacy/patches/char-tree.js**，不自行发明：
//      · charKeyOf：去 cutscene_ 前缀 → 去 _hx 后缀 → 去尾部 _N（顺序不可换，见该文件注释）
//      · assetCandidates：查表逐级放宽 原样 → 剥 _hx → 再剥 _N
//      · 命中名表用英文名做分组键、标题显示「中文名 英文名」；未命中用 charKeyOf 结果兜底
//      · 变体排序：立绘在前、技能（cutscene_）在后，再按资源名数字序
//      · 角色排序：普通角色在前、NPC 在后，同组按显示名
//   4. 本模块只做数据，不碰 DOM（DOM 在 roster-view.js），便于单独验证归并结果。
//
// 数据源选择（实测依据）：
//   · 统一走 /api/catalog：它把 spine 模型、live2d 模型、容器单文件合并成一份清单，
//     所以发现阶段不再按"根的 kind"猜该问哪个扫描器（同一个根可以混合内容）；
//   · 容器单文件（资源包）由列举层用魔数标记 `container`，kind 取插件声明的产出类型；
//     改取 /api/live2d/models。

import { getJson } from '../infra/api.js';
import { diagEvent } from '../app/status.js';

/** 资源名后缀归一化候选（与 char-tree.js 的 ASSET_SUFFIX_PATTERNS 一致） */
const ASSET_SUFFIX_PATTERNS = [/_hx$/i];

/**
 * 基础角色键：去 cutscene_ 前缀 → 去 _hx → 去尾部 _N。
 * 顺序不可换：`dafeng_2_hx` 先剥 _N 会因结尾非数字而剥不动，必须先剥 _hx。
 * @param {string} name
 * @returns {string}
 */
export function charKeyOf(name) {
  return String(name || '')
    .replace(/^cutscene_/i, '')
    .replace(/_hx$/i, '')
    .replace(/_\d+$/, '');
}

/**
 * 查表候选键（小写），逐级放宽：原样 → 剥 _hx → 再剥尾部 _N。
 * @param {string} name
 * @returns {string[]}
 */
export function assetCandidates(name) {
  const raw = String(name || '').toLowerCase();
  const out = [raw];
  for (const re of ASSET_SUFFIX_PATTERNS) {
    const prev = out[out.length - 1];
    const next = prev.replace(re, '');
    if (next && next !== prev) out.push(next);
  }
  const prev = out[out.length - 1];
  const noNum = prev.replace(/_\d+$/, '');
  if (noNum && noNum !== prev) out.push(noNum);
  return out;
}

/** 名表合并容器：byAsset（资源名 → 角色 id）+ characters（id → 角色信息） */
export function createNameIndex() {
  return { byAsset: {}, characters: {}, cache: new Map() };
}

/**
 * 把一份名表并进索引（多个资源根共用同一份名表时只并一次）。
 * @param {{byAsset?: object, characters?: object}} index
 * @param {{byAsset?: object, characters?: object}} table
 */
export function mergeNameTable(index, table) {
  if (!table) return;
  Object.assign(index.byAsset, table.byAsset || {});
  Object.assign(index.characters, table.characters || {});
  index.cache.clear(); // 合并后旧查询结果作废
}

/**
 * 查角色名（带缓存）。命中返回 {name, nameZh, costume, npc}，未命中返回 null。
 * @param {{byAsset: object, characters: object, cache: Map}} index
 * @param {string} assetName
 * @returns {{name: string, nameZh: string, costume: string, npc: boolean}|null}
 */
export function lookupName(index, assetName) {
  const raw = String(assetName || '').toLowerCase();
  if (index.cache.has(raw)) return index.cache.get(raw);
  let hit = null;
  if (index.byAsset && index.characters) {
    for (const key of assetCandidates(raw)) {
      const id = index.byAsset[key];
      const c = id ? index.characters[id] : null;
      if (c && c.name) {
        hit = {
          name: c.name,
          nameZh: c.nameZh || '',
          costume: c.costume || '',
          npc: !!c.npc,
        };
        break;
      }
    }
  }
  index.cache.set(raw, hit);
  return hit;
}

/**
 * 取一个资源根的模型清单。
 * @param {{id: string, name: string, kind?: string}} root
 * @returns {Promise<{models: object[], source: string}>}
 */
export async function loadRootModels(root) {
  const id = encodeURIComponent(root.id);
  // 单一发现路径：/api/catalog 一次给出该根下的**全部**模型条目
  //   （spine 模型 + live2d 模型 + 容器单文件），所以不必再"按根类型猜该问哪个扫描器"，
  //   同一个根里既能放普通模型目录、也能放容器文件。
  //   容器条目的 kind 由插件声明（解包后是什么内容），并带 `container` 标记供装载层解包用。
  const data = await getJson(`/api/catalog?root=${id}`);
  const models = Array.isArray(data.entries) ? data.entries : [];
  const containers = models.filter((m) => m.container).length;
  diagEvent('bundle.parse', { root: id, source: 'catalog', models: models.length, containers }, { level: 'info', src: 'app' });
  return { models, source: 'catalog' };
}

/**
 * 取一个资源根的名表（未配置 names 时服务端返回 names:null，这里当作"没有名表"）。
 * @param {string} rootId
 * @returns {Promise<object|null>}
 */
export async function loadRootNames(rootId) {
  try {
    const r = await getJson(`/api/names?root=${encodeURIComponent(rootId)}`);
    if (!r || !r.byAsset || !r.characters) return null;
    return r;
  } catch {
    // 名表缺失/损坏不应阻断名册（无表时按资源名归组），但要把原因带给调用方显示
    return null;
  }
}

/** 变体标签：Spine / Live2D / 资源包（与 char-tree.js 的 variantLabel 语义一致） */
export function variantLabel(m) {
  if (!m) return 'Spine';
  // 先判"是不是容器单文件"：它的 kind 现在是内容类型（live2d），
  //   若先判 kind 就会把资源包标成 Live2D，用户看不出它是包。
  if (m.container) return '资源包';
  if (m.kind === 'live2d') return 'Live2D';
  return 'Spine';
}

/**
 * 变体行的主文本：服装名（名表）优先，无名表时退回目录名/资源名。
 * @param {object} m
 * @param {object|null} nm 名表命中结果
 * @returns {{text: string, origName: string}}
 */
export function variantText(m, nm) {
  const dirName = String(m.srcDir || '').split('/').slice(-1)[0] || '';
  const origName = String(m.name || '');
  const text = nm && nm.costume ? nm.costume : (dirName || origName);
  return { text, origName };
}

/**
 * 把一批模型归并成角色数组（照 char-tree.js 的 buildTree + finalizeTree 规则）。
 * @param {object[]} models 同一游戏（可能来自多个资源根）的全部模型
 * @param {object} nameIndex
 * @param {string} [gameName] 游戏名；给了就拼进角色键（`char:游戏名|组名`，与旧前端一致，
 *   避免不同游戏下同名角色共用同一个展开键）
 * @returns {{chars: object[], stats: {models: number, exact: number, suffix: number, miss: number}}}
 */
export function buildChars(models, nameIndex, gameName = '') {
  const stats = { models: models.length, exact: 0, suffix: 0, miss: 0 };
  const charMap = new Map();

  for (const m of models) {
    const nm = lookupName(nameIndex, m.name);
    if (nm) {
      // via 只用于统计：原样命中 vs 剥后缀后才命中
      const keys = assetCandidates(m.name);
      const hitKey = keys.find((k) => nameIndex.byAsset[k]);
      stats[hitKey === keys[0] ? 'exact' : 'suffix'] += 1;
    } else {
      stats.miss += 1;
    }
    const groupName = nm ? nm.name : charKeyOf(m.name);
    const key = gameName ? `char:${gameName}|${groupName}` : `char:${groupName}`;
    if (!charMap.has(key)) {
      charMap.set(key, {
        key,
        groupName,
        title: nm && nm.nameZh ? `${nm.nameZh} ${nm.name}` : groupName,
        npc: nm ? nm.npc : false,
        variants: [],
      });
    }
    charMap.get(key).variants.push({ model: m, nm });
  }

  const chars = [...charMap.values()];
  for (const c of chars) {
    // 组内：立绘（非 cutscene_）在前，其余按资源名数字序
    c.variants.sort((a, b) => rankVariant(a.model) - rankVariant(b.model)
      || String(a.model.name).localeCompare(String(b.model.name), undefined, { numeric: true }));
    c.baseName = c.variants.length ? charKeyOf(String(c.variants[0].model.name || '')) : '';
    c.iconUrl = c.variants.map((v) => v.model.iconUrl).find(Boolean) || null;
  }
  // 角色排序：普通角色在前、NPC 在后；同组按显示名
  chars.sort((a, b) => (a.npc - b.npc) || a.title.localeCompare(b.title, undefined, { numeric: true }));

  return { chars, stats };
}

/** 组内排序权重：技能/剧情变体（cutscene_）排后面 */
function rankVariant(model) {
  return /^cutscene_/i.test(String(model.name || '')) ? 1 : 0;
}
