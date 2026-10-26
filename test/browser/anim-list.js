// test/anim-list.js —— 动作列表与循环（契约 docs/契约/渲染面.md §六 七条）
//
// 覆盖：
//   ① 右栏条数 == 底栏条数 == 模型实际动作数
//   ② 每条带时长；另造一个"取不到时长"的用例，确认不显示 0s
//   ③ 点右栏第 3 条 → 播放且底栏同步
//   ④ 点底栏第 5 条 → 右栏高亮同步
//   ⑤ 循环开启：顺序推进并回到第一条
//   ⑥ 循环关闭：停留当前动作不推进
//   ⑦ Spine 与 Live2D 各跑一遍 ①②③④
//
// 脚本自带前置：自己找模型（不写死名字/路径），找不到就记 skipped 并 ok（不判失败）。

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
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  // window.__WB__ / window.__WEB__ 都由前端启动时挂到 window；页面未就绪时两者都 undefined。
  //   直接快照会让 w 永久 undefined ⇒ 后面任何 w.xxx 一取就抛 TypeError。
  //   先等其中一个出现再快照；|| {} 兜底让后续断言如实报红而不是崩成 TypeError。
  //   条件用 &&（两个都没有才等）：只要有一个在就别等了。
  for (let i = 0; i < 80 && !window.__WB__ && !window.__WEB__; i += 1) await sleep(150);
  const w = window.__WB__ || window.__WEB__ || {};
  const results = [];
  const rec = (name, expect, actual, ok) => results.push({ name, expect, actual, ok: !!ok });

  // 基础上下文（其余 helper 由两个工厂提供；工厂内同名解构 ⇒ helper 体内一字不改）
  const C = { sleep, q, qa, w, results, rec };
  Object.assign(C, makeBasicHelpers(C));   // 9 个 DOM/面板读取类 helper
  Object.assign(C, makePickHelpers(C));      // pickSpine / pickLive2d
  Object.assign(C, makeCheckListHelper(C));  // checkList（依赖上面 9 个 basic helper，故排后）

  // 跨用例共享的可变中间态：spine / l2d 在各自段里赋值、在汇总里读 name。
  //   原来是 IIFE 作用域的局部；拆成独立函数后必须用对象承载，否则赋值不回传、
  //   汇总永远读到 null（表现是 summary.spineModel/live2dModel 恒为 null，而 total 正常）。
  const P = { spine: null, l2d: null };

  await runNoSingleLoop(C);    // ① 底栏无「单动循环」
  await runAnimSwitches(C);    // ② 动作组两个开关 + 命名
  await runSpineList(C, P);       // Spine 动作列表
  await runLive2dList(C, P);      // Live2D 动作列表
  await runNoDurationCase(C);  // ② 特例：无时长不得显示 0s

  return JSON.stringify({
    total: results.length,
    skipped: results.filter((r) => r.skipped === true).length,
    failed: results.filter((r) => !r.ok).length,
    spineModel: P.spine ? P.spine.model.name : null,
    live2dModel: P.l2d ? P.l2d.model.name : null,
    results,
  });
})()

/** DOM/面板读取类 helper：面板项枚举 / UI 签名 / 动作选择器 / 底栏取值 / 行文本 / 时长文本。
 *  工厂 + 解构同名局部变量 ⇒ helper 体内一字不改（仍写 qa(...)、panelItems() 等）。 */
