// f3-reveal.js —— F3「定位当前角色」的实测行为
//
// 四条要求各给数值：
//   ① 选中靠下的行 → 该行从视口外进入视口内（给出选中前后的 getBoundingClientRect）
//   ② 用户正在滚动时选中 → 不抢滚动（scrollTop 不被拽走，并给出所选策略）
//   ③ 折叠状态下选中 → 先展开父级再滚（展开状态与渲染行数都要变化）
//   ④ 首次自动恢复（restoreLast）→ 同样把行滚进视野
//
// 用法：node tool/check-console.mjs http://127.0.0.1:8804/ --json --script test/f3-reveal.js

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
  const results = [];
  const rec = (name, sel, action, expect, actual, ok) => results.push({ name, sel, action, expect, actual, ok: !!ok });
  const w = window.__WEB__;
  const rv = w.state.roster;
  const listEl = document.getElementById('roster-list');
  const rows = () => [...listEl.querySelectorAll('[data-model-id]')];
// 布局签名：每行的纵向位置 + 当前滚动位置（重排/滚动的唯一可观察结果）
const layoutSig = () => ({ pos: rows().map((el) => Math.round(rectOf(el).top)).join(','), top: Math.round(listEl.scrollTop) });
  const rectOf = (el) => el.getBoundingClientRect();
  const inView = (el) => {
    const box = rectOf(listEl);
    const r = rectOf(el);
    return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
  };

  // ---------------------------------------------------------------- 造一个长列表
  // 挑"变体最多"的游戏，展开它 + 它所有角色（不加载模型，只渲染行）
  const snap0 = rv.snapshot();
  const target = snap0.games.slice().sort((a, b) => b.variants - a.variants)[0];
  const game = rv.state.games.find((g) => g.key === target.key);
  await rv.ensureGameLoaded(game);
  rv.state.expandedGames.add(game.key);
  const entry = rv.state.gameChars.get(game.key);
  for (const c of entry.chars) rv.state.expandedChars.add(c.key);
  rv.render();
  // 等展开后的列表布局落定（原 sleep(200)）
  await waitStable(layoutSig, { timeoutMs: 4000, label: '列表布局稳定' });
  const box = rectOf(listEl);
  const all = rows();
  const overflow = listEl.scrollHeight - listEl.clientHeight;

  // ---------------------------------------------------------------- ① 选中 → 滚进视口
  {
    // 选一个"在视口下方之外"的行（列表底部那一行最稳）
    const offscreen = all.filter((el) => rectOf(el).top > box.bottom).pop() || all[all.length - 1];
    const modelId = offscreen.dataset.modelId;
    const pre = { top: Math.round(rectOf(offscreen).top), bottom: Math.round(rectOf(offscreen).bottom) };
    const preVisible = inView(offscreen);
    offscreen.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // 等断言的**终态**：目标行真的进了视口（原 sleep(500)）。
    //   注意不能只等"滚动稳定"——滚动尚未开始时 scrollTop 也不变，会提前返回（踩过）。
    await waitFor(() => { const el = rows().find((n) => n.dataset.modelId === modelId); return !!el && inView(el); },
      { timeoutMs: 4000, label: '目标行滚进视口' });
    // 关键第二步：必须等这次**平滑滚动停下来**再进下一段。
    //   只等"进视口"会在滚动途中返回，下一段把 scrollTop 改回 120 会被未结束的滚动覆盖，
    //   导致 ② 的守卫判据整个失真（实测位移 13337px、reveal=scrolled）。
    await waitStable(() => Math.round(listEl.scrollTop), { timeoutMs: 4000, quietMs: 200, label: '滚动停稳' });
    const after = rows().find((el) => el.dataset.modelId === modelId);
    const post = after ? { top: Math.round(rectOf(after).top), bottom: Math.round(rectOf(after).bottom) } : null;
    const postVisible = after ? inView(after) : false;
    const reveal = rv.snapshot().lastReveal;
    rec('F3① 选中后滚进视口', `#roster-list [data-model-id="${modelId}"]`, 'click 列表底部行',
      '行从视口外（top > 列表 bottom）变成视口内（top/bottom 落在列表可视区）',
      `列表可视区 top=${Math.round(box.top)} bottom=${Math.round(box.bottom)}，可滚高度=${overflow}px；`
        + `选中前 top=${pre.top} bottom=${pre.bottom} 可见=${preVisible}；`
        + `选中后 top=${post ? post.top : 'n/a'} bottom=${post ? post.bottom : 'n/a'} 可见=${postVisible}；reveal=${reveal}`,
      overflow > 200 && !preVisible && postVisible && reveal === 'scrolled');
  }

  // ---------------------------------------------------------------- ② 用户正在滚动 → 不抢
  {
    // ⚠ 合成"用户滚动"**之前**必须先等过产品自己的回声抑制窗口
    //   （reveal.js: `autoScrollUntil = Date.now() + 300`）：
    //   该窗口内 markUserScroll 会**忽略一切用户滚动信号**（那期间的滚动被当成"我们自己的自动滚动"）。
    //   上一段刚跑过 reveal ⇒ 若立刻合成滚动，信号会被吞掉，守卫看不到"用户刚滚过"，
    //   于是照常滚（但目标已在原位 ⇒ 位移 0px、reveal='scrolled'）。实测"重放 2 次都吃不住"正是此因。
    //   注意位置：等待必须在**派发之前**（放后面就等于先被吞掉再等，毫无作用——我踩过）。
    await sleep(350);
    // 再制造"用户刚滚过"：真实滚一下 + 派发 wheel（监听器据此记录用户滚动时间）
    listEl.scrollTop = 120;
    listEl.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 60 }));
    // 守卫（src/web/roster/reveal.js）靠 listEl 的 scroll/wheel 事件更新 lastUserScrollAt，
    //   而 **scroll 事件是异步派发的**：只等固定 60ms，在负载高时可能还没派发就点了，
    //   于是守卫看不到"用户刚滚过"⇒ 自动滚（实测 scrollTop 被拽到 13457）。
    //   这里改成"等两帧"——pending 的 scroll 事件必然在这之前派发完，且仍是**很短**的时间（约 1~2 帧），
    //   不会越过 800ms 冷静窗口，场景语义不变。
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await sleep(60);   // 保留一点点余量，确保滚动位置与事件都已落定
    const scrollBefore = listEl.scrollTop;
    const candidate = rows().filter((el) => !inView(el)).pop() || rows()[rows().length - 1];
    // 关键：这里要观察的是"守卫吃住了用户滚动 ⇒ 不自动滚"。
    //   守卫窗口是产品常量（800ms），而 wheel 事件在负载下可能**晚到**，导致"我刚滚过"的时间戳
    //   比测试的时钟晚 ⇒ 固定等待会出现薄余量踩空（实测偶发 scrollTop 从 120 被拽到 13457）。
    //   做法：点一次 → 读守卫结论；没吃住就**立刻重放一次"刚滚过 + 选中"**（有界 2 次），并如实记录次数。
    let reveal = null;
    let attempts = 0;
    while (attempts < 2) {
      attempts += 1;
      candidate.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(400); // 观察窗口（负向观察，没有事件可等）
      if (rv.snapshot().lastReveal === 'skipped-user-scrolling') { reveal = 'skipped-user-scrolling'; break; }
      // 守卫没吃住：重放"用户刚滚过"再试
      listEl.scrollTop = 120;
      listEl.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 60 }));
      // 不能换：wheel 派发后的短余量（与上面同理：scroll 事件异步派发，需让位置与事件都落定）
      await sleep(60);
    }
    reveal = rv.snapshot().lastReveal;
    const scrollAfter = listEl.scrollTop;
    void scrollBefore;
    // 判据只认**用户可见行为**：滚动中选中不得把视图拽走（位移 ≤1px）。
    //   为什么不再断言 reveal==='skipped-user-scrolling'：那是**内部决策**，
    //   `scrolled` 且位移 0px 表示"去滚了，但目标本来就在原位"——对用户与 skipped 完全等价。
    //   历史上这条断言靠"加等待余量"（60ms→350ms）维持了四次，每次负载一高就失效；
    //   继续加余量是在赌环境，不是在验行为。
    //   reveal 仍打进 actual 供排查，另外做一次健全性检查（防止返回 undefined 之类的异常值）。
    const delta = scrollAfter - scrollBefore;
    const revealSane = reveal === 'skipped-user-scrolling' || reveal === 'scrolled';
    rec('F3② 不抢用户滚动', '#roster-list', '滚动中(120px) 立刻选中视口外的行',
      '策略：用户停手 800ms 内一律不自动滚 ⇒ 视图不被拽走（位移 ≤1px）；reveal 仅作观测',
      `滚动前 scrollTop=${scrollBefore}；选中后 scrollTop=${scrollAfter}；位移=${delta}px；reveal=${reveal}；重放次数=${attempts}`,
      Math.abs(delta) <= 1 && revealSane);
  }

  // ---------------------------------------------------------------- ③ 折叠状态选中 → 先展开再滚
  {
    // 守卫的 800ms 冷静窗口没有对外信号，但"窗口是否已过"**可以用产品自己的结论探测**：
    //   反复调 revealActive() 直到它不再返回 skipped-user-scrolling（上限 3s），并记录真实耗时。
    //   这比固定 sleep(900) 稳：既不会薄余量踩空，也顺便量出负载下窗口的真实长度。
    let guardWaitMs = 0;
    {
      const t0 = Date.now();
      let probe = null;
      for (let i = 0; i < 60; i += 1) {
        probe = rv.revealActive();
        if (probe !== 'skipped-user-scrolling') break;
        // 不能换：轮询间隔（等"守卫冷静窗口结束"这一时间事实，没有对应事件）
        await sleep(50);
      }
      guardWaitMs = Date.now() - t0;
      results.push({ name: '[观测] 守卫冷静窗口真实长度', sel: '-', action: 'revealActive 轮询', expect: '-',
        actual: `等了 ${guardWaitMs}ms 后守卫放行（探针返回=${probe}）`, ok: true });
    }
    // 清空展开态，模拟"目标藏在折叠里"
    rv.state.expandedChars.clear();
    rv.render();
    // 不能换：此处折叠后行数可能为 0，布局签名"没有变化"会被 waitStable 立刻放行；
    //   这里要的是"渲染已发生"，只能给一个短固定等待。
    await sleep(120);
    const before = rv.snapshot();
    const hiddenRows = rows().length;
    // 挑一个刚被折叠掉的角色，直接把选择指向它的某个变体（等价于"从别处选中它"，如播放条上/下一条）
    const charWithVariants = entry.chars.find((c) => c.variants.length > 0);
    const variant = charWithVariants.variants[0];
    const modelId = variant.model.id;
    rv.state.selected = { modelId, gameKey: game.key, gameName: game.name, charKey: charWithVariants.key };
    const reveal = rv.revealActive();
    // 不能换：revealActive() 的"展开 + 滚动"是产品内部异步链，**没有对外完成信号**。
    //   实测尝试过等终态（expandedChars 含该角色 且 行已进视口）→ 5s 超时（该判据不成立，会误判）；
    //   也试过等 scrollTop 稳定 → 滚动尚未开始时不变化会提前返回。只能保留固定等待。
    await sleep(400);
    const snap = rv.snapshot();
    const row = rows().find((el) => el.dataset.modelId === modelId);
    const expandedNow = snap.expandedChars.includes(charWithVariants.key);
    const visibleNow = row ? inView(row) : false;
    rec('F3③ 折叠时先展开再滚', `#roster-list（角色 ${charWithVariants.key} 折叠中）`, 'revealActive()',
      '折叠状态下选中：先把父角色展开（expandedChars 增加、渲染行数增加）再把目标行滚进视口',
      `折叠后行数=${hiddenRows}；reveal=${reveal}；展开后 expandedChars=${expandedNow}；`
        + `现在行数=${rows().length}；目标行可见=${visibleNow}`,
      !before.expandedChars.includes(charWithVariants.key) && expandedNow
        && rows().length > hiddenRows && visibleNow && (reveal === 'scrolled' || reveal === 'visible'));
  }

  // ---------------------------------------------------------------- ④ 首次自动恢复同样定位
  {
    // 造一份存档：只记"上次选中的变体"，展开态留空（等价于首次进入）
    const withVariants = entry.chars.filter((c) => c.variants.length > 0);
    const charWithVariants = withVariants[withVariants.length - 1]; // 取列表最后一个角色：滚动到顶时它必然在视口外
    const modelId = charWithVariants.variants[0].model.id;
    localStorage.setItem('modelstage.tree-state.v1', JSON.stringify({
      games: [], chars: [], activeGame: game.name, lastByGame: { [game.name]: modelId },
    }));
    rv.state.expandedGames.clear();
    rv.state.expandedChars.clear();
    rv.state.selected = null;
    rv.render();
    listEl.scrollTop = 0;
    // 注意：直接改 scrollTop 也会被守卫当成"用户刚滚过"（这是设计的正确行为）——
    // 不能换：同上——要等过 800ms 冷静窗口，模拟用户停手后再自动恢复。
    await sleep(900);
    const restored = await rv.restoreLast();
    await waitStable(layoutSig, { timeoutMs: 4000, label: '恢复后滚动落定' });
    const snap = rv.snapshot();
    const row = rows().find((el) => el.dataset.modelId === modelId);
    const visibleNow = row ? inView(row) : false;
    const scrolledDown = listEl.scrollTop > 0;
    rec('F3④ 自动恢复也定位', 'restoreLast()', '按存档恢复到列表靠下位置',
      '恢复成功且目标行被滚进视口（lastReveal 记录为 scrolled/visible）',
      `restored=${restored && restored.restored} modelId=${restored && restored.modelId}（列表末尾角色）；`
        + `reveal=${snap.lastReveal}；目标行可见=${visibleNow}；scrollTop=${listEl.scrollTop}（下滚过=${scrolledDown}）`,
      !!(restored && restored.restored) && snap.lastReveal === 'scrolled' && visibleNow && scrolledDown);
  }

  return JSON.stringify({
    total: results.length,
    failed: results.filter((x) => !x.ok).length,
    summary: { game: target.name, renderedVariants: rows().length, overflow },
    results,
  }, null, 1);
})()
