// infra/slot-registry.js —— 插件插槽注册表（**只登记、不渲染**）
//
// 为什么单独成模块、且不碰 DOM：
//   · 校验逻辑（四类拒绝 + 顺序）是本阶段最容易写错的部分，必须能在 `node --test` 里直接跑；
//     一旦 import 里带上 document/window，就只能靠浏览器套件测，回归成本高一个量级。
//   · 装配层（plugin-host.js）只负责"把插件声明喂进来、把 disposer 挂进回收链"，
//     渲染（S2）另外接 —— 模块边界就是"纯校验 + 纯登记"。
//
// 校验顺序**固定**（设计 §4.2，测试会钉住）：
//   ① 同步窗口（不在脚本装载期的调用直接拒，见下）
//   ② unknown-slot     目录里没有这个名字
//   ③ slot-not-open    目录里有，但阶段未到（必须先于 ④，否则会被误报成"没声明"）
//   ④ undeclared-slot  插件清单没声明它
//   ⑤ risk-mismatch    声明了，但风险等级与目录不符（错误里带双方等级）
//   之后再查 spec 形状（id 必填 / 前缀 / 同插槽内重名）

/** 插槽名里的占位符写法：`panel.group.<groupId>` */
const PLACEHOLDER_RE = /<[^>]+>/;

/** 阶段序号：S1 < S2 < …（非 Sx 的值排最前，视为"未开放"） */
function stageRank(stage) {
  const m = /^S(\d+)$/i.exec(String(stage || '').trim());
  return m ? Number(m[1]) : 0;
}

/**
 * 把目录里的带占位符名字编译成匹配器。
 * 例：`panel.group.<groupId>` → /^panel\.group\.\\S+$/
 * @param {string} pattern
 * @returns {{test: (name: string) => boolean, dynamic: boolean}}
 */