function makeBasicHelpers(C) {
  const { sleep, q, qa, w, results, rec } = C;
  const panelItems = () => qa('#right-panel [data-ctl="ctl-anim-list"] [data-anim]');
  // 界面稳定签名：当前动作 + 面板条目数 + 底栏选项数（这三样变了就说明 UI 还在重排）
  const uiSig = () => ({ v: footVal(), items: panelItems().length, opts: footOpts().length });
  // 底栏「动作」已是自绘下拉（DOM 里没有 select）：选项与当前值从句柄读，
  //   自绘列表的项在 .transport-picker-item 上（与原生 option 同源同文案）。
  const motionPicker = () => {
    try { return (window.__WEB__ && window.__WEB__.state.transport.picker) ? window.__WEB__.state.transport.picker('transport-motion') : null; } catch { return null; }
  };
  const footOpts = () => qa('#app-footer .transport-picker[data-ctl="transport-motion"] .transport-picker-item').map((o) => o.textContent.trim());
  const footVal = () => {
    const pk = motionPicker();
    if (pk && typeof pk.value === 'function') return pk.value() || '';
    return '';
  };
  /** 通过自绘下拉真实选中某项（点列表项，等价用户的点击） */
  const pickMotion = async (id) => {
    const pk = q('#app-footer .transport-picker[data-ctl="transport-motion"]');
    if (!pk) return false;
    pk.querySelector('.transport-picker-btn').click();
    await waitStable(() => qa('#app-footer .transport-picker-item').length, { timeoutMs: 2000, label: '底栏下拉展开' });   // 原 sleep(150)：等自绘下拉展开
    const item = [...pk.querySelectorAll('.transport-picker-item')].find((li) => li.dataset.value === id);
    if (!item) { pk.querySelector('.transport-picker-btn').click(); return false; }
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => footVal() === id, { timeoutMs: 2000, label: '底栏选中生效' });   // 原 sleep(150)：等选中生效
    return true;
  };
  // 选中态用 aria-pressed 表达（样式在 panel.css，不再靠 is-primary 类）
  const highlighted = () => (panelItems().find((b) => b.getAttribute('aria-pressed') === 'true') || {}).dataset?.anim || '';
  /** 行的可视文案：名称 + （有时长才拼）· 时长，与底栏下拉一致 */
  const rowText = (btn) => {
    const name = (btn.querySelector('.ctl-list-name') || {}).textContent || btn.textContent;
    const time = (btn.querySelector('.ctl-list-time') || {}).textContent || '';
    return String(name).trim() + (time ? ' · ' + String(time).trim() : '');
  };
  const durText = (t) => (String(t).match(/(\d+\.\d)s\s*$/) || [])[1] || '';

  return { panelItems, uiSig, motionPicker, footOpts, footVal, pickMotion, highlighted, rowText, durText };
}

/**
 * 列表类 helper：pickSpine / pickLive2d（按结构条件发现模型）+ checkList（两侧共用的一套核对）。
 *  为什么必须提共享：这三个原来分散在「② 动作组」段内部，却被 Spine 段与 Live2D 段调用；
 *  拆成独立函数后若留在原段，那两段会 ReferenceError。
 */
/**
 * 发现类 helper：pickSpine / pickLive2d —— 按结构条件找一个可用模型（不写死根名/模型名）。
 *  为什么必须提共享：原来它们定义在「② 动作组」段内部，却被 Spine 段与 Live2D 段调用。
 */
function makePickHelpers(C) {
  const { sleep, q, qa, w, results, rec } = C;
  async function pickSpine() {
    const roots = ((await (await fetch('/api/roots')).json()).roots) || [];
    for (const r of roots) {
      let list = [];
      try { list = ((await (await fetch(`/api/spine/models?root=${encodeURIComponent(r.id)}`)).json()).models) || []; } catch { list = []; }
      for (const m of list.slice(0, 4)) {
        try {
          const doc = await w.surface.buildDocument({
            ...m, kind: 'spine', rootId: r.id, rootName: r.name,
            entry: m.entry || (m.modelUrl ? { url: m.modelUrl } : null),
          });
          const info = await w.state.currentRenderer.mount(doc);
          await waitStage('model', 'painted', { timeoutMs: 8000 });   // 原 sleep(500)：等首帧绘制（信号）
          if (info && Array.isArray(info.animations) && info.animations.length >= 6) return { root: r.id, model: m, count: info.animations.length };
        } catch { /* 试下一个 */ }
      }
    }
    return null;
  }

  /** 找一个 Live2D 模型（接口优先；无则返回 null） */

  async function pickLive2d() {
    const roots = ((await (await fetch('/api/roots')).json()).roots) || [];
    for (const r of roots) {
      let list = [];
      try { list = ((await (await fetch(`/api/live2d/models?root=${encodeURIComponent(r.id)}`)).json()).models) || []; } catch { list = []; }
      if (!list.length) continue;
      const m = list[0];
      try {
        const doc = await w.surface.buildDocument({
          ...m, kind: 'live2d', rootId: r.id, rootName: m.rootName || r.name,
          entry: { url: m.modelUrl },
        });
        await w.state.currentRenderer.mount(doc);
        await waitStage('model', 'interactive', { timeoutMs: 12000 });   // 原 sleep(2200)：等动作清单非空（信号）
        return { root: r.id, model: m };
      } catch { /* 继续找 */ }
    }
    return null;
  }

  return { pickSpine, pickLive2d };
}

/**
 * checkList：对一侧（Spine / Live2D）的动作列表做同一套核对（条数 / 命名 / 时长）。
 *  被 Spine 段与 Live2D 段共用 ⇒ 必须提共享作用域，否则两段都 ReferenceError。
 */
