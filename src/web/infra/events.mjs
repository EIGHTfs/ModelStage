// src/web/infra/events.mjs —— 宿主对外事件的**协议常量**（唯一来源）
//
// 为什么要单独一个文件：这些事件名原先以字符串字面量散落在多个文件里
//   （派发点与监听点各写一遍），任何批量重命名都可能顺手命中它 ——
//   真发生过：`spineviewer:plugins-loaded` 被批量替换成 `spineviewer:plugins-ctx.loaded`，
//   于是"卸载后面板不重建 / document.files 就绪后不重绘"，不报错、只静默失效。
//   收成常量 + 一条"不许再出现字面量"的单测（test/events-const.test.mjs）后，
//   改坏会当场红，而不是等到用户发现功能没反应。
//
// 使用口径：
//   · 派发：window.dispatchEvent(new CustomEvent(EVENTS.PLUGINS_LOADED, { detail }))
//   · 监听：window.addEventListener(EVENTS.PLUGINS_LOADED, handler)
//   · **不要**在任何业务文件里再写 `'spineviewer:...'` 字面量（单测会拦）
//
// 加新事件：在这里登记一个键，然后派发/监听两端都用常量；事件名本身是外部契约
//   （面板/插件可能按名字监听），改动要当成破坏性变更对待。

export const EVENTS = Object.freeze({
  /** 插件装载/卸载完成（面板侧据此重建；detail: { reason? , unloaded? }） */
  PLUGINS_LOADED: 'spineviewer:plugins-loaded',
  /** 单个插件注册成功（detail: { id }） */
  PLUGIN_REGISTERED: 'spineviewer:plugin-registered',
  /** 插件向宿主上报的通知（detail: { kind, msg }） */
  NOTIFY: 'spineviewer:notify',
});

export default EVENTS;
