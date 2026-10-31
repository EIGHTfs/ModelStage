// test/plugin-slots-manifest.test.mjs —— 插槽与设置声明的清单校验（S1-a 服务端）
//
// 三件事必须钉死（设计 §4.2 + 六条口径定案）：
//   ① 判定顺序固定：unknown-slot → slot-not-open → undeclared-slot → risk-mismatch
//      尤其"slot-not-open 必须早于 risk-mismatch"—— 否则 toolbar.actions（目录 append、阶段 S3）
//      会被误报成"risk 不符"，而它写得完全正确，只是阶段没到。
//   ② risk 以**插槽目录为准**；不一致时错误必须同时带 catalogRisk 与 declaredRisk（不让作者回头翻文档）。
//   ③ 逐项降级：非法项只进 errors，**绝不整体拒绝** —— 老插件（无 slots/settings）零改动可用。
//
// 为什么单独成一套：这层是纯函数（无 IO、无浏览器），跑一次不到 10ms；
//   而它守的是"插件装之前能不能看见它会占什么位置"，错了要等到 S1-b 渲染阶段才发现，代价大得多。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURRENT_STAGE,
  SLOT_CATALOG,
  SETTING_TYPES,
  isSlotOpen,
  matchSlot,
  validateDeclaredSettings,
  validateDeclaredSlots,
  validateSlotRegistration,
} from '../src/server/plugins/slot-catalog.mjs';

// ─────────────────────────── 目录本身 ───────────────────────────

test('目录：第一版五项齐全，字段齐全且取值合法', () => {
  const names = SLOT_CATALOG.map((s) => s.name);
  assert.deepEqual(names, [
    'panel.brand',
    'panel.group.<groupId>',
    'panel.control.<key>',
    'toolbar.actions',
    'stage.overlay',
  ]);
  for (const s of SLOT_CATALOG) {
    assert.ok(['single', 'list', 'keyed'].includes(s.type), `${s.name} 的 type 非法`);
    assert.ok(['append', 'replace', 'shadow'].includes(s.risk), `${s.name} 的 risk 非法`);
    assert.ok(['S1', 'S2', 'S3', 'S4', 'S5'].includes(s.stage), `${s.name} 的 stage 非法`);
    assert.equal(typeof s.desc, 'string', `${s.name} 应有可读说明`);
  }
});

test('目录匹配：精确名优先；占位符只吃一段非空名字（不带点/斜杠）', () => {
  assert.equal(matchSlot('panel.brand').name, 'panel.brand');
  assert.equal(matchSlot('panel.group.设置').name, 'panel.group.<groupId>');
  // key 形状按 §8.2 是 `plugin.<pluginId>.<key>`（含点）⇒ 占位符必须允许点，否则这条永远匹配不上
  assert.equal(matchSlot('panel.control.plugin.foo.bar').name, 'panel.control.<key>');
  assert.equal(matchSlot('panel.group.a.b').name, 'panel.group.<groupId>');
  assert.equal(matchSlot('panel.group.'), null, '占位符不能为空');
  assert.equal(matchSlot('panel.group'), null);
  assert.equal(matchSlot(''), null);
  assert.equal(matchSlot('nope.slot'), null);
});

test('阶段：S2 在当前阶段（S1）未开放；注入 S5 后开放', () => {
  const groupSlot = matchSlot('panel.group.x');
  assert.equal(isSlotOpen(groupSlot), false, `${CURRENT_STAGE} 阶段下 panel.group 应未开放`);
  assert.equal(isSlotOpen(groupSlot, 'S5'), true);
  assert.equal(isSlotOpen(matchSlot('panel.brand'), 'S5'), true);
  // 写错的 stage 按"未开放"处理（保守）
  assert.equal(isSlotOpen({ stage: 'S9' }, 'S5'), false);
});

// ─────────────────────────── ① unknown-slot ───────────────────────────

