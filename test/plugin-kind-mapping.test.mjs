// test/plugin-kind-mapping.test.mjs —— 插件控件 kind 必须映射到渲染层认得的 kind
//
// 为什么要这条：插件契约允许的 kind（segmented / toggle / button）与渲染层的 kind
//   （segmented / switch / actions / …）是两套词汇。没有映射时，老接口把 kind 原样透传，
//   `toggle` / `button` 会落到 view.js 的 default 分支 —— 渲染成一个**空的 <p class="ctl-note">**：
//   没有 data-ctl、没有 label、没有 disabled 原因，用户看到的就是"控件消失了"。
//   这个缺陷曾经真实存在（表现为"插件控件不渲染"），而且它连正常态都不渲染，
//   所以不能靠 disabled / 未接线那套断言发现 —— 只能靠这条映射完备性检查钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { PLUGIN_CONTROL_KINDS, normalizePluginSection } from '../src/web/panel/schema.js';

/** 渲染层认得的 kind（与 view.js 的分派分支一致；新增分支时这里也要跟着加） */
const VIEW_KINDS = new Set(['segmented', 'switch', 'actions', 'dynamic-list', 'readonly', 'chips', 'slider', 'select']);

/** 归一层需要的 ctx（字段取自 normalizePluginSection 实际读取的五个） */
function ctx() {
  return { groupIds: new Set(['settings']), titleToId: new Map([['设置', 'settings']]),
    takenIds: new Set(), registeredEffects: new Set() };
}

/** 造一份最小合法的控件声明（segmented 需要 options，其余不需要） */
function controlOf(kind, id) {
  const base = { id, kind, label: `夹具-${kind}` };
  return kind === 'segmented' ? { ...base, options: ['a', 'b'] } : base;
}

test('契约允许的每个 kind 都能归一成渲染层认得的 kind（防静默落到 note 分支）', () => {
  const ctx = { groupIds: new Set(['settings']), titleToId: new Map([['设置', 'settings']]),
    takenIds: new Set(), registeredEffects: new Set() };
  for (const kind of PLUGIN_CONTROL_KINDS) {
    const section = { group: 'settings', controls: [controlOf(kind, `ctl-${kind}`)] };
    const r = normalizePluginSection(section, ctx);
    assert.equal(r.ok, true, `kind=${kind} 的整节不应被拒（实际：${JSON.stringify(r.reason || r)}）`);
    const ctl = (r.controls || [])[0];
    assert.ok(ctl, `kind=${kind} 应产出一个控件`);
    assert.ok(VIEW_KINDS.has(ctl.kind),
      `kind=${kind} 归一后的 kind「${ctl.kind}」不是渲染层认得的（会落进 ctl-note 空行）`);
  }
});

test('button 归一成 actions 时必须带 buttons[]（renderActions 遍历的是 ctl.buttons）', () => {
  const ctx = { groupIds: new Set(['settings']), titleToId: new Map([['设置', 'settings']]),
    takenIds: new Set(), registeredEffects: new Set() };
  const r = normalizePluginSection({ group: 'settings', controls: [controlOf('button', 'ctl-btn')] }, ctx);
  const ctl = (r.controls || [])[0];
  assert.equal(ctl.kind, 'actions');
  assert.ok(Array.isArray(ctl.buttons) && ctl.buttons.length > 0,
    'actions 控件必须带 buttons[]，否则会落进 ctl-row-broken 兜底行');
});

test('未知 kind 仍按契约被单控件拒绝（映射表不能变成"什么都放行"）', () => {
  const ctx = { groupIds: new Set(['settings']), titleToId: new Map([['设置', 'settings']]),
    takenIds: new Set(), registeredEffects: new Set() };
  const r = normalizePluginSection({ group: 'settings', controls: [{ id: 'ctl-x', kind: 'weird', label: 'x' }] }, ctx);
  assert.equal((r.controls || []).length, 0, '未知 kind 不应产出控件');
  assert.ok((r.rejects || []).length > 0, '未知 kind 应进 rejects');
});
