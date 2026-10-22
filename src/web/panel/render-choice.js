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
  if (ctl.defaultValue !== undefined) sel.value = ctl.defaultValue;
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
export function renderChips(ctl, ctx) {
  const wired = ctx.isWired(ctl.id) && ctl.disabled !== true;
  const row = el('div', 'ctl-row ctl-row-chips');
  row.append(el('span', 'ctl-label', ctl.label));
  const box = el('div', 'ctl-chips');
  box.dataset.ctl = ctl.id || '';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', ctl.label);
  for (const opt of ctl.options) {
    const btn = el('button', 'chip-btn', opt.text || opt.value);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(opt.value === ctl.defaultValue));
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
