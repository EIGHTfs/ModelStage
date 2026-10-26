// f4-roots.js —— F4 资源根管理 UI 的实测行为
//
// 覆盖：add / rename / toggle / remove 四个写入动作 + 三条错误路径（400/409/404）+ merged 语义
//
// 跨平台规范（重要）：
//   · 脚本里**不出现任何硬编码绝对路径**：探针目录由调用方通过 URL query 传入
//         node tool/check-console.mjs "http://127.0.0.1:8804/?f4probe=<服务端已存在的目录>" \
//              --json --script test/f4-roots.js
//   · 没传参数 / 传入目录不存在 ⇒ 记一条 **skipped**（文案以 "skipped:" 开头）并跳过写入类断言，
//     不 fail、也不崩——这样 Windows/macOS 上没有类 Unix 临时目录也能跑，只是跳过写入部分。
//   · 重复目录（409）用的路径来自 `GET /api/roots` 的第一个根，不写死。
//
// 安全约束：探针根 id 一律取后端响应的 changed.root.id；只操作 f4_probe* 开头的 id；
//   try/finally 必定清理；拿不到 id 就跳过删除（保护用户真实配置）。

// [wait-ready] 生成块移到 IIFE 之外（140 行，留在编排函数里会让 IIFE 永远超长）；内容一字未改。
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

(async () => {   // ← 编排函数：只准备上下文 + 依次 await 各组用例 + 汇总
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const results = [];
  const rec = (name, sel, action, expect, actual, ok) => results.push({ name, sel, action, expect, actual, ok: !!ok });
  const skip = (name, why) => rec(name, '#root-manager', '前置缺失，未执行',
    '需要调用方传入 ?f4probe=<服务端已存在的目录>', `skipped: ${why}`, true);
  // window.__WEB__ 由前端启动时挂到 window；页面还没就绪时它是 undefined。
  //   若在这里直接快照，w 就永久是 undefined ⇒ mgr() 一求值就抛 TypeError，
  //   而下面「等 rootManager 就绪」的循环条件正是 !mgr() ⇒ 第一次求值就炸、循环等于不存在。
  //   所以先等它出现再快照；|| {} 兜底让 mgr() 不抛（真没就绪时由后续 waitFor 如实报红）。
  for (let i = 0; i < 80 && !window.__WEB__; i += 1) await sleep(150);
  const w = window.__WEB__ || {};
  const mgr = () => w.rootManager;
  const rows = () => [...document.querySelectorAll('#root-list [data-root-id]')];
// 界面稳定签名：管理区可见性 + 条目 id 序列 + 目录浏览器可见性 + 最近一条操作日志。
//   提交类操作（增删改）都是「await API 成功 → UI 重排」，用它等重排落定，替代固定 sleeps。
const f4Sig = () => ({
  hid: q('#root-manager-body') ? q('#root-manager-body').hidden : null,
  // ⚠ 必须是 id:name —— 只写 id 时「改名」改不到签名（rename 不改 id），
  //   waitStable 会在提交还没落地就放行（规则 10：只能等"已发生的变化结束"）。
  rows: rows().map((r) => {
    const nameEl = r.querySelector('[data-role="name"]');
    return `${r.dataset.rootId}:${nameEl ? String(nameEl.textContent).trim() : ''}`;
  }).join(','),
  dlg: q('#dir-picker') ? !q('#dir-picker').hidden : false,
  log: String((last() && (last().status !== undefined ? `${last().status}/${(last().data && last().data.action) || ''}` : (last().ts || last().action))) || ''),
});
  const msg = () => (q('#root-msg') || {}).textContent || '';
  const last = () => (mgr() && mgr().last) || {};
  const rootsAll = async () => (await (await fetch('/api/roots')).json()).roots;
  const sum = (o) => {
    const d = (o && o.data) || {};
    return `action=${o && o.action} status=${o && o.status} ok=${d.ok} changed=${JSON.stringify(d.changed || null)}`;
  };
  // 探针根判定：后端按目录名派生 id（可能叫 f4probe 或 f4_probe_a），所以按前缀宽松匹配；
  //   另外再用 path === 传入目录 做一次"确属本次创建"的核对，双保险
  const isProbe = (id) => /^f4_?probe/i.test(String(id || ''));

  // 不能换：轮询间隔（等 rootManager 模块就绪的循环体）
  for (let i = 0; i < 80 && !mgr(); i += 1) await sleep(150);
  const beforeRoots = await rootsAll();
  const beforeIds = beforeRoots.map((r) => r.id);
  const probeBase = new URLSearchParams(location.search).get('f4probe');
  // 跨用例共享的**可变**状态：原来是 4 个 let 在 IIFE 作用域里被多段读写。
  //   拆成独立函数后必须用对象承载——否则函数内的赋值不回传，后续用例读到旧值，
  //   表现为「语法通过、total 也对，但某条用例行为悄悄变了」（最难发现的一类错）。
  const P = {
    probeId: null,          // 探针根 id：F4① 写入；②③④⑤ 与清理读；清理末尾置回 null
    probePath: null,        // 探针根路径：F4① 写入
    groupsAfterAdd: null,   // 添加后的分组数：F4① 写入，F4③ 读
    addFormOpened: false,   // 「选择目录」表单是否真的显示出来（F4① 的交互证据）
    skipReason: '',         // 前置自证结论：非空时 5 条用例逐条 skip（保持单条粒度）
  };

  // 共享只读上下文（helper 与常量；可变状态见上面的 P）
  const C = { READY_RANK, afterTransition, beforeIds, beforeRoots, f4Sig, isProbe, last, mgr, msg, probeBase, q, readySnap, rec, results, rootsAll, rows, skip, sleep, snapshotOf, sum, w, waitAny, waitFor, waitFrames, waitStable, waitStage };

  const R = await runPreflight(C, P);
  P.skipReason = R.skipReason;
  if (P.skipReason) {
    // 环境缺数据时**逐条** skip，不合并成一条（历史病：整段包成 skipped 会让 5 条退化成 1 条）
    skip('F4 管理区展开', P.skipReason);
    skip('F4① 添加资源根', P.skipReason);
    skip('F4② 改名', P.skipReason);
    skip('F4③ 改名命中同名 → merged', P.skipReason);
    skip('F4④ 启停', P.skipReason);
  } else {
    await runManageExpand(C, P);
    await runAddRoot(C, P);
    await runRename(C, P);
    await runRenameMerge(C, P);
    await runToggleEnabled(C, P);
  }
  // ⑤ 与清理在原代码里就在 else 之外（无探针根也要走：清理分支会如实记「未执行」）
  await runErrorSurfacing(C, P);
  await runCleanup(C, P);

  return JSON.stringify({
    total: results.length,
    failed: results.filter((x) => !x.ok).length,
    skipped: results.filter((x) => /^skipped:/.test(String(x.actual))).length,
    summary: { f4probe: probeBase || null, beforeRoots: beforeIds, afterRoots: (await rootsAll()).map((r) => r.id), probeId: P.probeId },
    results,
  }, null, 1);
})()


