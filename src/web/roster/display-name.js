// web/roster/display-name.js —— 列表显示名的"取一次 + 就地更新"
//
// 口径（契约 §1.3 / 设计 列表显示名-displayName.md）：
//   · 只对**被选中的条目**取一次（不批量、不后台预扫）
//   · 名字由服务端从插件 analyze() 拿到并写缓存；前端只负责"要"和"显示"
//   · 拿到后**就地改文本**，不重建 chars —— 重建会丢展开态、滚动位置与当前选中项
//
// 前端不认识任何格式：它只把服务端给的字符串贴到 `.tree-variant-text` 与 `.tree-char-title` 上。

/**
 * 取一个条目的显示名（命中缓存时服务端不跑分析）。
 *
 * @param {{base: string, rootId: string, rel: string}} req
 * @returns {Promise<string|null>} 拿不到就是 null（调用方保持原样）
 */
export async function fetchDisplayName({ base, rootId, rel }) {
  if (!rootId || !rel) return null;
  try {
    const res = await fetch(`${base}/api/entries/display-name`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootId, rel }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.ok !== true) return null;
    const name = typeof data.displayName === 'string' ? data.displayName.trim() : '';
    return name || null;
  } catch {
    // 取名字失败不是错误：列表保持旧显示，不弹错、不阻塞
    return null;
  }
}

/**
 * 把名字就地贴到 DOM 上（不重建节点）。
 *
 * 目标：
 *   · 该模型自己的变体行 → `.tree-variant-text`
 *   · 它所属的角色行     → `.tree-char-title`
 * 两者**必须同时更新**（只改一处会出现"变体名变了、角色标题还是 __data"的割裂）。
 *
 * @param {Document} doc
 * @param {{modelId: string, charKey?: string|null, displayName: string|null}} opts
 * @returns {boolean} 是否真的改了文本
 */
export function paintDisplayName(doc, { modelId, charKey, displayName }) {
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (!doc || !modelId || !name) return false;
  let changed = false;

  // 变体行：按 modelId 精确匹配（同一角色下可能有多个变体，只改被选中的那条）
  const variantRow = doc.querySelector(`[data-model-id="${cssEscape(modelId)}"]`);
  if (variantRow) {
    const textEl = variantRow.querySelector('.tree-variant-text');
    if (textEl && textEl.textContent !== name) {
      textEl.textContent = name;
      changed = true;
    }
  }

  // 角色行：标题同步成同一个名字
  if (charKey) {
    const charRow = doc.querySelector(`[data-char-key="${cssEscape(charKey)}"]`);
    if (charRow) {
      const titleEl = charRow.querySelector('.tree-char-title');
      if (titleEl && titleEl.textContent !== name) {
        titleEl.textContent = name;
        changed = true;
      }
    }
  }
  return changed;
}

/** 极简 CSS 属性值转义：只处理会破坏选择器的字符（够用即可，不引依赖） */
function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}
