// roster-actions.js —— 名册（左栏三级树）的穷举实操脚本
//
// 用途：把左栏每个可点/可操作的元素都真的操作一遍，逐项断言"期望 vs 实测"。
//   本文件由 tool/check-console.mjs 在**页面上下文**里执行（不是 Node 脚本），
//   所以全程会被 check-console 的四类错误监听覆盖（console.error / 未捕获异常 / 浏览器日志 / 4xx）。
//
// 用法（在项目根执行；地址从命令行给，不写死）：
//   node tool/check-console.mjs http://127.0.0.1:8804/ --script test/roster-actions.js
//   加 --json 可拿到机器可读结果；退出码 0 = 零错误且脚本无异常。
//
// 返回：{ total, failed, results:[{name, sel, action, expect, actual, ok}] }
//
// 形态：整段包在自求值的 async IIFE 里（工具原样求值并 await），这样既能用 await，
//   又能通过 `node --check test/roster-actions.js` 的语法检查（不依赖顶层 await）。
//
// 纪律：
//   · 树每次操作后整棵重渲染 → **每次点击前重新查询元素**，不持有旧引用；
//   · 分段执行，某段抛错只记失败项，不中断后续段（保证"穷举"能跑完）。

(async () => {
// [wait-ready] begin —— 由 test/lib/wait-ready.mjs 生成，勿手改（改源头后跑 apply-wait-ready）
  // 就绪信号等待：等级用 rank 比较（pending 0 < mounted 1 < painted/settled 2 < interactive 3）
  const READY_RANK = { pending: 0, mounted: 1, painted: 2, settled: 2, interactive: 3 };
  const readySnap = (stage) => {
    const w = window.__WEB__;
    if (!w || typeof w.ready !== 'function') return stage ? { stage, state: 'pending' } : { at: 0, rev: 0, stages: {} };
    return w.ready(stage);
  };
  // 等某阶段到达某级别。failed 立即抛（带 reason），绝不等到超时
  const waitStage = async (name, level = 'interactive', opts = {}) => {
    const timeoutMs = opts.timeoutMs || 8000;
    const pollMs = opts.pollMs || 50;
    const sinceAt = opts.sinceAt || 0;      // 传了就等"这一轮新发生的"（边沿等待）
    const want = READY_RANK[level] === undefined ? 3 : READY_RANK[level];
    const t0 = performance.now();
    for (;;) {
      const cur = readySnap(name) || { state: 'pending' };
      if (cur.state === 'failed') {
        throw new Error('等待 ' + name + ' → ' + level + ' 时进入 failed：' + (cur.reason || '(无 reason)') + '；快照=' + JSON.stringify(cur));
      }
      const rank = READY_RANK[cur.state] === undefined ? -1 : READY_RANK[cur.state];
      if (rank >= want && (cur.at || 0) > sinceAt) return cur;
      if (performance.now() - t0 > timeoutMs) {
        throw new Error('等待 ' + name + ' → ' + level + ' 超时(' + timeoutMs + 'ms)；当前 ' + JSON.stringify(cur));
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  // 多个阶段任一到达（如 shell 或 renderer）
  const waitAny = async (names, level = 'interactive', opts = {}) => {
    const timeoutMs = opts.timeoutMs || 8000;
    const pollMs = opts.pollMs || 50;
    const sinceAt = opts.sinceAt || 0;
    const want = READY_RANK[level] === undefined ? 3 : READY_RANK[level];
    const t0 = performance.now();
    for (;;) {
      for (const n of names) {
        const cur = readySnap(n) || { state: 'pending' };
        if (cur.state === 'failed') throw new Error('等待 ' + n + '(任一) → ' + level + ' 时进入 failed：' + (cur.reason || '(无 reason)'));
        const rank = READY_RANK[cur.state] === undefined ? -1 : READY_RANK[cur.state];
        if (rank >= want && (cur.at || 0) > sinceAt) return { stage: n, ...cur };
      }
      if (performance.now() - t0 > timeoutMs) {
        const all = names.map((n) => { const c = readySnap(n) || { state: 'pending' }; return n + '=' + c.state; }).join(', ');
        throw new Error('等待任一 [' + names.join('/') + '] → ' + level + ' 超时(' + timeoutMs + 'ms)；当前 ' + all);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  // 整份快照（断言与超时排错用）
  const snapshotOf = () => readySnap();
  /**
   * 等渲染真的又画了 n 帧（帧计数是产品自己的信号，不是猜时间）。
   *   适用：改 DPR / 换皮 / 开关调试层 / 切分区过滤 这类"改完要等下一帧才看得到效果"的场景。
   *   局限：它只证明"循环在跑"，不证明"绘制内容已经反映改动"；需要内容级判据时仍要配像素/状态断言。
   * @param {number} [n] 要等的新增帧数（默认 2 帧）
   * @param {{timeoutMs?: number, label?: string}} [opts]
   */
  const waitFrames = async (n = 2, opts = {}) => {
    const label = opts.label || ('渲染推进 ' + n + ' 帧');
    const web = window.__WEB__;
    const framesNow = () => {
      try { return (web && web.stage && web.stage.debug && web.stage.debug().frames) || 0; } catch (e) { return 0; }
    };
    const start = framesNow();
    return waitFor(() => framesNow() - start >= n, { timeoutMs: opts.timeoutMs || 3000, label });
  };

  /**
   * 「触发一次过渡 → 等若干阶段一起 settled」的包装器。
   *
   * 为什么要包装而不是让调用方自己记时刻：
   *   「const t = Date.now(); click(); waitStage(..., {sinceAt: t})」 这种写法**容易漏记、容易记错位置**，
   *   漏了 sinceAt 就会拿到旧值立刻返回（等于没等）。把触发动作与 sinceAt 绑在同一个调用里，漏不了。
   *
   * 为什么用 allSettled：某个阶段可能**永远等不到 settled**（例如影院模式下某栏不参与过渡），
   *   不能让一个不配合的阶段把整个等待拖死。默认：全部有结果才返回，失败的**不抛**、只回报；
   *   传 「tolerate:false」 才抛（需要严格失败时用）。
   *
   * @param {() => (void|Promise<void>)} trigger 触发动作（点击/切换）
   * @param {string[]} stages 要等的阶段名（topbar / sidebarLeft / sidebarRight …）
   * @param {{timeoutMs?: number, tolerate?: boolean}} [opts]
   * @returns {Promise<{ok: boolean, failed: Array<{name: string, error: string|null}>}>}
   */
  const afterTransition = async (trigger, stages, opts = {}) => {
    const sinceAt = Date.now();
    await trigger();
    const list = Array.isArray(stages) ? stages : [stages];
    const settled = await Promise.allSettled(
      list.map((name) => waitStage(name, 'settled', { sinceAt, timeoutMs: opts.timeoutMs || 3000 })),
    );
    const failed = settled
      .map((r, i) => ({ name: list[i], error: r.status === 'rejected' ? String((r.reason && r.reason.message) || r.reason) : null }))
      .filter((x) => x.error !== null);
    if (failed.length && opts.tolerate === false) {
      throw new Error('过渡等待失败：' + failed.map((f) => f.name + '(' + f.error + ')').join('; '));
    }
    return { ok: failed.length === 0, failed };
  };

  // 等「界面稳定」：连续 quietMs 内签名不变即返回。
  //   用于"点一下 → 等 DOM 重排/重绘落定"这类**没有专门阶段信号**的场景：
  //   它不是盲等（稳定就立刻返回），也不是猜（签名确实没变才放行）。
  const waitStable = async (getSig, opts = {}) => {
    const timeoutMs = opts.timeoutMs || 3000;
    const quietMs = opts.quietMs || 150;
    const pollMs = opts.pollMs || 60;
    const label = opts.label || '界面稳定';
    const t0 = performance.now();
    let last = null;
    let since = performance.now();
    for (;;) {
      let sig = null;
      try { sig = JSON.stringify(getSig()); } catch { sig = null; }
      const now = performance.now();
      if (sig !== null && sig === last) {
        if (now - since >= quietMs) return true;
      } else {
        last = sig;
        since = now;
      }
      if (now - t0 > timeoutMs) throw new Error('等待' + label + '超时(' + timeoutMs + 'ms)；签名一直没稳定');
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  // 条件轮询（信号覆盖不到的场景：等某个 DOM 事实出现；不是"等固定时长"）
  const waitFor = async (cond, opts = {}) => {
    const timeoutMs = opts.timeoutMs || 4000;
    const pollMs = opts.pollMs || 50;
    const label = opts.label || '条件';
    const t0 = performance.now();
    for (;;) {
      let ok = false;
      // 支持异步条件（await cond()）：早期版本写 !!(cond()) 会把 Promise 恒判真，等于没等
      try { ok = !!(await cond()); } catch { ok = false; }
      if (ok) return true;
      if (performance.now() - t0 > timeoutMs) throw new Error('等待' + label + '超时(' + timeoutMs + 'ms)');
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  // [wait-ready] end
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => document.querySelector(s);
const qa = (s) => [...document.querySelectorAll(s)];
const snap = () => window.__WEB__.rosterSnapshot();
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const results = [];
const rec = (name, sel, action, expect, actual, ok) => results.push({ name, sel, action, expect, actual, ok: !!ok });
/**
 * 记一条"环境缺数据/配置不满足"的跳过：ok=true（不计入 failed）+ skipped=true（单独计数）+ 必须写原因。
 * ⚠️ 只有"配置结构不满足产品契约"或"枚举后确认零候选"才用它；断言失败一律仍走 rec(..., false)。
 */
const skip = (name, sel, expect, reason) => results.push({ name, sel, action: 'skip', expect, actual: `skipped：${reason}`, ok: true, skipped: true });

/**
 * /api/roots 按 name 分组的期望根数（roster 的"一级节点按 name 合并"要拿它做**相对断言**）。
 * ⚠️ 本机会有三个根都叫「碧蓝航线」⇒ 任何"该游戏有几个根"的断言都必须现算，不能写死数字。
 */
let rootsByNameCache = null;
async function rootsByName() {
  if (rootsByNameCache) return rootsByNameCache;
  const map = {};
  try {
    const rs = ((await (await fetch('/api/roots')).json()).roots) || [];
    for (const r of rs.filter((x) => x.enabled !== false)) map[r.name] = (map[r.name] || 0) + 1;
  } catch { /* 拿不到就留空表，断言会据此判失败并给出原因 */ }
  rootsByNameCache = map;
  return map;
}

async function until(fn, ms = 30000) {
  const t0 = Date.now();
  // 不能换：`until()` 的**轮询间隔**（每 100ms 读一次谓词），不是"等固定时间"
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); }
  return false;
}

const domRows = () => ({
  games: qa('[data-game-key].tree-game').length,
  chars: qa('[data-char-key].tree-char').length,
  variants: qa('[data-model-id]').length,
});
const gameOf = (name) => snap().games.find((g) => g.name === name);
// 界面稳定签名：行数 + 各游戏状态 + 展开态（任一变 ⇒ UI 还在重排）
const rosterSig = () => ({ rows: domRows(), games: snap().games.map((g) => g.status).join(','), ex: snap().expandedGames.length, ec: snap().expandedChars.length });
const clickGame = (name) => {
  const el = q(`[data-game-key="${gameOf(name).key}"].tree-game`);
  if (!el) throw new Error(`找不到游戏行 ${name}`);
  click(el);
};
/**
 * 各根能扫出多少模型（仅用于 skip 原因的诊断信息）：
 *   用来区分"根路径失效/未解包（模型数 0）"和"各根角色名不重叠（都有模型但名字不同）"。
 * @param {string[]} rootIds
 */
async function rootModelCounts(rootIds) {
  const out = {};
  for (const id of rootIds) {
    try {
      const j = await (await fetch(`/api/spine/models?root=${encodeURIComponent(id)}`)).json();
      out[id] = (j.models || []).length;
    } catch { out[id] = 'err'; }
  }
  return out;
}

const charKeysOf = (name) => qa('[data-char-key].tree-char')
  .filter((r) => r.dataset.gameKey === gameOf(name).key)
  .map((r) => r.dataset.charKey);
const clickChar = (key) => {
  const el = q(`[data-char-key="${key}"].tree-char`);
  if (!el) throw new Error(`找不到角色行 ${key}`);
  click(el);
};

/** 分段执行：任一段抛错都记录成失败项，不中断后续段 */
async function section(title, fn) {
  try { await fn(); } catch (e) { rec(`【段】${title}`, '-', '执行', '正常完成', `异常: ${e.message}`, false); }
}

// ------------------------------------------------- 0. 初始态：游戏节点按 name 合并
await section('初始态', async () => {
  const s = snap();
  const names = s.games.map((g) => g.name);
  // 不写死游戏数量（用户会增删资源根）：校验"按 name 合并"这条语义本身。
  //   但"至少 2 个游戏""至少一个多根游戏"是**产品要支持的结构**，缺了要明确 skip 并说明配置不满足。
  const nameSet = new Set(s.games.map((g) => g.name));
  const expectByName = await rootsByName();
  const mergedOk = s.games.every((g) => (g.roots || []).length === (expectByName[g.name] || 0));
  rec('一级节点按 name 合并', '.tree-game', '读取',
    '每个游戏名唯一（同名根合并成一个节点）；每个节点的根数 = /api/roots 里同 name 的根数；初始未加载',
    `games=${names.join(' / ')}（去重后 ${nameSet.size} 个）；各节点根数=${JSON.stringify(s.games.map((g) => [g.name, (g.roots || []).length]))}；期望=${JSON.stringify(expectByName)}；status=${s.games.map((g) => g.status).join('/')}`,
    nameSet.size === s.games.length && mergedOk && s.games.every((g) => g.status === 'idle'));

  if (s.games.length < 2) {
    skip('多游戏切换', '.tree-game', '至少 2 个游戏可切换',
      `配置里只有 ${s.games.length} 个游戏；产品要求支持多游戏，此环境不满足`);
  }
  if (!s.games.some((g) => (g.roots || []).length >= 2)) {
    skip('跨根归并', '.tree-game', '至少一个游戏由 ≥2 个根合并',
      '配置里没有多根游戏；产品要求支持同游戏多根，此环境不满足');
  }
});

// ------------------------------- 1. 两个游戏逐个展开/折叠 + 规模数字
// 具体是哪两个游戏是**数据**（现挑），不是写死的名字；但"至少 2 个含角色行的游戏"是产品结构要求。
//   为什么不能直接取前两个游戏名：配置里可能有"没有角色行"的游戏根（例如只放 .moc 的 Live2D 根），
//   拿它去跑"展开后角色行出现"必然失败 —— 那是数据差异，不是功能缺陷。
const GAME_NAMES = await (async () => {
  const picked = [];
  for (const g of snap().games) {
    if (picked.length >= 2) break;
    try {
      clickGame(g.name);
      await until(() => ['ready', 'error'].includes(gameOf(g.name).status));
      const hasChars = charKeysOf(g.name).length > 0;      // 必须在折叠**之前**数
      // 折叠回去，让后续段从"未展开"的可控状态开始
      if (snap().expandedGames.includes(gameOf(g.name).key)) clickGame(g.name);
      await waitStable(rosterSig, { timeoutMs: 3000, label: '挑选游戏后界面稳定' });
      if (hasChars) picked.push(g.name);
    } catch { /* 该游戏展开失败就跳过它 */ }
  }
  return picked;
})();
if (GAME_NAMES.length < 2) {
  skip('多游戏切换', '.tree-game', '至少 2 个游戏含角色行可切换',
    `配置里只有 ${GAME_NAMES.length} 个游戏能展开出角色行；产品要求支持多游戏，此环境不满足`);
}
for (const name of GAME_NAMES) {
  await section(`游戏 ${name}`, async () => {
    const before = domRows();
    clickGame(name);
    await until(() => ['ready', 'error'].includes(gameOf(name).status));
    const g = gameOf(name);
    const after = domRows();
    rec(`游戏 ${name} 展开`, `[data-game-key="${g.key}"].tree-game`, 'click', 'status=ready，角色行出现',
      `roots=${g.roots.join('+')} sources=${g.sources.join('+')} chars=${g.chars} variants=${g.variants} 角色行 ${before.chars}→${after.chars}`,
      g.status === 'ready' && after.chars > before.chars && g.variants > 0);

    clickGame(name);
    await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });   // 原 sleep(150)
    rec(`游戏 ${name} 折叠`, `[data-game-key="${g.key}"].tree-game`, 'click', '该游戏不在 expandedGames',
      `expandedGames=${JSON.stringify(snap().expandedGames)} 角色行=${domRows().chars}`,
      !snap().expandedGames.includes(g.key));
  });
}

// ------------------------ 2. 跨根归并：一个角色节点下含不同资源根的变体
await section('跨根归并', async () => {
  // 不依赖具体角色名：在**多根游戏**里逐个尝试，找第一个"变体来自 ≥2 个根"的角色。
  //   这测的是归并能力本身；找不到说明配置里没有跨根角色（skip，不算失败）。
  const multi = snap().games.find((g) => (g.roots || []).length >= 2) || null;
  if (!multi) {
    skip('角色跨根归并', '[data-model-id]', '同一角色节点下聚合来自不同资源根的变体',
      '配置里没有多根游戏；产品要求支持同游戏多根，此环境不满足');
    return;
  }
  clickGame(multi.name);
  await until(() => gameOf(multi.name).status === 'ready');
  const keys = charKeysOf(multi.name);
  let found = null;
  let scanned = 0;
  for (const key of keys.slice(0, 60)) {           // 上限 60 个，避免极端配置下扫太久
    // 只在未展开时点（无条件点会把已展开的收起来 → 读到 0 个变体，误判"没有跨根角色"）
    const el = q(`[data-char-key="${key}"].tree-char`);
    if (!el) continue;
    scanned += 1;
    if (el.getAttribute('aria-expanded') !== 'true') clickChar(key);
    await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });
    const variants = qa('[data-model-id]');
    const roots = [...new Set(variants.map((v) => v.dataset.rootId))];
    if (variants.length >= 2 && roots.length >= 2) { found = { key, variants, roots }; break; }
    // 收起继续下一个：**只在确实展开时**才点（否则会把下一个刚展开的又收起来）
    const elNow = q(`[data-char-key="${key}"].tree-char`);
    if (elNow && elNow.getAttribute('aria-expanded') === 'true') clickChar(key);
  }
  if (!found) {
    skip('角色跨根归并', `游戏「${multi.name}」的角色行`, '同一角色节点下聚合来自不同资源根的变体',
      `该游戏共 ${keys.length} 个角色（${(multi.roots || []).length} 个根），已扫前 ${scanned} 个，没有变体跨 ≥2 根的角色；`
        + `各根模型数=${JSON.stringify(await rootModelCounts(multi.roots || []))}`);
    return;
  }
  rec('角色跨根归并', `[data-char-key="${found.key}"].tree-char`, 'click',
    '同一角色节点下聚合来自不同资源根的变体',
    `变体 ${found.variants.length} 个，来源根=${found.roots.join('+')}：${found.variants.map((v) => `${v.dataset.rootId}/${v.textContent.trim().slice(0, 18)}`).join(' | ')}`,
    found.variants.length >= 2 && found.roots.length >= 2);
  clickChar(found.key);
  clickGame(multi.name);
  await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });   // 原 sleep(150)
});

// ------------------------- 3. 两个游戏 × 各 3 个角色：展开 → 折叠
for (const name of GAME_NAMES) {
  await section(`游戏 ${name} 角色层`, async () => {
    // 只在"确实未展开"时点击，并等角色行真的渲染出来（status=ready ≠ 行已渲染）
    if (!snap().expandedGames.includes(gameOf(name).key)) clickGame(name);
    await until(() => gameOf(name).status === 'ready');
    await until(() => charKeysOf(name).length > 0, 15000);
    const allKeys = charKeysOf(name);
    const keys = allKeys.slice(0, 3);
    // 相对断言：渲染出的角色行数必须等于快照里该游戏的角色数（不写死具体数量）
    const expectChars = (gameOf(name) || {}).chars;
    rec(`游戏 ${name} 角色行数`, `[data-char-key].tree-char[game=${name}]`, '读取',
      '角色行数 === 快照该游戏角色数，且至少 1 个可操作',
      `渲染 ${allKeys.length} 个（快照 chars=${expectChars}），取前 ${keys.length} 个操作`,
      allKeys.length >= 1 && (expectChars === undefined || allKeys.length === expectChars));
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      const vBefore = domRows().variants;
      clickChar(key);
      await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });   // 原 sleep(150)
      const vAfter = domRows().variants;
      const exp = q(`[data-char-key="${key}"].tree-char`).getAttribute('aria-expanded');
      rec(`角色 ${name}#${i + 1} 展开`, `[data-char-key="${key}"].tree-char`, 'click', '变体行增加、aria-expanded=true',
        `变体行 ${vBefore}→${vAfter} aria-expanded=${exp}`, vAfter > vBefore && exp === 'true');

      clickChar(key);
      await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });   // 原 sleep(150)
      const exp2 = q(`[data-char-key="${key}"].tree-char`).getAttribute('aria-expanded');
      rec(`角色 ${name}#${i + 1} 折叠`, `[data-char-key="${key}"].tree-char`, 'click', '变体行回落到展开前、aria-expanded=false',
        `变体行 ${vAfter}→${domRows().variants} aria-expanded=${exp2}`, domRows().variants === vBefore && exp2 === 'false');
    }
    clickGame(name);
    await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });   // 原 sleep(150)
  });
}

