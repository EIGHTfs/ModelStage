// panel.js —— 右侧控制面板渲染（M3：控件齐全、布局就位、一律不接线）
//
// 做什么：按 panel-schema.js 的分组表渲染 9 个手风琴分组与组内控件。
// 接线边界（M3 铁律 1：不允许"看着能点却没反应"）：
//   · **手风琴开合是真实行为**（点一次真的展开/折叠，aria-expanded 同步翻转）——
//     这是 M3 验收明确要求逐个实操的部分；
//   · **组内控件一律 disabled + data-pending="true"**，M6 统一接线，避免"接一半"打乱验收口径。
//
// 控件种类：
//   segmented 分段按钮组（单选语义，用 aria-pressed 表达当前项，M6 才真正改值）
//   switch    开关（role=switch + aria-checked）
//   actions   一组动作按钮（导出/导入/恢复默认）
//   dynamic-list 动态内容占位（M6 由模型数据填充）
//   note      纯说明文字

import { PANEL_GROUPS } from './panel-schema.js';

/** 元素工厂（与名册那边同名的本地小工具，避免跨模块只为建元素而互相依赖） */
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/** 每个未接线控件统一打上标记：M6 接线时以此为准逐项摘掉 */
function markPending(node, id) {
  node.dataset.pending = 'true';
  if (id) node.id = id;
  return node;
}

/** 分段按钮组：一个 label + 若干选项按钮（全部 disabled，默认不选任何项） */
function renderSegmented(ctl) {
  const row = el('div', 'ctl-row');
  row.append(el('span', 'ctl-label', ctl.label));
  const group = el('div', 'ctl-seg');
  group.dataset.ctl = ctl.id || '';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', ctl.label);
  for (const opt of ctl.options) {
    const item = typeof opt === 'string' ? { text: opt } : opt;
    const btn = markPending(el('button', 'seg-btn', item.text), null);
    btn.type = 'button';
    btn.disabled = true;
    btn.setAttribute('aria-pressed', 'false');
    if (item.title) btn.title = `${item.title}（M6 接线）`;
    else btn.title = '待接线（M6）';
    group.append(btn);
  }
  row.append(group);
  return row;
}

/** 开关：label + 假开关（role=switch，disabled） */
function renderSwitch(ctl) {
  const row = el('div', 'ctl-row ctl-row-switch');
  row.append(el('span', 'ctl-label', ctl.label));
  const btn = markPending(el('button', 'switch-btn'), ctl.id);
  btn.type = 'button';
  btn.disabled = true;
  btn.setAttribute('role', 'switch');
  btn.setAttribute('aria-checked', 'false');
  btn.title = '待接线（M6）';
  btn.append(el('span', 'switch-knob'));
  row.append(btn);
  return row;
}

/** 动作按钮组：导出设置 / 导入设置 / 恢复默认 */
function renderActions(ctl) {
  const row = el('div', 'ctl-actions');
  row.dataset.ctl = ctl.id || '';
  for (const label of ctl.buttons) {
    const btn = markPending(el('button', 'mini-btn', label), null);
    btn.type = 'button';
    btn.disabled = true;
    btn.title = '待接线（M6）';
    row.append(btn);
  }
  return row;
}

/** 动态内容占位：M6 会在这个容器里填真实条目 */
function renderDynamicList(ctl) {
  const box = el('div', 'ctl-dynamic');
  box.dataset.ctl = ctl.label || '';
  box.dataset.pending = 'true';
  box.append(el('p', 'ctl-note', ctl.note || '（M6 接线）'));
  return box;
}

/** 按种类分派 */
function renderControl(ctl) {
  switch (ctl.kind) {
    case 'segmented': return renderSegmented(ctl);
    case 'switch': return renderSwitch(ctl);
    case 'actions': return renderActions(ctl);
    case 'dynamic-list': return renderDynamicList(ctl);
    default: return el('p', 'ctl-note', ctl.note || '');
  }
}

/**
 * 渲染一个手风琴分组。
 * 开合状态存在 DOM 上（aria-expanded + class），M6 若需要持久化再抽到 store。
 * @param {object} group
 */
function renderGroup(group) {
  const section = el('section', 'acc');
  section.dataset.group = group.id;

  const trigger = el('button', 'acc-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-expanded', String(!!group.defaultOpen));
  trigger.setAttribute('aria-controls', `acc-body-${group.id}`);
  trigger.append(el('span', 'acc-arrow'));
  trigger.append(el('span', 'acc-title', group.title));

  const body = el('div', 'acc-body');
  body.id = `acc-body-${group.id}`;
  body.setAttribute('role', 'region');
  body.setAttribute('aria-label', group.title);
  for (const ctl of group.controls) body.append(renderControl(ctl));
  body.hidden = !group.defaultOpen;

  // 开合是真实行为：切换 aria-expanded 与 hidden，箭头方向由 CSS 跟着 aria 走
  trigger.addEventListener('click', () => {
    const open = trigger.getAttribute('aria-expanded') === 'true';
    trigger.setAttribute('aria-expanded', String(!open));
    body.hidden = open;
  });

  if (group.defaultOpen) section.classList.add('is-open');
  section.append(trigger, body);
  return section;
}

/**
 * 把面板挂到容器上。
 * @param {{headEl: HTMLElement, bodyEl: HTMLElement}} mounts
 * @returns {{groups: number, controls: number}}
 */
export function mountPanel({ headEl, bodyEl }) {
  headEl.replaceChildren();
  bodyEl.replaceChildren();

  // 面板头：标题 + 「收起菜单」（旧前端在面板右缘有这个按钮；M3 未接线故 disabled）
  const title = el('span', 'panel-title', '控制面板');
  const collapse = markPending(el('button', 'mini-btn', '收起菜单'), 'btn-collapse-menu');
  collapse.type = 'button';
  collapse.disabled = true;
  collapse.title = '待接线（M6）：收起右侧面板';
  headEl.append(title, collapse);

  for (const group of PANEL_GROUPS) bodyEl.append(renderGroup(group));

  // 统计口径：面板头 + 组内所有非手风琴控件（M3 全部 disabled），供断言核对控件数
  const controls = (headEl.querySelectorAll('button, select, input').length)
    + (bodyEl.querySelectorAll('button:not(.acc-trigger), select, input, [role="switch"]').length);
  return { groups: PANEL_GROUPS.length, controls };
}
