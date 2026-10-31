// server/plugins/slot-catalog.mjs —— 插槽目录（唯一权威）+ 声明/注册两套校验
//
// 为什么目录要做成**代码里的常量表**（而不是 JSON 文件）：
//   ① 与 PLUGIN_ROLES 同一个做法（registry.mjs:16），插槽名字与风险等级是**契约事实**，
//      不是部署配置 —— 放 JSON 会让"改一个名字"变成运维动作；
//   ② 校验逻辑与目录必须同源：分成两个文件就会出现"目录里加了、校验没跟上"的漂移。
//
// 两个校验入口，对应两个不同时机，**不要混用**：
//   validateDeclaredSlots()      —— 清单校验期（读 plugin.json 时）：校验"你声明了什么"
//   validateSlotRegistration()   —— 注册期（插件调 slots.register 时）：校验"这一次注册"
// 区别只有一条：③ undeclared-slot 只有注册期才判得出来（清单里的每一项按定义都是"已声明"）。
//
// 判定顺序**固定不可调换**（设计 §4.2）：unknown-slot → slot-not-open → undeclared-slot → risk-mismatch。
// 为什么 slot-not-open 必须排在 risk 之前：toolbar.actions 在目录里是 append、但它属于未开放阶段；
//   先判 risk 的话会报"risk 不符" —— 可它写得完全正确，只是阶段没到，这种错误会把人引向错方向。

/** 阶段序列：用来比较"目录声明的 stage 是否已到" */
export const SLOT_STAGES = ['S1', 'S2', 'S3', 'S4', 'S5'];

/** 当前实现阶段。改动这里等于"开放下一批插槽"，是**有意为之的开关**，不要让它随代码漂移 */
export const CURRENT_STAGE = 'S3';

/** 风险三档（设计 §三）：append 只追加 / replace 会替换原生内容 / shadow 会遮蔽原生界面 */
export const SLOT_RISKS = ['append', 'replace', 'shadow'];

/** 插槽类型（设计 §三）：single 单值 / list 列表 / keyed 键值 */
export const SLOT_TYPES = ['single', 'list', 'keyed'];

/**
 * 插槽目录（第一版全表）。
 *
 * 只有这五项 —— 加减插槽必须改这里，且**只改这里**（校验与 /api/plugins 下发都读本表）。
 * name 里的 `<xxx>` 是**占位符**：匹配"该前缀 + 一段非空名字"，不是精确名。
 */
export const SLOT_CATALOG = [
  // 单值：后注册覆盖先注册。会替换原生品牌名 ⇒ replace，且留到 S5（品牌是产品级的东西）
  { name: 'panel.brand', type: 'single', risk: 'replace', stage: 'S5',
    desc: '右栏品牌名/副标题' },
  // 列表：往指定分组追加控件。只追加不动原生 ⇒ append（默认允许），S2 开放
  { name: 'panel.group.<groupId>', type: 'list', risk: 'append', stage: 'S2',
    desc: '往右栏某个分组里追加控件（groupId 由插件定，建议带 plugin. 前缀）' },
  // 键值：按控件 id 占位、可整体替换该控件 ⇒ replace，S5
  { name: 'panel.control.<key>', type: 'keyed', risk: 'replace', stage: 'S5',
    desc: '替换某个内置控件（key 必须写成 plugin.<pluginId>.<key>，见设计 §8.2）' },
  // 工具栏按钮：只追加 ⇒ append，但属于第二步（S3）
  { name: 'toolbar.actions', type: 'list', risk: 'append', stage: 'S3',
    desc: '顶栏追加按钮' },
  // 舞台叠加层：只追加 ⇒ append，暂不排期（S4）
  { name: 'stage.overlay', type: 'list', risk: 'append', stage: 'S4',
    desc: '画布之上的叠加层（调试/水印）' },
];

/** 转义正则元字符（占位符名字里可能有 `.`，必须转义成字面点） */
function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 在目录里找一条插槽：先精确匹配，再按占位符规则匹配。
 *
 * 顺序很重要：`panel.brand` 是精确项，若先跑占位符规则也能被 `panel.<x>` 命中（当前目录没有这种写法，
 *   但将来加了宽泛规则就会出问题）⇒ 精确优先。
 * @param {string} name 插槽名（如 `panel.brand` / `panel.group.设置`）
 * @returns {object|null} 目录项；找不到返回 null
 */