// -------------------------------------------------------- 4. 搜索（N → M）
await section('搜索', async () => {
  const input = q('#roster-search');
  const setKw = async (kw) => {
    input.value = kw;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });   // 原 sleep(500)
  };
  const firstGame = GAME_NAMES[0];
  if (!firstGame) {
    skip('搜索框输入（中文名）', '#roster-search', '结果收窄且 >0（搜索时自动展开到变体）',
      '配置里没有能展开出角色行的游戏，无法构造搜索场景');
    return;
  }
  clickGame(firstGame);
  await until(() => gameOf(firstGame).status === 'ready');
  const baseChars = qa('[data-char-key].tree-char').length;
  // 关键词取自**当前渲染出来的第一个角色标题**（角色名是数据，不写死具体角色）：
  //   取前 2 个字做子串搜索，既保证能命中，又能验证"结果被收窄"。
  const firstTitle = ((qa('.tree-char-title')[0] || {}).textContent || '').trim();
  const kw = firstTitle.slice(0, Math.min(2, firstTitle.length));
  if (!kw) {
    skip('搜索框输入（中文名）', '#roster-search', '结果收窄且 >0（搜索时自动展开到变体）',
      '名册里没有可读的角色标题，无法构造搜索关键词');
  } else {
  await setKw(kw);
  await until(() => snap().games.every((g) => ['ready', 'error'].includes(g.status)), 40000);
  await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });   // 原 sleep(400)
  const hitChars = qa('[data-char-key].tree-char').length;
  const hitVariants = qa('[data-model-id]').length;
  const titles = qa('.tree-char-title').slice(0, 3).map((n) => n.textContent);
  rec('搜索框输入（中文名）', '#roster-search', `input "${kw}"（取自第一个角色名）`, '结果收窄且 >0（搜索时自动展开到变体）',
    `角色 ${baseChars}→${hitChars}，变体 ${hitVariants}，命中=${JSON.stringify(titles)}`,
    hitChars > 0 && hitChars < baseChars && hitVariants > 0);
  }

  await setKw('zzz不存在的角色zzz');
  await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });   // 原 sleep(300)
  rec('搜索框无匹配', '#roster-search', 'input "zzz不存在的角色zzz"', '角色 0 且显示「无匹配」',
    `角色=${qa('[data-char-key].tree-char').length} 无匹配文案=${q('#roster-list').textContent.includes('无匹配')}`,
    qa('[data-char-key].tree-char').length === 0 && q('#roster-list').textContent.includes('无匹配'));

  await setKw('');
  await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });   // 原 sleep(300)
  rec('搜索框清空', '#roster-search', 'input ""', '恢复搜索前条数',
    `角色=${qa('[data-char-key].tree-char').length}（搜索前 ${baseChars}）`,
    qa('[data-char-key].tree-char').length === baseChars);
});

