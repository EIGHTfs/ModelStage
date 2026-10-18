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

/**
 * 分段按钮组：一个 label + 若干选项按钮。
 * 接线口径：控件带 `values` 才算已接线——按钮可点、默认项按 defaultValue 高亮、点击回传机器值；
 *   不带的保持 disabled + data-pending（不许"看着能点却没反应"）。
 * @param {object} ctl
 * @param {{onSetting: Function}} ctx
 */
function renderSegmented(ctl, ctx) {
  // 是否可点由**接线方**（映射表）决定：带 values 只说明"有机器值可取"，不代表已生效
  const wired = ctx.isWired(ctl.id) && Array.isArray(ctl.values) && ctl.values.length === ctl.options.length;
  const row = el('div', 'ctl-row');
  row.append(el('span', 'ctl-label', ctl.label));
  const group = el('div', 'ctl-seg');
  group.dataset.ctl = ctl.id || '';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', ctl.label);
  const defaultIdx = wired && ctl.defaultValue !== undefined ? ctl.values.indexOf(ctl.defaultValue) : -1;

  ctl.options.forEach((opt, i) => {
    const item = typeof opt === 'string' ? { text: opt } : opt;
    const btn = el('button', 'seg-btn', item.text);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(i === defaultIdx));
    if (wired) {
      btn.title = item.title || item.text;
      btn.addEventListener('click', () => {
        for (const other of group.children) other.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-pressed', 'true');
        try { ctx.onSetting(ctl.id, ctl.values[i]); } catch { /* 接线失败不影响面板自身状态 */ }
      });
    } else {
      markPending(btn, null);
      btn.disabled = true;
      btn.title = item.title ? `${item.title}（M6 接线）` : '待接线（M6）';
    }
    group.append(btn);
  });
  row.append(group);
  // 需要读数行的控件（当前只有帧率）：数值由 mountPanel 暴露的 setFps 更新
  if (ctl.readout) {
    const readout = el('span', 'ctl-readout', '—');
    readout.dataset.readout = ctl.id;
    readout.setAttribute('aria-live', 'polite');
    row.append(readout);
  }
  return row;
}

/**
 * 开关：label + 开关（role=switch）。
 * 未接线的开关**仍按旧端默认态显示**（defaultOn），只是不可点——避免"默认值看起来是关"的错配。
 */
function renderSwitch(ctl, ctx) {
  const wired = ctx.isWired(ctl.id);
  const row = el('div', 'ctl-row ctl-row-switch');
  row.append(el('span', 'ctl-label', ctl.label));
  const btn = el('button', 'switch-btn');
  btn.id = ctl.id || '';
  btn.type = 'button';
  btn.setAttribute('role', 'switch');
  let on = !!ctl.defaultOn;
  btn.setAttribute('aria-checked', String(on));
  if (wired) {
    btn.title = ctl.title || ctl.label;
    btn.addEventListener('click', () => {
      on = !on;
      btn.setAttribute('aria-checked', String(on));
      try { ctx.onSetting(ctl.id, on); } catch { /* 接线失败不影响面板自身状态 */ }
    });
  } else {
    markPending(btn, null);
    btn.disabled = true;
    btn.title = '待接线（M6）';
  }
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

/** 只读行：label + 值（值由接线方写入，用于展示无法切换或纯信息类内容） */
function renderReadonly(ctl) {
  const row = el('div', 'ctl-row ctl-row-readonly');
  row.append(el('span', 'ctl-label', ctl.label));
  const v = el('span', 'ctl-value', '—');
  v.dataset.readout = ctl.id || '';
  if (ctl.note) v.title = ctl.note;
  row.append(v);
  return row;
}

/** 按种类分派 */
function renderControl(ctl, ctx) {
  switch (ctl.kind) {
    case 'segmented': return renderSegmented(ctl, ctx);
    case 'switch': return renderSwitch(ctl, ctx);
    case 'actions': return renderActions(ctl);
    case 'dynamic-list': return renderDynamicList(ctl);
    case 'readonly': return renderReadonly(ctl);
    default: return el('p', 'ctl-note', ctl.note || '');
  }
}

/**
 * 渲染一个手风琴分组。
 * 开合状态存在 DOM 上（aria-expanded + class），M6 若需要持久化再抽到 store。
 * @param {object} group
 */
function renderGroup(group, ctx) {
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
  for (const ctl of group.controls) body.append(renderControl(ctl, ctx));
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
 * @param {{headEl: HTMLElement, bodyEl: HTMLElement, onSetting?: (id: string, value: any) => void}} mounts
 *   onSetting：已接线控件的回传口（面板只把"点了哪个选项"翻成机器值，具体生效由接线方决定）
 * @returns {{groups: number, controls: number, setFps: (fps: number|null) => void}}
 */
export function mountPanel({ headEl, bodyEl, onSetting, wiredIds }) {
  headEl.replaceChildren();
  bodyEl.replaceChildren();
  // 接线集合来自接线方（main.js 的映射表），与 schema 的 values 解耦：
  // 这样"schema 加了取值域但还没接生效"的控件会保持 disabled，不会出现点了没反应。
  const wiredSet = new Set(Array.isArray(wiredIds) ? wiredIds : []);
  const ctx = {
    onSetting: typeof onSetting === 'function' ? onSetting : () => {},
    isWired: (id) => !!id && wiredSet.has(id),
  };

  // 面板头：标题 + 「收起菜单」（旧前端在面板右缘有这个按钮；M3 未接线故 disabled）
  const title = el('span', 'panel-title', '控制面板');
  const collapse = markPending(el('button', 'mini-btn', '收起菜单'), 'btn-collapse-menu');
  collapse.type = 'button';
  collapse.disabled = true;
  collapse.title = '待接线（M6）：收起右侧面板';
  headEl.append(title, collapse);

  for (const group of PANEL_GROUPS) bodyEl.append(renderGroup(group, ctx));

  /** 只读行写入（运行时版本等信息由接线方给） */
  function setReadonly(id, text) {
    const node = bodyEl.querySelector(`[data-readout="${id}"]`);
    if (node) node.textContent = text || '—';
  }

  /** 帧率读数（实测值；null 表示暂无数据），由接线方按需刷新 */
  function setFps(fps) {
    const node = bodyEl.querySelector('[data-readout="ctl-fps"]');
    if (!node) return;
    // 说明写进 title：设备渲染能力不足时，60/30 两档的实测帧率会看不出差异，这是性能而非接线问题
    node.title = '实测帧率。受设备性能限制：渲染上限低于所选上限时，60/30 两档看不出差异';
    node.textContent = typeof fps === 'number' && fps > 0 ? `当前 ${Math.round(fps)} FPS` : '—';
  }

  // 统计口径：面板头 + 组内所有非手风琴控件，供断言核对控件数
  const controls = (headEl.querySelectorAll('button, select, input').length)
    + (bodyEl.querySelectorAll('button:not(.acc-trigger), select, input, [role="switch"]').length);
  return { groups: PANEL_GROUPS.length, controls, setFps, setReadonly };
}
