// f2-topbar.js —— F2 顶栏四项的实测行为（每个按钮"点了之后什么变了"）
//
// 覆盖：①截图导出 ②影院模式 ③菜单（已删，断言不存在） ④导入按钮（已删，断言不存在）
// 判据一律是 DOM / 数值变化：截图看 blob 字节与文件名字段，影院看 data-cinema + 元素位移。
//
// 用法：node tool/check-console.mjs http://127.0.0.1:8804/ --json --script test/f2-topbar.js

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
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  /** 轮询直到条件成立或超时（高负载下过渡动画会拖长，固定 sleep 容易误判） */
  const waitUntil = async (fn, ms = 1800, step = 60) => {
    const t0 = Date.now();
    // 不能换：until() 的轮询间隔
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
    return fn();
  };
  const results = [];
  const rec = (name, sel, action, expect, actual, ok) => results.push({ name, sel, action, expect, actual, ok: !!ok });
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const rect = (el) => (el ? el.getBoundingClientRect() : null);
  /**
   * 位置比较的容差（px）。
   *
   * 为什么必须有：面板坐标来自 transform/left 的累加与 getBoundingClientRect 的亚像素值，
   *   取整后会出现 ±1 的抖动（实测：复位应回到 1680，实际读到 1681）。严格相等会把
   *   "布局正确、只是舍入"误判成失败；而同一处断言里若一处带容差、一处不带，判据本身就不可信。
   */
  const POS_TOL = 1;
  const w = window.__WEB__;

  // 不能换：轮询间隔（等 #btn-cinema 出现的循环体）
  for (let i = 0; i < 60 && !q('#btn-cinema'); i += 1) await sleep(150);

  // 前置：截图必须有画面可截 —— 先真加载一个模型并确认帧在增长、画布尺寸已按几何固定。
  // （不加载的话画布还是 300×150 默认尺寸、像素全空，导出必然是空图）
  let loadErr = null;
  let loaded = null;
  let loadRootId = null;
  try {
    // 不写死资源根：从 GET /api/roots 找第一个能扫出模型的根
    const roots = ((await (await fetch('/api/roots')).json()).roots) || [];
    for (const r of roots) {
      const list = await (await fetch(`/api/spine/models?root=${encodeURIComponent(r.id)}`)).json();
      const m = (list.models || [])[0];
      if (m) { loaded = m; loadRootId = r.id; break; }
    }
    if (loaded) {
      const doc = await w.stage.buildDocument(loaded);
      await w.stage.load({ document: doc });
    }
  } catch (e) { loadErr = String((e && e.message) || e); }
  await waitFrames(2, { timeoutMs: 15000, label: 'Live2D 装载后推进 2 帧' });   // 原 sleep(1200)：等装载/首帧（信号）
  const canvasEl = q('#stage-canvas');
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

  // 活性判据：引擎渲染循环在跑 + （有采样能力时）两次像素签名不同
  const s1 = typeof w.stage.samplePixels === 'function' ? w.stage.samplePixels() : null;
  await waitFrames(2, { timeoutMs: 12000, label: '装载后推进 2 帧' });   // 原 sleep(600)：等装载后首帧（信号）
  const s2 = typeof w.stage.samplePixels === 'function' ? w.stage.samplePixels() : null;
  const preAlive = loopAlive(w.stage);
  const preMoving = !!(s1 && s2 && s1.signature !== s2.signature);
  const preCanvas = canvasEl ? `${canvasEl.width}×${canvasEl.height}` : 'n/a';

  // ---------------------------------------------------------------- ① 顶栏按钮集合
  {
    const ids = qa('#app-header button').map((b) => b.id);
    const want = ['btn-shot', 'btn-library', 'btn-menu', 'btn-cinema', 'btn-fullscreen'];
    const removed = ['btn-import'];
    const missingWanted = want.filter((id) => !ids.includes(id));
    const stillThere = removed.filter((id) => ids.includes(id));
    const allEnabled = want.every((id) => { const el = q(`#${id}`); return el && !el.disabled && !el.dataset.pending; });
    rec('F2① 顶栏按钮集合', '#app-header button', '枚举',
      '顶栏 5 个按钮全部可点：截图导出/模型库/菜单/影院模式/全屏；仅「导入模型」已删除（本项目不走单模型导入）',
      `实际=${ids.join(',')}；缺=${missingWanted.join(',') || '无'}；应删未删=${stillThere.join(',') || '无'}；全可点=${allEnabled}`,
      missingWanted.length === 0 && stillThere.length === 0 && allEnabled);
  }

  // ---------------------------------------------------------------- ② 截图导出
  {
    const before = w.screenshotExport || null;
    click(q('#btn-shot'));
    // toBlob 是异步回调：等它落地
    // 不能换：轮询间隔（等截图 toBlob 落地的循环体）
    for (let i = 0; i < 30 && (!w.screenshotExport || w.screenshotExport === before); i += 1) await sleep(150);
    const shot = w.screenshotExport || {};
    const nameOk = /^modelstage-.+-\d{8}-\d{6}\.png$/.test(String(shot.filename || ''));
    const sizeOk = typeof shot.bytes === 'number' && shot.bytes > 1000;
    const dimOk = shot.width > 0 && shot.height > 0;
    const pixelsOk = typeof shot.nonEmpty === 'number' && shot.nonEmpty > 0;
    const datasetOk = !!document.documentElement.dataset.screenshot;
    rec('F2② 截图导出', '#btn-shot', 'click',
      '生成 PNG blob（>1KB）、文件名 modelstage-<模型>-<YYYYMMDD-HHMMSS>.png、宽高取自画布、且画面非空',
      `前置 load=${loaded ? `${loadRootId}/${loaded.name}` : 'skipped: 当前配置里没有可加载模型'}${loadErr ? '(' + loadErr.slice(0, 18) + ')' : ''} 画布=${preCanvas} 循环在跑=${preAlive} 画面在变=${preMoving}；`
        + `filename=${shot.filename || '(无)'}；bytes=${shot.bytes}；${shot.width}×${shot.height}；`
        + `非空像素=${shot.nonEmpty}；dataset=${document.documentElement.dataset.screenshot || '(无)'}`,
      !!loaded && preAlive && nameOk && sizeOk && dimOk && pixelsOk && datasetOk);
  }

  // ---------------------------------------------------------------- ③ 影院模式
  {
    const header = q('#app-header');
    const left = q('#left-panel');
    const right = q('#right-panel');
    const r0 = { header: rect(header).bottom, left: rect(left).x, right: rect(right).x };
    click(q('#btn-cinema'));
    // 开：等"顶栏滑出 + 两侧移出"真正到位（高负载下过渡可能远超 200ms 的 --ui-fade）
    await waitUntil(() => rect(header).bottom <= 0 && rect(left).x < 0 && rect(right).x >= window.innerWidth - POS_TOL, 3000);
    const on = document.documentElement.dataset.cinema;
    const r1 = { header: rect(header).bottom, left: rect(left).x, right: rect(right).x };
    const ariaOn = q('#btn-cinema').getAttribute('aria-pressed');
    // 再点一次恢复
    click(q('#btn-cinema'));
    await waitUntil(() => document.documentElement.dataset.cinema === 'off'
      && rect(header).bottom > 0 && rect(left).x >= 0 && rect(right).x < window.innerWidth, 3000);
    const off = document.documentElement.dataset.cinema;
    const r2 = { header: rect(header).bottom, left: rect(left).x, right: rect(right).x };
    const headerGone = r1.header <= 0;
    const leftGone = r1.left < 0;
    const rightGone = r1.right >= window.innerWidth - POS_TOL;
    const backOk = r2.header > 0 && r2.left >= 0 && r2.right < window.innerWidth;
    rec('F2③ 影院模式', '#btn-cinema', 'click ×2',
      '开：data-cinema=on，顶栏滑出（bottom≤0）、左栏移出（x<0）、右栏移出（x≥视口宽）；关：三者复位',
      `开前 header.bottom=${r0.header} left.x=${r0.left} right.x=${r0.right}；`
        + `开后 ${on}/${ariaOn} header.bottom=${r1.header} left.x=${r1.left} right.x=${r1.right}；`
        + `复位后 ${off} header.bottom=${r2.header} left.x=${r2.left} right.x=${r2.right}`,
      on === 'on' && ariaOn === 'true' && headerGone && leftGone && rightGone
        && off === 'off' && backOk);
  }

  // ---------------------------------------------------------------- ⑤ 菜单 / 收起菜单（右栏显隐一对）
  {
    const panel = q('#right-panel');
    // 前置归位：影院用例可能把右栏留在收起态，先把「显示」状态恢复，否则基准就错了
    if (document.documentElement.dataset.right === 'off') {
      q('#btn-menu').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await afterTransition(() => click(q('#btn-menu')), ['sidebarRight']);   // 原 sleep(400)：右栏位移过渡（toggleRightPanel 已接 retrackStage）
    }
    await waitStable(() => Math.round(rect(q('#right-panel')).x), { timeoutMs: 3000, quietMs: 150, label: '右栏位置落定' });   // 原 sleep(400)：取基准前等右栏位置稳定
    const x0 = Math.round(rect(panel).x);
    // on 状态下右栏左边界必须落在「视口宽 − 右栏宽」上：宽度从样式常量 --right-w 派生，
    //   不写死数字（改常量时无需回来改测试）。这条才是"位置到位"的判据——
    //   旧写法只要求 x2 < 视口宽，实测 x2=1698（差 18px）也照样通过，等于没验。
    const rootStyle = getComputedStyle(document.documentElement);
    const remBase = parseFloat(rootStyle.fontSize) || 16;
    const rightRaw = String(rootStyle.getPropertyValue('--right-w') || '').trim();
    const rightW = rightRaw.endsWith('rem') ? parseFloat(rightRaw) * remBase : (parseFloat(rightRaw) || 0);
    const expectOnX = window.innerWidth - rightW;
    click(q('#btn-menu'));
    // 等位移真正到位再读（高负载下过渡会拖长，固定 420ms 曾读到未移动的位置）
    await waitUntil(() => Math.round(rect(panel).x) >= window.innerWidth - POS_TOL, 3000);
    const offAttr = document.documentElement.dataset.right;
    const x1 = Math.round(rect(panel).x);
    click(q('#btn-menu'));
    await waitUntil(() => Math.abs(Math.round(rect(panel).x) - expectOnX) <= POS_TOL, 3000);
    const onAttr = document.documentElement.dataset.right;
    const x2 = Math.round(rect(panel).x);
    // 面板头「收起菜单」也要能收起（旧端同一行为），收起后靠顶栏「菜单」打开
    click(q('[data-ctl="btn-collapse-menu"]'));
    await waitUntil(() => Math.round(rect(panel).x) >= window.innerWidth - POS_TOL, 3000);
    const off2 = document.documentElement.dataset.right;
    const x3 = Math.round(rect(panel).x);
    click(q('#btn-menu'));
    // 等位移动画走完（过渡中取坐标会得到中间值，曾读到 1779）
    let restored = Math.round(rect(panel).x);
    for (let i = 0; i < 20 && Math.abs(restored - expectOnX) > POS_TOL; i += 1) {
      // 不能换：轮询间隔（读回位后逐帧比对）
      await sleep(100);
      restored = Math.round(rect(panel).x);
    }
    rec('F2⑤ 菜单 / 收起菜单', '#btn-menu + [data-ctl="btn-collapse-menu"]', 'click 菜单 → 菜单 → 收起菜单 → 菜单',
      'data-right 在 on/off 间切换；收起时右栏移出视口（x≥视口宽）；'
        + 'on 状态左边界 = 视口宽 − --right-w（±1px 容差）',
      `初始 x=${x0}；菜单后 ${offAttr} x=${x1}；再菜单后 ${onAttr} x=${x2}；`
        + `收起菜单后 ${off2} x=${x3}；最后复位 x=${restored}；`
        + `期望 on 状态 x=${expectOnX}（视口 ${window.innerWidth} − 右栏 ${rightW}）`,
      // 位置判据统一用 POS_TOL 容差：亚像素舍入会让"复位后"落在期望值 ±1（实测 1680 → 1681），
      //   旧写法在这里用严格相等、在上面两处却已带 1px 容差 —— 同一断言两种标准，本身就是 bug。
      //   on 状态的两处（x2 / restored）现在都对齐 expectOnX，而不是只比"没超出视口"。
      offAttr === 'off' && x1 >= window.innerWidth - POS_TOL
        && onAttr === 'on' && Math.abs(x2 - expectOnX) <= POS_TOL
        && off2 === 'off' && x3 >= window.innerWidth - POS_TOL
        && Math.abs(restored - expectOnX) <= POS_TOL);
  }

  // ---------------------------------------------------------------- ⑥ Esc 退出影院
  {
    await afterTransition(() => click(q('#btn-cinema')), ['topbar', 'sidebarLeft', 'sidebarRight']);   // 原 sleep(300)：影院三段过渡（toggleCinema 已接 retrackStages）
    const wasOn = document.documentElement.dataset.cinema === 'on';
    await afterTransition(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), ['topbar', 'sidebarLeft', 'sidebarRight']);   // 原 sleep(350)：Esc 退出影院同样走三段过渡
    const nowOff = document.documentElement.dataset.cinema;
    const headerBack = rect(q('#app-header')).bottom > 0;
    rec('F2⑥ Esc 退出影院', 'window keydown Escape', 'keydown',
      '影院开着时按 Esc 直接退出并复位顶栏',
      `开=${wasOn}；Esc 后 dataset=${nowOff}；顶栏回来=${headerBack}`,
      wasOn && nowOff === 'off' && headerBack);
  }

  // ---------------------------------------------------------------- ⑦ 截图取面 / 尺寸恒定（自证判据）
  // 手法：测试内部同时跑「正常取法」与「退化取法」（后者模拟旧实现），
  //   两者结论必须**相反**——正常一致、退化不一致，才说明判据真的在管这件事。
  //   这样不需要临时改产品代码，也就没有 A/B 残留风险。
  {
    // ⑦⑧ 需要一个 Live2D 面才有意义：自己按 API 结果装载一个（不写死模型名）
    const ensureLive2DFace = async () => {
      try { if (w.state.surface.stageMode() === 'live2d') return true; } catch { /* 继续加载 */ }
      // 不写死根名/模型名：遍历所有根问 /api/live2d/models，取第一个
      //   ⚠️ /api/roots 的 kind 全是 'spine'（含 Live2D 根）⇒ 只能靠这个接口判断有没有 Live2D 模型
      let hit = null;
      try {
        const rs = ((await (await fetch('/api/roots')).json()).roots) || [];
        for (const r of rs.filter((x) => x.enabled !== false)) {
          const data = await (await fetch(`/api/live2d/models?root=${encodeURIComponent(r.id)}`)).json();
          const m = (data && data.models || [])[0];
          if (m) { hit = { model: m, rootId: r.id }; break; }
        }
      } catch { hit = null; }
      if (!hit) return false;
      // 用 API 直装（名册不一定把 Live2D 模型渲染成角色/变体行；本机 '天命之子' 根 chars=0）
      try {
        const doc = await w.surface.buildDocument({
          ...hit.model, kind: 'live2d', rootId: hit.rootId, rootName: hit.model.rootName || '',
          entry: { url: hit.model.modelUrl },
        });
        await w.state.currentRenderer.mount(doc);
        await waitFrames(2, { timeoutMs: 15000, label: 'Live2D 装载后推进 2 帧' });   // 原 sleep(5200)：等 Live2D 装载+首帧（信号）
        return w.state.surface.stageMode() === 'live2d';
      } catch { return false; }
    };
    // ⑦⑧ 只在有 Live2D 面时才有意义：返回值必须接住 —— 原来 `await ensureLive2DFace()` 丢弃返回值，
    //   没面时会继续拿 Spine 残留算 digest ⇒ **假绿**（比假红严重）。下面据此把这两条标成 skip。
    const faceReady = await ensureLive2DFace();

    /** 正常：当前渲染器的 capture()（产品实现） */
    const captureNormal = () => {
      const r = w.state.surface.activeRenderer();
      return r && typeof r.capture === 'function' ? r.capture() : null;
    };
    /** 退化：只读 Spine 画布（旧实现） */
    const captureDegraded = () => {
      const canvas = q('#stage-canvas');
      if (!canvas) return null;
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return null;
      const buf = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 997) sum = (sum + buf[i]) % 1000003;
      return { width: canvas.width, height: canvas.height, digest: sum };
    };
    /** 当前面的画布尺寸：Live2D 面看 PIXI 的 view，Spine 面看舞台画布 */
    const canvasSize = () => {
      try {
        const mode = w.state.surface.stageMode();
        if (mode === 'live2d') {
          const app = w.live2d && w.live2d.getApp ? w.live2d.getApp() : null;
          const v = app && app.view;
          if (v && v.width && v.height) return [v.width, v.height];
        }
      } catch { /* 落到舞台画布 */ }
      const c = q('#stage-canvas');
      return c ? [c.width, c.height] : [0, 0];
    };

    // ⑦-1 取当前面：Live2D 面时，正常取法与退化取法的 digest 必须不同
    const loadedFace = w.state.surface.stageMode();
    if (!loadedFace) {
      rec('F2⑦ 截图取当前面', 'renderer.capture() vs 只读 #stage-canvas', '对比 digest',
        '当前面为 Live2D 时两种取法 digest 必须不同（证明不是截的 Spine 残留）；且正常取法尺寸=画布尺寸',
        'skipped: 当前没有激活的渲染面（未装载模型），该断言无从对比', true);
    }
    const normal = captureNormal();
    const degraded = captureDegraded();
    const canvasNow = canvasSize();
    rec('F2⑦ 截图取当前面', 'renderer.capture() vs 只读 #stage-canvas', '对比 digest',
      '当前面为 Live2D 时两种取法 digest 必须不同（证明不是截的 Spine 残留）；且正常取法尺寸=画布尺寸',
      `面=${loadedFace}；正常 w×h=${normal && normal.width}×${normal && normal.height} digest=${normal && normal.digest}；`
        + `退化 w×h=${degraded && degraded.width}×${degraded && degraded.height} digest=${degraded && degraded.digest}；画布=${canvasNow.join('×')}`,
      !loadedFace || (!!normal && !!degraded && normal.digest !== degraded.digest
        && normal.width === canvasNow[0] && normal.height === canvasNow[1]));
    // 没有 Live2D 面 ⇒ 这条无从验证：标成 skip（环境缺数据），不计失败但必须可见
    if (!loadedFace) { results[results.length - 1].skipped = true; }

    // ⑦-2 尺寸恒定：暂停态正常取法仍等于画布尺寸；退化（extract 包围盒）必须不等于
    const playBtn = q('#transport-play');
    // 不能换：行内短等待：点播放/暂停后立即读 aria，无对应信号
    if (playBtn && playBtn.getAttribute('aria-pressed') === 'true') { playBtn.click(); await sleep(400); }
    const pausedNormal = captureNormal();
    let bbox = null;
    try {
      const app = w.live2d && w.live2d.getApp ? w.live2d.getApp() : null;
      const ext = app && app.renderer && app.renderer.extract;
      if (ext && typeof ext.canvas === 'function' && app.stage) {
        const c = ext.canvas(app.stage);
        if (c) bbox = { width: c.width, height: c.height };
      }
    } catch { bbox = null; }
    const canvasPaused = canvasSize();
    const bboxDiffers = !!bbox && (bbox.width !== canvasPaused[0] || bbox.height !== canvasPaused[1]);
    const pausedOk = !loadedFace
      || (!!pausedNormal && pausedNormal.width === canvasPaused[0] && pausedNormal.height === canvasPaused[1] && bboxDiffers);
    rec('F2⑧ 截图尺寸恒定', '#transport-play 暂停后', '两次取法对比',
      '暂停态正常取法尺寸仍=画布尺寸；直接取包围盒（旧兜底）尺寸≠画布尺寸（说明该断言能抓住回退）',
      `${loadedFace ? '' : 'skipped: 无激活渲染面；'}暂停正常=${pausedNormal && pausedNormal.width}×${pausedNormal && pausedNormal.height}；画布=${canvasPaused.join('×')}；`
        + `包围盒=${bbox ? `${bbox.width}×${bbox.height}` : '(取不到)'}；包围盒≠画布=${bboxDiffers}`,
      pausedOk);
    if (!loadedFace) { results[results.length - 1].skipped = true; }
    // 不能换：点播放/暂停后的短余量（没有任何就绪信号可等，只是在让状态落定）
    if (playBtn && playBtn.getAttribute('aria-pressed') === 'false') { playBtn.click(); await sleep(250); }
  }

  return JSON.stringify({
    total: results.length,
    skipped: results.filter((r) => r.skipped === true).length,
    failed: results.filter((x) => !x.ok).length,
    dataset: {
      cinema: document.documentElement.dataset.cinema,
      screenshot: document.documentElement.dataset.screenshot,
    },
    results,
  }, null, 1);
})()