// ------------------------------------------------------------- 5. 选中态
await section('选中态', async () => {
  const firstChar = q('[data-char-key].tree-char');
  if (!firstChar) {
    skip('变体选中 A/B', '[data-model-id]', '同一角色下至少 2 个变体，可切换选中',
      '名册里没有角色行可展开（当前配置没有可用模型）');
    return;
  }
  if (firstChar.getAttribute('aria-expanded') !== 'true') {
    clickChar(firstChar.dataset.charKey);
    // 等"变体行真的渲染出来"（DOM 事实），不再盲等 200ms
    try { await waitFor(() => qa('[data-model-id]').length > 0, { timeoutMs: 3000, label: '角色展开后出现变体行' }); } catch { /* 由下面 count 断言报红 */ }
  }
  const count = qa('[data-model-id]').length;
  if (count < 2) {
    skip('变体选中 A/B', '[data-model-id]', '同一角色下至少 2 个变体，可切换选中',
      `该角色只有 ${count} 个变体（配置里没有多根/多版本同名角色）`);
    return;
  }

  const idA = qa('[data-model-id]')[0].dataset.modelId;
  click(q(`[data-model-id="${idA}"]`));
  await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });   // 原 sleep(200)
  const selA = q(`[data-model-id="${idA}"]`).classList.contains('is-selected');
  const stateA = snap().selected && snap().selected.modelId;
  rec('变体选中 A', `[data-model-id="${idA}"]`, 'click', 'A 高亮且 state.selected=A',
    `A.is-selected=${selA} selected=${stateA}`, selA && stateA === idA);

  const idB = qa('[data-model-id]').map((n) => n.dataset.modelId).find((x) => x !== idA);
  click(q(`[data-model-id="${idB}"]`));
  await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });   // 原 sleep(200)
  const selRows = qa('[data-model-id].is-selected');
  rec('变体改选 B', `[data-model-id="${idB}"]`, 'click', 'A 取消高亮、只剩 B 高亮',
    `高亮行=${selRows.length}（${selRows.map((n) => n.dataset.modelId).join(',')}）A 仍高亮=${q(`[data-model-id="${idA}"]`).classList.contains('is-selected')}`,
    selRows.length === 1 && selRows[0].dataset.modelId === idB);
});