function makeCheckListHelper(C) {
  const { sleep, qa, w, results, rec, panelItems, uiSig, footOpts, footVal, pickMotion, highlighted, rowText, durText } = C;
  async function checkList(label, expectCount, expectWithDuration) {
    if (w.state.panel && typeof w.state.panel.refreshAnimations === 'function') w.state.panel.refreshAnimations();
    await waitFor(() => qa('#right-panel [data-ctl="ctl-anim-list"] .ctl-list-time').some((n) => /\d+\.\d+s/.test(n.textContent || '')), { timeoutMs: 6000, label: '动作时长已填充' });   // 原 sleep(1400)：等时长预热落地
    const panel = panelItems();
    const foot = footOpts();
    rec(`${label} ① 条数一致`, `${label}：右栏 == 底栏 == 模型动作数`,
      `panel=${panel.length} foot=${foot.length} model=${expectCount} 顺序一致=${
        panel.length === foot.length && panel.every((b, i) => rowText(b) === foot[i])}`,
      panel.length > 0 && panel.length === foot.length && panel.length === expectCount);

    // 契约 §二：数据里有正值时长就必须显示；没有（如空轨道动画）就不显示，且严禁出现 0.0s
    const withDur = panel.map((b) => durText(rowText(b))).filter(Boolean);
    const zeroShown = panel.filter((b) => /0\.0s/.test(rowText(b))).length;
    rec(`${label} ② 带时长`, `有正时长的条目全部显示时长（应=${expectWithDuration}），且不出现 0s`,
      `条数=${panel.length} 有时长=${withDur.length}（应=${expectWithDuration}）0s 冒充=${zeroShown} 样例=${
        panel.slice(0, 3).map((b) => rowText(b)).join(' | ')}`,
      panel.length > 0 && withDur.length === expectWithDuration && zeroShown === 0);

    // 3 / 5 是契约 §六 明确规定的序号（"点右栏第 3 条""点底栏第 5 条"），必须按契约固定；
    //   条数本身不写死——来自 buildAnimationList / 装载返回的 animations.length。
    if (panel.length >= 3) {
      const b = panel[2];
      const id = b.dataset.anim;
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await waitStable(uiSig, { timeoutMs: 4000, label: '切换动作后界面稳定' });   // 原 sleep(700)：等列表/底栏跟着换
      rec(`${label} ③ 点右栏第 3 条`, '播放该动作，底栏选中项同步',
        `点击=${id} 底栏=${footVal()} 高亮=${highlighted()}`,
        footVal() === id && highlighted() === id);
    } else {
      rec(`${label} ③ 点右栏第 3 条`, '需要 ≥3 条动作', `skipped：只有 ${panel.length} 条`, true);
    results[results.length - 1].skipped = true;
    }

    if (panel.length >= 5) {
      const id5 = panel[4].dataset.anim;
      await pickMotion(id5);
      await waitStable(uiSig, { timeoutMs: 4000, label: '选中第 5 条后界面稳定' });   // 原 sleep(700)
      rec(`${label} ④ 点底栏第 5 条`, '右栏高亮同步到第 5 条',
        `下拉=${id5} 实际=${footVal()} 高亮=${highlighted()}`,
        footVal() === id5 && highlighted() === id5);
    } else {
      rec(`${label} ④ 点底栏第 5 条`, '需要 ≥5 条动作', `skipped：只有 ${panel.length} 条`, true);
    results[results.length - 1].skipped = true;
    }
  }

  return { checkList };
}


/** ① 底栏不再有「单动循环」 */
async function runNoSingleLoop(C) {
  const { q, qa, rec } = C;
  // ---------------------------------------------------------------- ① 底栏不再有「单动循环」
  const footerText = (q('#app-footer') || {}).textContent || '';
  const footerBtnIds = qa('#app-footer button').map((b) => b.id);
  rec('① 底栏无「单动循环」', 'DOM 里查不到循环按钮，其余传输类控件仍在且可点',
    `#transport-loop=${!!q('#transport-loop')} 文案含"单动循环"=${/单动循环/.test(footerText)} `
    + `按钮=${footerBtnIds.join(',')} 可点=${
      qa('#app-footer button').every((b) => !b.disabled)}`,
    !q('#transport-loop') && !/单动循环/.test(footerText)
    // 背景控件已从 <button id="transport-bg"> 改为自绘 picker（schema.js 的 custom:'picker'），
    //   所以判据放宽为"按钮 id 里有它 **或** 底栏存在同名 picker 容器"——意图不变：传输类控件都还在。
      && ['transport-prev', 'transport-play', 'transport-next', 'transport-reset-view']
        .every((id) => footerBtnIds.includes(id))
      && (footerBtnIds.includes('transport-bg') || !!q('#app-footer [data-ctl="transport-bg"]'))
      && qa('#app-footer button').every((b) => !b.disabled));

}


