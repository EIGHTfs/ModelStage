// test/slot-registry.test.mjs —— 插槽注册表的四类拒绝与顺序（设计 §4.2）
//
// 这一层是本阶段最容易写错的地方，所以**在 node 里直接测**（模块本身 DOM-free）：
//   ① 四类拒绝码各自能命中
//   ② 顺序固定：unknown-slot → slot-not-open → undeclared-slot → risk-mismatch
//      （其中 slot-not-open 必须先于 undeclared-slot —— 否则"目录里有但没开放"会被误报成"没声明"）
//   ③ 同步约束：不在装载期 ⇒ not-in-load-window
//   ④ disposer 幂等 + disposeAll 后 stats 归零
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSlotRegistry } from '../src/web/infra/slot-registry.js';

/** 与服务端 /api/plugins 的 slotCatalog 同形的最小目录 */
const CATALOG = [
  { name: 'panel.brand', type: 'single', risk: 'replace', stage: 'S5' },
  { name: 'panel.group.<groupId>', type: 'list', risk: 'append', stage: 'S2' },
  { name: 'panel.control.<key>', type: 'keyed', risk: 'replace', stage: 'S5' },
  { name: 'toolbar.actions', type: 'list', risk: 'append', stage: 'S3' },
];

function makeReg(opts = {}) {
  const rejects = [];
  const reg = createSlotRegistry({
    catalog: CATALOG,
    declaredByPlugin: opts.declaredByPlugin || {},
    onReject: (r) => rejects.push(r),
    openStage: opts.openStage || 'S2',
    // 内置分组 id：注册表用它区分"引用内置组"与"插件新建组"（设计 §七·一）
    groupIds: opts.groupIds || ['motion', 'skin', 'play', 'filter', 'pma', 'runtime', 'theme', 'debug', 'settings'],
    // 内置控件 id：键值插槽（panel.control.*）只能替换它们（不许静默新建）
    builtinControlIds: opts.builtinControlIds || ['sharpness', 'ctl-filter-preset'],
    isInLoadWindow: opts.isInLoadWindow || (() => true),
  });
  return { reg, rejects };
}

test('unknown-slot：目录里没有这个名字', () => {
  const { reg, rejects } = makeReg({ declaredByPlugin: { p1: [{ name: 'panel.nope', risk: 'append' }] } });
  assert.equal(reg.register('p1', 'panel.nope', { id: 'plugin.p1.a' }), null);
  assert.equal(rejects.at(-1).code, 'unknown-slot');
  assert.match(rejects.at(-1).why, /不在插槽目录里/);
  assert.equal(reg.stats().total, 0);
});

test('slot-not-open：目录里有，但阶段未到（S2 开放时 S5 的插槽仍拒）', () => {
  const { reg, rejects } = makeReg({ openStage: 'S2', declaredByPlugin: { p1: [{ name: 'panel.brand', risk: 'replace' }] } });
  assert.equal(reg.register('p1', 'panel.brand', { id: 'plugin.p1.brand' }), null);
  assert.equal(rejects.at(-1).code, 'slot-not-open');
  assert.equal(rejects.at(-1).catalogStage, 'S5');
  assert.equal(rejects.at(-1).openStage, 'S2');
});

test('顺序：阶段未到时，即使插件没声明也先报 slot-not-open（不是 undeclared-slot）', () => {
  const { reg, rejects } = makeReg({ openStage: 'S1', declaredByPlugin: { p1: [] } });   // S1：全部未开放
  assert.equal(reg.register('p1', 'panel.group.settings', { id: 'plugin.p1.x' }), null);
  assert.equal(rejects.at(-1).code, 'slot-not-open', '必须先命中阶段判断，而不是"没声明"');
});

test('undeclared-slot：阶段已开，但清单没声明', () => {
  const { reg, rejects } = makeReg({ openStage: 'S2', declaredByPlugin: { p1: [{ name: 'panel.brand', risk: 'replace' }] } });
  assert.equal(reg.register('p1', 'panel.group.settings', { id: 'plugin.p1.x' }), null);
  assert.equal(rejects.at(-1).code, 'undeclared-slot');
  assert.match(rejects.at(-1).why, /没有在 plugin\.json 的 slots 里声明/);
});