// --------------------------------------------------------- 6. 收起按钮
await section('收起按钮', async () => {
  if (!GAME_NAMES.length) {
    skip('收起按钮', '#btn-collapse', '两级展开数 N→0，变体行归零，面板保留',
      '配置里没有能展开出角色行的游戏，无从验证收起行为');
    return;
  }
  click(q('#btn-collapse'));
  await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });   // 原 sleep(150)
  for (const name of GAME_NAMES) {
    if (!snap().expandedGames.includes(gameOf(name).key)) clickGame(name);
    await until(() => gameOf(name).status === 'ready');
  }
  for (const name of GAME_NAMES) {
    const k = charKeysOf(name)[0];
    if (k && !snap().expandedChars.includes(k)) { clickChar(k); await waitStable(rosterSig, { timeoutMs: 3000, label: '展开角色稳定' }); }
  }
  const before = { games: snap().expandedGames.length, chars: snap().expandedChars.length };
  const beforeVariants = domRows().variants;
  click(q('#btn-collapse'));
  await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });   // 原 sleep(300)
  const after = { games: snap().expandedGames.length, chars: snap().expandedChars.length };
  rec('收起按钮', '#btn-collapse', 'click', '两级展开数 N→0，变体行归零，面板保留',
    `展开游戏 ${before.games}→${after.games}，展开角色 ${before.chars}→${after.chars}，变体行 ${beforeVariants}→${domRows().variants}，面板隐藏=${q('#left-panel').classList.contains('is-hidden')}`,
    // 只要求"确实展开了东西 → 点收起后全归零 + 面板保留"；
    //   多少个游戏/角色属于环境结构，已由「多游戏切换」那条单独判定，这里不重复设门槛
    before.games >= 1 && before.chars >= 1 && after.games === 0 && after.chars === 0
      && domRows().variants === 0 && !q('#left-panel').classList.contains('is-hidden'));
});