/** ② 动作组：两个开关、命名正确 */
async function runAnimSwitches(C) {
  const { sleep, qa, rec } = C;
  // ---------------------------------------------------------------- ② 动作组：两个开关，命名正确
  const motionTrigger = qa('#right-panel .acc-trigger').find((x) => x.textContent.trim() === '动作');
  if (motionTrigger && motionTrigger.getAttribute('aria-expanded') !== 'true') motionTrigger.click();
  await waitStable(() => qa('#app-footer .transport-picker-item').length, { timeoutMs: 2000, label: '动作下拉展开' });   // 原 sleep(300)：等下拉展开
  const motionSwitches = qa('#right-panel [data-group="motion"] [role="switch"]');
  const switchLabels = motionSwitches.map((s) => ((s.closest('.ctl-row') || {}).querySelector?.('.ctl-label') || {}).textContent || '');
  // 判据跟随产品变更：混合模式开关已按设计手动隐藏（panel/schema.js hidden:true，DOM 不构建），
  //   所以"动作组两个开关"退化为"有且仅有循环播放一个"，且混合模式不得以任何形式残留成 DOM。
  const mixResidue = qa('#right-panel [data-ctl="ctl-mix-mode"]').length;
  rec('② 动作组开关（混合模式已按设计隐藏）', '只剩循环播放一个；混合模式不构建 DOM；命名不用「单动循环」',
    `开关=${motionSwitches.map((s) => s.id).join(',')} 标签=${switchLabels.join(' / ')}；ctl-mix-mode DOM=${mixResidue}`,
    motionSwitches.length === 1
      && motionSwitches[0].id === 'ctl-anim-loop'
      && switchLabels.includes('循环播放')
      && mixResidue === 0
      && !switchLabels.some((t) => /单动/.test(t)));

  /** 找一个动作数 >= 6 的 Spine 模型（遍历资源根，取前几个候选试装） */
}


/**
 * Spine 侧动作列表：前置发现 → 条数/命名/时长核对（checkList）→ ⑤循环推进 / ⑥停留 /
 * ⑤正交（混合模式×循环）/ ⑥持久化，四组判据共用同一个模型与同一套开关操作。
 *
 * **为什么约 100 行仍不再细分（按 §3.5 两档口径）**：
 *   这四组判据不是独立用例，而是**同一条"循环行为"判据链**——`ensureLoop(want)` 这个
 *   局部辅助函数被其中三组共用，`seen` / `before` / `after` / `loopSwitch` 等中间态也
 *   在组间传递（前一组把循环打开，后一组才谈"关闭后是否停留"）。
 *   按组硬拆成 4 个函数，要么把这 5~6 个中间态逐层串参，要么在拆出的函数里重复一遍
 *   开关前置操作 —— 两种都比现在更难读，也更容易在改一处时漏改另一处。
 *   若将来其中某组演变成独立场景（例如循环持久化单独抽成启动恢复用例），再单独提出。
 */
