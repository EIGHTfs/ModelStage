// test/debug-drag.js —— 调试日志浮层「可拖动 + 记住位置 + 节流」的门禁用例
//
// 用法（未注册进 tool/test-all.mjs 的 SUITES，所以不会被自动门禁拖慢）：
//   node tool/check-console.mjs http://127.0.0.1:8804/ --wait 5000 --json --script test/debug-drag.js
// 需要纳入门禁时，把 { name: 'debug-drag', script: 'test/debug-drag.js' } 加进 SUITES。
//
// 为什么要有这套：拖动的两个关键性质（节流比、位置记忆）平时只能靠手工数，
//   而"节流"一旦被改回逐帧写 style，页面会明显发滞——这条必须能用数字抓住。
//
// 覆盖范围（边界断言按**形态**分开，别混）：
//   ①~⑦ 展开态：节流、落盘、滚动不动、左上/右下极限、持久化、stats
//   ⑧ 收起态极限：拖胶囊到四角外，断言**胶囊整块**在视口内（最小形态，缩无可缩）
//   ⑨ 四象限展开方向：胶囊停在各象限 → 展开 → 方向符合象限，且面板整块在视口内

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

/** 等面板就绪并收集本次要用的元素与视口尺寸（调试日志关掉时返回 null） */
async function bootstrap() {
  // 不能换：轮询间隔（等调试面板挂载），没有挂载回调可等
  for (let i = 0; i < 60 && !document.querySelector('.dbg-panel'); i += 1) await sleep(150);
  const root = document.querySelector('.dbg-panel');
  if (!root) return null;
  return {
    root,
    head: root.querySelector('.dbg-head'),
    list: root.querySelector('.dbg-list'),
    vw: window.innerWidth,
    vh: window.innerHeight,
  };
}

/** 用例收集器 */
function makeRec(results) {
  return (name, sel, action, expect, actual, ok) => results.push({ name, sel, action, expect, actual, ok: !!ok });
}

/** 造一次拖动：moves 次 pointermove 分成 batches 批，每批后等一帧（模拟真实跨帧分布） */
async function dragOn({ root, head, list, vw, vh }, { moves, batches, dx, dy }) {
    root.dataset.dragMoves = '0';
    root.dataset.dragWrites = '0';
    const r = root.getBoundingClientRect();
    const sx = r.left + Math.min(60, r.width / 2);
    const sy = r.top + Math.min(12, r.height / 2);
    const fire = (type, x, y) => head.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 21, pointerType: 'mouse', isPrimary: true,
      clientX: x, clientY: y, button: 0, buttons: 1,
    }));
    const scrollBefore = Math.round(list.scrollTop);
    fire('pointerdown', sx, sy);
    const per = Math.max(1, Math.round(moves / batches));
    for (let b = 0; b < batches; b += 1) {
      for (let i = 0; i < per; i += 1) {
        const k = b * per + i;
        fire('pointermove', sx + (dx * k) / moves, sy + (dy * k) / moves);
      }
      await frame();
    }
    const midInline = { transform: root.style.transform, left: root.style.left, top: root.style.top };
    fire('pointerup', sx + dx, sy + dy);
    await frame();
    return {
      moves: Number(root.dataset.dragMoves),
      writes: Number(root.dataset.dragWrites),
      midInline,
      after: { transform: root.style.transform, left: root.style.left, top: root.style.top },
      scrollBefore,
      scrollAfter: Math.round(list.scrollTop),
    };
  }

/** 造一组操作助手（拖胶囊 / 收起 / 展开）—— 收起态唯一的手柄是胶囊 */
function makeHelpers(env) {
  const { root } = env;
  /** 拖一次胶囊：按目标 left/top 分步移动，越过 4px 阈值 */
  async function dragPillTo(targetLeft, targetTop, pointerId = 77) {
    const pill = root.querySelector('.dbg-pill');
    const pr = pill.getBoundingClientRect();
    const sx = pr.left + pr.width / 2;
    const sy = pr.top + pr.height / 2;
    const fire2 = (type, x, y) => pill.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', isPrimary: true,
      clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    }));
    fire2('pointerdown', sx, sy);
    for (let i = 1; i <= 8; i += 1) {
      fire2('pointermove', sx + ((targetLeft + pr.width / 2) - sx) * i / 8, sy + ((targetTop + pr.height / 2) - sy) * i / 8);
      // 不能换：模拟拖动的步进间隔（各 pointermove 之间需要时间差，事件序列本身就是判据）
      await sleep(10);
    }
    fire2('pointerup', targetLeft + pr.width / 2, targetTop + pr.height / 2);
    // 不能换：观察窗口——拖动结果只有"落定后"才能读，没有完成事件
    await sleep(120);
    return pill;
  }

  /** 收起面板（已在收起态则跳过） */
  async function ensureCollapsed() {
    if (root.dataset.collapsed !== 'true') {
      root.querySelector('.dbg-collapse').click();
      // 不能换：等面板折叠过渡（面板自身动画，无事件可等）
      await sleep(430);
    }
  }

  /** 展开面板（点胶囊） */
  async function expand() {
    root.querySelector('.dbg-pill').click();
    // 不能换：等面板展开过渡（同上）
    await sleep(470);
  }
  return { dragPillTo, ensureCollapsed, expand };
}