// -------------------------------------- 7. 顶栏「模型库」= 面板显隐
//
// 判据取**几何量**（computed transform 的 tx、rect.x），不取 classList：
//   类名加上只代表"意图已发出"，位移由 CSS transition 驱动，真的滑出屏幕才算隐藏。
// 为什么不能"点击 → 固定 sleep → 读一次"：
//   transition 的推进依赖样式解析时机，点击后若什么都不读、睡满再读，
//   动画起点会被推迟到那次读取的时刻，于是读到 tx=0（实测：睡 350ms 读到 0，
//   而同一次点击后每 40ms 读一次，170ms 就已 -303、350ms 到 -304）。
//   这类"时序读法"造成的假失败必须靠**轮询到位**消除，而不是靠加大 sleep。
await section('顶栏模型库按钮', async () => {
  const panel = () => q('#left-panel');
  /** 读 computed transform 的平移分量（tx）；none 视作 0，解析不出给 NaN */
  const txOf = () => {
    const tf = getComputedStyle(panel()).transform;
    if (!tf || tf === 'none') return 0;
    const m = /matrix\(([^)]+)\)/.exec(tf);
    return m ? Math.round(Number(m[1].split(',')[4])) : NaN;
  };
  const widthOf = () => Math.round(panel().getBoundingClientRect().width);
  const ariaOf = () => q('#btn-library').getAttribute('aria-expanded');
  /**
   * 轮询到 tx 满足条件为止；无论成败都把实际读到的值带回去（失败时能看出差在哪）。
   * 另记 `lastChangeMs`：从点击到"tx 最后一次发生变化"的毫秒数（0 = 整个窗口里一次都没变）。
   *   用途：红时区分两种情况——略超预算 = 迟到（可考虑放宽窗口）；一次没变 = 真没恢复（查产品）。
   *   分辨率注意：两次采样之间还要等一次 `waitStable`，所以该值只有百毫秒级精度，不是精确时刻。
   */
  /**
   * 等"位移 + aria 同时到位"。
   * 为什么不能只等位移：实测 trace 里出现过 tx 已经回到 0、而 aria-expanded 仍是 false
   *   （class 先切 → 过渡跑完 → aria/dataset 最后才写；三者在不同时机落地）。
   *   旧实现只轮询 tx，于是"位移到位"就返回，随后读 aria 判红 —— 是**等错了对象**，不是代码坏。
   * 预算是 6s：本机 transform 过渡约 300ms，但负载高时 aria 落地可到 3s+。
   */
  const settle = async (pred, ariaWant, timeout = 6000) => {
    const t0 = Date.now();
    let tx = txOf();
    let prev = tx;
    let lastChangeMs = 0;
    let okBoth = false;
    while (Date.now() - t0 < timeout) {
      tx = txOf();
      if (tx !== prev) { prev = tx; lastChangeMs = Date.now() - t0; }
      if (pred(tx) && ariaOf() === ariaWant) { okBoth = true; break; }
      // 轮询间隔：等"位移+aria 这一对"稳定下来再重新判定（用既有 waitStable，不另开定时器）
      try {
        await waitStable(() => [txOf(), ariaOf()], { timeoutMs: 400, quietMs: 40, pollMs: 40, label: '位移/aria 稳定' });
      } catch { /* 一直在变就继续下一轮判定 */ }
    }
    return { tx, x: Math.round(panel().getBoundingClientRect().x), aria: ariaOf(),
      ms: Date.now() - t0, ok: okBoth, lastChangeMs, budgetMs: timeout };
  };

  const w = widthOf();
  const entryTx = txOf();
  // 临时取证（查完即删）：每次点击前后的"可见性真相"与 DOM 事实
  const probe = (tag) => ({
    tag,
    vis: window.__WEB__.state ? window.__WEB__.state.leftPanelVisible : 'n/a',
    hidden: panel().classList.contains('is-hidden'),
    tx: txOf(),
    x: Math.round(panel().getBoundingClientRect().x),
    aria: ariaOf(),
    leftState: document.documentElement.dataset.leftState || '',
    cinema: document.documentElement.dataset.cinema || '',
  });
  const trace = [probe('before1')];
  click(q('#btn-library'));
  const hide = await settle((tx) => tx <= -(w - 2), 'false');
  trace.push(probe('after1'));
  const clsHidden = panel().classList.contains('is-hidden');
  trace.push(probe('before2'));
  click(q('#btn-library'));
  trace.push(probe('after2click'));
  const show = await settle((tx) => tx === 0, 'true');
  trace.push(probe('after2settle'));

  rec('顶栏模型库按钮', '#btn-library', 'click ×2', `左栏位移 0→-${w}→0，aria-expanded 翻转`,
    `entryTx=${entryTx}；隐藏后 tx=${hide.tx} x=${hide.x} aria=${hide.aria}（${hide.ms}ms${hide.ok ? ' 到位' : ' 未到位'}`
      + `，lastChange=${hide.lastChangeMs}ms/${hide.budgetMs}ms）；`
      + `恢复后 tx=${show.tx} x=${show.x} aria=${show.aria}（${show.ms}ms${show.ok ? ' 到位' : ' 未到位'}`
      + `，lastChange=${show.lastChangeMs}ms/${show.budgetMs}ms）；is-hidden=${clsHidden}；`
      + `TRACE=${JSON.stringify(trace)}`,
    entryTx === 0 && hide.ok && hide.aria === 'false'
      && show.ok && show.aria === 'true' && w > 0);
});

