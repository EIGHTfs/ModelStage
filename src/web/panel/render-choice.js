// panel/render-choice.js —— 下拉与预设按钮组（chips）两类"多选一"控件的渲染
//
// 单独成模块：view.js 要守行数上限，且这两类控件逻辑相近（都有"一组候选、选一个"的结构）。
import { el, markDisabled } from './dom.js';

/** 下拉（select）：项较多、单列占一行的场景（主题、DPR、皮肤等） */
export function renderSelect(ctl, ctx) {
  // ctl.disabled 由 applyCapabilities 置（当前渲染面未声明该能力）：
  //   必须同时压制交互，否则"看起来能点、点了没反应"就是静默无效。
  const wired = ctx.isWired(ctl.id) && ctl.disabled !== true;
  const row = el('div', 'ctl-row');
  row.dataset.ctl = ctl.id || ''; // 与分段/开关一致：外层行也带 data-ctl，便于统一查询
  row.append(el('span', 'ctl-label', ctl.label));
  const sel = el('select', 'ctl-select');
  sel.id = ctl.id || '';
  sel.dataset.ctlSelect = ctl.id || '';
  for (const opt of ctl.options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.text;
    sel.append(o);
  }
  {
    const ivSel = ctx && typeof ctx.initialValue === 'function' ? ctx.initialValue(ctl.id) : undefined;
    const wantSel = ivSel === undefined ? ctl.defaultValue : ivSel;
    if (wantSel !== undefined && [...sel.options].some((o) => o.value === String(wantSel))) sel.value = String(wantSel);
  }
  if (wired) {
    sel.addEventListener('change', () => {
      try { ctx.onSetting(ctl.id, sel.value); } catch { /* 接线失败保持选择 */ }
    });
  } else {
    markDisabled(sel, ctl, ctx);
  }
  row.append(sel);
  return row;
}

/** 预设按钮组（chips）：一组同名按钮，每项自带机器值（滤镜这类"多选一但项很多"的场景） */
/** 造一个候选项节点：列表布局用行，否则用 chips 胶囊 */
function buildOptionNode(ctl, opt, selectedValue) {
  // 选中值由调用方给（工厂里的当前值）；缺省才回落到 schema 默认。
  //   不能在这里直接读 ctl.defaultValue —— 那会和"按工厂值标选中"形成两个来源，
  //   面板重建后出现两个同时高亮（实测：深空青 + 云蓝 都是 aria-pressed=true）。
  const sel = selectedValue === undefined ? ctl.defaultValue : selectedValue;
  if (ctl.layout === 'list') {
    const row = renderListRow(opt, { selected: opt.value === sel });
    row.type = 'button';
    return row;
  }
  const chip = el('button', 'chip-btn', opt.text || opt.value);
  chip.type = 'button';
  chip.setAttribute('aria-pressed', String(opt.value === sel));
  return chip;
}

export function renderChips(ctl, ctx) {
  const wired = ctx.isWired(ctl.id) && ctl.disabled !== true;
  const row = el('div', 'ctl-row ctl-row-chips');
  row.append(el('span', 'ctl-label', ctl.label));
  // layout:'list' → 纵向列表容器（皮肤列表照旧端的行样式）；否则仍是横向 chips（滤镜预设等）
  const box = el('div', ctl.layout === 'list' ? 'ctl-chips ctl-list' : 'ctl-chips');
  box.dataset.ctl = ctl.id || '';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', ctl.label);
  const ivChips = ctx && typeof ctx.initialValue === 'function' ? ctx.initialValue(ctl.id) : undefined;
  const wantChips = ivChips === undefined ? ctl.defaultValue : ivChips;
  for (const opt of ctl.options) {
    // 选中态只有一个来源：把工厂里的当前值传下去（不要在这里再补一次标 true）
    const btn = buildOptionNode(ctl, opt, wantChips);
    if (wired) {
      btn.title = opt.text || opt.value;
      btn.addEventListener('click', () => {
        for (const other of box.children) other.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-pressed', 'true');
        try { ctx.onSetting(ctl.id, opt.value); } catch { /* 接线失败不影响面板状态 */ }
      });
    } else {
      markDisabled(btn, ctl, ctx);
    }
    box.append(btn);
  }
  row.append(box);
  return row;
}

/**
 * 单选列表的一行（与旧端动作/皮肤列表同一套样式）：
 *   左名右值、选中主色描边、hover 变色、名称溢出省略。
 * @param {{text: string, value: string}} opt
 * @param {{selected?: boolean, timeText?: string, title?: string}} [opts]
 * @returns {HTMLButtonElement}
 */
export function renderListRow(opt, opts = {}) {
  const btn = el('button', 'ctl-list-row');
  btn.type = 'button';
  btn.dataset.value = String(opt.value);
  btn.setAttribute('aria-pressed', String(!!opts.selected));
  const name = el('span', 'ctl-list-name', opt.text || opt.value);
  btn.append(name);
  if (opts.timeText) btn.append(el('span', 'ctl-list-time', opts.timeText));
  if (opts.title) btn.title = opts.title;
  return btn;
}
