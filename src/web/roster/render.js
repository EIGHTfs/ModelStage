// roster/render.js —— 名册渲染（从 view.js 原样搬出：DOM 结构与文案一字不改）
//
// 负责什么：
//   · 整棵树的渲染（一级游戏 / 二级角色 / 三级变体）与顶部计数文案；
//   · 类型胶囊行（renderTypeFilter）与"类型筛选把所有条目挡掉"的提示；
//   · 游戏状态判定（groupStatus）与扫描状态就地贴行（applyScanStatusToRow / aggregateScan）；
//   · 跨根归并角色树（rebuildGroupChars，实现在 store.rebuildChars）。
//
// 不负责什么：加载编排（load.js）、事件（events.js）、装配（view.js）。
// 依赖方向（单向）：store ← load ← render ← view / events。
//   本文件只读 store 的状态、只调 store 的动作，不 import load；
//   快照投影（snapshot.js）通过 snapshotOf 注入 —— 因为快照要用本文件的 groupStatus，
//   而本文件要在 render 末尾产出快照，直接互相 import 就是环。

import {
  aggregateScanSnapshots, formatScanStatus, resolveGroupPhase, scanNeedsRetry,
} from './scan-stream.js';
import { visibleChars } from './filter.js';
import { deriveTypeCounts, filterCharsByType, usableTypeSelection } from './type-filter.js';
import { typeLabel } from '../../shared/type-labels.mjs';
import { el, renderGroupRow, renderCharRow, renderVariantRow } from './rows.js';

/** 渲染上限：每个游戏最多渲染多少角色行（避免 2000+ 角色一次铺满）。
 *  默认值只是兜底，可用 window.__WEB_CONFIG__.renderLimitPerGame 覆盖 */
const RENDER_LIMIT_DEFAULT = 400;
function renderLimitPerGame() {
  const custom = Number(window.__WEB_CONFIG__ && window.__WEB_CONFIG__.renderLimitPerGame);
  return Number.isFinite(custom) && custom > 0 ? custom : RENDER_LIMIT_DEFAULT;
}

/**
 * @param {object} deps 全部由 view 注入
 * @param {object} deps.store        名册 store（唯一状态持有者）
 * @param {{render:number}} deps.counters 调试计数器（与 view 共用同一引用，render 里 +1）
 * @param {HTMLElement} deps.listEl  名册列表容器
 * @param {HTMLElement} deps.countEl 顶部计数节点
 * @param {HTMLElement|null} deps.typeFilterEl 类型胶囊行容器（取不到时整体降级为"没有类型筛选"）
 * @param {() => object} deps.snapshotOf 状态快照（render 末尾写进 dataset 供自动化断言）
 */
