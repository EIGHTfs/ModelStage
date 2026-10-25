// f1-controls.js —— F1 四个外壳控件的实测行为（每个都要"点了之后有可观测变化"）
//
// 覆盖：ctl-show-status / ctl-debug-log / ctl-hang-guard / ctl-settings-io
// 判据一律是 DOM 状态或数值变化，不接受"没报错"。
//
// 用法：node tool/check-console.mjs http://127.0.0.1:<port>/ --json --script test/f1-controls.js

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

// 面板稳定签名：控件数量 + 处于按下态控件。
//   特意不含 #stage-status 文本：它会持续刷新（时间戳/计数），放进去会让签名永不稳定（踩过）。
const f1Sig = () => ({
  n: qa('[data-ctl]').length,
  on: qa('[data-ctl][aria-pressed="true"]').map((e) => e.dataset.ctl).join(','),
});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const results = [];
  const rec = (name, sel, action, expect, actual, ok) => results.push({ name, sel, action, expect, actual, ok: !!ok });

// ------------------------------------------------- 5. F1 四个外壳控件的实测行为
{
  const clickId = (id) => {
    const el = document.getElementById(id);
    if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return !!el;
  };
  const hint = q('#stage-hint');
  const log = window.__WEB__ && window.__WEB__.stageLog;

  // ① 显示状态信息：关掉后状态行不再显示（日志照旧有），打开能恢复文字
  clickId('ctl-show-status');
  await waitStable(f1Sig, { timeoutMs: 3000, label: '控件操作后界面稳定' });   // 原 sleep(120)：等状态显示切换落到 UI
  const offFlag = document.documentElement.dataset.showStatus;
  const hintHidden = hint ? hint.hidden : null;
  const logLenBefore = (log || []).length;
  window.__WEB__.stage && window.__WEB__.stage.stats && document.dispatchEvent(new Event('noop'));
  const stageStatusProbe = (() => {
    // 借用一次真实状态写入：底栏「背景」已是自绘下拉，**选中一项**会写一条 stageStatus
    //   （只点触发按钮只会展开列表，不再写状态——这是 6b 改成选择区后的正确行为）
    const pk = document.querySelector('.transport-picker[data-ctl="transport-bg"]');
    const btn = pk && pk.querySelector('.transport-picker-btn');
    if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // 必须选**与当前不同**的项：同值不会触发回调（选中即回填、不重复应用，这是 6b 的判据）
    const item = pk && [...pk.querySelectorAll('.transport-picker-item')]
      .find((i) => i.getAttribute('aria-selected') !== 'true');
    if (item) item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return !!item;
  })();
  // 不能换：IIFE 内的短等待，属于"点一下→立即读状态"的既有写法，无对应信号
  await sleep(150);
  const hiddenAfterStatus = hint ? hint.hidden : null;
  const logGrew = (log || []).length > logLenBefore;
  clickId('ctl-show-status');
  await waitStable(f1Sig, { timeoutMs: 3000, label: '控件操作后界面稳定' });   // 原 sleep(120)：等状态显示切换落到 UI
  const onFlag = document.documentElement.dataset.showStatus;
  const hintVisibleBack = hint ? !hint.hidden : false;
  rec('F1① 显示状态信息', '#stage-hint', 'click 关 → 触发状态 → click 开',
    '关：隐藏且不再显示；日志仍记录；开：恢复显示',
    `开/关=${onFlag}/${offFlag}；关后 hidden=${hintHidden}；触发后仍 hidden=${hiddenAfterStatus}；日志增长=${logGrew}；开回 visible=${hintVisibleBack}`,
    offFlag === 'off' && hintHidden === true && hiddenAfterStatus === true && logGrew && onFlag === 'on' && hintVisibleBack);

  // ② 调试日志：控制浮层显隐，且采集仍在
  clickId('ctl-debug-log');
  await waitStable(f1Sig, { timeoutMs: 3000, label: '控件操作后界面稳定' });   // 原 sleep(150)：等调试日志开关落到 UI
  const host = q('#debug-panel-host');
  const offLogFlag = document.documentElement.dataset.debugLog;
  const hostHidden = host ? host.hidden : null;
  clickId('ctl-debug-log');
  await waitStable(f1Sig, { timeoutMs: 3000, label: '控件操作后界面稳定' });   // 原 sleep(150)：等调试日志开关落到 UI
  const onLogFlag = document.documentElement.dataset.debugLog;
  const hostShown = host ? !host.hidden : false;
  const entries = window.__WEB__ && window.__WEB__.debugLog && window.__WEB__.debugLog.entries
    ? window.__WEB__.debugLog.entries().length : -1;
  rec('F1② 调试日志', '#debug-panel-host', 'click 关 → click 开',
    '关：浮层 hidden=true；开：hidden=false；面板已采到日志条目',
    `开/关=${onLogFlag}/${offLogFlag}；关后 hidden=${hostHidden}；开回 hidden=${!hostShown}；采到条目=${entries}`,
    offLogFlag === 'off' && hostHidden === true && onLogFlag === 'on' && hostShown && entries > 0);

  // ③ 防卡死保护
  // 前置（这是本次修正的关键）：看门狗按设计只在"有模型在渲染"时判停滞，
  //   所以必须先真加载一个模型并确认帧在增长，否则注入冻结帧也只会被跳过（recoveries 恒 0）。
  const stageRef2 = window.__WEB__.stage;
/**
 * 渲染循环是否真的在跑（**唯一可信的活性判据**）。
 * 为什么不用 stats().frames：那个计数由 startPlayback 里另一条 rAF 自增，
 *   引擎渲染循环停了它照样涨 —— 曾因此把一个"切档后画面冻结"的 bug 判成通过。
 * @returns {boolean}
 */
function loopAlive(s) {
  try {
    const d = s && typeof s.debug === 'function' ? s.debug() : null;
    const e = d && d.engine;
    return !!(e && e.isPlaying === true && e.animationId !== null);
  } catch {
    return false;
  }
}

  // 不写死资源根：从 GET /api/roots 里找第一个"能扫描出模型"的根（跨环境/换配置都能跑）
  let probeRootId = null;
  let probeModel = null;
  try {
    const roots = ((await (await fetch('/api/roots')).json()).roots) || [];
    for (const r of roots) {
      const j = await (await fetch(`/api/spine/models?root=${encodeURIComponent(r.id)}`)).json();
      const m = (j.models || [])[0];
      if (m) { probeRootId = r.id; probeModel = m; break; }
    }
  } catch { /* 探测失败按"没有模型"处理 */ }
  let loadErr = null;
  try {
    if (probeModel) {
      // 显式两步：先组装 Document（失败会得到 state='error'），再交给舞台装载
      const probeDoc = await stageRef2.buildDocument(probeModel);
      await stageRef2.load({ document: probeDoc });
    }
  } catch (e) { loadErr = String((e && e.message) || e); }
  // 不能换：本用例的装载是**测试直调**（不走 app 的模型装载管线），
        //   而 model 阶段的 ready 信号只由那条管线驱动 ⇒ waitStage('model',*) 永远停在 pending（实测 12s 超时）。
        //   这里退回固定等待。
        await sleep(900);
  const loadedStats = stageRef2.stats();
  const hasModel = !!loadedStats.model;
  // 环境里没有任何可加载模型 ⇒ 这一条无从验证，**skip 而不是 fail**（配置问题不是代码问题）
  if (!probeModel) {
    results.push({
      name: '引擎装载/活性/hang-guard', sel: '#stage-canvas', action: 'skip',
      expect: '装载后循环在跑、冻结帧能自愈',
      actual: 'skipped：当前配置里没有任何可加载模型（/api/roots 下所有根都扫不出模型）', ok: true, skipped: true,
    });
  }
  // 活性判据：引擎渲染循环在跑（frames 计数不可信，见 loopAlive 注释）
  // 不能换：活性判据的时间窗口（观察 700ms 内渲染循环是否在推进），窗口本身是判据
  await sleep(700);
  const alive = loopAlive(stageRef2);
  // 计数清零：加载期间的 tick 不算（没模型时不参与判定，但让断言从干净基线开始）
  const hg = window.__WEB__.hangGuard || {};
  hg.ticks = 0; hg.stalls = 0; hg.recoveries = 0; hg.lastFrames = null;
  const ticks0 = hg.ticks;
  // 不能换：取 ticks0 基准前的观察窗口（要真实的推进样本，不能换成信号）
  await sleep(1200);
  const ticks1 = hg.ticks;

  // 正向：冻结帧到"判定所需的时长"→ 必须检出并自愈
  //   时间窗按配置现算：第 1 次 tick 用来对齐基准（不算落后），之后要点满 stallLimit 次，
  //   所以至少要 (stallLimit + 1) 个 tick；再多给 1 个 tick 余量，避免调度抖动卡在边界。
  const cfg = window.__WEB__.hangGuardConfig;
  const tickMs = (cfg && cfg.tickMs) || 1000;
  const stallLimit = (cfg && cfg.stallLimit) || 3;
  const freezeMs = (stallLimit + 2) * tickMs;
  const origStats = stageRef2.stats;
  // 冻结基准取"当前真实帧数"：若随便写个更大的数，第一次 tick 会被判成"帧在增长"而白吃一次对齐
  const baseFrames = origStats().frames;
  const frozen = { ...origStats(), phase: 'ready', model: probeModel || {}, frames: baseFrames };
  stageRef2.stats = () => frozen;
  const ticksBeforeFreeze = hg.ticks;
  // 保留固定等待：这里就是要"观察一段时间内没有变化"（冻结后 ticks 不该涨），
  //   换成任何"等某事件"的写法都会把判据本身改掉。
  // 不能换：冻结/恢复判据的时间窗口，换成"等事件"会把判据本身改掉
  await sleep(freezeMs);
  const ticksAfterFreeze = hg.ticks;
  stageRef2.stats = origStats;
  const recov = hg.recoveries;
  const stallLogged = (log || []).some((x) => /渲染停滞/.test(x.line));
  // 把"时间窗够不够"做成显式断言：窗口不够时这条先红，一眼能看出不是实现问题
  const freezeTickedEnough = ticksAfterFreeze - ticksBeforeFreeze >= stallLimit + 1;

  // 反向验证：把判定阈值临时调大（99 次）→ 同样的冻结必须不再被判停滞
  const savedLimit = cfg ? cfg.stallLimit : null;
  if (cfg) cfg.stallLimit = 99;
  hg.stalls = 0; hg.lastFrames = null;
  const recovBefore = hg.recoveries;
  stageRef2.stats = () => frozen;
  // 不能换：冻结帧判据的时间窗口（"冻结这么久"本身就是判据，不是等某个状态）
  await sleep(freezeMs);
  stageRef2.stats = origStats;
  const recovAfterHighLimit = hg.recoveries;
  if (cfg && savedLimit !== null) cfg.stallLimit = savedLimit;
  const reverseOk = recovAfterHighLimit === recovBefore;

  // 关闭：定时器必须停
  clickId('ctl-hang-guard');
  await waitStable(f1Sig, { timeoutMs: 3000, label: '控件操作后界面稳定' });   // 原 sleep(120)：等卡死守卫开关落到 UI
  const hgOff = document.documentElement.dataset.hangGuard;
  const ticksAtOff = hg.ticks;
  // 不能换：取 ticksAtOff 的观察窗口，同上
  await sleep(1300);
  const ticksStill = hg.ticks;
  clickId('ctl-hang-guard');
  await waitStable(f1Sig, { timeoutMs: 3000, label: '控件操作后界面稳定' });   // 原 sleep(120)：等卡死守卫开关落到 UI
  // 没有可加载模型时上面已经记了 skip，这里不再重复断言（否则会多出一条 fail）
  if (probeModel) {
  rec('F1③ 防卡死保护', 'ctl-hang-guard + __WEB__.hangGuard', `先加载模型 → 冻结帧 ${freezeMs}ms → 阈值调大再冻结 → 关 1.3s`,
    '有模型且帧在增长时：冻结帧被判停滞（recoveries≥1 + warn）；阈值调大后同样冻结不再判；关掉后 ticks 停止',
    `加载=${probeModel ? `${probeRootId}/${probeModel.name}` : 'skipped: 当前配置里没有任何可加载模型'}${loadErr ? '(' + loadErr.slice(0, 20) + ')' : ''} model=${hasModel} 循环在跑=${alive}；`
      + `开时 ticks ${ticks0}→${ticks1}；正向 冻结 ${freezeMs}ms 期间 ticks ${ticksBeforeFreeze}→${ticksAfterFreeze}`
      + `（需≥${stallLimit + 1} 次，够=${freezeTickedEnough}）recoveries=${recov} 有warn=${stallLogged}；`
      + `反向 阈值调大后 recoveries ${recovBefore}→${recovAfterHighLimit}（不再判=${reverseOk}）；`
      + `关后 ticks ${ticksAtOff}→${ticksStill}（dataset=${hgOff}）`,
    !!probeModel && hasModel && alive && ticks1 > ticks0 && freezeTickedEnough && recov >= 1 && stallLogged
      && reverseOk && hgOff === 'off' && ticksStill === ticksAtOff);
  }

  // ④ 设置导入导出：导出（前端偏好 + 服务端配置原文）→ 导入两条分支 → 恢复默认
  const btns = [...document.querySelectorAll('[data-ctl="ctl-settings-io"] button')];
  const importBtn = btns.find((b) => b.dataset.action === '导入设置');
  const exportBtn = btns.find((b) => b.dataset.action === '导出设置');
  const restoreBtn = btns.find((b) => b.dataset.action === '恢复默认');
  // 导入已接线：应为可点、且不再声称后端 501
  const importEnabled = !!importBtn && !importBtn.disabled;
  const importTitle = importBtn ? importBtn.title : '';
  const importStaleNote = /501/.test(importTitle) || /尚未实现/.test(importTitle);

  // 导出：应带 project.files（服务端配置原文）+ panel/view（前端偏好）
  if (exportBtn) exportBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  // 导出内部要 fetch 服务端配置（异步）：固定 700ms 在负载高时会读到 null，
  //   轮询到出现为止（上限 4s），避免把"还没回来"误判成"没带 project.files"。
  // 不能换：轮询间隔（等 prefs 回来的循环体）
  for (let i = 0; i < 40 && !(window.__WEB__ && window.__WEB__.settingsExport); i += 1) await sleep(100);
  const exported = window.__WEB__ && window.__WEB__.settingsExport;
  let parsed = null;
  try { parsed = JSON.parse((exported || {}).text || 'null'); } catch { parsed = null; }
  const exportOk = !!(parsed && parsed.schema && parsed.panel);
  const hasProject = !!(parsed && parsed.project && parsed.project.files);

  // 分支 A：旧的"仅偏好"文件（顶层直接是偏好）→ 只写本地存储、不发 POST
  const io = window.__WEB__ && window.__WEB__.settingsIo;
  let prefsRes = null;
  try {
    prefsRes = await io.importText(JSON.stringify({ uiTheme: 'dark-cyan', background: { mode: 'transparent' } }));
  } catch (e) { prefsRes = { ok: false, error: String((e && e.message) || e) }; }
  await waitStable(f1Sig, { timeoutMs: 3000, label: 'prefs 请求后界面稳定' });   // 原 sleep(300)：等请求结果落到 UI
  const bgAfterImport = (document.getElementById('stage') || {}).dataset ? document.getElementById('stage').dataset.bg : null;

  // 分支 B：含 project.files 但内容非法 → 后端 400，错误文案要显示出来（不写盘）
  let badRes = null;
  try {
    badRes = await io.importText(JSON.stringify({ project: { files: { 'not-allowed.txt': 'x' } } }));
  } catch (e) { badRes = { ok: false, error: String((e && e.message) || e) }; }
  // 等"状态行出现文案"这个 DOM 事实（原来盲等 300ms）；超时也继续，由下面的断言如实报红
  try {
    await waitFor(() => {
      const t = (document.getElementById('root-msg') || {}).textContent || '';
      return t.trim().length > 0;
    }, { timeoutMs: 2000, label: '导入失败文案出现' });
  } catch { /* 没出现就按空文案判定 */ }
  const badMsg = (document.getElementById('root-msg') || {}).textContent || '';
  // 文案口径：统一「导入失败：<环节>（后端原因）」——断言只认前缀与环节，不锁具体句
  const importErrShown = !badRes.ok && /导入失败/.test(String(badRes.error || '')) && /项目配置/.test(String(badRes.error || ''));

  // 恢复默认：清存储 + 复位主题
  try { localStorage.setItem('modelstage-settings-v2', JSON.stringify({ uiTheme: '__probe__' })); } catch { /* 跳过 */ }
  if (restoreBtn) restoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await waitStable(f1Sig, { timeoutMs: 3000, label: '控件操作后界面稳定' });   // 原 sleep(500)：等恢复默认后的重排
  let storedAfter = null;
  try { storedAfter = localStorage.getItem('modelstage-settings-v2'); } catch { storedAfter = 'n/a'; }
  const restoredFlag = document.documentElement.dataset.settingsRestored || '';
  const themeBack = document.documentElement.dataset.uiTheme;
  rec('F1④ 设置导入导出', '[data-ctl="ctl-settings-io"]', '导出 → 导入(偏好/非法) → 恢复默认',
    '导出：JSON 含 project.files + panel/view；导入：可点且无 501 旧说明，偏好分支生效、非法分支报 400；恢复默认清存储并回默认主题',
    `导入 enabled=${importEnabled} title=${JSON.stringify(importTitle.slice(0, 30))} 旧501说明=${importStaleNote}；`
      + `导出 schema=${(parsed || {}).schema || 'null'} 面板项=${exported ? exported.panelCount : -1} project.files=${
        exported && exported.projectFiles !== undefined ? exported.projectFiles : (hasProject ? Object.keys(parsed.project.files).length : 0)}；`
      + `导入偏好分支 ok=${prefsRes && prefsRes.ok} mode=${prefsRes && prefsRes.mode} 背景=${bgAfterImport}；`
      + `导入非法分支 ok=${badRes && badRes.ok} 错误已提示=${importErrShown}；`
      + `恢复后 localStorage=${storedAfter === null ? 'null' : String(storedAfter).slice(0, 16)} 标记=${!!restoredFlag} 主题=${themeBack}`,
    importEnabled && !importStaleNote && exportOk && hasProject
      && !!(prefsRes && prefsRes.ok && prefsRes.mode === 'prefs') && importErrShown
      && !String(storedAfter || '').includes('__probe__') && !!restoredFlag && themeBack === 'dark-cyan');
}


  return JSON.stringify({
    total: results.length,
    skipped: results.filter((r) => r.skipped === true).length,
    failed: results.filter((r) => !r.ok).length,
    dataset: {
      showStatus: document.documentElement.dataset.showStatus,
      debugLog: document.documentElement.dataset.debugLog,
      hangGuard: document.documentElement.dataset.hangGuard,
      settingsExport: document.documentElement.dataset.settingsExport,
      settingsRestored: document.documentElement.dataset.settingsRestored,
    },
    results,
  }, null, 1);
})()