// ---------------------------------- 8. 未接线控件必须是 disabled
await section('未接线控件', async () => {
  // 顶栏（F2 之后）：只剩四个真按钮且全部可点；导入（本项目按资源根目录扫描加载，没有"导入单个模型"路径）
  // 与菜单（没有可放的内容）已删除，删除理由记在 src/web/README.md
  const topbarIds = ['btn-shot', 'btn-library', 'btn-menu', 'btn-cinema', 'btn-fullscreen'];
  const topbarStates = topbarIds.map((id) => {
    const el = q(`#${id}`);
    return `${id}:${el ? (el.disabled ? 'disabled' : '可点') : '缺失'}`;
  });
  const topbarOk = topbarIds.every((id) => { const el = q(`#${id}`); return !!el && !el.disabled; });
  const removedOk = ['btn-import'].every((id) => !q(`#${id}`)); // 只有「导入模型」已删（不走单模型导入）
  // 选择目录按钮在 F4 已接线：它是"新增资源根"表单的提交按钮，应为可点且不带 pending
  const addRoot = q('#btn-add-root');
  // 「选择目录」= 触发器：可点；左栏资源根区域里**不再有任何输入框**（路径靠弹层里的目录浏览器选）
  const rootAreaInputs = qa('#root-manager input').length;
  const addRootWired = !!addRoot && !addRoot.disabled && addRoot.dataset.pending !== 'true'
    && rootAreaInputs === 0;
  rec('顶栏按钮接线态', '#app-header', '枚举',
    '截图/模型库/菜单/影院/全屏 五个按钮全部可点；仅「导入模型」已删除；左栏「选择目录」已接线',
    `顶栏=${topbarStates.join(' ')}；仅删除导入=${removedOk}；选择目录已接线=${addRootWired}（资源根区输入框=${rootAreaInputs}）`,
    topbarOk && removedOk && addRootWired);
    // 接线态口径：未接线控件必须 disabled 且带 data-pending；已接线的允许可点
  {
    // 只看 schema 驱动的控件（带 data-ctl）；静态顶栏图标不在本断言管辖内
    const all = [...document.querySelectorAll('#app-header button, #right-panel button, #app-footer button')]
      .filter((e) => !e.classList.contains('acc-trigger') && e.closest('[data-ctl]'));
    const unwired = all.filter((e) => e.disabled);
    const wired = all.filter((e) => !e.disabled);
    // 不可点有两种合法原因：未接线（data-pending）与"该动作/能力不可用但如实注明"（data-disabled-reason）
    const unwiredOk = unwired.every((e) => e.dataset.pending === 'true' || !!e.dataset.disabledReason);
    const wiredOk = wired.every((e) => !e.dataset.pending);
    rec('未接线控件标注（接线态）', '顶栏/右栏/底栏', '枚举',
      '未接线项 disabled + data-pending；已接线项可点且无 pending',
      `未接线 ${unwired.length} 个全 pending=${unwiredOk}；已接线 ${wired.length} 个无 pending=${wiredOk}`,
      // F1~F4 接线完成后未接线数应为 0；若不为 0，必须每个都带 pending/reason
      unwiredOk && wiredOk);
  }
  // 底栏另有动态口径：已接线的（重置视图）可点，其余仍 disabled + pending
  {
    const foot = [...document.querySelectorAll('#app-footer button, #app-footer select')];
    const enabled = foot.filter((e) => !e.disabled).map((e) => e.id);
    const disabledAllPending = foot.filter((e) => e.disabled).every((e) => e.dataset.pending === 'true');
    rec('底栏接线态标注', '#app-footer', '枚举', '已接线可点、其余 disabled 且带 data-pending',
      `可点=${enabled.join(',') || '(无)'}；未接线 ${foot.length - enabled.length} 个全 pending=${disabledAllPending}`,
      enabled.length === foot.length && disabledAllPending); // 8 个控件全部接线后不再有未接线项
  }});