/** ①②③ 展开态：节流、落盘（锚点）、拖动不改滚动位置 */
async function caseThrottleAndPersist(env, rec, helpers, drag) {
  const { root, vw, vh, list } = env;
  // ① 节流：200 次 move / 10 批 ⇒ 写入次数应远小于 move 次数
  const d1 = await drag(env, { moves: 200, batches: 10, dx: -160, dy: -80 });
  const ratio = d1.writes ? d1.moves / d1.writes : 0;
  rec('① 拖动节流（rAF 合并）', '.dbg-head', 'pointerdown + 200×pointermove + pointerup',
    'moves 记满 200；样式写入远小于 moves（比值 ≥10）；拖动中只写 transform、left/top 不变',
    `moves=${d1.moves} writes=${d1.writes} 比值=${ratio.toFixed(1)}；`
      + `拖动中 transform=${d1.midInline.transform || '(空)'} left=${d1.midInline.left || '(空)'} top=${d1.midInline.top || '(空)'}`,
    d1.moves === 200 && d1.writes > 0 && ratio >= 10
      && /translate3d/.test(d1.midInline.transform || ''));

  // ② 松手提交：transform 清空、left/top 落真值、并写 localStorage
  // S3 起位置存进统一偏好键（debug.panelPos），旧键会被迁移删除 ⇒ 一律经工厂读
  const uiMod = await import('/app/ui-state.js');
  let saved = null;
  try { saved = uiMod.getPanelPos(); } catch { saved = null; }
  const rect1 = root.getBoundingClientRect();
  // 落盘的是**锚点**（收起态胶囊盒子的位置），不是面板左上角：
  //   面板位置由锚点 + 展开方向算出，所以这里跟 stats().anchor 比，而不是跟视觉坐标比。
  const dbgHandle = window.__WEB__ && window.__WEB__.debugPanelDrag;
  const anchorNow = dbgHandle && typeof dbgHandle.stats === 'function' ? dbgHandle.stats().anchor : null;
  rec('② 松手落盘（锚点）', '.dbg-panel', 'pointerup',
    'transform 清空、left/top 有内联值、localStorage 的锚点与当前形态换算出的锚点一致',
    `transform=${d1.after.transform || '(空)'} left=${d1.after.left} top=${d1.after.top}；`
      + `saved=${saved ? `${saved.left}/${saved.top}` : '(无)'} 换算锚点=${anchorNow ? `${Math.round(anchorNow.left)}/${Math.round(anchorNow.top)}` : '(无)'} 视觉=${Math.round(rect1.left)}/${Math.round(rect1.top)}`,
    !d1.after.transform && /px$/.test(d1.after.left || '') && !!saved && !!anchorNow
      && Math.abs(saved.left - Math.round(anchorNow.left)) <= 1 && Math.abs(saved.top - Math.round(anchorNow.top)) <= 1);

  // ③ 拖动不改日志滚动位置
  rec('③ 拖动不影响日志滚动', '.dbg-list', '拖动全程', 'scrollTop 前后相同',
    `前=${d1.scrollBefore} 后=${d1.scrollAfter}`, d1.scrollBefore === d1.scrollAfter);

  return d1;
}