/** F4 Preflight —— 从原巨型 IIFE 整体提出（用例代码逐字搬运，仅把跨段可变状态改为 P.xxx） */
async function runPreflight(C, P) {
  const { probeBase, rec } = C;
  // ---------------------------------------------------------------- 前置自证
  // ① 没传参：直接 skipped（这是跨平台的正解：路径只能由调用方给）
  // ② 传了但要先确认它在服务端真的存在：**只读预检**（browse 父目录），不写配置
  const parentOf = (p) => {
    const s = String(p);
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i > 0 ? s.slice(0, i) : '';
  };
  const baseOf = (p) => {
    const s = String(p);
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  };
  let skipReason = probeBase ? null : '未传 ?f4probe=<服务端已存在的目录>';
  if (probeBase) {
    const parent = parentOf(probeBase);
    try {
      const listing = await (await fetch(`/api/browse?path=${encodeURIComponent(parent)}`)).json();
      const exists = (listing.dirs || []).some((d) => d.name === baseOf(probeBase));
      if (!exists) {
        // 提示：/api/browse 不列隐藏目录（点开头的），探针目录别用点开头，否则这里会误判为不存在
        skipReason = `传入目录在服务端不可见：${probeBase}（/api/browse 列不出它；注意别用点开头的隐藏目录）`;
      }
    } catch (err) {
      skipReason = `预检失败：${(err && err.message) || err}`;
    }
  }
  rec('F4 前置自证（探针目录可由参数传入）', '?f4probe=', 'URL query 传参',
    '传了可用目录 → 跑写入类断言；没传/目录不可用 → 记 skipped 并跳过（不 fail、不崩）',
    `${skipReason ? `skipped: ${skipReason}` : `f4probe=${probeBase} 可用`}；${
      probeBase ? '' : '跑法：?f4probe=<服务端已存在的目录>'}`,
    true);
  return { skipReason };
}