function compilePattern(pattern) {
  const text = String(pattern || '');
  if (!PLACEHOLDER_RE.test(text)) {
    return { test: (name) => name === text, dynamic: false };
  }
  const escaped = text
    .split(/(<[^>]+>)/)
    // 占位符吃"一段非空、非空白"，**允许带点**：设计 §8.2 要求 panel.control.<key> 的 key 写成
    //   plugin.<pluginId>.<key>（本身含两个点），禁点会让那条规范永远匹配不上。
    .map((part) => (PLACEHOLDER_RE.test(part) ? '\\S+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  const re = new RegExp(`^${escaped}$`);
  return { test: (name) => re.test(name), dynamic: true };
}

/**
 * 造一个插槽注册表。
 * @param {{
 *   catalog?: Array<{name:string, type:string, risk:string, stage:string, desc?:string}>,
 *   declaredByPlugin?: Record<string, Array<{name:string, risk:string}>>,
 *   onReject?: (rej: object) => void,
 *   openStage?: string,
 *   isInLoadWindow?: () => boolean,
 * }} [opts]
 */
export function createSlotRegistry(opts = {}) {
  const catalog = Array.isArray(opts.catalog) ? opts.catalog : [];
  const declaredByPlugin = opts.declaredByPlugin && typeof opts.declaredByPlugin === 'object'
    ? opts.declaredByPlugin : {};
  const onReject = typeof opts.onReject === 'function' ? opts.onReject : () => {};
  const openStage = String(opts.openStage || 'S1');
  const isInLoadWindow = typeof opts.isInLoadWindow === 'function' ? opts.isInLoadWindow : () => true;

  /** 目录项 + 编译后的匹配器（构造时算一次，注册期不重复编译） */
  const entries = catalog.map((e) => ({ ...e, matcher: compilePattern(e && e.name) }));
  /** 已登记的插槽：pluginId → [{ name, id, order, label, spec, catalogRisk }] */
  const byPlugin = new Map();
  /** 拒绝记录（最近 50 条，测试与排障都读它） */
  const rejects = [];

  /** 按名字找目录项（静态名优先，其次按占位符模式匹配） */
  function findCatalogEntry(name) {
    const hit = entries.find((e) => !e.matcher.dynamic && e.matcher.test(name));
    if (hit) return hit;
    return entries.find((e) => e.matcher.dynamic && e.matcher.test(name)) || null;
  }

  /** 该插件在清单里声明过哪些插槽（服务端 slotErrors 里被丢的项不算声明成功） */
  function declaredOf(pluginId) {
    const list = declaredByPlugin[pluginId];
    if (!Array.isArray(list)) return [];
    // 服务端下发的 slots 是**字符串数组**（slot-catalog.mjs:171-188 只收非空字符串）；
    //   同时兼容 {name, risk} 形状（老版本/测试注入），统一成同一种记录
    return list
      .map((item) => (typeof item === 'string' ? { name: item.trim(), risk: null } : {
        name: String((item && item.name) || '').trim(),
        risk: item && item.risk ? String(item.risk) : null,
      }))
      .filter((d) => d.name);
  }

  /** 记一条拒绝：给调用方 false、给 onReject、给 stats */
  function reject(pluginId, name, code, why, detail) {
    const rec = { pluginId: pluginId || null, name: name || null, code, why, at: Date.now(), ...(detail || {}) };
    rejects.push(rec);
    if (rejects.length > 50) rejects.shift();
    try { onReject(rec); } catch { /* 拒绝回执失败不影响拒绝本身 */ }
    return rec;
  }

  /** 已登记列表（按插件） */
  function listOf(pluginId) {
    return byPlugin.get(pluginId) || [];
  }

  /**
   * 登记一个插槽。
   * @param {string} pluginId 注册者（必须与清单里的 id 一致）
   * @param {string} name 插槽名，如 `panel.group.settings`
   * @param {object} spec 插件声明：{ id, order?, label?, render?, onAction? }
   * @returns {null | (() => void)} 成功返回 disposer；失败返回 null（原因走 onReject + stats）
   */
  /**
   * 校验"这个插槽能不能被这个插件注册"（前三类 + 风险等级）。
   * 顺序固定：unknown-slot → slot-not-open → undeclared-slot → risk-mismatch。
   * @param {string} pid
   * @param {string} slotName
   * @returns {{ok: true, entry: object, catalogRisk: string} | {ok: false}}
   */
  function checkSlotAllowed(pid, slotName) {
    // ② 目录里没有
    const entry = findCatalogEntry(slotName);
    if (!entry) {
      reject(pid, slotName, 'unknown-slot',
        `插槽「${slotName}」不在插槽目录里（可用：${entries.map((e) => e.name).join(' / ')}）`);
      return { ok: false };
    }
    // ③ 阶段未到（必须先于 ④：否则"目录里有但没开放"会被误报成"插件没声明"）
    if (stageRank(entry.stage) > stageRank(openStage)) {
      reject(pid, slotName, 'slot-not-open',
        `插槽「${slotName}」在当前阶段（${openStage}）尚未开放（目录标注 ${entry.stage}）`,
        { catalogStage: entry.stage, openStage });
      return { ok: false };
    }
    // ④ 插件清单没声明
    const declared = declaredOf(pid).find((d) => d.name === slotName) || null;
    if (!declared) {
      reject(pid, slotName, 'undeclared-slot',
        `插件 ${pid} 没有在 plugin.json 的 slots 里声明「${slotName}」，拒绝注册`,
        { declared: declaredOf(pid).map((d) => d.name) });
      return { ok: false };
    }
    // ⑤ 风险等级不符（目录为准；清单里的 risk 只作显式确认）
    const declaredRisk = String(declared.risk || '').trim();
    const catalogRisk = String(entry.risk || '').trim();
    if (declaredRisk && catalogRisk && declaredRisk !== catalogRisk) {
      reject(pid, slotName, 'risk-mismatch',
        `插槽「${slotName}」风险等级不符：清单声明 ${declaredRisk}，目录要求 ${catalogRisk}`,
        { catalogRisk, declaredRisk });
      return { ok: false };
    }
    return { ok: true, entry, catalogRisk };
  }

  /**
   * 校验 spec 形状：id 必填、必须带插件前缀（设计 §8.2）、同插槽内不许重名。
   * @param {string} pid
   * @param {string} slotName
   * @param {object} spec
   * @returns {{ok: true, id: string, order: number, label: string} | {ok: false}}
   */
  function checkSpec(pid, slotName, spec) {
    const id = String((spec && spec.id) || '').trim();
    if (!id) { reject(pid, slotName, 'missing-id', 'spec.id 必填（同插槽内唯一，用于回收与冲突提示）'); return { ok: false }; }
    // 前缀强制只适用于**键值插槽**（设计 §8.2：panel.control.<key> 的 key 必须写成 plugin.<pluginId>.<key>）。
    //   分组插槽（panel.group.*）里的控件 id 只需全局唯一 —— 它的归属已经由 pluginId 记录，
    //   强行加前缀会把插件自己习惯的命名一脚踢开（验收夹具 zzfixture.amount 就是这么被误拒的）。
    const isKeyed = /^panel\.control\./.test(slotName);
    const prefix = `plugin.${pid}.`;
    if (isKeyed && !id.startsWith(prefix)) {
      reject(pid, slotName, 'bad-id-prefix', `键值插槽的 spec.id「${id}」必须带插件前缀 ${prefix}（设计 §8.2）`);
      return { ok: false };
    }
    if (listOf(pid).some((r) => r.name === slotName && r.id === id)) {
      reject(pid, slotName, 'duplicate-id', `插槽「${slotName}」里已存在 id「${id}」`, { id });
      return { ok: false };
    }
    return {
      ok: true,
      id,
      order: Number.isFinite(Number(spec && spec.order)) ? Number(spec.order) : 1000,
      label: String((spec && spec.label) || id),
    };
  }

  /**
   * 登记一个插槽（只登记，不渲染）。
   * @param {string} pluginId 注册者（必须与清单里的 id 一致）
   * @param {string} name 插槽名，如 `panel.group.settings`
   * @param {object} spec 插件声明：{ id, order?, label?, render?, onAction? }
   * @returns {null | (() => void)} 成功返回 disposer；失败返回 null（原因走 onReject + stats）
   */
  function register(pluginId, name, spec) {
    const pid = String(pluginId || '').trim();
    const slotName = String(name || '').trim();

    // ① 同步窗口：不在脚本装载期的调用一律拒（异步注册在 S1 就是明确不支持）
    if (!isInLoadWindow()) {
      reject(pid, slotName, 'not-in-load-window',
        '不在脚本装载期：slots.register 必须在插件脚本顶层同步调用（await/Promise/setTimeout 之后的注册不被支持）');
      return null;
    }
    if (!pid) { reject('', slotName, 'missing-plugin-id', '缺少 pluginId（宿主未提供装载上下文）'); return null; }
    if (!slotName) { reject(pid, '', 'missing-slot-name', '缺少插槽名'); return null; }

    const allowed = checkSlotAllowed(pid, slotName);
    if (!allowed.ok) return null;
    const shape = checkSpec(pid, slotName, spec);
    if (!shape.ok) return null;

    const record = {
      pluginId: pid, name: slotName, id: shape.id, order: shape.order, label: shape.label,
      risk: allowed.catalogRisk, spec: spec || {},
    };
    const list = byPlugin.get(pid) || [];
    list.push(record);
    byPlugin.set(pid, list);

    let disposed = false;
    return function disposeSlot() {
      if (disposed) return;                       // 幂等：重复调用不会误删别人
      disposed = true;
      const cur = byPlugin.get(pid) || [];
      const i = cur.indexOf(record);
      if (i >= 0) cur.splice(i, 1);
      if (!cur.length) byPlugin.delete(pid);
    };
  }

  /**
   * 回收某个插件的全部插槽登记（卸载插件时调；与逐个 disposer 等价，但更省事）。
   * @param {string} pluginId
   * @returns {number} 回收条数
   */
  function disposeAll(pluginId) {
    const pid = String(pluginId || '').trim();
    const list = byPlugin.get(pid) || [];
    byPlugin.delete(pid);
    return list.length;
  }

  /** 快照（测试与 __SLOT_STATS__ 读它） */
  function stats() {
    const plugins = {};
    let total = 0;
    for (const [pid, list] of byPlugin) {
      plugins[pid] = list.length;
      total += list.length;
    }
    return {
      openStage,
      catalogSize: entries.length,
      total,
      byPlugin: plugins,
      // 明细保留必要字段即可：spec 里可能有函数，不能直接序列化给测试
      entries: [...byPlugin].flatMap(([pid, list]) => list.map((r) => ({
        pluginId: pid, name: r.name, id: r.id, order: r.order, label: r.label, risk: r.risk,
      }))),
      rejects: rejects.slice(),
    };
  }

  /**
   * 供**渲染层**读取的登记明细（含 spec，能拿到 render 函数）。
   *
   * 与 stats() 的区别：stats() 是给测试/__SLOT_STATS__ 的可序列化快照（不含函数），
   *   这里是装配期真正要拿去渲染的对象；两者共用一个真相（byPlugin），只是视图不同。
   * @returns {Array<{pluginId:string,name:string,id:string,order:number,label:string,risk:string,spec:object}>}
   */
  function renderEntries() {
    return [...byPlugin].flatMap(([pid, list]) => list.map((r) => ({
      pluginId: pid, name: r.name, id: r.id, order: r.order, label: r.label, risk: r.risk, spec: r.spec || {},
    })));
  }

  return { register, disposeAll, stats, renderEntries };
}
