// infra/dom.js —— 最小 DOM 工厂（跨模块公共层）
//
// 本文件是 `el()` 的**唯一实现**。panel/dom.js 与 roster/rows.js 只是 re-export ——
//   **不要在任何地方再新增 el 的实现**（历史上曾有三份各自漂移：panel / roster / debug）。
//   判据是"函数体只有一份"，不是"文本只出现一次"：re-export 不算第二份实现。
//
// 为什么收在 infra/：panel / roster / debug 三个功能层都要建节点，
//   而这个工厂与业务无关；放在任何单一功能层都会让另外两层反向依赖它。

/**
 * 建元素：tag + class + 文本。
 *
 * 三处判空的语义（改动前历史实现一致，逐条都是刻意的，别"简化"）：
 *   · className 用 falsy 判空 ⇒ 传 '' / undefined / null / 0 都**不设 class 属性**
 *     （不是设成空字符串 —— 那会在 outerHTML 里留下 `class=""`）
 *   · text 用 `!== undefined && !== null` 判空 ⇒ **`0` 与 `''` 会被写入**
 *     （数字 0 是常见内容，用 falsy 判空会把 0 吞掉）
 *   · text 一律 `String(...)` 后再写入 ⇒ 传对象得到 "[object Object]"，
 *     但调用方实际传的通常是对象索引取值后的字符串（见 panel/view.js）
 *
 * @param {string} tag 标签名
 * @param {string} [className] 类名（可空）
 * @param {string|number} [text] 文本内容（0 与空串都会写入）
 * @returns {HTMLElement}
 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
