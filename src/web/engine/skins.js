// engine/skins.js —— 皮肤与插槽过滤（从 player 拆出，保持单文件规模）
//
// 语义：
//   · pickInitialSkin 装载时挑默认皮肤（判据是"该皮肤下有没有附件"，见函数注释）；
//   · getSkins 取骨架数据里的皮肤名列表（default 也在内，顺序同运行时）；
//   · setSkins 用第一个皮肤名设置，并记住整份列表（切 PMA 重建后要继续生效）；
//   · setSlotFilter 只记关键词，实际隐藏由 hideFilteredSlots/restoreFilteredSlots 在绘制前后做
//     （B5 补绘制侧的过滤，这里先把状态与关键词口径统一，避免出现两处真值）。

/**
 * 选出**装载时应默认使用**的皮肤（不硬编码任何名字，判据来自数据本身）。
 *
 * 为什么需要：有些资源把全部附件放在**具名皮肤**里，`default` 只是个空壳 ——
 *   不设皮肤就等于挂在空壳上，骨架有上百个槽位却只有几个有附件，画面整片空白，
 *   而日志一切正常（mount 成功、动作能播、无 error），极难从日志看出问题。
 * 判据为什么是"能画出来的槽位数"（有附件**且附件有 region**）而不是"皮肤名像不像目录名"：
 *   descriptor 到渲染层只剩 `{name, version, skeletonFile:{name}, atlasFile, textureFiles}`，
 *   **没有路径** ⇒ 推不出目录名；而"这个皮肤下到底挂了多少附件"是任何资源都能直接量的通用事实。
 *
 * 规则（三步，逐步退让）：
 *   ① `default` 下**有**附件 ⇒ 用它（多数资源的常态 ⇒ 行为与改动前完全一致）
 *   ② `default` 是空壳 ⇒ 按运行时顺序取第一个"有附件"的皮肤
 *   ③ 都不行 ⇒ 仍用 `default`（不报错、不改变既有行为）
 *
 * 副作用说明：探测时必须真的切一次皮肤 + setSlotsToSetupPose 才数得准，
 *   所以函数结束时**当前皮肤就是返回值对应的那个**（调用方随后 setSkins 会再设一次，幂等）。
 * @param {object} engine
 * @returns {string|null} 选中的皮肤名；无法判断（无骨架/无皮肤）时返回 null
 */
export function pickInitialSkin(engine) {
  const sd = engine && engine.skeletonData;
  const sk = engine && engine.skeleton;
  if (!sd || !sk || !Array.isArray(sd.skins) || !sd.skins.length) return null;
  const names = sd.skins.map((s) => s && s.name).filter(Boolean);
  if (!names.length) return null;
  /**
   * 数一个皮肤下"setup pose 时**能画出东西**"的槽位（切过去数，故有副作用）。
   *
   * ⚠️ 判据必须是「有附件 **且附件有 region**」，不能只数"有附件"：
   *   实测某资源 `default` 皮肤下挂着 3 个附件，但全是 **PointAttachment**（定位点，没有图）——
   *   只数"有附件"会得到 3 > 0，于是把空壳皮肤判成正常皮肤、画面照样空白。
   *   加上 region 之后：default = 0、`00` = 131 ⇒ 判据才真正指向"能画出来"。
   */
  const drawableCount = (name) => {
    const skin = typeof sd.findSkin === 'function' ? sd.findSkin(name) : null;
    if (!skin) return -1;
    try {
      sk.setSkin(skin);
      if (typeof sk.setSlotsToSetupPose === 'function') sk.setSlotsToSetupPose();
      return (sk.slots || []).filter((slot) => !!(slot.attachment && slot.attachment.region)).length;
    } catch {
      return -1;
    }
  };
  const hasDefault = names.includes('default');
  if (hasDefault && drawableCount('default') > 0) return 'default';
  for (const n of names) {
    if (n === 'default') continue;
    if (drawableCount(n) > 0) return n;
  }
  // 全都不行：回到 default（没有 default 就保持运行时现状、不动它）
  return hasDefault ? 'default' : null;
}