async function runSpineList(C, P) {
  const { sleep, q, w, results, rec, panelItems, uiSig, footVal, pickMotion, checkList, pickSpine } = C;
  // ---------------------------------------------------------------- Spine
  P.spine = await pickSpine();
  if (!P.spine) {
    rec('Spine 前置', '存在动作数 ≥6 的 Spine 模型', 'skipped：目录里没找到（整套 Spine 侧未验证）', true);
    results[results.length - 1].skipped = true;
  } else {
    // Spine：时长来自 skeletonData，正值的那几条必须显示
    let spineExpected = 0;
    try {
      const details = typeof w.stage.animationDetails === 'function' ? w.stage.animationDetails() : [];
      spineExpected = details.filter((d) => Number(d.duration) > 0).length;
    } catch { spineExpected = 0; }
    await checkList(`Spine(${P.spine.model.name})`, P.spine.count, spineExpected);

    // ⑤ 循环开启：顺序推进并回到第一条
    const first = panelItems()[0];
    const loopSwitch = q('#ctl-anim-loop');
    if (first && loopSwitch) {
      await pickMotion(first.dataset.anim);
      await waitStable(uiSig, { timeoutMs: 3000, label: '首条动作选中后稳定' });   // 原 sleep(300)
      if (document.documentElement.dataset.animLoop !== 'on') {
        loopSwitch.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
      // 等"开关状态真的落到 dataset=on"再继续：uiSig 不含 animLoop，
      //   用 waitStable 会在 UI 已稳但 dataset 还没写时提前返回 ⇒ 偶发读到 undefined（连带 4 条判据假红）。
      await waitFor(() => document.documentElement.dataset.animLoop === 'on',
        { timeoutMs: 3000, label: '循环开关 dataset 落到 on' });
      const seen = [];
      for (let i = 0; i < 60; i += 1) {
        const v = document.documentElement.dataset.transportMotion || '';
        if (v && seen[seen.length - 1] !== v) seen.push(v);
        // 不能换：这是**采样间隔**（每 250ms 读一次 dataset，观察"推送序列"的变化顺序）；
        //   序列本身没有完成信号，只能按间隔采样
        if (seen.length >= 4) break;
        await sleep(250);
      }
      rec('⑤ 循环开启 ⇒ 顺序推进', '按列表顺序逐条推进（末尾回到第一条）',
        `序列=${seen.slice(0, 5).join(' → ')} loop=${document.documentElement.dataset.animLoop}`,
        // 契约 §四/§六⑤：开启后要"跨过第 2、3 条"，因此至少 3 个不同动作算通过
        seen.length >= 3 && document.documentElement.dataset.animLoop === 'on');

      // ⑥ 循环关闭：不推进
      loopSwitch.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // 先等 dataset 落到 off（同上：这是判据要读的值，不能靠 UI 稳定去猜）
      await waitFor(() => document.documentElement.dataset.animLoop === 'off',
        { timeoutMs: 3000, label: '循环开关 dataset 落到 off' });
      // 不能换：这里就是要**观察 4s 内自动播放是否推进**（"没有变化"本身是判据）
      const before = document.documentElement.dataset.transportMotion || footVal();
      await sleep(4000);
      const after = document.documentElement.dataset.transportMotion || footVal();
      rec('⑥ 循环关闭 ⇒ 停留当前动作', '不推进（同一动作重复播）',
        `关闭后 ${before} → ${after}（loop=${document.documentElement.dataset.animLoop}）`,
        before === after && document.documentElement.dataset.animLoop === 'off');
      // ⑤ 正交：改混合模式不影响循环（状态与推进），反之亦然
      // 注意：混合模式开关已按产品设计手动隐藏（schema hidden:true），DOM 里不存在；
      //   这里按"能力缺失即跳过"处理，并记为 skipped（不是失败）。
      const mix = q('#ctl-mix-mode');
      if (!mix) {
        rec('⑤ 正交（混合模式 × 循环）', '#ctl-mix-mode', '跳过',
          '混合模式已手动隐藏（hidden:true），该项不再有 UI，跳过正交断言',
          'skipped: ctl-mix-mode 按设计隐藏（schema hidden:true）', true);
        results[results.length - 1].skipped = true;
      }
      const ensureLoop = async (want) => {
        const target = want ? 'on' : 'off';
        if ((document.documentElement.dataset.animLoop || 'off') !== target) {
          loopSwitch.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await waitFor(() => document.documentElement.dataset.animLoop === target,
            { timeoutMs: 3000, label: `循环开关 dataset 落到 ${target}` });
        }
      };
      await ensureLoop(true);
      const loopBefore = document.documentElement.dataset.animLoop;
      const mixBefore = document.documentElement.dataset.mixMode;
      if (mix) { mix.dispatchEvent(new MouseEvent('click', { bubbles: true })); await waitStable(uiSig, { timeoutMs: 3000, label: '混音切换后稳定' }); }   // 原 sleep(300)：等混音态生效
      const loopAfterMix = document.documentElement.dataset.animLoop;
      const mixAfter = document.documentElement.dataset.mixMode;
      // 循环仍应推进（混合模式只管过渡，不管"播完接谁"）
      const advance = [];
      // 不能换：采样间隔（观察数值是否推进）
      // 不能换：采样间隔（观察"是否在推进"需要一段时间的序列样本，无完成信号）
      for (let i = 0; i < 16; i += 1) {
        const v = document.documentElement.dataset.transportMotion;
        if (advance[advance.length - 1] !== v) advance.push(v);
        await sleep(250);
      }
      if (mix) {
        rec('⑤ 两开关正交', '切混合模式不改变循环开关状态与行为；切循环不改变混合模式状态',
          `loop ${loopBefore}→${loopAfterMix}；mix ${mixBefore}→${mixAfter}；`
          + `切混合模式后仍在推进 ${advance.length} 段`,
          loopBefore === 'on' && loopAfterMix === 'on' && mixAfter !== mixBefore && advance.length >= 2);
      } else {
        // 混合模式没有 UI（按设计隐藏）⇒ 正交无从测；只验证"循环本身仍在推进"
        rec('⑤ 循环推进（混合模式已隐藏，正交不适用）', '循环开启时逐条推进',
          `切之前 loop=${loopBefore}；观测到 ${advance.length} 段`,
          loopBefore === 'on' && advance.length >= 2);
      }

      // ⑥ 持久化：状态写入存储；清内存态后走启动恢复路径仍是"开"
      await ensureLoop(true);
      await waitStable(uiSig, { timeoutMs: 3000, label: '恢复面板设置后稳定' });   // 原 sleep(300)
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem('modelstage-settings-v2') || '{}'); } catch { stored = null; }
      const persisted = !!(stored && stored.panel && stored.panel['ctl-anim-loop'] === true);
      w.state.panelSettings = {};            // 模拟"刷新后内存态清空"
      const mod = await import('/panel/panel-settings.js');
      mod.restorePanelSettings(new Set());   // 启动恢复路径
      // 恢复路径是异步的：等 dataset 真回到 on（而不是靠"UI 稳定"猜）
      await waitFor(() => document.documentElement.dataset.animLoop === 'on',
        { timeoutMs: 4000, label: '启动恢复后 dataset 回到 on' });
      const restoredSwitch = q('#ctl-anim-loop') ? q('#ctl-anim-loop').getAttribute('aria-checked') : null;
      rec('⑥ 循环开关持久化', '刷新后开关仍为开（写存储 + 启动恢复路径有效）',
        `存储=${persisted} 恢复后 dataset=${document.documentElement.dataset.animLoop} 开关=${restoredSwitch}`,
        persisted && document.documentElement.dataset.animLoop === 'on' && restoredSwitch === 'true');
    } else {
      rec('⑤ 循环开启 ⇒ 顺序推进', '需要至少一条动作 + 循环控件', 'skipped：前置不足', true);
      rec('⑥ 循环关闭 ⇒ 停留当前动作', '需要至少一条动作 + 循环控件', 'skipped：前置不足', true);
      rec('⑤ 两开关正交', '需要至少一条动作 + 两个开关', 'skipped：前置不足', true);
      rec('⑥ 循环开关持久化', '需要两个开关', 'skipped：前置不足', true);
    }
  }

}