test('risk-mismatch：错误里必须同时带 catalogRisk 与 declaredRisk', () => {
  const { reg, rejects } = makeReg({
    openStage: 'S5',
    declaredByPlugin: { p1: [{ name: 'panel.brand', risk: 'append' }] },   // 声明成 append，目录要求 replace
  });
  assert.equal(reg.register('p1', 'panel.brand', { id: 'plugin.p1.brand' }), null);
  const r = rejects.at(-1);
  assert.equal(r.code, 'risk-mismatch');
  assert.equal(r.catalogRisk, 'replace');
  assert.equal(r.declaredRisk, 'append');
  assert.match(r.why, /replace/);
});

test('同步约束：不在装载期 ⇒ not-in-load-window（原因写清"必须在脚本顶层同步调用"）', () => {
  const { reg, rejects } = makeReg({
    openStage: 'S2',
    isInLoadWindow: () => false,
    declaredByPlugin: { p1: [{ name: 'panel.group.settings', risk: 'append' }] },
  });
  assert.equal(reg.register('p1', 'panel.group.settings', { id: 'plugin.p1.x' }), null);
  assert.equal(rejects.at(-1).code, 'not-in-load-window');
  assert.match(rejects.at(-1).why, /脚本顶层同步调用/);
});

test('分组插槽：id 不强制前缀，但同插槽内不许重名', () => {
  const { reg, rejects } = makeReg({ openStage: 'S2', declaredByPlugin: { p1: [{ name: 'panel.group.settings', risk: 'append' }] } });
  // 分组插槽不强制前缀（设计 §8.2 的前缀规则只针对键值插槽）
  assert.equal(typeof reg.register('p1', 'panel.group.settings', { id: 'sharpness' }), 'function');
  const ok = reg.register('p1', 'panel.group.settings', { id: 'plugin.p1.sharpness', label: '清晰度', order: 100 });
  assert.equal(typeof ok, 'function', '合法注册应返回 disposer');
  assert.equal(reg.register('p1', 'panel.group.settings', { id: 'plugin.p1.sharpness' }), null);
  assert.equal(rejects.at(-1).code, 'duplicate-id');
  assert.equal(reg.stats().total, 2, '两条不同 id 都应登记成功，重复的那条被拒');
});

test('分组 id 规则：内置组放行；插件新建组必须带 plugin.<pluginId>. 前缀', () => {
  const { reg, rejects } = makeReg({
    openStage: 'S2',
    declaredByPlugin: {
      // 注意：冒用他人前缀那条也要先声明，否则会先命中 undeclared-slot（顺序：声明早于形状判断）
      p1: ['panel.group.settings', 'panel.group.plugin.p1.extra', 'panel.group.notprefixed', 'panel.group.plugin.p2.extra'],
    },
  });
  // ① 引用内置组：放行
  assert.equal(typeof reg.register('p1', 'panel.group.settings', { id: 'a1' }), 'function');
  // ② 插件自己的新分组：放行
  assert.equal(typeof reg.register('p1', 'panel.group.plugin.p1.extra', { id: 'a2' }), 'function');
  // ③ 无前缀的新分组：拒绝 + 可读原因
  assert.equal(reg.register('p1', 'panel.group.notprefixed', { id: 'a3' }), null);
  assert.equal(rejects.at(-1).code, 'bad-group-id');
  assert.match(rejects.at(-1).why, /必须写成 plugin\.<pluginId>\.<name>/);
  // ④ 冒用别的插件前缀：也算不合规（前缀必须是自己）
  assert.equal(reg.register('p1', 'panel.group.plugin.p2.extra', { id: 'a4' }), null);
  assert.equal(rejects.at(-1).code, 'bad-group-id');
});

