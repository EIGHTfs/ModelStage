// test/toolbar-contract.test.mjs —— 顶栏内置按钮的**契约表**（不是渲染结果）
//
// 迁自 test/browser/f2-topbar.js 的「F2① 顶栏按钮集合」：
//   那条断言用 DOM 里 `#app-header button` 的 id 列表去核对"内置 5 个按钮在不在"，
//   但"有哪些内置按钮"这件事**本来就写在 toolbar-schema.js 的 TOOLBAR_ACTIONS 表**里，
//   DOM 只是这张表的渲染产物 ⇒ 属于第 3 级（源码/契约表），不该起浏览器。
//   浏览器侧保留的是行为断言（点了之后画布/影院/菜单/Esc 有什么变化，判据 ③ 事件链路）。
//
// 断言对象全部是**导入的常量表**，不扫源码文本、不写死环境数字：
//   · 数量由表自身长度推导（不写 5）
//   · 图标合法性用 TOOLBAR_ICON_WHITELIST 判定（不复制一份图标名清单）
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOLBAR_ACTIONS,
  TOOLBAR_ICON_WHITELIST,
  PLUGIN_TOOLBAR_MAX,
} from '../src/web/panel/toolbar-schema.js';

test('① 内置按钮表：id 非空唯一、带 btn- 前缀、动作字段齐全', () => {
  const ids = TOOLBAR_ACTIONS.map((a) => String(a.id || ''));
  assert.deepEqual(ids.filter((id) => !id), [], 'id 不能为空');
  assert.equal(new Set(ids).size, ids.length, `id 必须唯一，实际：${ids.join(', ')}`);

  const badPrefix = ids.filter((id) => !id.startsWith('btn-'));
  assert.deepEqual(badPrefix, [], `内置按钮 id 应以 btn- 开头，异常：${badPrefix.join(', ')}`);

  const missingField = [];
  for (const action of TOOLBAR_ACTIONS) {
    for (const field of ['id', 'icon', 'label', 'title', 'action']) {
      if (typeof action[field] !== 'string' || !action[field].trim()) missingField.push(`${action.id || '?'}.${field}`);
    }
  }
  assert.deepEqual(missingField, [], `这些字段必填且非空：${missingField.join(', ')}`);
});

test('② 图标只能来自白名单（插件不许自造图标名）', () => {
  const unknownIcons = TOOLBAR_ACTIONS
    .filter((a) => !TOOLBAR_ICON_WHITELIST.has(String(a.icon)))
    .map((a) => `${a.id}:${a.icon}`);
  assert.deepEqual(unknownIcons, [], `图标必须在白名单里，异常：${unknownIcons.join(', ')}`);
  // 白名单自身要够用但不该为空（空表意味着所有按钮都不合法，属于配置事故）
  assert.ok(TOOLBAR_ICON_WHITELIST.size > 0, '图标白名单不应为空');
});

test('③ 已移除的「导入模型」入口不得回到表里（本项目不走单模型导入）', () => {
  const ids = TOOLBAR_ACTIONS.map((a) => String(a.id));
  assert.ok(!ids.includes('btn-import'),
    `btn-import 已按需求移除（单一模型导入不是本项目的入口方式），实际表：${ids.join(', ')}`);
});

test('④ order 必须唯一且升序可排（否则按钮位置随实现漂移）', () => {
  const orders = TOOLBAR_ACTIONS.map((a) => a.order);
  assert.deepEqual(orders.filter((o) => !Number.isFinite(o)), [], '每个动作都要有数值 order');
  assert.equal(new Set(orders).size, orders.length, `order 必须唯一，实际：${orders.join(', ')}`);
  const sorted = orders.slice().sort((a, b) => a - b);
  assert.deepEqual(orders, sorted, 'TOOLBAR_ACTIONS 应按 order 升序声明（渲染按它排）');
});

test('⑤ 插件按钮上限是有限正数（防止插件把顶栏撑爆）', () => {
  assert.ok(Number.isFinite(PLUGIN_TOOLBAR_MAX) && PLUGIN_TOOLBAR_MAX > 0,
    `PLUGIN_TOOLBAR_MAX 应为有限正数，实际 ${PLUGIN_TOOLBAR_MAX}`);
});