// ------------------------------------------------------------ 9. 状态落盘
await section('持久化键', async () => {
  const raw = localStorage.getItem('modelstage.tree-state.v1');
  const parsed = raw ? JSON.parse(raw) : null;
  rec('localStorage 键名', 'localStorage["modelstage.tree-state.v1"]', '读取',
    '沿用旧前端键名，结构含 games/chars/activeGame/lastByGame（activeGame 存游戏名）',
    parsed ? `keys=${Object.keys(parsed).join(',')} activeGame=${parsed.activeGame} lastByGame=${JSON.stringify(parsed.lastByGame)}` : '未写入',
    !!parsed && ['games', 'chars', 'activeGame', 'lastByGame'].every((k) => k in parsed));
});

// ------------------------------------------------- 10. 全屏按钮（原生 API）
await section('全屏按钮', async () => {
  click(q('#btn-fullscreen'));
  await waitStable(() => document.fullscreenElement, { timeoutMs: 3000, quietMs: 200, label: '全屏态落定' });   // 原 sleep(400)
  const on = !!document.fullscreenElement;
  click(q('#btn-fullscreen'));
  await waitStable(() => document.fullscreenElement, { timeoutMs: 3000, quietMs: 200, label: '全屏态落定' });   // 原 sleep(400)
  const off = !document.fullscreenElement;
  // 无头浏览器可能拒绝全屏（非用户手势）；判定标准是"有响应且不报错"，错误由 check-console 兜
  rec('全屏按钮', '#btn-fullscreen', 'click ×2', '进入全屏→退出（无头下被拒绝也不报错）',
    `进入后 fullscreenElement=${on}，退出后为空=${off}`, off);
});

