// test/panel-contract.test.mjs —— 右侧面板的**契约级**事实（静态扫描，第 3 级）
//
// 迁自 test/browser/panel-actions.js：那些断言的对象是"导出的表 / 常量 / 样式规则"，
//   不是"浏览器把页面渲染出来之后才存在的状态"，所以不需要起浏览器。
//   （浏览器里保留的是它们的 DOM 半边：声明 == 实际渲染出来的东西，那只有渲染后才知道。）
//
// 断言原则：
//   · 能 import 就 import（PANEL_GROUPS / TRANSPORT_CONTROLS / RENDERER_INDEPENDENT / settingKeyOf）；
//   · 必须读文本时只读**样式契约**（panel.css 的"哪个属性绑在哪个属性选择器上"），
//     不断言选择器组合方式、不断言行号；
//   · 不写死环境数字：控件数、分组数、键数全部从数据推导；只有"命名前缀"这类契约才写常量。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PANEL_GROUPS, TRANSPORT_CONTROLS, RENDERER_INDEPENDENT, settingKeyOf,
} from '../src/web/panel/schema.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL_CSS = path.join(PROJECT_ROOT, 'src/web/panel/panel.css');

/** 全部右栏控件（拍平，只保留带 id 的） */
function allPanelControls() {
  return PANEL_GROUPS.flatMap((group) => (group.controls || []).filter((c) => c && c.id));
}

test('① 右栏控件清单：id 非空唯一、命名有前缀、每组至少一个控件', () => {
  const controls = allPanelControls();
  assert.ok(controls.length > 0, 'PANEL_GROUPS 里应有控件（否则面板是空的）');

  const ids = controls.map((c) => c.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dup)], [], `控件 id 必须全局唯一，重复的：${dup.join(', ')}`);

  // 命名契约：右栏控件一律 ctl- 前缀（插件控件走另一条通道，不在这张表里）
  const badPrefix = ids.filter((id) => !String(id).startsWith('ctl-'));
  assert.deepEqual(badPrefix, [], `右栏控件 id 应以 ctl- 开头，异常：${badPrefix.join(', ')}`);

  const emptyGroups = PANEL_GROUPS.filter((g) => !(g.controls || []).some((c) => c && c.id)).map((g) => g.title);
  assert.deepEqual(emptyGroups, [], `每个分组至少要有一个控件，空组：${emptyGroups.join(', ')}`);
});

test('② 底栏控件清单：id 非空唯一、transport- 前缀、且不含已移除的循环按钮', () => {
  const ids = TRANSPORT_CONTROLS.map((c) => c.id);
  assert.ok(ids.length > 0, 'TRANSPORT_CONTROLS 不应为空');
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dup)], [], `底栏控件 id 必须唯一，重复的：${dup.join(', ')}`);
  const badPrefix = ids.filter((id) => !String(id).startsWith('transport-'));
  assert.deepEqual(badPrefix, [], `底栏控件 id 应以 transport- 开头，异常：${badPrefix.join(', ')}`);

  // 契约事实（不是环境数字）：循环播放已移到右栏「循环播放」开关，底栏不该再有它
  assert.ok(!ids.includes('transport-loop'),
    '底栏不应再有 transport-loop（循环播放入口在右栏「动作」组的开关上）');

  // 文案层面同一条契约：底栏任何控件的 label/title/options 都不该再出现「单动循环」这个词。
  //   为什么用导入的表而不是 DOM：文案是这张表渲染出来的，表里没有它，界面上就不可能有；
  //   这条替代了原先在 anim-list 浏览器脚本里"底栏 textContent 不含该词"的断言（同一条事实只留一处）。
  const singleLoopText = [];
  for (const ctl of TRANSPORT_CONTROLS) {
    const texts = [ctl.label, ctl.title, ...(Array.isArray(ctl.options) ? ctl.options : [])]
      .filter((t) => typeof t === 'string');
    if (texts.some((t) => t.includes('单动循环'))) singleLoopText.push(ctl.id);
  }
  assert.deepEqual(singleLoopText, [], `这些底栏控件的文案里还有「单动循环」：${singleLoopText.join(', ')}`);
});

