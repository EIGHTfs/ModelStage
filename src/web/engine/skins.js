// engine/skins.js —— 皮肤与插槽过滤（从 player 拆出，保持单文件规模）
//
// 语义：
//   · getSkins 取骨架数据里的皮肤名列表（default 也在内，顺序同运行时）；
//   · setSkins 用第一个皮肤名设置，并记住整份列表（切 PMA 重建后要继续生效）；
//   · setSlotFilter 只记关键词，实际隐藏由 hideFilteredSlots/restoreFilteredSlots 在绘制前后做
//     （B5 补绘制侧的过滤，这里先把状态与关键词口径统一，避免出现两处真值）。

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