// ------------------------------------ 11. 键盘可达（tabindex + Enter）
await section('键盘激活', async () => {
  click(q('#btn-collapse'));
  await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });   // 原 sleep(150)
  const kbGame = GAME_NAMES[0] || snap().games[0].name;
  const row = q(`[data-game-key="${gameOf(kbGame).key}"].tree-game`);
  row.focus();
  const focused = document.activeElement === row;
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => gameOf(kbGame).status === 'ready');
  await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });   // 原 sleep(200)
  const expanded = snap().expandedGames.includes(gameOf(kbGame).key);
  rec('键盘 Enter 展开游戏', '[data-game-key].tree-game', 'focus + Enter', '可聚焦且 Enter 与点击等价',
    `focus=${focused} expandedGames=${JSON.stringify(snap().expandedGames)} 角色行=${domRows().chars}`,
    focused && expanded && domRows().chars > 0);
  click(q('#btn-collapse'));
  await waitStable(rosterSig, { timeoutMs: 3000, label: '界面稳定' });   // 原 sleep(150)
});

// 防再犯：失败项单列 failures（期望 vs 实测并排），这样"failed:1"一眼就能看出差在哪个数值，
// 不用从 32 条 results 里翻；每条用例的 actual 也必须写实测值而不是布尔结论。
const failures = results.filter((r) => !r.ok).map((r) => ({ name: r.name, sel: r.sel, expect: r.expect, actual: r.actual }));
return JSON.stringify({ total: results.length, failed: failures.length, skipped: results.filter((r) => r.skipped === true).length, failures, results }, null, 1);
})();