export function matchSlot(name) {
  const want = String(name || '').trim();
  if (!want) return null;
  const exact = SLOT_CATALOG.find((s) => s.name === want);
  if (exact) return exact;
  for (const entry of SLOT_CATALOG) {
    const open = entry.name.indexOf('<');
    if (open < 0) continue;                       // 精确项上面已经处理过
    const head = entry.name.slice(0, open);       // 如 'panel.group.'
    // 占位符吃"一段非空名字"，**允许带点**：设计 §8.2 要求 panel.control.<key> 的 key 写成
    //   `plugin.<pluginId>.<key>`（本身含两个点），若这里禁点，那条规范就永远匹配不上。
    // 转义层级注意：模板串里写 `[^\\s]`，产出的正则才是"非空白"；写成 `[^\\\\s]` 会变成
    //   "不是反斜杠且不是字母 s" —— 任何名字含 s 的插槽（settings / skin）都会被误判 unknown-slot。
    if (new RegExp(`^${escapeRe(head)}[^\\s]+$`).test(want)) return entry;
  }
  return null;
}

/**
 * 目录项的阶段是否已开放（stage 序号 <= 当前阶段序号）。
 *
 * `currentStage` 可注入：生产调用一律用缺省（CURRENT_STAGE），只有测试需要"假装已经到 S5"
 *   才能覆盖 risk-mismatch 这类**只有在插槽已开放时才会走到**的分支
 *   （当前第一版目录里最靠前的是 S2，若不允许注入，那些分支就永远测不到）。
 * @param {object} entry 目录项
 * @param {string} [currentStage] 当前阶段（缺省 CURRENT_STAGE）
 */
export function isSlotOpen(entry, currentStage = CURRENT_STAGE) {
  if (!entry) return false;
  const at = SLOT_STAGES.indexOf(entry.stage);
  const cur = SLOT_STAGES.indexOf(String(currentStage));
  if (at < 0 || cur < 0) return false;            // 写错的 stage 一律按"未开放"处理（保守）
  return at <= cur;
}

/**
 * 校验**一次注册请求**（设计 §4.2 的四步，顺序固定）。
 *
 * @param {string} name 插件要注册的插槽名
 * @param {string[]} declaredSlots 该插件在清单里声明的插槽名（已通过 validateDeclaredSlots）
 * @param {object} [opts] { risk } 插件在这次注册里声明的风险等级（可选；缺省按目录）
 * @returns {{ok: true, entry: object} | {ok: false, error: object}}
 */
export function validateSlotRegistration(name, declaredSlots, opts = {}) {
  const want = String(name || '').trim();
  const declared = Array.isArray(declaredSlots) ? declaredSlots.map(String) : [];
  const currentStage = opts.currentStage === undefined ? CURRENT_STAGE : String(opts.currentStage);

  // ① 目录里有没有这个插槽
  const entry = matchSlot(want);
  if (!entry) {
    return { ok: false, error: { name: want, why: 'unknown-slot', hint: '插槽目录里没有这一项（见 /api/plugins 的 slotCatalog）' } };
  }
  // ② 阶段开放了没有（必须早于 risk：见文件头注释）
  if (!isSlotOpen(entry, currentStage)) {
    return {
      ok: false,
      error: {
        name: want, why: 'slot-not-open',
        catalogStage: entry.stage,
        hint: `该插槽尚未开放（阶段 ${entry.stage}+）`,
      },
    };
  }
  // ③ 清单里声明了没有（只有注册期判得出来）
  if (!declared.includes(want)) {
    return {
      ok: false,
      error: {
        name: want, why: 'undeclared-slot',
        hint: `清单没声明这个插槽；要先在 plugin.json 的 slots 里列出 "${want}"`,
      },
    };
  }
  // ④ risk 与目录是否一致
  const declaredRisk = opts.risk === undefined || opts.risk === null ? entry.risk : String(opts.risk);
  if (declaredRisk !== entry.risk) {
    return {
      ok: false,
      error: {
        name: want, why: 'risk-mismatch',
        catalogRisk: entry.risk,
        declaredRisk,
        hint: `目录要求 ${entry.risk}，你按 ${declaredRisk} 声明`,
      },
    };
  }
  return { ok: true, entry };
}

/**
 * 校验清单里的 `slots` 声明（清单校验期）。
 *
 * **逐项降级**：非法项进 `errors`，合法项照常进 `slots` —— 绝不整体拒绝。
 *   理由：插件因为一个拼错的插槽名就从 /api/plugins 里消失，用户看到的是"插件没了"，
 *   比"某个插槽没生效"难查一个数量级。
 * @param {unknown} raw plugin.json 里的 slots 字段
 * @returns {{slots: string[], errors: object[]}} slots 是**已通过校验**的声明（去重、保序）
 */
