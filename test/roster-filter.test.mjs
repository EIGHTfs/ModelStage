// test/roster-filter.test.mjs —— 名册搜索匹配（纯函数）+ 持久化键名（静态契约）
//
// 迁自 test/browser/roster-actions.js：
//   · 搜索匹配三条（角色名命中显示整组 / 变体命中显示整组 / 游戏名或根 id 命中显示该游戏全部）
//     断言对象是"给定数据 + 关键词 ⇒ 哪些角色可见"，属纯逻辑（判据第 1 级），起浏览器毫无必要；
//   · localStorage 键名（键名常量保持稳定）属源码契约表（第 3 级）：
//     ui-state.js 在模块级就碰 window，node 里 import 不了，所以按"读文件 + 只断言契约级事实"来验。
//
// 两条自缚规则（本文件遵守）：
//   ① **不写死数量**：所有条数断言都从夹具自身推导（`f.charA.variants.length`），不出现魔法数字；
//   ② **不依赖本机部署**：夹具是**构造的合成数据**（GameA / 角色甲 / SrcA…），
//      不含任何真实游戏名、角色名或资源根 id，换机器、换根配置都同样成立。
//
// 注意：`roster-actions.js` 里仍保留两条**合并语义**断言，它们**没有**迁出来：
//   合并逻辑在 list.js / view.js 里，且链路模块（../app/status.js、../app/ui-state.js）
//   在模块级就引用 window（实测 `import` 直接抛 "window is not defined"）⇒ 当前不可 node 测试。
//   为了测试去抽纯函数属于产品改动，不在本批范围（见交付说明的"遗留"）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { variantSearchText, charMatches, visibleChars } from '../src/web/roster/filter.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 造一条变体（model + 可选名表项），字段与 list.js 产出的形状一致 */
function makeVariant(modelName, srcDir, nm) {
  return { model: { name: modelName, srcDir }, nm: nm || null };
}

/**
 * 造一个游戏 + 两个角色（**全部合成数据**）：
 *   · 游戏有两个根 —— 用来验证"根 id 命中 ⇒ 显示该游戏全部角色"
 *   · 角色 A 有两个变体（一个带名表、一个不带）—— 用来验证"变体命中 ⇒ 显示整组"
 */
function makeFixture() {
  const charA = {
    key: 'char-a',
    title: '角色甲 CharA',
    variants: [
      makeVariant('model_a_00', 'SrcA', { name: '角色甲', costume: '默认' }),
      makeVariant('model_a_01', 'SrcA', null),
    ],
  };
  const charB = {
    key: 'char-b',
    title: '角色乙 CharB',
    variants: [makeVariant('model_b_00', 'SrcB', { name: '角色乙', costume: '皮肤一' })],
  };
  const game = { key: 'game:GameA', name: 'GameA', roots: [{ id: 'root-a' }, { id: 'root-a-2' }] };
  return { game, chars: [charA, charB], charA, charB };
}

/** 造 state（只带 filter.js 需要的两个字段） */
function makeState(fixture, keyword) {
  return { gameChars: new Map([[fixture.game.key, { chars: fixture.chars }]]), keyword };
}

test('① 角色名命中 ⇒ 该角色整组可见（变体一个不少）', () => {
  const f = makeFixture();
  const visible = visibleChars(f.game, makeState(f, '角色甲'));
  assert.deepEqual(visible.map((c) => c.key), [f.charA.key], '只应命中角色甲');
  assert.equal(visible[0].variants.length, f.charA.variants.length,
    '整组可见：全部变体都要在（不能只剩命中的那个）');
});

test('② 变体命中 ⇒ 也显示整组（模型名 / 目录 / 中文名 / 服装都参与匹配）', () => {
  const f = makeFixture();
  // 变体 2 没有名表项，命中点只有 model.name —— 命中的是"变体"，但返回的是整组
  for (const keyword of ['model_a_01', 'srca', '默认']) {
    const visible = visibleChars(f.game, makeState(f, keyword));
    assert.deepEqual(visible.map((c) => c.key), [f.charA.key], `关键词「${keyword}」应命中角色甲这一组`);
    assert.equal(visible[0].variants.length, f.charA.variants.length,
      `关键词「${keyword}」命中后仍应显示整组全部变体`);
  }
  // 反例自证：无关关键词必须一个都不返回（否则上面的"命中"没有判别力）
  assert.deepEqual(visibleChars(f.game, makeState(f, 'zzz-no-such-keyword-zzz')), []);
});

test('③ 游戏名 / 资源根 id 命中 ⇒ 显示该游戏全部角色', () => {
  const f = makeFixture();
  const allKeys = f.chars.map((c) => c.key);
  for (const keyword of [f.game.name.toLowerCase(), f.game.roots[1].id]) {
    const visible = visibleChars(f.game, makeState(f, keyword));
    assert.deepEqual(visible.map((c) => c.key), allKeys,
      `关键词「${keyword}」应显示该游戏全部角色（游戏名与根 id 都算命中）`);
  }
});

test('④ 空关键词 ⇒ 全显示（不过滤）', () => {
  const f = makeFixture();
  assert.deepEqual(visibleChars(f.game, makeState(f, '')).map((c) => c.key), f.chars.map((c) => c.key));
});

test('⑤ variantSearchText：小写归一，且覆盖 model.name / srcDir / 中文名 / 服装', () => {
  const variant = makeVariant('Model_A_00', 'SrcA', { name: '角色甲', costume: '默认' });
  const text = variantSearchText(variant);
  for (const part of ['model_a_00', 'srca', '角色甲', '默认']) {
    assert.ok(text.includes(part), `搜索文本应包含「${part}」，实际 ${text}`);
  }
  assert.equal(text, text.toLowerCase(), '搜索文本必须已小写（否则大小写不同的关键词匹配不到）');
});

test('⑥ 静态契约：持久化键名常量唯一且值稳定', () => {
  const uiStatePath = path.join(PROJECT_ROOT, 'src/web/app/ui-state.js');
  const uiStateSource = fs.readFileSync(uiStatePath, 'utf8');
  const declared = /export const TREE_STATE_KEY = '([^']+)'/.exec(uiStateSource);
  assert.ok(declared, "ui-state.js 里应有 `export const TREE_STATE_KEY = '…'` 这一行");
  // 键名是**契约事实**（不是数量）：值必须稳定 —— 改它等于让所有用户的历史展开态失效
  const key = declared[1];
  assert.ok(key.startsWith('modelstage.'), `键名应带产品前缀，实际 ${key}`);

  // 单一来源：这个字面量在 src/web 里只应出现在**常量定义**处（行尾注释不算）
  const declaredLineNo = uiStateSource.split('\n')
    .findIndex((line) => line.includes(`TREE_STATE_KEY = '${key}'`)) + 1;
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');          // 去掉行尾注释，只看代码
        if (code.includes(key)) offenders.push(`${path.relative(PROJECT_ROOT, full)}:${i + 1}`);
      });
    }
  };
  walk(path.join(PROJECT_ROOT, 'src/web'));
  assert.deepEqual(offenders, [`src/web/app/ui-state.js:${declaredLineNo}`],
    `键名应只出现在常量定义处（两处就是两份真相），实际：${offenders.join(', ')}`);

  // persist.js 必须转发这个常量，而不是复制一份字面量
  const persistSource = fs.readFileSync(path.join(PROJECT_ROOT, 'src/web/roster/persist.js'), 'utf8');
  assert.match(persistSource, /LS_KEY = uiState\.TREE_STATE_KEY/, 'persist.js 应使用 uiState.TREE_STATE_KEY（单一来源）');
});