test('③ 分组标题集合：标题与组 id 都非空唯一（同名/同 id 会让合并与定位失效）', () => {
  const titles = PANEL_GROUPS.map((g) => String(g.title || ''));
  const groupIds = PANEL_GROUPS.map((g) => String(g.id || ''));

  assert.deepEqual(titles.filter((t) => !t.trim()), [], '分组标题不能为空');
  assert.deepEqual(groupIds.filter((id) => !id.trim()), [], '分组 id 不能为空');
  assert.equal(new Set(titles).size, titles.length, `分组标题必须唯一，实际：${titles.join(' / ')}`);
  assert.equal(new Set(groupIds).size, groupIds.length, `分组 id 必须唯一，实际：${groupIds.join(' / ')}`);

  // 标题与 id 的一一对应关系：插件按 title 或 id 定位分组，两者都不能有歧义
  for (const group of PANEL_GROUPS) {
    assert.ok(String(group.title || '').trim(), `分组 ${group.id} 缺标题`);
    assert.ok(String(group.id || '').trim(), `分组「${group.title}」缺 id`);
  }
});

test('④ 控件分类门禁：每个控件必须属于 hidden / capabilityKey / debugKey / RENDERER_INDEPENDENT 之一', () => {
  const independent = new Set(RENDERER_INDEPENDENT || []);
  const miss = [];
  for (const control of allPanelControls()) {
    if (control.hidden === true) continue;
    if (typeof control.capabilityKey === 'string' && control.capabilityKey) continue;
    if (typeof control.debugKey === 'string' && control.debugKey) continue;
    if (independent.has(control.id)) continue;
    miss.push(control.id);
  }
  // 为什么必须有这条：漏标一个控件，它就会"永远显示"——能力不支持的渲染面也照样建出来，
  //   表现为"点了没反应"或"切到 Live2D 后多了几个不该有的控件"（靠人肉维护最容易漏）。
  assert.deepEqual(miss, [], `控件缺少分类标注（四类之外）：${miss.join(', ')}`);
});

test('⑤ 接线键：能接线的控件必须能推出设置键，且键两两不同（共键会让改一个另一个跟着变）', () => {
  const keyed = [];
  for (const control of allPanelControls()) {
    if (control.hidden === true) continue;                       // 隐藏项不建，不需要键
    if (new Set(RENDERER_INDEPENDENT).has(control.id)) continue;  // 与渲染器无关的项由外壳接线
    const key = settingKeyOf(control.id);
    assert.ok(key, `控件 ${control.id} 既不在 RENDERER_INDEPENDENT、也没有可推导的设置键（无法接线）`);
    keyed.push({ id: control.id, key });
  }
  assert.ok(keyed.length > 0, '应至少有一个可推键的控件');

  const seen = new Map();
  const collisions = [];
  for (const { id, key } of keyed) {
    if (seen.has(key)) collisions.push(`${seen.get(key)} 与 ${id} 共用 ${key}`);
    else seen.set(key, id);
  }
  assert.deepEqual(collisions, [], `设置键必须唯一：${collisions.join('；')}`);
});

test('⑥ 禁用样式契约：删除线只绑 data-pending，不许绑 :disabled', () => {
  const css = fs.readFileSync(PANEL_CSS, 'utf8');
  // 只解析"选择器 → 声明块"这一层（不处理嵌套 at-rule，panel.css 现状没有用到）
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), body: m[2] }));
  assert.ok(rules.length > 0, 'panel.css 应能解析出规则块');

  const pendingStrike = rules.filter((r) => r.selector.includes('data-pending') && /text-decoration\s*:\s*line-through/.test(r.body));
  // 为什么必须画线：未接线（pending）是"还没接上"，划线是最省字的可见标记
  assert.ok(pendingStrike.length > 0, '应有"data-pending=true ⇒ text-decoration: line-through"的规则');

  const disabledStrike = rules.filter((r) => /:disabled|\[disabled\]/.test(r.selector) && /text-decoration\s*:\s*line-through/.test(r.body));
  // 为什么禁止：能力不支持的项只是"这一面没有这个能力"，划线会让人以为它坏了（历史 bug：两者共用 :disabled 划线）
  assert.deepEqual(disabledStrike.map((r) => r.selector), [],
    '禁用线不得绑在 :disabled 上（能力不支持 ≠ 未接线）');
});
