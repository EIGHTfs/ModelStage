// test/live2d-lifecycle.test.mjs —— Live2D 覆盖层生命周期静态回归（node --test，无需浏览器）
//
// 为什么要有这个套件：G6 引入过一个"同面切换后整屏空白"的真 bug ——
//   PIXI 的 app.destroy(true) 会摘掉 canvas 只留容器，而 buildOverlay 当时只看
//   `container.isConnected` 就复用空容器，于是 ensureApp 拿到 null canvas ⇒ PIXI 自建一张
//   **不在 DOM 里的游离画布**：画面全白，但 stats 与像素采样全都正常（用"像素"当证据永远发现不了）。
// 所以这里的判据一律是 **DOM 关系**，不是像素。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDomShim } from './helpers/dom-shim.mjs';
import { createOverlay } from '../src/web/live2d/overlay.js';
import { releaseLive2DResources } from '../src/web/live2d/release.js';

const OVERLAY_ID = 'live2d-overlay';
const CANVAS_ID = 'live2d-overlay-canvas';

/** 造一份被测用的 overlay 上下文（st 是普通对象，模拟舞台状态） */
function setup() {
  const { document, reset } = installDomShim();
  reset();
  const logs = [];
  const st = {
    app: null, overlay: null, model: null, modelId: null, meta: null,
    motionMap: new Map(), vfsStats: { hits: 1 }, active: false, libsReady: {},
  };
  const overlay = createOverlay({
    st,
    note: (m) => logs.push(String(m)),
    surfaceSize: () => ({ width: 800, height: 600, dpr: 1 }),
    getOverlayHost: () => document.body,
  });
  return { document, st, overlay, logs };
}

test('契约 §五-7：unmount（destroy(true) 摘掉 canvas）后 buildOverlay 仍返回含 canvas 的容器', () => {
  const { document, st, overlay } = setup();
  const first = overlay.buildOverlay();
  assert.ok(document.getElementById(CANVAS_ID), '首次应建出覆盖层 canvas');

  // 模拟 PIXI app.destroy(true)：removeView 把 canvas 从容器里摘掉，只留容器 div
  const canvas = document.getElementById(CANVAS_ID);
  first.removeChild(canvas);
  assert.equal(document.getElementById(CANVAS_ID), null, '前置：canvas 已被摘掉');
  assert.equal(first.isConnected, true, '前置：容器仍在文档里（这正是当初误判的来源）');

  const again = overlay.buildOverlay();
  assert.equal(again, first, '容器应被复用（不整块重建）');
  const rebuilt = document.getElementById(CANVAS_ID);
  assert.ok(rebuilt, '契约 §五-7：buildOverlay 必须补建 canvas，否则 PIXI 会渲染到游离画布');
  assert.equal(rebuilt.parentElement, first, 'canvas 必须挂在覆盖层容器内');
  assert.equal(st.overlay, first, 'st.overlay 应指向容器');
});

test('unmount：内容复位、**app 常驻**、容器保留（只隐藏，不摘 DOM）', () => {
  const { document, st, overlay } = setup();
  overlay.buildOverlay();
  let destroyed = 0;
  st.app = { view: { canvas: null }, renderer: null, destroy() { destroyed += 1; }, stop() {} };
  st.model = { destroy() {} };
  st.modelId = 'live2d-x';
  st.active = true;

  releaseLive2DResources({ st, note: () => {}, doc: document });

  // 契约（防上下文泄漏）：app **不 destroy**——destroy(true) 的 removeView 会摘掉 canvas，
  //   下次必然 new PIXI.Application()，每次多 1 个匿名探测上下文，累积到浏览器上限（~16）就画布黑。
  assert.equal(destroyed, 0, 'unmount/dispose 都不得 destroy app（app 常驻复用）');
  assert.ok(st.app, 'app 必须保留（常驻）');
  assert.equal(st.model, null, 'unmount 后 model 必须为 null');
  assert.equal(st.active, false, 'unmount 后 active 必须为 false');
  // 容器保留（app 常驻⇒它的 canvas 还得在里面）；"容器在、canvas 不在"的旧坑由"不再 destroy app"避免
  assert.ok(document.getElementById(OVERLAY_ID), '容器保留（只隐藏）');
});

test('unmount 幂等：连调两次不抛错、状态不变', () => {
  const { document, st, overlay } = setup();
  overlay.buildOverlay();
  st.app = { destroy() {} };
  st.active = true;

  releaseLive2DResources({ st, note: () => {}, doc: document });
  assert.doesNotThrow(() => releaseLive2DResources({ st, note: () => {}, doc: document }), '第二次必须幂等不抛错');
  assert.ok(st.app, 'app 仍保留');
  assert.equal(st.active, false);
  assert.ok(document.getElementById(OVERLAY_ID), '容器保留（app 的 canvas 还在里面）');
});

test('dispose：与 unmount 同路径（app 常驻、容器保留、仅隐藏）', () => {
  const { document, st, overlay } = setup();
  overlay.buildOverlay();
  st.app = { view: { canvas: null }, renderer: null, destroy() {}, stop() {} };
  releaseLive2DResources({ st, note: () => {}, doc: document });
  assert.ok(st.app, 'app 常驻');
  assert.ok(document.getElementById(OVERLAY_ID), '容器保留（不摘 DOM，避免"容器在、canvas 不在"的旧坑）');
});

test('释放之后再装载：buildOverlay 全量重建（容器 + canvas 都在）', () => {
  const { document, st, overlay } = setup();
  overlay.buildOverlay();
  st.app = { destroy() {} };
  releaseLive2DResources({ st, note: () => {}, doc: document });

  const fresh = overlay.buildOverlay();
  assert.ok(fresh, '释放后必须能重建容器');
  assert.equal(fresh.isConnected, true, '重建的容器要在文档里');
  const canvas = document.getElementById(CANVAS_ID);
  assert.ok(canvas, '重建后必须有 canvas（否则又是游离画布白屏）');
  assert.equal(canvas.parentElement, fresh);
});
