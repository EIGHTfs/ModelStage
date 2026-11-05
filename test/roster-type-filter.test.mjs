// test/roster-type-filter.test.mjs —— 名册「类型筛选」纯函数（第 1 级：纯逻辑，不起浏览器）
//
// 覆盖设计稿 §5（派生与计数口径）、§5.3（只排除类型过滤、仍计入关键词）、§6（显示名回退）、
//   §7（持久化失效项被忽略）与 §九（验收：多选并集 / 与关键词交集 / 空选不过滤）。
//
// 为什么这些能在 node 里测：type-filter.js 只依赖 filter.js（纯函数）与 shared/type-labels.mjs，
//   整条依赖链没有 window/document，import 不会炸。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveTypeCounts, filterCharsByType, typeKeyOf, usableTypeSelection,
} from '../src/web/roster/type-filter.js';
import { TYPE_LABELS, UNKNOWN_TYPE_KEY, typeLabel } from '../src/shared/type-labels.mjs';

/**
 * 造一份最小名册：games + gameChars（结构与 roster/list.js 的 buildChars 输出同形）。
 * @param {Array<{key: string, variants: Array<{id: string, kind: string|null, name?: string}>}>} spec
 */
function makeRoster(spec) {
  const games = [];
  const gameChars = new Map();
  spec.forEach((game, index) => {
    const gameKey = game.key || `game:${index}`;
    games.push({ key: gameKey, name: gameKey, roots: [{ id: `root-${index}` }] });
    const chars = game.chars || [{
      key: `char-${index}`,
      title: `char-${index}`,
      variants: (game.variants || []).map((variant) => ({
        model: { id: variant.id, name: variant.name || variant.id, kind: variant.kind, srcDir: '' },
        nm: null,
      })),
    }];
    gameChars.set(gameKey, { chars, stats: { miss: 0 } });
  });
  return { games, gameChars };
}

const countOf = (counts, key) => (counts.find((entry) => entry.key === key) || { count: 0 }).count;

test('空名册：没有类型，也没有计数', () => {
  const roster = makeRoster([]);
  assert.deepEqual(deriveTypeCounts({ ...roster, keyword: '' }), []);
});

test('单一类型：全部变体归入同一档', () => {
  const roster = makeRoster([{ variants: [{ id: 'a', kind: 'spine' }, { id: 'b', kind: 'spine' }] }]);
  const counts = deriveTypeCounts({ ...roster, keyword: '' });
  assert.deepEqual(counts, [{ key: 'spine', count: 2 }]);
});

test('多类型混合：按数量降序，并列按 key 字典序（稳定）', () => {
  const roster = makeRoster([
    { variants: [{ id: 'a', kind: 'spine' }, { id: 'b', kind: 'spine' }, { id: 'c', kind: 'live2d' }] },
    { variants: [{ id: 'd', kind: 'live2d' }, { id: 'e', kind: null }] },
  ]);
  const counts = deriveTypeCounts({ ...roster, keyword: '' });
  assert.deepEqual(counts.map((entry) => entry.key), ['live2d', 'spine', UNKNOWN_TYPE_KEY]);
  assert.equal(countOf(counts, 'live2d'), 2);
  assert.equal(countOf(counts, 'spine'), 2);
  // live2d 与 spine 并列 2 ⇒ 字典序 live2d 在前；unknown 1 个排最后
  assert.equal(countOf(counts, UNKNOWN_TYPE_KEY), 1);
});

test('kind 为 null 的条目归入 unknown（未解包容器不丢）', () => {
  const variant = { model: { id: 'bundle-x', kind: null } };
  assert.equal(typeKeyOf(variant), UNKNOWN_TYPE_KEY);
  assert.equal(typeKeyOf({ model: { kind: '' } }), UNKNOWN_TYPE_KEY);
  assert.equal(typeKeyOf({ model: { kind: 'live2d' } }), 'live2d');
});

test('计数口径：只排除类型过滤，关键词仍然计入', () => {
  // 两个角色：sakura（spine + live2d 各一）、yuki（spine）
  //   注意关键词是"角色整组判定"（命中角色名或任一变体即整组可见），所以这里用**角色名**制造裁剪，
  //   而不是靠变体名 —— 后者只会让整组照样可见，测不出"关键词把类型计数变小"。
  const roster = makeRoster([{
    chars: [
      {
        key: 'char-sakura', title: 'sakura',
        variants: [
          { model: { id: 's1', name: 's1', kind: 'spine', srcDir: '' }, nm: null },
          { model: { id: 's2', name: 's2', kind: 'live2d', srcDir: '' }, nm: null },
        ],
      },
      {
        key: 'char-yuki', title: 'yuki',
        variants: [{ model: { id: 'y1', name: 'y1', kind: 'spine', srcDir: '' }, nm: null }],
      },
    ],
  }]);
  const all = deriveTypeCounts({ ...roster, keyword: '' });
  assert.equal(countOf(all, 'spine'), 2);
  assert.equal(countOf(all, 'live2d'), 1);

  // 关键词 sakura ⇒ yuki 整组不可见 ⇒ spine 只剩 1
  const filtered = deriveTypeCounts({ ...roster, keyword: 'sakura' });
  assert.equal(countOf(filtered, 'spine'), 1);
  assert.equal(countOf(filtered, 'live2d'), 1);

  // 口径关键点：派生函数**不认识**"选中了哪些类型"，所以选中后重新派生，数字不变
  //   （视图层只在列表上应用 filterCharsByType，不把选中集合喂回派生）
  const afterSelectingSpine = deriveTypeCounts({ ...roster, keyword: 'sakura' });
  assert.deepEqual(afterSelectingSpine, filtered);
});