/** F4 ManageExpand —— 从原巨型 IIFE 整体提出（用例代码逐字搬运，仅把跨段可变状态改为 P.xxx） */
async function runManageExpand(C, P) {
  const { beforeIds, q, rec, rootsAll, rows, sleep, waitFor } = C;
      // ------------------------------------------------------------ 准备：展开管理区
        const body = q('#root-manager-body');
        const wasHidden = body.hidden;
        q('#btn-root-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        // 等管理区真的展开（原 sleep(150) 盲等）
        await waitFor(() => !body.hidden, { timeoutMs: 3000, label: '管理区展开' });
        const open = !body.hidden;
        rec('F4 管理区展开', '#btn-root-toggle', 'click',
          '默认收起 → 点「管理」展开；展开后列出根条目（含已停用项，来自后端 rootsAll）',
          `展开前 hidden=${wasHidden}；展开后 hidden=${!open}；条目数=${rows().length}；`
            + `GET /api/roots 启用数=${beforeIds.length}；条目 id=${rows().map((r) => r.dataset.rootId).join(',')}`,
          wasHidden && open && rows().length >= beforeIds.length);
}


/** F4 AddRoot —— 从原巨型 IIFE 整体提出（用例代码逐字搬运，仅把跨段可变状态改为 P.xxx） */
async function runAddRoot(C, P) {
  const { beforeIds, isProbe, last, msg, probeBase, q, rec, rootsAll, rows, sleep, sum, w, waitFor } = C;
      // ------------------------------------------------------------ ① add
        // 「选择目录」→ 弹服务端目录浏览器 → 跳到探针目录 → 选择此目录 → 填显示名 → 添加
        q('#btn-add-root').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        // 等目录浏览器弹窗就绪（原 sleep(300)）
        await waitFor(() => { const d = q('#dir-picker'); const pk = w.rootManager && w.rootManager.picker; return !!d && !!pk && pk.state.open === true; }, { timeoutMs: 4000, label: '目录浏览器打开' });
        const dlg = q('#dir-picker');
        const picker = w.rootManager && w.rootManager.picker;
        P.addFormOpened = !!dlg && !!picker && picker.state.open === true;
        if (picker) {
          await picker.goto(probeBase);
          // 等目标目录渲染出选择按钮（原 sleep(400)）
          await waitFor(() => { const d = q('#dir-picker'); return !!d && !!d.querySelector('[data-pick]'); }, { timeoutMs: 6000, label: '目录列表就绪' });
          const pickBtn = dlg && dlg.querySelector('[data-pick]');
          if (pickBtn) pickBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          // 等显名输入框出现（原 sleep(200)）
          await waitFor(() => { const d = q('#dir-picker'); return !!d && !!d.querySelector('[data-role="name"]'); }, { timeoutMs: 3000, label: '显名输入框就绪' });
          const nameInput = dlg && dlg.querySelector('[data-role="name"]');
          if (nameInput) nameInput.value = 'F4探针A';
          const addBtn = dlg && dlg.querySelector('[data-role="add"]');
          if (addBtn) addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
        // 等添加结果落到 UI（原 sleep(1500)）：操作日志出现 root 变更即算落地
        await waitFor(() => { const x = last(); return !!(x && x.data && x.data.changed && x.data.changed.root); }, { timeoutMs: 8000, label: '添加结果落 UI' });
        const l = last();
        P.probeId = (l.data && l.data.changed && l.data.changed.root && l.data.changed.root.id) || null;
        P.probePath = (l.data && l.data.changed && l.data.changed.root && l.data.changed.root.path) || null;
        P.groupsAfterAdd = Array.isArray(l.data && l.data.groups) ? l.data.groups.length : null;
        const afterIds = (await rootsAll()).map((r) => r.id);
        const inList = rows().some((r) => r.dataset.rootId === P.probeId);
        rec('F4① 添加资源根', '#root-add-form', `填 ${probeBase} + 名字 → 提交`,
          '后端 200，启用根数量 +1，管理列表出现新条目，提示「已添加」',
          `请求体={"action":"add","path":"<f4probe>","name":"F4探针A"}；${sum(l)}；`
            + `roots ${beforeIds.length}→${afterIds.length}；新 id=${P.probeId}；列表有条目=${inList}；`
          + `目录浏览器已打开=${P.addFormOpened}；提示="${msg()}"`,
          l.status === 200 && isProbe(P.probeId) && afterIds.length === beforeIds.length + 1
            && inList && P.addFormOpened && /已添加/.test(msg()));
}


/** F4 Rename —— 从原巨型 IIFE 整体提出（用例代码逐字搬运，仅把跨段可变状态改为 P.xxx） */
async function runRename(C, P) {
  const { f4Sig, last, msg, rec, rows, sum, waitFor, waitStable } = C;
      // ------------------------------------------------------------ ② rename
        rows().find((r) => r.dataset.rootId === P.probeId)
          .querySelector('[data-role="rename"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await waitStable(f4Sig, { timeoutMs: 3000, label: '改名输入框展开' });
        const input = rows().find((r) => r.dataset.rootId === P.probeId).querySelector('[data-role="rename-input"]');
        input.value = 'F4探针A改名';
        rows().find((r) => r.dataset.rootId === P.probeId)
          .querySelector('[data-role="rename-save"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        // 等 rename 的**专属终态**，而不是"签名稳定"：
        //   后端返回 → UI 记一条提示「已改名为…」并刷新行内名字。任一到即算落地。
        await waitFor(() => {
          const l = last();
          const row = rows().find((r) => r.dataset.rootId === P.probeId);
          const nm = row && row.querySelector('[data-role="name"]');
          const shown = nm ? String(nm.textContent).trim() : '';
          return (l && l.status === 200 && /已改名/.test(msg())) || /F4探针A改名/.test(shown);
        }, { timeoutMs: 6000, label: '改名结果落到 UI' });
        const title = rows().find((r) => r.dataset.rootId === P.probeId)
          .querySelector('[data-role="name"]').textContent;
        const changed = (last().data && last().data.changed) || {};
        rec('F4② 改名', `[data-root-id="${P.probeId}"] [data-role="rename"]`, '内联输入新名字 → 保存',
          '后端 200 且 merged=false，条目显示新名字，提示「已改名为」',
          `请求体={"action":"rename",id:"${P.probeId}",name:"F4探针A改名"}；${sum(last())}；`
            + `行内显示="${title}"；提示="${msg()}"`,
          last().status === 200 && /F4探针A改名/.test(title) && /已改名/.test(msg()) && !changed.merged);
}


/** F4 RenameMerge —— 从原巨型 IIFE 整体提出（用例代码逐字搬运，仅把跨段可变状态改为 P.xxx） */
async function runRenameMerge(C, P) {
  const { beforeRoots, f4Sig, last, mgr, msg, rec, rootsAll, skip, sum, waitStable } = C;
      // ------------------------------------------------------------ ③ merged（改成已有名字）
        // 目标名字取自真实根列表（不写死名字，配置里没有别的根就跳过）
        const other = beforeRoots[0];
        if (!other || !other.name) {
          skip('F4③ 改名命中同名 → merged', '当前配置只有一条根，没有"另一个已存在的名字"可命中');
        } else {
          const rootsBefore = (await rootsAll()).length;
          await mgr().submitRename(P.probeId, other.name);
          await waitStable(f4Sig, { timeoutMs: 6000, label: '提交后 UI 落定' });
          const l = last();
          const changed = (l.data && l.data.changed) || {};
          const groupsNow = Array.isArray(l.data && l.data.groups) ? l.data.groups.length : null;
          const rootsNow = (await rootsAll()).length;
          rec('F4③ 改名命中同名 → merged', `[data-root-id="${P.probeId}"]`, `改成已存在的「${other.name}」`,
            '后端 changed.merged=true；界面提示「已合并到同名根」；归并后分组数 -1（启用根条数不变）',
            `请求体={"action":"rename",id:"${P.probeId}",name:"<已有根名>"}；${sum(l)}；`
              + `groups ${P.groupsAfterAdd}→${groupsNow}；启用 roots ${rootsBefore}→${rootsNow}；提示="${msg()}"`,
            changed.merged === true && /已合并到同名根/.test(msg())
              && P.groupsAfterAdd !== null && groupsNow === P.groupsAfterAdd - 1);
        }
}


/** F4 ToggleEnabled —— 从原巨型 IIFE 整体提出（用例代码逐字搬运，仅把跨段可变状态改为 P.xxx） */
async function runToggleEnabled(C, P) {
  const { f4Sig, last, msg, rec, rootsAll, rows, sum, waitStable } = C;
      // ------------------------------------------------------------ ④ toggle
        const row = rows().find((r) => r.dataset.rootId === P.probeId);
        const labelBefore = row.querySelector('[data-role="toggle"]').textContent;
        row.querySelector('[data-role="toggle"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await waitStable(f4Sig, { timeoutMs: 6000, label: '提交后 UI 落定' });
        const after = rows().find((r) => r.dataset.rootId === P.probeId);
        const enabledAttr = after ? after.dataset.enabled : 'gone';
        const labelAfter = after ? after.querySelector('[data-role="toggle"]').textContent : '';
        rec('F4④ 启停', `[data-root-id="${P.probeId}"] [data-role="toggle"]`, `click（${labelBefore}→${labelAfter}）`,
          '后端 200；条目仍留在列表（用 rootsAll 渲染）并标为已停用，按钮文案翻转',
          `请求体={"action":"toggle",id:"${P.probeId}",enabled:false}；${sum(last())}；`
            + `按钮 ${labelBefore}→${labelAfter}；行 enabled=${enabledAttr}；提示="${msg()}"`,
          last().status === 200 && labelBefore === '停用' && labelAfter === '启用'
            && enabledAttr === 'false' && /已停用/.test(msg()));
}


/** F4 ErrorSurfacing —— 从原巨型 IIFE 整体提出（用例代码逐字搬运，仅把跨段可变状态改为 P.xxx） */
async function runErrorSurfacing(C, P) {
  const { beforeRoots, f4Sig, last, mgr, msg, rec, waitStable } = C;
    // ------------------------------------------------------------ ⑤ 三条错误路径（不依赖探针目录，始终执行）
      const rel = await mgr().submitAdd('relative/dir');
      await waitStable(f4Sig, { timeoutMs: 6000, label: '提交后 UI 落定' });
      const relStatus = last().status; const relMsg = msg();
      // 重复目录用真实根路径（从 GET 取，不写死）
      const dupPath = beforeRoots[0] && beforeRoots[0].path;
      let dup = null; let dupStatus = null; let dupMsg = 'skipped: 配置里没有可用根路径';
      if (dupPath) {
        dup = await mgr().submitAdd(dupPath);
        await waitStable(f4Sig, { timeoutMs: 6000, label: '提交后 UI 落定' });
        dupStatus = last().status; dupMsg = msg();
      }
      const miss = await mgr().submitRemove('__nope__');
      await waitStable(f4Sig, { timeoutMs: 6000, label: '提交后 UI 落定' });
      const missStatus = last().status; const missMsg = msg();
      rec('F4⑤ 错误如实显示（400/409/404）', '#root-msg', '相对路径 / 重复目录 / 删不存在',
        '三条错误都把后端文案原样显示并带状态码：绝对路径(400)、已登记(409)、未找到(404)',
        `相对路径→HTTP ${relStatus}“${relMsg}”；重复目录→HTTP ${dupStatus}“${dupMsg}”；删不存在→HTTP ${missStatus}“${missMsg}”`,
        rel === false && relStatus === 400 && /绝对路径/.test(relMsg)
          && (!dupPath || (dup === false && dupStatus === 409 && /已登记/.test(dupMsg)))
          && miss === false && missStatus === 404 && /未找到/.test(missMsg));
}


/** F4 Cleanup —— 从原巨型 IIFE 整体提出（用例代码逐字搬运，仅把跨段可变状态改为 P.xxx） */
async function runCleanup(C, P) {
  const { beforeIds, f4Sig, isProbe, last, mgr, msg, probeBase, rec, rootsAll, rows, sum, waitStable } = C;
    const ours = !!P.probeId && (isProbe(P.probeId) || (!!probeBase && P.probePath === probeBase));
    if (ours) {
      await mgr().submitRemove(P.probeId);
      await waitStable(f4Sig, { timeoutMs: 6000, label: '提交后 UI 落定' });
      const afterIds = (await rootsAll()).map((r) => r.id);
      const gone = !rows().some((r) => r.dataset.rootId === P.probeId);
      rec('F4 清理（删除探针根）', `[data-root-id="${P.probeId}"]`, '二次确认后删除',
        '后端 200，条目消失，资源根数量回到测试前（不污染用户配置）',
        `请求体={"action":"remove",id:"${P.probeId}"}；${sum(last())}；`
          + `roots 回到 ${afterIds.length}（测试前 ${beforeIds.length}）；条目已消失=${gone}；提示="${msg()}"`,
        afterIds.length === beforeIds.length && gone);
    } else {
      rec('F4 清理（删除探针根）', '#root-list', '未执行',
        '没有探针根就不删除任何东西（保护用户真实配置）',
        `P.probeId=${String(P.probeId)} 既不是 f4?probe* 前缀、path 也不等于传入目录 → 跳过删除`, true);
    }
}