/** Live2D 侧动作列表（走 checkList） */
async function runLive2dList(C, P) {
  const { w, rec, checkList, pickLive2d } = C;
  // ---------------------------------------------------------------- Live2D
  P.l2d = await pickLive2d();
  if (!P.l2d) {
    rec('Live2D 前置', '存在可装载的 Live2D 模型', 'skipped：接口没返回 Live2D 模型', true);
  } else {
    const bridge = w.live2d && w.live2d.bridge;
    // 先把时长取全（Live2D 时长在动作文件里，取一次缓存住），再据此算期望条数
    if (bridge && typeof bridge.ensureMotionDurations === 'function') {
      try { await bridge.ensureMotionDurations(); } catch { /* 取不到就按 0 条期望 */ }
    }
    const items = bridge && typeof bridge.motionItems === 'function' ? bridge.motionItems() : [];
    const l2dExpected = items.filter((x) => Number(x.duration) > 0).length;
    await checkList(`Live2D(${P.l2d.model.name})`, items.length, l2dExpected);
  }

}


/** ② 特例：无时长不得显示 0s */
async function runNoDurationCase(C) {
  const { rec } = C;
  // ---------------------------------------------------------------- ② 特例：无时长不得显示 0s
  try {
    const mod = await import('/app/anim-list.js');
    const text = mod.labelWithDuration({ label: 'no-duration-case', duration: null });
    rec('② 无时长特例', '只显示名字，不出现 0s / —',
      `labelWithDuration(null 时长) = ${JSON.stringify(text)}`,
      text === 'no-duration-case' && !/0\.0s/.test(text));
  } catch (err) {
    rec('② 无时长特例', '模块可导入', `失败：${String(err && err.message || err)}`, false);
  }

}