test('过滤语义：空选中不过滤；单选/多选取并集', () => {
  const roster = makeRoster([{
    variants: [{ id: 'a', kind: 'spine' }, { id: 'b', kind: 'live2d' }, { id: 'c', kind: null }],
  }]);
  const chars = roster.gameChars.get('game:0').chars;

  assert.equal(filterCharsByType(chars, new Set()), chars);          // 同一引用：不过滤
  assert.equal(filterCharsByType(chars, []).length, 1);

  const onlySpine = filterCharsByType(chars, new Set(['spine']));
  assert.deepEqual(onlySpine[0].variants.map((v) => v.model.id), ['a']);

  const spineAndUnknown = filterCharsByType(chars, new Set(['spine', UNKNOWN_TYPE_KEY]));
  assert.deepEqual(spineAndUnknown[0].variants.map((v) => v.model.id), ['a', 'c']);

  // 多选 = 并集：一个角色命中任一选中类型就保留
  const allTypes = filterCharsByType(chars, new Set(['spine', 'live2d', UNKNOWN_TYPE_KEY]));
  assert.deepEqual(allTypes[0].variants.map((v) => v.model.id), ['a', 'b', 'c']);
});

test('过滤不修改原数据（渲染层只读 state.gameChars）', () => {
  const roster = makeRoster([{ variants: [{ id: 'a', kind: 'spine' }, { id: 'b', kind: 'live2d' }] }]);
  const chars = roster.gameChars.get('game:0').chars;
  const before = chars[0].variants.length;
  filterCharsByType(chars, new Set(['spine']));
  assert.equal(chars[0].variants.length, before);
  assert.notEqual(filterCharsByType(chars, new Set(['spine']))[0], chars[0]);
});

test('与关键词取交集：关键词把整组挡掉时，类型过滤也救不回来', () => {
  const roster = makeRoster([{
    variants: [{ id: 'sakura', kind: 'spine' }, { id: 'yuki', kind: 'live2d' }],
  }]);
  const chars = roster.gameChars.get('game:0').chars;
  // 关键词 "sakura" 命中第一个变体 ⇒ 整组可见（filter.js 的角色整组判定）
  const keywordVisible = chars.filter((c) => c.variants.some((v) => v.model.id.includes('sakura')));
  const typed = filterCharsByType(keywordVisible, new Set(['live2d']));
  // 角色整组可见（含 live2d 变体）⇒ 类型过滤仍能留下 live2d 那条
  assert.deepEqual(typed[0].variants.map((v) => v.model.id), ['yuki']);

  const noneVisible = chars.filter(() => false);
  assert.deepEqual(filterCharsByType(noneVisible, new Set(['live2d'])), []);
});

test('持久化：失效类型被忽略，但不会被要求删除（纯函数只做收敛）', () => {
  const stored = ['spine', 'gone-type', '', null, 'live2d'];
  const usable = usableTypeSelection(stored, ['spine', 'live2d', UNKNOWN_TYPE_KEY]);
  assert.deepEqual([...usable], ['spine', 'live2d']);
  // 全部失效 ⇒ 空集合（= 不过滤）
  assert.equal(usableTypeSelection(['gone-type'], ['spine']).size, 0);
  // 形状不对不抛
  assert.equal(usableTypeSelection(null, ['spine']).size, 0);
  assert.equal(usableTypeSelection('spine', ['spine']).size, 0);
});

test('显示名：已知走映射，未知原值回退（不美化大小写）', () => {
  assert.equal(typeLabel('spine'), 'Spine');
  assert.equal(typeLabel('live2d'), 'Live2D');
  assert.equal(typeLabel(UNKNOWN_TYPE_KEY), '待解包');
  assert.equal(typeLabel('bundle'), '资源包');
  assert.equal(typeLabel('myCustomKind'), 'myCustomKind');
  assert.equal(TYPE_LABELS[UNKNOWN_TYPE_KEY], '待解包');
});