export function validateDeclaredSlots(raw, currentStage = CURRENT_STAGE) {
  const slots = [];
  const errors = [];
  if (raw === undefined || raw === null) return { slots, errors };
  if (!Array.isArray(raw)) {
    errors.push({ name: '', why: 'bad-shape', hint: 'slots 必须是字符串数组' });
    return { slots, errors };
  }
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) {
      errors.push({ name: typeof item === 'string' ? item : String(item), why: 'bad-shape', hint: 'slots 的每一项必须是非空字符串' });
      continue;
    }
    const name = item.trim();
    if (slots.includes(name)) continue;             // 重复声明：静默去重（不是错误，作者只是写了两遍）
    const entry = matchSlot(name);
    if (!entry) {
      errors.push({ name, why: 'unknown-slot', hint: '插槽目录里没有这一项（见 /api/plugins 的 slotCatalog）' });
      continue;
    }
    if (!isSlotOpen(entry, currentStage)) {
      errors.push({ name, why: 'slot-not-open', catalogStage: entry.stage, hint: `该插槽尚未开放（阶段 ${entry.stage}+）` });
      continue;
    }
    slots.push(name);
  }
  return { slots, errors };
}

/** settings 第一版只支持两种类型（定案口径 ①）：number/slider 留第二版（涉及范围/步进校验） */
export const SETTING_TYPES = ['enum', 'boolean'];

/**
 * 设置键的强制前缀：`plugin.<pluginId>.`
 *
 * 为什么必须带前缀（与设计 §8.2 的键值插槽同口径）：能力键白名单是**全局合并**的
 *   （`capabilities.settings` 一个数组），两个插件都声明 `sharpness` 时白名单里会出现两条同名字符串，
 *   而"哪一条生效"取决于并入顺序 —— 那是不可调试的。带前缀后撞名从"可能"变成"不可能"。
 * 为什么是 `plugin.` 而不是别的：键值插槽（`panel.control.<key>`）已经用这个前缀，
 *   两条通道口径必须一致，否则同一个插件在两处的键长得不一样。
 */
export const SETTING_KEY_PREFIX = 'plugin.';

/**
 * 校验清单里的 `settings` 声明（清单校验期），同样是**逐项降级**。
 *
 * @param {unknown} raw plugin.json 里的 settings 字段
 * @returns {{settings: object[], errors: object[]}}
 *   settings 每项归一成 {key, type, label, options?, default}（只留这些字段，清单里多写的不透传）
 */
export function validateDeclaredSettings(raw, pluginId = '') {
  const settings = [];
  const errors = [];
  if (raw === undefined || raw === null) return { settings, errors };
  if (!Array.isArray(raw)) {
    errors.push({ key: '', why: 'bad-shape', hint: 'settings 必须是数组' });
    return { settings, errors };
  }
  // 没给 pluginId 就不校验前缀（缺省向后兼容：老调用点不受影响，也不会误判）
  const requiredPrefix = pluginId ? `${SETTING_KEY_PREFIX}${pluginId}.` : null;
  const seen = new Set();
  for (const item of raw) {
    const key = item && typeof item === 'object' && typeof item.key === 'string' ? item.key.trim() : '';
    if (!key) {
      errors.push({ key: '', why: 'bad-shape', hint: 'settings 的每一项必须带非空字符串 key' });
      continue;
    }
    // 前缀校验放在"key 非空"之后、"类型"之前：先判形状再判语义
    if (requiredPrefix && !key.startsWith(requiredPrefix)) {
      errors.push({
        key, why: 'key-prefix',
        hint: `settings 的 key 必须以 ${requiredPrefix} 开头（能力键白名单是全局合并的，不带前缀会撞名）`,
      });
      continue;
    }
    if (seen.has(key)) {
      errors.push({ key, why: 'duplicate-key', hint: '同一个 key 声明了多次，只保留第一条' });
      continue;
    }
    const type = String((item && item.type) || '');
    if (!SETTING_TYPES.includes(type)) {
      errors.push({ key, why: 'bad-type', hint: `type 只支持 ${SETTING_TYPES.join(' / ')}（number/slider 留第二版）` });
      continue;
    }
    const label = item && typeof item.label === 'string' ? item.label : key;
    if (type === 'enum') {
      const options = Array.isArray(item.options) ? item.options.map(String) : [];
      if (options.length < 2) {
        errors.push({ key, why: 'bad-options', hint: 'enum 至少要两个 options' });
        continue;
      }
      const def = item.default === undefined ? options[0] : item.default;
      if (!options.includes(String(def))) {
        errors.push({ key, why: 'bad-default', hint: `default(${String(def)}) 不在 options 里` });
        continue;
      }
      seen.add(key);
      settings.push({ key, type, label, options, default: String(def) });
      continue;
    }
    // boolean
    const def = item.default === undefined ? false : item.default;
    if (typeof def !== 'boolean') {
      errors.push({ key, why: 'bad-default', hint: 'boolean 的 default 必须是 true/false' });
      continue;
    }
    seen.add(key);
    settings.push({ key, type, label, default: def });
  }
  return { settings, errors };
}
