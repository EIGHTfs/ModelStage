// engine/pma.js —— 转发层：实现已按职责拆到 `pma/` 目录（detect / resolve / upload / blend）。
//
// 保留本文件是为了**对外导入路径不变**：textures.js / appearance.js / pipeline.js
//   都还写 `./pma.js`（textures.js 那层再转发也保留）。真正的代码在本目录的 index.js 里再导出。
export * from './pma/index.js';
