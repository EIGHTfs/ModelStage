// test/renderer-contract.test.mjs —— 渲染器契约（§二 接口 / §五-3 卸载 / §五-7 GL 资源）静态回归
//
// 为什么用桩渲染器：这一层要验的是"**方法存在性**与**分派规则**"，不是某个渲染器怎么画。
//   用桩能在 Node 里秒级验证，且不依赖浏览器/服务；真实渲染器的存在性检查只是"有没有漏实现"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDomShim } from './helpers/dom-shim.mjs';
import { pickDisposeCall } from '../src/web/render/surface.js';

/** 造一个桩渲染器：记录被调用的方法 */
function stubRenderer(id, methods = ['mount', 'unmount', 'dispose']) {
  const calls = [];
  const r = { id, calls };
  for (const m of methods) r[m] = (...args) => { calls.push(m); return args; };
  return r;
}

/** 造一个可跑 activate 的 switcher（state/renderers/disposeActive 全用桩） */
async function makeSwitcher({ activeId = null, docs = {} } = {}) {
  const { createSwitcher } = await import('../src/web/render/surface-switch.js');
  const modes = [];
  const state = { activeId, swapping: false, pending: null };
  const renderers = docs;
  const switcher = createSwitcher({
    renderers,
    state,
    setMode: () => {},
    disposeActive: (mode) => { modes.push(mode || 'dispose'); },
    handle: () => ({ canvas: null }),
    measure: () => {},
    requestRender: () => {},
    note: () => {},
    noteSwitch: () => {},
    onSwitched: () => {},
  });
  return { switcher, modes, state };
}

// 契约 §二（接口）：每个渲染器必须同时实现 unmount 与 dispose
test('契约 §二：spine / live2d 渲染器都同时实现 unmount 与 dispose', async () => {
  installDomShim();
  const { createSpineRenderer } = await import('../src/web/render/spine.js');
  const { createLive2DRenderer } = await import('../src/web/render/live2d.js');
  const fakeStage = { unload() {}, dispose() {}, load() { return {}; } };
  const fakeLive2d = { mount() { return {}; }, unmount() {}, dispose() {} };
  const pairs = [
    ['spine', createSpineRenderer({ stage: fakeStage })],
    ['live2d', createLive2DRenderer({ live2d: fakeLive2d })],
  ];
  for (const [name, r] of pairs) {
    assert.equal(typeof r.unmount, 'function', `${name} 渲染器缺 unmount（契约 §二）`);
    assert.equal(typeof r.dispose, 'function', `${name} 渲染器缺 dispose（契约 §二）`);
  }
});

// 契约 §五-3：unmount 释放内容、dispose 彻底释放；两者都不得遗留自建 GL 资源（§五-7）
test('契约 §五-3：pickDisposeCall 按 mode 选方法（unmount / dispose）', () => {
  const r = stubRenderer('stub');
  pickDisposeCall(r, 'unmount')();
  assert.deepEqual(r.calls, ['unmount'], "mode='unmount' 应调用 unmount（保留引擎）");
  pickDisposeCall(r, 'dispose')();
  assert.deepEqual(r.calls, ['unmount', 'dispose'], "mode='dispose' 应调用 dispose（彻底拆）");
  pickDisposeCall(r)();
  assert.deepEqual(r.calls, ['unmount', 'dispose', 'dispose'], '缺省语义 = dispose（宁可彻底拆）');
});

// 契约 §五-7：渲染器没实现 unmount 时**必须回落 dispose**，不能什么都不做（否则就是资源泄漏）
test('契约 §五-7：渲染器缺 unmount 时回落调 dispose（不得静默跳过）', () => {
  const onlyDispose = stubRenderer('only-dispose', ['mount', 'dispose']);
  pickDisposeCall(onlyDispose, 'unmount')();
  assert.deepEqual(onlyDispose.calls, ['dispose'], '缺 unmount ⇒ 回落 dispose，不能空转');

  const nothing = { id: 'nothing', mount() {} };
  assert.equal(pickDisposeCall(nothing, 'unmount'), null, '两种都没有时应返回 null（由调用方决定如何记日志）');
  assert.equal(pickDisposeCall(null, 'unmount'), null, '空渲染器也必须安全');
});

// 契约 §五-3 + G6 分流规则：同渲染器换内容 → unmount；换渲染器 → dispose
test('surface-switch 分流：previous === next → unmount；previous !== next → dispose', async () => {
  const spine = stubRenderer('spine');
  const live2d = stubRenderer('live2d');
  const renderers = new Map([['spine', spine], ['live2d', live2d]]);

  // ① spine → spine（同面换内容）：unmount
  {
    const { switcher, modes } = await makeSwitcher({ activeId: 'spine', docs: renderers });
    await switcher.activate({ state: 'ready', kind: 'spine' });
    assert.deepEqual(modes, ['unmount'], '同渲染器换内容应走 unmount（保留引擎）');
  }
  // ② spine → live2d（换渲染器）：dispose
  {
    const { switcher, modes } = await makeSwitcher({ activeId: 'spine', docs: renderers });
    await switcher.activate({ state: 'ready', kind: 'live2d' });
    assert.deepEqual(modes, ['dispose'], '换渲染器必须 dispose（不留旧 GL 上下文）');
  }
  // ③ live2d → live2d（同面）：unmount（具体实现内部同样是全拆，见 live2d-lifecycle 套件）
  {
    const { switcher, modes } = await makeSwitcher({ activeId: 'live2d', docs: renderers });
    await switcher.activate({ state: 'ready', kind: 'live2d' });
    assert.deepEqual(modes, ['unmount'], 'live2d 同面切换走 unmount');
  }
});