test('disposer 幂等 + disposeAll 后 stats 归零', () => {
  const { reg } = makeReg({
    openStage: 'S2',
    declaredByPlugin: {
      p1: [{ name: 'panel.group.settings', risk: 'append' }],
      p2: [{ name: 'panel.group.settings', risk: 'append' }],
    },
  });
  const d1 = reg.register('p1', 'panel.group.settings', { id: 'plugin.p1.a', order: 10 });
  reg.register('p1', 'panel.group.settings', { id: 'plugin.p1.b', order: 20 });
  reg.register('p2', 'panel.group.settings', { id: 'plugin.p2.c' });
  assert.equal(reg.stats().total, 3);
  assert.deepEqual(reg.stats().byPlugin, { p1: 2, p2: 1 });

  d1();
  d1();                               // 幂等：重复调用不能多删
  assert.equal(reg.stats().total, 2);

  assert.equal(reg.disposeAll('p1'), 1);     // p1 还剩 b
  assert.equal(reg.stats().total, 1);
  assert.deepEqual(reg.stats().byPlugin, { p2: 1 }, 'p2 不受影响');
  assert.equal(reg.disposeAll('p2'), 1);
  assert.equal(reg.stats().total, 0);
});

test('键值插槽：spec.id 必须带 plugin.<pluginId>. 前缀（分组插槽不要求）', () => {
  const { reg, rejects } = makeReg({
    openStage: 'S5',
    declaredByPlugin: { p1: ['panel.control.plugin.p1.sharpness'] },   // 字符串数组形状（服务端实际下发形状）
  });
  const bad = reg.register('p1', 'panel.control.plugin.p1.sharpness', { id: 'sharpness' });
  assert.equal(bad, null);
  assert.equal(rejects.at(-1).code, 'bad-id-prefix');
  const ok = reg.register('p1', 'panel.control.plugin.p1.sharpness', { id: 'plugin.p1.sharpness' });
  assert.equal(typeof ok, 'function', 'key 含点也必须能匹配上目录里的 panel.control.<key>');
  assert.equal(reg.stats().total, 1);
});

test('键值插槽：目标必须是既有内置控件；两个插件抢同一控件时后注册者被拒并带双方', () => {
  const { reg, rejects } = makeReg({
    openStage: 'S5',
    declaredByPlugin: {
      p1: ['panel.control.plugin.p1.ctl-filter-preset'],
      p2: ['panel.control.plugin.p2.ctl-filter-preset'],
      p3: ['panel.control.plugin.p3.ctl-not-exist'],
    },
  });
  // 目标不存在 ⇒ unknown-control（不许静默新建）
  assert.equal(reg.register('p3', 'panel.control.plugin.p3.ctl-not-exist', { id: 'plugin.p3.x' }), null);
  assert.equal(rejects.at(-1).code, 'unknown-control');
  // p1 占位成功；p2 抢同一个内置控件 ⇒ 被拒，原因带双方
  assert.equal(typeof reg.register('p1', 'panel.control.plugin.p1.ctl-filter-preset', { id: 'plugin.p1.preset' }), 'function');
  assert.equal(reg.register('p2', 'panel.control.plugin.p2.ctl-filter-preset', { id: 'plugin.p2.preset' }), null);
  assert.equal(rejects.at(-1).code, 'control-taken');
  assert.match(rejects.at(-1).why, /p1/, '原因里要有先占位者的 pluginId');
});

test('stats 明细不含 spec 函数（可被序列化给测试/__SLOT_STATS__）', () => {
  const { reg } = makeReg({ openStage: 'S2', declaredByPlugin: { p1: [{ name: 'panel.group.settings', risk: 'append' }] } });
  reg.register('p1', 'panel.group.settings', {
    id: 'plugin.p1.a',
    render: () => ({ kind: 'toggle' }),
    onAction: () => {},
  });
  const s = reg.stats();
  assert.equal(s.total, 1);
  assert.equal(s.entries[0].id, 'plugin.p1.a');
  assert.equal(s.entries[0].name, 'panel.group.settings');
  assert.equal(JSON.parse(JSON.stringify(s)).entries[0].id, 'plugin.p1.a', 'stats 必须可 JSON 序列化');
});
