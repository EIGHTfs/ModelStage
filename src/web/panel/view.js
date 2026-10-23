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
//   dynamic-list 动态内容容器（由接线方按模型填充）
//   note      纯说明文字

import { ACTION_ICONS, COLLAPSE_ICON, GROUP_ICONS, svgIcon } from './icons.js';
import { el, markDisabled, markPending } from './dom.js';
import { renderChips, renderListRow, renderSelect } from './render-choice.js';
import { PANEL_GROUPS } from './schema.js';

/** 元素工厂（与名册那边同名的本地小工具，避免跨模块只为建元素而互相依赖） */
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
    btn.dataset.value = String(ctl.values[i]);
    btn.setAttribute('aria-pressed', String(i === defaultIdx));
    const hint = (ctl.titles && ctl.titles[i]) || item.title;
    const optDisabled = Array.isArray(ctl.disabledValues) && ctl.disabledValues.includes(ctl.values[i]);
    if (wired && !optDisabled) {
      btn.title = hint || item.text;
      btn.addEventListener('click', () => {
        for (const other of group.children) other.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-pressed', 'true');
        try { ctx.onSetting(ctl.id, ctl.values[i]); } catch { /* 接线失败不影响面板自身状态 */ }
      });
    } else if (optDisabled) {
      // 单个取值被禁（如"自定义背景"这类尚未接线的选项）：属开发中项，保持 pending 口径
      btn.disabled = true;
      markPending(btn, null);
      btn.title = hint || '待接线（M6）';
    } else {
      markDisabled(btn, ctl, ctx);
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
  // 未声明能力的控件由 applyCapabilities 置 ctl.disabled：这里一并压制交互（禁用+原因，不静默）
  const wired = ctx.isWired(ctl.id) && ctl.disabled !== true;
  const row = el('div', 'ctl-row ctl-row-switch');
  row.dataset.ctl = ctl.id || ''; // 与分段/下拉一致：外层行可被 [data-ctl] 定位
  row.append(el('span', 'ctl-label', ctl.label));
  const btn = el('button', 'switch-btn');
  btn.id = ctl.id || '';
  btn.type = 'button';
  btn.setAttribute('role', 'switch');
  btn.setAttribute('aria-checked', String(!!ctl.defaultOn));
  if (wired) {
    btn.title = ctl.title || ctl.label;
    btn.addEventListener('click', () => {
      // 从 DOM 派生下一个状态：外部同步（另一处开关）改过 aria-checked 后，这里仍能正确翻转
      const next = btn.getAttribute('aria-checked') !== 'true';
      btn.setAttribute('aria-checked', String(next));
      try { ctx.onSetting(ctl.id, next); } catch { /* 接线失败不影响面板自身状态 */ }
    });
  } else {
    markDisabled(btn, ctl, ctx);
  }
  btn.append(el('span', 'switch-knob'));
  row.append(btn);
  return row;
}

/** 动作按钮组：导出设置 / 导入设置 / 恢复默认 */
function renderActions(ctl, ctx) {
  const row = el('div', 'ctl-actions');
  row.dataset.ctl = ctl.id || '';
  const wired = !!(ctx && typeof ctx.isWired === 'function' && ctx.isWired(ctl.id));
  const blocked = ctx && typeof ctx.disabledReason === 'function' ? ctx.disabledReason(ctl.id) : null;
  for (const item of ctl.buttons) {
    const def = typeof item === 'string' ? { text: item } : item;
    const btn = el('button', 'mini-btn', def.text);
    btn.type = 'button';
    btn.dataset.action = def.text;
    if (ACTION_ICONS[def.text]) { btn.prepend(svgIcon(ACTION_ICONS[def.text])); btn.classList.add('has-icon'); }
    const reason = def.disabledReason || blocked; // 单按钮不可用时如实写原因，不冒充"待接线"
    if (reason) { btn.disabled = true; btn.title = reason; btn.dataset.disabledReason = reason; } else if (wired) {
      btn.title = def.title || def.text;
      btn.addEventListener('click', () => { try { ctx.onSetting(ctl.id, def.text); } catch { /* 接线失败不影响面板状态 */ } });
    } else { markPending(btn, null); btn.disabled = true; btn.title = '待接线（M6）'; }
    row.append(btn);
  }
  return row;
}