test('清单校验：目录里没有的插槽名 ⇒ unknown-slot，且不进 slots', () => {
  const { slots, errors } = validateDeclaredSlots(['no.such.slot']);
  assert.deepEqual(slots, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].why, 'unknown-slot');
  assert.equal(errors[0].name, 'no.such.slot');
  assert.ok(errors[0].hint, '错误必须带可读提示');
});

// ─────────────────────────── ② slot-not-open ───────────────────────────

test('清单校验：未开放阶段的插槽 ⇒ slot-not-open（写明阶段），且不进 slots', () => {
  // panel.brand 是 S5，当前 S1 ⇒ 未开放
  const { slots, errors } = validateDeclaredSlots(['panel.brand']);
  assert.deepEqual(slots, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].why, 'slot-not-open');
  assert.equal(errors[0].catalogStage, 'S5');
  assert.match(errors[0].hint, /S5/);
});

test('**顺序**：未开放阶段必须**先于** risk 判定（toolbar.actions 不能被误报 risk-mismatch）', () => {
  // toolbar.actions：目录 risk=append、stage=S3。这里故意声明 risk=replace（不一致）+ 当前阶段 S1
  const r = validateSlotRegistration('toolbar.actions', ['toolbar.actions'], { risk: 'replace' });
  assert.equal(r.ok, false);
  assert.equal(r.error.why, 'slot-not-open', '阶段没到就该报 slot-not-open，不能报 risk-mismatch');
  assert.equal(r.error.catalogStage, 'S3');
});

// ─────────────────────────── ③ undeclared-slot ───────────────────────────

test('注册校验：清单没声明 ⇒ undeclared-slot（只有注册期判得出来）', () => {
  // panel.brand 已在 S5 开放（注入 S5），但清单没声明
  const r = validateSlotRegistration('panel.brand', [], { currentStage: 'S5' });
  assert.equal(r.ok, false);
  assert.equal(r.error.why, 'undeclared-slot');
  assert.match(r.error.hint, /panel\.brand/);
});

// ─────────────────────────── ④ risk-mismatch ───────────────────────────

test('注册校验：risk 与目录不一致 ⇒ risk-mismatch，**同时带目录值与声明值**', () => {
  const r = validateSlotRegistration('panel.brand', ['panel.brand'], { currentStage: 'S5', risk: 'append' });
  assert.equal(r.ok, false);
  assert.equal(r.error.why, 'risk-mismatch');
  assert.equal(r.error.catalogRisk, 'replace');
  assert.equal(r.error.declaredRisk, 'append');
  assert.match(r.error.hint, /replace/);
});

test('注册校验：risk 一致（或省略 ⇒ 按目录）时通过', () => {
  const explicit = validateSlotRegistration('panel.brand', ['panel.brand'], { currentStage: 'S5', risk: 'replace' });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.entry.name, 'panel.brand');
  // 省略 risk：按目录，不报错
  const omitted = validateSlotRegistration('panel.brand', ['panel.brand'], { currentStage: 'S5' });
  assert.equal(omitted.ok, true);
});

// ─────────────────────────── 老插件零改动 ───────────────────────────

test('老插件：没有 slots / settings 字段 ⇒ 空数组 + 零错误（不报错、不拒绝）', () => {
  for (const raw of [undefined, null, []]) {
    const s = validateDeclaredSlots(raw);
    assert.deepEqual(s.slots, []);
    assert.deepEqual(s.errors, []);
    const g = validateDeclaredSettings(raw);
    assert.deepEqual(g.settings, []);
    assert.deepEqual(g.errors, []);
  }
});

test('逐项降级：合法项保留、非法项只进 errors（插件不会被整体拒绝）', () => {
  const { slots, errors } = validateDeclaredSlots(['panel.group.x', 'no.such.slot', 'panel.brand'], 'S5');
  assert.deepEqual(slots, ['panel.group.x', 'panel.brand'], '合法项必须保留');
  assert.equal(errors.length, 1, '只有非法那一项进 errors');
  assert.equal(errors[0].why, 'unknown-slot');
});

