// app/memory-bars.js —— 内存三色条的两个挂载点（舞台顶部 / 设置面板）统一管理
//
// 为什么要这一层：面板会重建、舞台容器常在，两处各有自己的生命周期。
//   组件本身（panel/memory-bar.js）只管"画一条"；谁该在什么时候拉数据、要不要显示，
//   集中在这么一个小模块里，免得散落到 model-actions / panel-settings / shell-controls 各处。
//
// 刷新时机（事件驱动，无定时器）：
//   · 模型加载成功后          → refreshStage()
//   · 面板重建（展开设置时）  → refreshPanel()
//   · 「显示状态信息」开关    → setStageVisible()（关掉时舞台那条跟着消失，与状态行同策略）

import { mountMemoryBar } from '../panel/memory-bar.js';

/** 舞台顶部那条（容器在 index.html 里） */
const stageBar = mountMemoryBar('#mem-bar-stage');

/** 设置面板里那条（容器由 schema 的 ctl-memory-bar 提供） */
const panelBar = mountMemoryBar('#right-panel [data-ctl="ctl-memory-bar"]');

/** 舞台那条是否允许显示（跟「显示状态信息」开关走，默认开） */
let stageVisible = true;

/**
 * 刷新舞台顶部那条（模型加载成功后调用）。
 * @returns {Promise<boolean>} 是否显示成功
 */
export async function refreshStage() {
  if (!stageVisible) { stageBar.hide(); return false; }
  return stageBar.refresh();
}

/**
 * 刷新设置面板那条（面板重建后调用）。
 * @returns {Promise<boolean>}
 */
export async function refreshPanel() {
  return panelBar.refresh();
}

/**
 * 「显示状态信息」开关联动：关掉时舞台那条立即隐藏（不拉数据、不留空壳）。
 * @param {boolean} on
 */
export function setStageVisible(on) {
  stageVisible = on !== false;
  if (!stageVisible) { stageBar.hide(); return; }
  // 打开时补拉一次（此刻可能还没有数据）
  refreshStage().catch(() => { /* 失败已由组件内部记 warn 并隐藏 */ });
}

/**
 * 绑定「展开设置面板 → 拉一次」（文档 §五）。
 * 面板重建时也会调 refreshPanel，但"点开设置组"不重建面板 ⇒ 单独绑点击。
 * 幂等：只绑一次。
 * @returns {boolean} 本次是否新绑定
 */
let bound = false;
export function bindPanelBarRefresh() {
  if (bound) return false;
  bound = true;
  document.addEventListener('click', (ev) => {
    const trigger = ev.target && typeof ev.target.closest === 'function'
      ? ev.target.closest('#right-panel .acc-trigger')
      : null;
    if (!trigger) return;
    const label = (trigger.textContent || '').trim();
    // 只关心「设置」组：其它组与内存无关，不必拉数据
    if (!label.includes('设置')) return;
    refreshPanel().catch(() => { /* 失败已由组件记 warn 并隐藏 */ });
  }, true);
  return true;
}

/** 供断言：两处当前显示的数值（无数据返回 null） */
export function memoryBarSnapshot() {
  const read = (sel) => {
    const bar = document.querySelector(sel);
    if (!bar || bar.hidden) return null;
    return {
      aria: bar.getAttribute('aria-label'),
      text: (bar.querySelector('.mem-bar-text') || {}).textContent || '',
      pct: {
        server: bar.dataset.pctServer, other: bar.dataset.pctOther, avail: bar.dataset.pctAvail,
      },
    };
  };
  return {
    stage: read('#mem-bar-stage .mem-bar'),
    panel: read('#right-panel [data-ctl="ctl-memory-bar"] .mem-bar'),
  };
}