/** ④⑤⑥⑦ 展开态：左上/右下极限、持久化、stats 句柄 */
async function caseBoundsAndStats(env, rec, helpers, drag) {
  const { root, vw, vh } = env;
  // ④ 边界：左上极限不越 0
  await drag(env, { moves: 40, batches: 4, dx: -4000, dy: -4000 });
  const rTL = root.getBoundingClientRect();
  rec('④ 左上边界 clamp', '.dbg-panel', '拖向左上极限', 'left/top 均 ≥ 0（标题栏完整可见）',
    `left=${Math.round(rTL.left)} top=${Math.round(rTL.top)}`, rTL.left >= 0 && rTL.top >= 0);

  // ⑤ 边界：右下极限不出视口
  await drag(env, { moves: 40, batches: 4, dx: 4000, dy: 4000 });
  const rBR = root.getBoundingClientRect();
  rec('⑤ 右下边界 clamp', '.dbg-panel', '拖向右下极限', '面板右/下不超出视口',
    `right=${Math.round(rBR.right)} bottom=${Math.round(rBR.bottom)} 视口=${vw}×${vh}`,
    rBR.right <= vw + 1 && rBR.bottom <= vh + 1);

  // ⑥ 位置可被读取（供刷新后比对）：写盘值与 dataset 一致
  let saved2 = null;
  try { saved2 = uiMod.getPanelPos(); } catch { saved2 = null; }
  rec('⑥ 位置已持久化', 'ui-state.debug.panelPos', '拖后读取', '记录存在且 left/top 为有限数',
    `saved=${saved2 ? `${saved2.left}/${saved2.top}` : '(无)'}`,
    !!saved2 && Number.isFinite(saved2.left) && Number.isFinite(saved2.top));

  // ⑦ 句柄可用（自动化读计数的推荐入口）
  const handle = window.__WEB__ && window.__WEB__.debugPanelDrag;
  const stats = handle && typeof handle.stats === 'function' ? handle.stats() : null;
  rec('⑦ stats() 可读', '__WEB__.debugPanelDrag', 'stats()', '返回 {moves, writes} 计数',
    stats ? `moves=${stats.moves} writes=${stats.writes} left=${stats.left} top=${stats.top}` : 'skipped: 句柄未挂（__WEB__ 建得比面板晚）',
    !handle || (stats && Number.isFinite(stats.moves) && Number.isFinite(stats.writes)));

}

/** ⑧ 收起态极限：胶囊是最小形态，必须整块留在视口内（不按展开尺寸提前预留） */
async function caseCollapsedBounds(env, rec, helpers) {
  const { root, vw, vh } = env;
  const { dragPillTo, ensureCollapsed } = helpers;
  await ensureCollapsed();
  await dragPillTo(-5000, -5000);
  const pillTL = root.getBoundingClientRect();
  const pillOkTL = pillTL.left >= 0 && pillTL.top >= 0;
  await dragPillTo(5000, 5000);
  const pillBR = root.getBoundingClientRect();
  const pillOkBR = pillBR.right <= vw + 1 && pillBR.bottom <= vh + 1;
  rec('⑧ 收起态夹取（按胶囊尺寸）', '.dbg-pill', '拖到左上/右下极限',
    '胶囊整块在视口内（left/top ≥ 0；right ≤ vw、bottom ≤ vh）',
    `左上=${Math.round(pillTL.left)}/${Math.round(pillTL.top)}；右下 right=${Math.round(pillBR.right)} bottom=${Math.round(pillBR.bottom)} 视口=${vw}×${vh}`,
    pillOkTL && pillOkBR);

}

/** ⑨ 四象限：胶囊停在哪，面板就朝视口中心长，且展开后整块在视口内 */
async function caseQuadrants(env, rec, helpers) {
  const { root, vw, vh } = env;
  const { dragPillTo, ensureCollapsed, expand } = helpers;
  const quadrants = [
    { name: '左上', left: 20, top: 20, want: 'down-right' },
    { name: '右上', left: vw - 200, top: 20, want: 'down-left' },
    { name: '左下', left: 20, top: vh - 60, want: 'up-right' },
    { name: '右下', left: vw - 200, top: vh - 60, want: 'up-left' },
  ];
  for (const q of quadrants) {
    await ensureCollapsed();
    await dragPillTo(q.left, q.top, 80 + q.left);
    await expand();
    const r = root.getBoundingClientRect();
    const inside = r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1;
    rec(`⑨ 展开方向 · ${q.name}`, '.dbg-panel', `胶囊拖到${q.name}后展开`,
      `方向=${q.want}，面板整块在视口内`,
      `方向=${root.dataset.openDir} 面板=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`,
      root.dataset.openDir === q.want && inside);
  }

}

(async () => {
  const results = [];
  const rec = makeRec(results);
  const env = await bootstrap();
  if (!env) {
    rec('拖动用例', '.dbg-panel', '前置', '调试面板存在（调试日志开关打开）', 'skipped: 面板未挂载', true);
    return JSON.stringify({ total: results.length, failed: 0, results }, null, 1);
  }
  const helpers = makeHelpers(env);
  await caseThrottleAndPersist(env, rec, helpers, dragOn);
  await caseBoundsAndStats(env, rec, helpers, dragOn);
  await caseCollapsedBounds(env, rec, helpers);
  await caseQuadrants(env, rec, helpers);
  return JSON.stringify({
    total: results.length,
    failed: results.filter((r) => !r.ok).length,
    dataset: { dragLeft: env.root.dataset.dragLeft, dragTop: env.root.dataset.dragTop, openDir: env.root.dataset.openDir },
    results,
  }, null, 1);
})();