test('坏形状：slots 不是数组 ⇒ 一条 bad-shape，不抛异常', () => {
  const r = validateDeclaredSlots('panel.brand');
  assert.deepEqual(r.slots, []);
  assert.equal(r.errors[0].why, 'bad-shape');
  // 数组里混了非字符串
  const r2 = validateDeclaredSlots([123, null, 'panel.group.x'], 'S5');
  assert.deepEqual(r2.slots, ['panel.group.x']);
  assert.equal(r2.errors.filter((e) => e.why === 'bad-shape').length, 2);
});

// ─────────────────────────── settings（enum / boolean） ───────────────────────────

test('settings：enum 与 boolean 两种合法声明通过，字段被归一', () => {
  assert.deepEqual(SETTING_TYPES, ['enum', 'boolean']);
  const { settings, errors } = validateDeclaredSettings([
    { key: 'sharpness', type: 'enum', label: '清晰度', options: ['关', '轻', '强'], default: '轻' },
    { key: 'premultiply', type: 'boolean' },
  ]);
  assert.deepEqual(errors, []);
  assert.equal(settings.length, 2);
  assert.deepEqual(settings[0], { key: 'sharpness', type: 'enum', label: '清晰度', options: ['关', '轻', '强'], default: '轻' });
  // boolean 缺 default ⇒ 归一成 false
  assert.deepEqual(settings[1], { key: 'premultiply', type: 'boolean', label: 'premultiply', default: false });
});

test('settings：非法声明逐项降级（bad-type / bad-options / bad-default / duplicate-key）', () => {
  const { settings, errors } = validateDeclaredSettings([
    { key: 'a', type: 'number' },                                  // 第一版不支持
    { key: 'b', type: 'enum', options: ['只有一个'] },               // options 太少
    { key: 'c', type: 'enum', options: ['x', 'y'], default: 'z' },  // default 不在 options
    { key: 'd', type: 'boolean', default: 'yes' },                 // boolean 却给字符串
    { key: 'e', type: 'boolean' },
    { key: 'e', type: 'boolean' },                                 // 重复 key
    { type: 'boolean' },                                           // 缺 key
  ]);
  assert.deepEqual(settings.map((s) => s.key), ['e'], '只有 e 的第一条合法');
  const whys = errors.map((e) => e.why).sort();
  assert.deepEqual(whys, ['bad-default', 'bad-default', 'bad-options', 'bad-shape', 'bad-type', 'duplicate-key']);
});

test('settings：key 必须以 plugin.<pluginId>. 开头（why=key-prefix）', () => {
  // 不带前缀 ⇒ 拒绝（能力键白名单是全局合并的，撞名不可调试）
  const bad = validateDeclaredSettings([{ key: 'sharpness', type: 'boolean' }], 'demo');
  assert.deepEqual(bad.settings, []);
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.errors[0].why, 'key-prefix');
  assert.equal(bad.errors[0].key, 'sharpness');
  assert.match(bad.errors[0].hint, /plugin\.demo\./);

  // 前缀是**别的**插件 id ⇒ 也算不合法（防止 A 插件占 B 的键）
  const other = validateDeclaredSettings([{ key: 'plugin.other.x', type: 'boolean' }], 'demo');
  assert.equal(other.errors[0].why, 'key-prefix');

  // 正确前缀 ⇒ 通过
  const ok = validateDeclaredSettings([{ key: 'plugin.demo.sharpness', type: 'boolean' }], 'demo');
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.settings[0].key, 'plugin.demo.sharpness');

  // 不传 pluginId ⇒ **不校验前缀**（向后兼容：老调用点与老插件都不受影响）
  const legacy = validateDeclaredSettings([{ key: 'sharpness', type: 'boolean' }]);
  assert.deepEqual(legacy.errors, []);
  assert.equal(legacy.settings[0].key, 'sharpness');
});

test('settings：非数组 ⇒ bad-shape，不抛异常', () => {
  const r = validateDeclaredSettings({ key: 'x' });
  assert.deepEqual(r.settings, []);
  assert.equal(r.errors[0].why, 'bad-shape');
});