export function createRosterRender({ store, counters, listEl, countEl, typeFilterEl, snapshotOf }) {
  const state = store.state;

  /** 找到该游戏当前的游戏行（渲染是整棵重建的，所以每次都要重新查，不能缓存节点） */
  function groupRowOf(group) {
    if (!group) return null;
    return [...listEl.querySelectorAll('[data-group-key].tree-game')]
      .find((row) => row.dataset.groupKey === group.key) || null;
  }

  /**
   * 把一个游戏下**所有正在扫描的根**聚合成一个状态（含"已完成根"的计数基线）。
   * 具体口径在 scan-stream.js:aggregateScanSnapshots（纯函数，有单测）；
   *   这里只负责把视图里活跃的 monitor 与基线凑起来。
   * @param {object|null} group
   * @returns {object|null} null = 该游戏当前没有扫描在进行
   */
  function aggregateScan(group) {
    if (!group) return null;
    const snaps = [];
    for (const [rootId, cur] of state.scan) {
      if (group.roots.some((r) => r.id === rootId)) snaps.push(cur.monitor.state);
    }
    return aggregateScanSnapshots(snaps, state.scanBaseline.get(group.key) || null);
  }

  /**
   * 把扫描状态贴到游戏行的状态位上（**就地改文本**，不整棵重渲染）。
   * 为什么不重渲染：一次扫描会发几十帧，每帧重建 400+ 行会把主线程占死 —— 而状态行就是一行文本。
   * @param {object|null} group
   * @param {object} snap createScanMonitor().state
   */
  function applyScanStatusToRow(group, snap) {
    const row = groupRowOf(group);
    if (!row) return;
    let slot = row.querySelector('.tree-count');
    if (!slot) {
      slot = el('span', 'tree-count', '');
      row.append(slot);
    }
    const text = formatScanStatus(snap);
    if (text) {
      slot.textContent = text;
      slot.classList.add('is-scanning');
      slot.title = snap.currentPath ? `当前：${snap.currentPath}` : '';
    } else if (slot.classList.contains('is-scanning')) {
      // 扫描结束（loaded/idle）⇒ 把进度文案收拾掉；正常计数由下一次 render 补上
      slot.textContent = '';
      slot.classList.remove('is-scanning');
      slot.title = '';
    }
    // 〔重试〕：只在 stalled/failed 出现；点击由 listEl 上的委托统一处理（见 bindEvents）
    let retry = row.querySelector('[data-scan-retry]');
    if (scanNeedsRetry(snap)) {
      if (!retry) {
        retry = el('button', 'tree-scan-retry', '重试');
        retry.type = 'button';
        retry.dataset.scanRetry = group.key;
        retry.title = '重新订阅扫描进度（服务端有单飞，不会重复扫描）';
        row.append(retry);
      }
    } else if (retry) {
      retry.remove();
    }
  }

  /** 某游戏的全部根是否都已就绪（有失败也算"可渲染"，错误在游戏节点下提示） */
  function groupStatus(group) {
    const entries = group.roots.map((r) => state.loaded.get(r.id));
    // 唯一判定：根加载状态 + 扫描聚合状态一起交给 resolveGroupPhase（纯函数，有单测）。
    //   视图里不再有第二套推导 —— 那会让「扫描中」与「加载失败」同时出现。
    return resolveGroupPhase({
      scan: aggregateScan(group),
      rootStates: entries.map((e) => (e && e.status ? e.status : 'idle')),
    });
  }

  /**
   * 重新归并某游戏的角色（跨根）：把该游戏所有已就绪根的模型并成一个数组再归并。
   * 为什么在游戏层归并：同一角色可能同时有 Live2D 与 Spine 变体（来自不同根），
   *   按根各自归并会得到两个同名角色节点，造成不一致。
   * @param {object} group
   */
  function rebuildGroupChars(group) {
    // 归并逻辑收在 store（store.rebuildChars 与这里原来是同一份实现）
    store.rebuildChars(group.key);
  }

  /**
   * 渲染类型胶囊行（搜索框下方那一行）。
   *
   * 为什么不复用工具栏按钮：胶囊要自动换行、要带计数、要表达 aria-pressed 的选中态，
   *   与 .mini-btn 的"单行操作按钮"定位不同；只复用它的视觉语言（描边+底色），类名单列。
   * @param {Array<{key: string, count: number}>} counts 类型与计数（已按数量降序）
   * @param {Set<string>} activeTypes 当前**生效**的选中集合（已剔除当前不存在的失效项）
   */
  function renderTypeFilter(counts, activeTypes) {
    if (!typeFilterEl) return;
    // 名册为空（一个类型都没有）⇒ 整行隐藏，不留一条空白（设计稿 §4.4）
    if (!counts.length) {
      typeFilterEl.hidden = true;
      typeFilterEl.replaceChildren();
      return;
    }
    typeFilterEl.hidden = false;
    const nodes = counts.map(({ key, count }) => {
      const chip = el('button', 'roster-type-chip', `${typeLabel(key)} ${count}`);
      chip.type = 'button';
      chip.dataset.typeKey = key;
      chip.setAttribute('aria-pressed', activeTypes.has(key) ? 'true' : 'false');
      chip.title = `只看 ${typeLabel(key)}（当前搜索下 ${count} 个变体）`;
      return chip;
    });
    // 「清除」只在至少选 1 个时出现；不提供「全部」按钮（全部 = 全部取消选中）
    if (activeTypes.size) {
      const clear = el('button', 'roster-type-clear', '清除');
      clear.type = 'button';
      clear.dataset.role = 'clear-type-filter';
      clear.setAttribute('aria-label', '清除类型筛选');
      clear.title = '清除类型筛选（等价于不筛选）';
      nodes.push(clear);
    }
    typeFilterEl.replaceChildren(...nodes);
  }

  /** 渲染整棵树（只渲染可见部分；展开的角色才生成变体行） */
  function render() {
    counters.render += 1;
    listEl.replaceChildren();

    // 首次渲染时插件指纹还没取到 ⇒ 这一帧不显示"不支持"标记（避免用过期结论误导），
    //   指纹就绪后再重画一次。之所以放在 render 里而不是 mount 里：mount 是同步函数。
    // 徽标颜色 / ⚠ / 文案全部来自条目自带的三字段（display/support/loadResult，契约 §一）：
    //   名册不再有"本地失败缓存"这一层，也就不需要指纹初始化与快照拉取。

    const searching = state.keyword.length > 0;
    let totalChars = 0;
    let totalVariants = 0;
    let rendered = 0;
    let loadedGroups = 0;
    // 类型胶囊的计数口径 = **当前关键词下**的可见变体数（不含类型过滤本身的影响，见设计稿 §5.3）。
    //   所以先算 counts（只吃 keyword），再算 activeTypes，最后才把类型过滤作用到列表上。
    const typeCounts = deriveTypeCounts({ groups: state.groups, groupChars: state.groupChars, keyword: state.keyword });
    const activeTypes = usableTypeSelection([...state.typeFilter], typeCounts.map((entry) => entry.key));
    renderTypeFilter(typeCounts, activeTypes);
    // 被类型过滤挡掉的变体数 / 留下来的变体数：只用于"当前筛选下没有条目"的提示文案
    let hiddenByType = 0;
    let keptVariants = 0;

    for (const group of state.groups) {
      const status = groupStatus(group);
      if (status === 'ready') loadedGroups += 1;
      const charsByKeyword = visibleChars(group, state);
      const chars = filterCharsByType(charsByKeyword, activeTypes);
      if (activeTypes.size) {
        const visibleCount = charsByKeyword.reduce((n, c) => n + c.variants.length, 0);
        const keptCount = chars.reduce((n, c) => n + c.variants.length, 0);
        hiddenByType += visibleCount - keptCount;
        keptVariants += keptCount;
      }
      const open = state.expandedGroups.has(group.key) || (searching && chars.length > 0);

      listEl.append(renderGroupRow(group, {
        open: state.expandedGroups.has(group.key),
        status,
        charCount: chars.length,
      }));
      if (!open) continue;

      if (status === 'loading') {
        listEl.append(el('p', 'muted-hint tree-hint', '加载中…'));
        continue;
      }
      if (status === 'error') {
        listEl.append(el('p', 'error-banner', `加载失败：${group.roots.map((r) => r.id).join(', ')}`));
        continue;
      }
      if (status === 'scanning' || status === 'stalled') {
        // 扫描还在推进：不显示"没有模型"这种结论，也不出失败横幅
        if (!chars.length) listEl.append(el('p', 'muted-hint tree-hint', '正在读取清单…'));
        continue;
      }
      if (status === 'idle') {
        // 恢复展开态但没加载（启动不预取）⇒ 明确告诉用户"要点一下"，而不是假装没有模型
        listEl.append(el('p', 'muted-hint tree-hint', '未加载 · 点这一行的「点击加载」'));
        continue;
      }

      totalChars += chars.length;
      const limit = renderLimitPerGame(); // 每次渲染读一次：改配置后刷新即生效
      const selectedId = state.selected ? state.selected.modelId : null;
      for (const c of chars) {
        if (rendered >= limit) break;
        rendered += 1;
        const charOpen = state.expandedChars.has(c.key) || searching;
        listEl.append(renderCharRow(group, c, charOpen));
        // 变体数按数据统计（不依赖是否展开），与「N 游戏 / M 角色 / K 变体」口径一致
        totalVariants += c.variants.length;
        if (!charOpen) continue;
        for (const v of c.variants) {
          // 行内的颜色 / ⚠ / 文案全部由条目自带的三字段渲染（display/support/loadResult），
          //   这里不再注入任何本地失败记录 —— 服务端是唯一权威（契约 §一）。
          listEl.append(renderVariantRow(group, c, v, selectedId));
        }
      }
      if (!chars.length) {
        listEl.append(el('p', 'muted-hint tree-hint', searching ? '无匹配' : '该游戏没有可加载模型'));
      }
    }

    // 类型筛选把所有条目都挡掉时给一句可读提示，不留空白（设计稿 §10.2 第 1 条）。
    //   不自动改用户的选择：解包完成后条目会从 unknown 跳到 spine/live2d，
    //   这里只如实说明"被挡掉了多少个"，让用户自己决定是否取消筛选。
    if (activeTypes.size && keptVariants === 0 && hiddenByType > 0) {
      listEl.prepend(el('p', 'muted-hint tree-hint', `当前筛选下没有条目（${hiddenByType} 个已移到其它类型）`));
    }

    // 计数文案：全量已加载时用统一口径（N 游戏 / M 角色 / K 变体），否则标注已加载多少
    const allLoaded = loadedGroups === state.groups.length;
    const prefix = allLoaded ? `${state.groups.length} 游戏` : `${state.groups.length} 游戏 / 已加载 ${loadedGroups}`;
    countEl.textContent = searching
      ? `搜索「${state.keyword}」：${totalChars} 角色 / ${totalVariants} 变体`
      : `${prefix}：${totalChars} 角色 / ${totalVariants} 变体`;

    // 重建会把行换成新节点：仍在扫描的根要把状态行重新贴回去（否则一次别的渲染就把进度冲掉）
    for (const group of state.groups) {
      const agg = aggregateScan(group);
      if (agg) { applyScanStatusToRow(group, agg); continue; }
      // 没有活跃扫描：这一轮结束（该游戏已 ready）⇒ 丢掉基线，免得下次展开时把旧数字算进去
      if (state.scanBaseline.has(group.key) && groupStatus(group) === 'ready') store.clearScanBaseline(group.key);
    }

    // 供自动化断言：把状态投影成可读快照
    document.documentElement.dataset.rosterReady = '1';
    document.documentElement.dataset.rosterSnapshot = JSON.stringify(snapshotOf());
  }

  return {
    render, renderTypeFilter, groupStatus, aggregateScan, applyScanStatusToRow, rebuildGroupChars, groupRowOf,
  };
}
