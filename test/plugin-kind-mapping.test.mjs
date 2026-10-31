// test/plugin-kind-mapping.test.mjs —— 插件控件 kind 必须映射到渲染层认得的 kind
//
// 为什么要这条：插件契约允许的 kind（segmented / toggle / button）与渲染层的 kind
//   （segmented / switch / actions / …）是两套词汇。没有映射时，`toggle` / `button`
//   会落到 view.js 的 default 分支 —— 渲染成一个**空的 <p class="ctl-note">**：
//   没有 data-ctl、没有 label、没有 disabled 原因，用户看到的就是"控件消失了"。
//   这个缺陷曾经真实存在（表现为"插件控件不渲染"），而且它连正常态都不渲染，
//   所以不能靠 disabled / 未接线那套断言发现 —— 只能靠这条映射完备性检查钉住。
//
// 走**插槽**路径测：旧 registerControls 已在其内部转成插槽注册，逐节归一层随之删除；
//   `mergeSlotControls` 是现在唯一的"插件声明 → 面板控件"翻译点。
import test from 'node:test';
import assert from 'node:assert/strict';

import { PANEL_GROUPS, PLUGIN_CONTROL_KINDS, mergeSlotControls } from '../src/web/panel/schema.js';

/** 渲染层认得的 kind（与 view.js 的分派分支一致；新增分支时这里也要跟着加） */
const VIEW_KINDS = new Set(['segmented', 'switch', 'actions', 'dynamic-list', 'readonly', 'chips', 'slider', 'select']);

/**
 * 走一次插槽聚合：把一个 render() 返回指定 kind 的控件合进「设置」组。
 * @param {string} kind render 返回的插件 kind
 * @param {string} [id] 控件 id
 * @returns {{merged: object, ctl: object|null}}
 */
function mergeOne(kind, id = 'ctl-fixture') {
  const entries = [{
    pluginId: 'p1',
    name: 'panel.group.settings',
    id,
    label: `夹具-${kind}`,
    order: 10,
    setting: '',
    spec: {
      render: () => (kind === 'segmented'
        ? { kind, options: ['a', 'b'] }
        : { kind, label: `夹具-${kind}` }),
    },
  }];
  const merged = mergeSlotControls(PANEL_GROUPS, entries, {});
  const ctl = merged.groups
    .flatMap((g) => (g.controls || []))
    .find((c) => String(c && c.id) === id) || null;
  return { merged, ctl };
}

test('契约允许的每个 kind 都能归一成渲染层认得的 kind（防静默落到 note 分支）', () => {
  for (const kind of PLUGIN_CONTROL_KINDS) {
    const { merged, ctl } = mergeOne(kind, `ctl-${kind}`);
    assert.equal(merged.added, 1, `kind=${kind} 应成功合成一个控件`);
    assert.ok(ctl, `kind=${kind} 应产出控件`);
    assert.ok(VIEW_KINDS.has(ctl.kind),
      `kind=${kind} 归一后的 kind「${ctl.kind}」不是渲染层认得的（会落进 ctl-note 空行）`);
  }
});

test('button 归一成 actions 时必须带 buttons[]（renderActions 遍历的是 ctl.buttons）', () => {
  const { ctl } = mergeOne('button', 'ctl-btn');
  assert.equal(ctl.kind, 'actions');
  assert.ok(Array.isArray(ctl.buttons) && ctl.buttons.length > 0,
    'actions 控件必须带 buttons[]，否则会落进 ctl-row-broken 兜底行');
});

test('未知 kind 被拒（映射表不能变成"什么都放行"）', () => {
  const { merged, ctl } = mergeOne('weird', 'ctl-weird');
  assert.equal(merged.added, 0, '未知 kind 不应产出控件');
  assert.equal(merged.rejected, 1, '未知 kind 应计入 rejected');
  assert.equal(ctl, null);
});
