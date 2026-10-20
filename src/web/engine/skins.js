// engine/skins.js —— 皮肤与插槽过滤（从 player 拆出，保持单文件规模）
//
// 语义与旧引擎一致：
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
 * 应用皮肤（多皮肤时按旧引擎做法合成一个临时皮肤）。
 * @param {object} engine
 * @param {string[]} list
 */
export function setSkins(engine, list) {
  if (!engine.skeleton || !engine.skeletonData) return false;
  const names = Array.isArray(list) ? list : [];
  engine.activeSkins = names.slice();
  if (!names.length) return false;
  try {
    if (names.length === 1) {
      const skin = engine.skeletonData.findSkin ? engine.skeletonData.findSkin(names[0]) : null;
      if (skin) engine.skeleton.setSkin(skin);
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
    return true;
  } catch {
    return false; /* 皮肤不存在时保持原样 */
  }
}

/** 关键词归一化（小写去空） */
export function normalizeKeywords(keywords) {
  return (Array.isArray(keywords) ? keywords : []).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
}