/** 皮肤名列表 */
export function getSkins(engine) {
  const skins = (engine.skeletonData && engine.skeletonData.skins) || [];
  return skins.map((s) => s.name);
}

/**
 * 应用皮肤。
 * @param {object} engine
 * @param {string[]} list
 */
export function setSkins(engine, list) {
  if (!engine.skeleton || !engine.skeletonData) return false;
  const names = Array.isArray(list) ? list : [];
  if (!names.length) return false;
  try {
    if (names.length === 1) {
      const skin = engine.skeletonData.findSkin ? engine.skeletonData.findSkin(names[0]) : null;
      // 名字不存在就别"假装切了"：返回 false，让上层保持原皮肤与真实设置，
      //   否则面板会显示一个不存在的皮肤名而画面没变（下次重建贴图还会按错名字再设一遍）
      if (!skin) return false;
      engine.skeleton.setSkin(skin);
    } else {
      const Skin = engine.spine && engine.spine.Skin;
      const merged = Skin ? new Skin('_combined') : null;
      if (merged) {
        for (const n of names) {
          const s = engine.skeletonData.findSkin ? engine.skeletonData.findSkin(n) : null;
          try { if (s) merged.addSkin(s); } catch { /* 单个皮肤合成失败继续 */ }
        }
        engine.skeleton.setSkin(merged);
      }
    }
    if (typeof engine.skeleton.setSlotsToSetupPose === 'function') engine.skeleton.setSlotsToSetupPose();
    engine.activeSkins = names.slice(); // 只有真的切成功才记账
    return true;
  } catch {
    return false; /* 皮肤不存在时保持原样 */
  }
}

/**
 * 隐藏命中关键词的插槽（绘制前调用）。
 * 口径：槽名或附件名小写包含任一关键词即命中；命中时把 attachment 摘成 null，
 *   绘制后再挂回 —— 不销毁附件，否则切回不过滤时部件就再也画不出来了。
 * @param {object} engine
 * @returns {number} 本次隐藏的槽数（0 表示没过滤）
 */
export function hideFilteredSlots(engine) {
  const backup = engine.slotHiddenBackup || (engine.slotHiddenBackup = []);
  backup.length = 0;
  const keywords = engine.slotFilterKeywords || [];
  if (!keywords.length || !engine.skeleton) return 0;
  const order = engine.skeleton.drawOrder || engine.skeleton.slots || [];
  for (const slot of order) {
    if (!slot || !slot.attachment) continue;
    const slotName = ((slot.data && slot.data.name) || '').toLowerCase();
    const attName = ((slot.attachment && slot.attachment.name) || '').toLowerCase();
    if (keywords.some((k) => slotName.includes(k) || attName.includes(k))) {
      backup.push({ slot, att: slot.attachment });
      slot.attachment = null;
    }
  }
  return backup.length;
}

/**
 * 还原被摘掉的插槽（绘制后调用，异常路径也必须走，否则画面上会一直缺件）。
 * @param {object} engine
 */
export function restoreFilteredSlots(engine) {
  const backup = engine.slotHiddenBackup || [];
  for (const item of backup) item.slot.attachment = item.att;
  backup.length = 0;
}

/**
 * 关键词能命中多少个"当前有附件的槽"（只读，不改骨架）。
 * 用途：让调用方能区分"关键词没匹配到东西"和"匹配到了但隐不隐藏看不出来"。
 * @param {object} engine
 * @param {string[]} keywords
 * @returns {number}
 */
export function countFilterableSlots(engine, keywords) {
  const list = normalizeKeywords(keywords);
  if (!list.length || !engine.skeleton) return 0;
  const order = engine.skeleton.drawOrder || engine.skeleton.slots || [];
  let n = 0;
  for (const slot of order) {
    if (!slot || !slot.attachment) continue;
    const slotName = ((slot.data && slot.data.name) || '').toLowerCase();
    const attName = ((slot.attachment && slot.attachment.name) || '').toLowerCase();
    if (list.some((k) => slotName.includes(k) || attName.includes(k))) n += 1;
  }
  return n;
}

/** 关键词归一化（小写去空） */
export function normalizeKeywords(keywords) {
  return (Array.isArray(keywords) ? keywords : []).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
}
