// spine/canvas.js —— 舞台的**唯一出口**（拆分后只做再导出）。
//
// 保留这个文件名是因为导入路径属于既有契约：调用方一律 `import { createSpineStage } from './spine/canvas.js'`。
// 实现分在同目录 canvas-*.js（runtime / document / view / pixels / engine / api / api-groups / entry）。
// 契约（渲染器契约 §2.1）：对外键一个不能少；setDebug 在设置组与渲染组各定义一次，
//   后挂载者生效 —— 挂载顺序由 attachExtraApi 固定，勿调整。
export { createSpineStage } from './canvas-entry.js';
