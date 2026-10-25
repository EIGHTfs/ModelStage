// test/bg-source.test.mjs —— 背景来源统一层（panel/bg-source.js）的纯逻辑验收
//
// 为什么用 node --test 而不是在浏览器里点：这一层的关键是**判定口径**
//   （纯色按 color 匹配、自定义按 url 匹配、同色只认第一条、找不到就无勾），
//   全是纯函数，用假数据覆盖边界比在页面上点半天可靠得多。
//
// 数据入口（listSolids / listBackgrounds）走的是网络，这里把全局 fetch 换成
//   返回固定 JSON 的假实现 ⇒ 不需要真服务端在跑，也不碰真实 data/ 目录。

import test from 'node:test';
import assert from 'node:assert/strict';
import { normColor, selectedSourceId, listBgSources, BUILTIN_SOURCES } from '../src/web/panel/bg-source.js';

/** 造一个只认两个接口的假 fetch（其它路径一律 404，避免掩盖意外请求） */
function stubFetch({ solids = [], images = [], failSolids = false } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/backgrounds/solids') && !u.includes('/api/backgrounds/solids/')) {
      if (failSolids) return new Response(JSON.stringify({ error: '取预设失败' }), { status: 500, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ items: solids }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/backgrounds')) {
      // 注意：图片接口的客户端（app/backgrounds.js 的 request()）要求 body.ok === true，
      //   少了这个字段会被判成失败（真实服务端也带它）
      return new Response(JSON.stringify({ ok: true, items: images }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  return () => { globalThis.fetch = real; };
}

const solid = (id, name, color) => ({ id, name, color, createdAt: '2026-01-01T00:00:00.000Z' });
const image = (id, name, url) => ({ id, name, url, bytes: 1024 });

test('1 normColor：大小写归一，非法值返回空串', () => {
  assert.equal(normColor('#3D8F5C'), '#3d8f5c', '大写应归一成小写');
  assert.equal(normColor('  #3d8f5c '), '#3d8f5c', '两侧空白应被去掉');
  assert.equal(normColor('#abc'), '', '三位简写不接受（契约只认 6 位）');
  assert.equal(normColor('red'), '', '颜色名不接受');
  assert.equal(normColor(null), '', '空值返回空串');
});

test('2 listBgSources：三组分门别类，且 id 唯一（同色两条不撞 id）', async () => {
  const restore = stubFetch({
    solids: [solid('s1', '炭黑', '#1A1A1C'), solid('s2', '炭黑副本', '#1a1a1c')],
    images: [image('i1', '图A', '/api/backgrounds/file/a.png')],
  });
  try {
    const g = await listBgSources();
    assert.equal(g.builtin.length, 2, '内置两项（棋盘格 / 透明）');
    assert.deepEqual(g.builtin.map((x) => x.id), BUILTIN_SOURCES.map((x) => x.id));
    assert.equal(g.solid.length, 2);
    assert.deepEqual(g.solid.map((x) => x.color), ['#1a1a1c', '#1a1a1c'], '颜色归一成小写');
    assert.equal(new Set(g.solid.map((x) => x.id)).size, 2, '两条同色预设的 id 必须互不相同');
    assert.equal(g.custom.length, 1);
    assert.equal(g.custom[0].id, 'custom:/api/backgrounds/file/a.png');
    assert.deepEqual(g.errors, [], '两个接口都成功时不应有错误');
  } finally { restore(); }
});

test('3 selectedSourceId：纯色按 color 匹配（不是按名字/id）', () => {
  const groups = { solid: [{ id: 'solid:s1', name: '炭黑', color: '#1a1a1c' }], custom: [] };
  const hit = selectedSourceId({ mode: 'solid', color: '#1A1A1C' }, groups);
  assert.equal(hit.groupId, 'solid');
  assert.equal(hit.itemId, 'solid:s1', '按颜色值命中（大小写不敏感）');
});

test('4 selectedSourceId：两条同色 ⇒ 只认第一条', () => {
  const groups = {
    solid: [
      { id: 'solid:s1', name: '炭黑', color: '#1a1a1c' },
      { id: 'solid:s2', name: '炭黑副本', color: '#1a1a1c' },
    ],
    custom: [],
  };
  const hit = selectedSourceId({ mode: 'solid', color: '#1a1a1c' }, groups);
  assert.equal(hit.itemId, 'solid:s1', '两条同色时只取第一条，不能两条都打勾');
});

test('5 selectedSourceId：color 不在任何预设里 ⇒ itemId 为 null，但档位仍是 solid', () => {
  const groups = { solid: [{ id: 'solid:s1', name: '炭黑', color: '#1a1a1c' }], custom: [] };
  const hit = selectedSourceId({ mode: 'solid', color: '#123456' }, groups);
  assert.equal(hit.groupId, 'solid', '档位仍算"纯色"（按钮要亮）');
  assert.equal(hit.itemId, null, '列表里不该有任何一条打勾');
});

test('6 selectedSourceId：自定义按 url 匹配；url 不在列表里同样无勾', () => {
  const groups = { solid: [], custom: [{ id: 'custom:/u/a.png', name: '图A', url: '/u/a.png' }] };
  assert.equal(selectedSourceId({ mode: 'custom', imageUrl: '/u/a.png' }, groups).itemId, 'custom:/u/a.png');
  assert.equal(selectedSourceId({ mode: 'custom', imageUrl: '/u/zzz.png' }, groups).itemId, null);
  assert.equal(selectedSourceId({ mode: 'custom', imageUrl: '' }, groups).itemId, null, '没有 url 时无勾');
});

test('7 selectedSourceId：棋盘格 / 透明 归内置档位', () => {
  assert.deepEqual(selectedSourceId({ mode: 'checkerboard' }), { groupId: 'builtin', id: 'checkerboard', itemId: null });
  assert.deepEqual(selectedSourceId({ mode: 'transparent' }), { groupId: 'builtin', id: 'transparent', itemId: null });
});

test('8 selectedSourceId：缺省/异常入参不抛错，回落棋盘格', () => {
  assert.equal(selectedSourceId(null).groupId, 'builtin');
  assert.equal(selectedSourceId({}).id, 'checkerboard');
  assert.equal(selectedSourceId({ mode: 'solid', color: '#1a1a1c' }, undefined).itemId, null, '没有分组数据时无勾但不抛');
});

test('9 listBgSources：单个接口失败时保留另一组，并把原因带出来', async () => {
  const restore = stubFetch({ images: [image('i1', '图A', '/u/a.png')], failSolids: true });
  try {
    const g = await listBgSources();
    assert.equal(g.solid.length, 0, '纯色接口失败 ⇒ 该组为空');
    assert.equal(g.custom.length, 1, '图片接口正常 ⇒ 该组照常给出');
    assert.equal(g.errors.length, 1, '失败原因要带出来（面板据此提示）');
    // 只校验"确实指向出错的接口 + 有内容"：具体措辞由 infra/api 的重试包装决定（可能带 HTTP 状态），
    //   钉死文案会让测试随包装层调整而假红
    assert.match(g.errors[0], /solids|500|失败/, '错误原因应能定位到出错的接口');
  } finally { restore(); }
});