/** 动态内容占位：M6 会在这个容器里填真实条目 */
function renderDynamicList(ctl) {
  // 容器由接线方按当前模型填充（动作列表）；空态给提示
  const box = el('div', 'ctl-dynamic ctl-list');
  box.dataset.ctl = ctl.id || ctl.label || '';
  box.dataset.role = 'dynamic';
  box.append(el('p', 'ctl-note', ctl.note || '选中模型后显示'));
  return box;
}

/** 下拉（select）：用于主题这类"项较多、单列占位"的选择 */
/** 只读行：label + 值（值由接线方写入，用于展示无法切换或纯信息类内容） */
function renderReadonly(ctl) {
  const row = el('div', 'ctl-row ctl-row-readonly');
  row.dataset.ctl = ctl.id || '';
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
    case 'actions': return renderActions(ctl, ctx);
    case 'dynamic-list': return renderDynamicList(ctl);
    case 'readonly': return renderReadonly(ctl);
    case 'chips': return renderChips(ctl, ctx);
    case 'select': return renderSelect(ctl, ctx);
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
  // 同旧端：标题前彩色图标（主色），箭头在右
  if (GROUP_ICONS[group.id]) trigger.append(svgIcon(GROUP_ICONS[group.id]));
  trigger.append(el('span', 'acc-title', group.title));
  trigger.append(el('span', 'acc-arrow'));

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
export function mountPanel({ headEl, bodyEl, onSetting, wiredIds, groups }) {
  // schema 可由调用方按渲染器能力过滤后传入；缺省用全量 PANEL_GROUPS（保持原有行为）
  const schema = Array.isArray(groups) && groups.length ? groups : PANEL_GROUPS;
  headEl.replaceChildren();
  /**
   * 现查容器：面板可能在切面/重建时被换成新 DOM，
   *   闭包里捕获的 bodyEl 会变成"不在文档里的旧节点"——刷上去看不到任何变化（实测过的坑）。
   *   所有访问器一律用时就查；查不到（面板未构建/被隐藏）就安全返回。
   * @param {string} selector 相对容器的选择器
   * @returns {Element|null}
   */
  function find(selector) {
    const host = (typeof document !== 'undefined' && document.querySelector('#right-panel [data-ctl]'))
      ? document.querySelector('#right-panel') : bodyEl;
    if (!host) return null;
    return host.querySelector(selector);
  }

  bodyEl.replaceChildren();
  // 接线集合来自接线方（main.js 的映射表），与 schema 的 values 解耦：
  // 这样"schema 加了取值域但还没接生效"的控件会保持 disabled，不会出现点了没反应。
  const wiredSet = new Set(Array.isArray(wiredIds) ? wiredIds : []);
  // 能力过滤结果（schema.applyCapabilities 写在控件上）：disabled 的控件一律不可点并给 reason
  const byId = new Map(); // id → 控件定义（setOptions 需要读 emptyText 之类的声明）
  for (const group of schema) for (const ctl of group.controls || []) if (ctl && ctl.id) byId.set(ctl.id, ctl);
  const disabledMap = new Map();
  for (const group of schema) {
    for (const ctl of group.controls || []) {
      if (ctl && ctl.id && ctl.disabled) disabledMap.set(ctl.id, ctl.reason || '当前渲染器不支持');
    }
  }
  const ctx = {
    onSetting: typeof onSetting === 'function' ? onSetting : () => {},
    isWired: (id) => !!id && wiredSet.has(id) && !disabledMap.has(id),
    /** 能力层禁用原因（有值 ⇒ 该控件按"当前渲染器不支持"禁用） */
    disabledReason: (id) => disabledMap.get(id) || null,
  };

  // 面板头：标题 + 「收起菜单」（旧前端在面板右缘有这个按钮；M3 未接线故 disabled）
  const title = el('span', 'panel-title', '控制面板');
  // 「收起菜单」：点击由 main.js 在 #panel-head 委托绑定（面板重建不丢监听）
  const collapse = el('button', 'mini-btn has-icon', '收起菜单');
  collapse.prepend(svgIcon(COLLAPSE_ICON));
  collapse.dataset.ctl = 'btn-collapse-menu'; // 与组内控件同口径，便于统一用 [data-ctl] 定位
  collapse.type = 'button';
  collapse.title = '收起右侧控制面板（顶栏「菜单」可再打开）';
  headEl.append(title, collapse);

  for (const group of schema) bodyEl.append(renderGroup(group, ctx));

  // 已接线控件的声明默认值：作为"面板即真相"的唯一来源，交给接线方在启动时下发
  const defaults = {};
  for (const group of schema) {
    for (const ctl of group.controls) {
      if (wiredSet.has(ctl.id) && ctl.defaultValue !== undefined) defaults[ctl.id] = ctl.defaultValue;
      // 开关类没有取值域：默认态用 defaultOn 声明，同样由接线方启动时下发一次
      else if (wiredSet.has(ctl.id) && ctl.kind === 'switch' && ctl.defaultOn !== undefined) defaults[ctl.id] = !!ctl.defaultOn;
    }
  }

  /** 只读行写入（运行时版本等信息由接线方给） */
  function setReadonly(id, text) {
    const node = find(`[data-readout="${id}"]`);
    if (node) node.textContent = text || '—';
  }

  /** 动态重建预设按钮组（皮肤列表在换模型后要用新数据重建） */
  function setOptions(id, options, selected) {
    const box = find(`[data-ctl="${id}"]`);
    if (!box || !Array.isArray(options)) return false;
    // 该项可能因"当前渲染面未声明该能力"而禁用：重建选项时必须**保留禁用态**，
    //   否则装载模型后刷新皮肤列表会把禁用按钮换成可点按钮（表现为"换面后又能点了"）。
    const blocked = ctx && typeof ctx.disabledReason === 'function' ? ctx.disabledReason(id) : null;
    box.replaceChildren();
    const asList = box.classList.contains('ctl-list'); // 皮肤列表：列表行；其它：横向 chips
    const ctlDef = byId.get(id) || null;
    if (asList && options.length === 0 && ctlDef && ctlDef.emptyText) {
      // 空态照旧端：居中一行弱化小字（如"默认皮肤"），不留空白区
      box.append(el('div', 'ctl-list-empty', ctlDef.emptyText));
      return true;
    }
    for (const opt of options) {
      const btn = asList
        ? renderListRow(opt, { selected: String(opt.value) === String(selected) })
        : el('button', 'chip-btn', opt.text || opt.value);
      btn.type = 'button';
      btn.dataset.value = String(opt.value);
      if (!asList) btn.setAttribute('aria-pressed', String(String(opt.value) === String(selected)));
      if (blocked) {
        btn.disabled = true;
        btn.title = `${blocked}：${opt.text || opt.value}`;
        btn.dataset.disabledReason = blocked;
        box.append(btn);
        continue;
      }
      btn.title = opt.text || opt.value;
      btn.addEventListener('click', () => {
        for (const other of box.children) other.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-pressed', 'true');
        try { ctx.onSetting(id, opt.value); } catch { /* 接线失败保持选择 */ }
      });
      box.append(btn);
    }
    return true;
  }

  /** 设置开关显示态（两处共用同一状态的开关要同步） */
  function setChecked(id, on) {
    const box = find(`[data-ctl="${id}"]`);
    const btn = box ? box.querySelector('[role="switch"]') : null;
    if (btn) btn.setAttribute('aria-checked', String(!!on));
  }

  /** 回填控件显示值（启动时按存储恢复：主题 / 背景模式等） */
  function setValue(id, value) {
    const box = find(`[data-ctl="${id}"]`);
    if (box) {
      const opts = [...box.children];
      const idx = opts.findIndex((b) => b.dataset.value === String(value));
      if (idx >= 0) {
        opts.forEach((b, i) => b.setAttribute('aria-pressed', String(i === idx)));
        return;
      }
    }
    const sel = find(`select[data-ctl-select="${id}"]`);
    if (sel && [...sel.options].some((o) => o.value === String(value))) sel.value = String(value);
  }

  /** 帧率读数（实测值；null 表示暂无数据），由接线方按需刷新 */
  function setFps(fps) {
    const node = find('[data-readout="ctl-fps"]');
    if (!node) return;
    // 说明写进 title：设备渲染能力不足时，60/30 两档的实测帧率会看不出差异，这是性能而非接线问题
    node.title = '实测帧率。受设备性能限制：渲染上限低于所选上限时，60/30 两档看不出差异';
    node.textContent = typeof fps === 'number' && fps > 0 ? `当前 ${Math.round(fps)} FPS` : '—';
  }

  // 统计口径：面板头 + 组内所有非手风琴控件，供断言核对控件数
  const controls = (headEl.querySelectorAll('button, select, input').length)
    + (bodyEl.querySelectorAll('button:not(.acc-trigger), select, input, [role="switch"]').length);
  return { groups: schema.length, controls, setFps, setReadonly, setValue, setOptions, setChecked, defaults };
}
