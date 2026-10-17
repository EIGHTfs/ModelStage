// infra/shortcuts.js —— 快捷键的唯一真相源
//
// 设计口径：
//   ① **所有**键位/动作名/文案只在这个文件出现；其他地方只能通过 registerShortcuts 注册 handler，
//      不得再各自 window.addEventListener('keydown')（否则"某个键在某个模块偷偷生效"永远查不清）。
//   ② 焦点在输入类元素里时**一律不响应** —— 用户在搜索框打 a 不该跳模型。
//   ③ 键位重复在**启动时**就抛错（早暴露，别等运行时出现"按一下同时干两件事"）。
//
// 不做什么：
//   · 不处理组合键（Ctrl/⌘/Alt 一律放行给浏览器，避免抢刷新/查找/截图等原生快捷键）；
//   · 不管长按连发（浏览器自带 repeat，交给各 action 自己决定要不要忽略）。

/**
 * 快捷键表（唯一声明处）。
 *
 * `key` 用 KeyboardEvent.key 的**小写**形式：字母键写作 'a'，空格写作 ' '，Esc 写作 'Escape'。
 * `action` 是注册表里的动作名（registerShortcuts 的 key）。
 * `label` 用于文档与调试输出，不参与匹配。
 */
export const SHORTCUTS = [
  { key: ' ', action: 'togglePlay', label: '播放 / 暂停' },
  { key: 'a', action: 'prev', label: '上一个' },
  { key: 's', action: 'next', label: '下一个' },
  { key: 'z', action: 'prevMotion', label: '上一个动作' },
  { key: 'x', action: 'nextMotion', label: '下一个动作' },
  { key: 'r', action: 'resetView', label: '重置视图' },
  { key: 'e', action: 'screenshot', label: '截图导出' },
  { key: 'h', action: 'toggleCinema', label: '影院模式（进/出）' },
  { key: 'Escape', action: 'exitCinema', label: '退出影院（只退不进）' },
];

/** 焦点落在这些元素里时，快捷键一律不响应 */
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * 判断事件是否发生在"用户正在输入"的上下文里。
 * @param {KeyboardEvent} e
 * @returns {boolean} true = 正在输入，应跳过快捷键
 */
export function isTypingContext(e) {
  const t = e && e.target;
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName || '').toUpperCase();
  return TYPING_TAGS.has(tag);
}

/** 带修饰键的组合留给浏览器（Ctrl+R 刷新、⌘F 查找、Alt+Tab 等） */
function hasModifier(e) {
  return !!(e.ctrlKey || e.metaKey || e.altKey);
}

/**
 * 校验键位表：重复键直接抛错。
 *
 * 为什么在启动时抛：重复键的运行时表现是"按一下触发两件事"或"只有后注册的那个生效"，
 * 排查时很难想到是按键表写重了 —— 早失败比晚诡异好。
 * @param {Array<{key:string, action:string}>} [list]
 */
export function validateShortcuts(list = SHORTCUTS) {
  const seen = new Map();
  for (const s of list) {
    const k = String(s.key);
    if (seen.has(k)) {
      throw new Error(`快捷键冲突：${k} 同时绑定了 ${seen.get(k)} 与 ${s.action}`);
    }
    if (!s.action) throw new Error(`快捷键 ${k} 缺少 action`);
    seen.set(k, s.action);
  }
  return true;
}

/** 已注册的 handler（action → fn）；重复注册会被拒绝，避免"两个模块抢同一个动作" */
const handlers = new Map();
let bound = false;
/** 最近一次按键命中记录（诊断/自动化断言用，不参与逻辑） */
let lastHit = null;

/**
 * 注册快捷键处理器并挂上**唯一**的全局键盘监听。
 *
 * 可重复调用（幂等）：后传入的 handler 会覆盖同名动作，监听只挂一次。
 * @param {Record<string, Function>} map action → handler
 * @returns {{bound:boolean, count:number}} 注册结果
 */
export function registerShortcuts(map) {
  validateShortcuts();
  for (const [action, fn] of Object.entries(map || {})) {
    if (typeof fn !== 'function') continue;
    handlers.set(action, fn);
  }
  if (!bound) {
    window.addEventListener('keydown', onKeyDown);
    bound = true;
  }
  return { bound, count: handlers.size };
}

/**
 * 全局键盘分发。
 * @param {KeyboardEvent} e
 */
function onKeyDown(e) {
  if (hasModifier(e)) return;              // 组合键交给浏览器
  if (isTypingContext(e)) return;          // 正在输入：一个键都不抢
  if (e.defaultPrevented) return;          // 已被更具体的组件处理（如自绘下拉的键盘导航）

  const raw = typeof e.key === 'string' ? e.key : '';
  const key = raw.length === 1 ? raw.toLowerCase() : raw;
  const item = SHORTCUTS.find((s) => s.key === key);
  if (!item) return;
  const fn = handlers.get(item.action);
  if (!fn) return;

  // 空格默认会滚动页面、'/' 会唤起快速查找等：命中快捷键时压掉默认行为
  e.preventDefault();
  lastHit = { key, action: item.action, at: Date.now() };
  try { fn(e); } catch (err) { /* 单个动作失败不能影响键盘本身 */ console.warn('[shortcuts]', item.action, err); }
}

/** 诊断快照（自动化断言用）：已绑动作数 / 是否已挂监听 / 最近命中 */
export function shortcutStats() {
  return {
    bound,
    actions: [...handlers.keys()],
    keys: SHORTCUTS.map((s) => s.key),
    lastHit,
  };
}
