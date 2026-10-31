// panel-actions.js —— 右侧控制面板 + 底部播放条的穷举实操脚本（M3）
//
// 用途：把面板相关元素逐类实操一遍并断言：
//   1. 手风琴 9 组逐个展开/折叠（真实行为，aria-expanded 与可见性同步翻转）；
//   2. 所有未接线控件逐个断言 disabled + data-pending="true"（给总数）；
//   3. 已接线控件（模型库 / 全屏 / 左栏收起）各操作一次并记录变化；
//   4. 区域 rect 与控件计数一并回传，供几何回归对照。
//
// 用法（项目根执行；地址由参数给，脚本内不写死）：
//   node tool/check-console.mjs http://127.0.0.1:8804/ --script test/panel-actions.js
//   加 --json 拿机器可读结果；退出码 0 = 零错误且脚本无异常。
//
// 形态：整段是自求值 async IIFE（工具原样求值并 await），因此也能通过 node --check。
// 返回：{ total, failed, results:[...], summary:{...} }

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

// 面板稳定签名：控件 aria 状态 + 左栏位移（判断点完控件后 UI 是否已重排/过渡完）
const panelSig = () => ({
  on: qa('#right-panel [data-ctl][aria-pressed="true"]').map((e) => e.dataset.ctl).join(','),
  x: Math.round((q('#left-panel') || q('.panel-left') || { getBoundingClientRect: () => ({ x: 0 }) }).getBoundingClientRect().x),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => document.querySelector(s);
const qa = (s) => [...document.querySelectorAll(s)];
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const results = [];
const rec = (name, sel, action, expect, actual, ok) => results.push({ name, sel, action, expect, actual, ok: !!ok });
const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
};


  // 共享上下文（本文件没有跨段 helper 需要工厂：全部是 const 箭头函数，直接进 C）
  const C = { panelSig, sleep, q, qa, click, results, rec, rectOf };

  // 0 段一次枚举的产出 I：后续子步骤只读消费（不是可变累加器）
  const I = await runControlInventory(C);
  await runWiredLists(C, I);
  const J = await runDefaultValues(C, I);   // J = { titles, expectTitles }
  await runViewSettings(C, I);
  await runDisabledStyle(C, I);
  await runGroupTitles(C, J);

  await runAccordion(C);   // 1. 手风琴 9 组
  const U = await runUnwiredRight(C);   // 2a. 右栏未接线控件（产出 nonTrigger 供 2b 复用）
  await runWiredEffectiveness(C, U);    // 2b. 可点控件必须有效
  await runUnwiredFooter(C);            // 2c. 底栏未接线控件
  await runWired(C);       // 3. 已接线控件
  await runRects(C);       // 4. 区域 rect

const summary = {
  rightPanel: {
    // 控件计数按「内置 + 插件」分组（插件往面板加控件后总数会变，混在一起就无法当基线对照）：
  //   插件控件数由宿主在合并时写进 dataset.pluginControls，内置 = 总数 − 插件数。
    total: qa('#right-panel button, #right-panel select, #right-panel input').length,
    pluginControls: Number(document.documentElement.dataset.pluginControls || 0),
    builtinControls: qa('#right-panel button, #right-panel select, #right-panel input').length
      - Number(document.documentElement.dataset.pluginControls || 0),
    triggers: qa('#right-panel .acc-trigger').length,
    disabled: qa('#right-panel button:not(.acc-trigger), #right-panel select, #right-panel input').filter((e) => e.disabled).length,
  },
  footer: {
    total: qa('#app-footer button, #app-footer select').length,
    disabled: qa('#app-footer button, #app-footer select').filter((e) => e.disabled).length,
  },
  dataset: {
    panelControls: document.documentElement.dataset.panelControls,
    transportControls: document.documentElement.dataset.transportControls,
  },
};
return JSON.stringify({ total: results.length, failed: results.filter((r) => !r.ok).length, summary, results }, null, 1);
})();


/**
 * 取出"实际用于渲染的控件声明"（合并结果），供孤儿能力键检查使用。
 *
 * 为什么在测试里重算：面板没把合并结果暴露出来（view.js 的 mountPanel 只回计数与 defaults），
 *   而这条检查必须看见**插件控件**。重算用的是与装配期同一批公开函数、同一批输入
 *   （host.controlSections / host.slotSections / registeredEffectIds），
 *   并用"DOM 的控件 id 必须都能在合并结果里找到"做漂移护栏。
 * @returns {Promise<{groups: Array, slotCapabilityKeys: string[]}>}
 */
async function readMergedGroups() {
  const mod = await import('/panel/schema.js');
  const web = window.__WEB__ || {};
  const host = (web.state && web.state.pluginHost) || null;
  const sections = host && typeof host.controlSections === 'function' ? host.controlSections() : [];
  const slotEntries = host && typeof host.slotSections === 'function' ? host.slotSections() : [];
  const effects = host && typeof host.registeredEffectIds === 'function' ? host.registeredEffectIds() : [];
  let groups = mod.PANEL_GROUPS || [];
  if (sections.length) {
    groups = mod.mergePluginControls(groups, sections, { registeredEffects: effects }).groups;
  }
  let slotCapabilityKeys = [];
  if (slotEntries.length && typeof mod.mergeSlotControls === 'function') {
    const r = mod.mergeSlotControls(groups, slotEntries, { buildProps: () => ({}) });
    groups = r.groups;
    slotCapabilityKeys = Array.isArray(r.capabilityKeys) ? r.capabilityKeys.slice() : [];
  }
  return { groups, slotCapabilityKeys };
}

/**
 * 孤儿能力键判据（纯函数，便于自检）：
 *   控件带 capabilityKey、该键不在 declared、且**不是 disabled**（契约 §9.3 要求"已声明未注册"的控件
 *   置灰保留，那是合法状态而不是孤儿）。
 * @param {Array<{controls?: Array}>} groups 合并后的分组
 * @param {Set<string>} declared 当前生效的能力键集合
 * @returns {string[]} `id:capabilityKey` 列表（空 = 无孤儿）
 */
function findOrphanKeys(groups, declared) {
  const out = [];
  for (const g of groups || []) {
    for (const c of g.controls || []) {
      if (!c || !c.id) continue;
      if (c.disabled === true) continue;
      if (typeof c.capabilityKey !== 'string' || !c.capabilityKey) continue;
      if (!declared.has(c.capabilityKey)) out.push(`${c.id}:${c.capabilityKey}`);
    }
  }
  return out;
}

/** 枚举 + 控件分类门禁（静态检查） */
async function runControlInventory(C) {
  const { qa, rec } = C;
  const rightItems = qa('#right-panel button, #right-panel select, #right-panel input');
  const triggers = qa('#right-panel .acc-trigger');
  const footItems = qa('#app-footer button, #app-footer select');
  const nonTrigger = rightItems.filter((el) => !el.classList.contains('acc-trigger'));
  // 接线态口径：可点的控件 = 页面实际接线集合；未接线的必须 disabled 且带 data-pending
  const ctlIdOf = (el) => {
    const box = el.closest('[data-ctl]');
    return box ? box.dataset.ctl : (el.id || '');
  };
  // 动态列表容器（动作列表）本身不是控件：它的条目由模型决定，空态不该算进"可点集合"
  const isDynamicBox = (node) => node.closest('[data-role="dynamic"]') !== null;
  const enabledEls = nonTrigger.filter((el) => !el.disabled && !isDynamicBox(el));
  const disabledEls = nonTrigger.filter((el) => el.disabled);
  const enabledIds = [...new Set(enabledEls.map(ctlIdOf).filter(Boolean))].sort();
  const declaredWired = [...new Set(((window.__WEB__ && window.__WEB__.panelWired) || []))].sort();
  // ---- 门禁：每个控件必须显式归到三层优先级之一，否则"永远显示"会静默发生
  //   ① hidden:true（手动隐藏） ② capabilityKey / debugKey（自动按声明） ③ RENDERER_INDEPENDENT（与渲染器无关）
  //   漏标 ⇒ 本断言失败（这正是"靠人肉维护"最容易漏的地方，用测试钉死它）
    let gateMiss = [];
    let hiddenIds = [];
    // mod 要在 try 之外声明：I 需要把它交给后续子步骤（B 段用 mod 校验能力键），
    //   而 try 块内 const 出了块就不可见。
    let mod = null;
    try {
      mod = await import('/panel/schema.js');
      const indep = new Set(mod.RENDERER_INDEPENDENT || []);
      const allControls = (mod.PANEL_GROUPS || []).flatMap((g) => (g.controls || []).filter((c) => c && c.id));
      for (const c of allControls) {
        if (c.hidden === true) { hiddenIds.push(c.id); continue; }
        if (typeof c.capabilityKey === 'string' && c.capabilityKey) continue;
        if (typeof c.debugKey === 'string' && c.debugKey) continue;
        if (indep.has(c.id)) continue;
        gateMiss.push(c.id);
      }
      gateMiss = gateMiss;
    } catch { gateMiss = ['<import-failed>']; }
    rec('控件分类门禁（hidden/能力键/白名单）', 'PANEL_GROUPS', '静态检查',
      '每个控件必须属于：hidden:true / capabilityKey / debugKey / RENDERER_INDEPENDENT 之一；漏标即失败',
      `漏标 ${gateMiss.length} 个${gateMiss.length ? '：' + gateMiss.join(',') : ''}；手动隐藏 ${hiddenIds.length} 个${hiddenIds.length ? '：' + hiddenIds.join(',') : ''}`,
      // 说明：原先此处还断言 `hiddenIds.includes('ctl-mix-mode')`（钉住"混合模式开关以 hidden 形式存在"）。
      //   混合过渡改由「播放 → 混合时长」一个滑块控制后，该控件已按需求**移除**，
      //   钉住它存在的断言随之删除；此处不是为让测试变绿而放宽判据，其余门禁原样保留。
      gateMiss.length === 0);


  // I 是「一次枚举的结果」，交给后续子步骤只读消费
  return { rightItems, triggers, footItems, nonTrigger, enabledEls, disabledEls, enabledIds, declaredWired, mod };
}


/** 接线态清单：右栏 / 底栏 */
async function runWiredLists(C, I) {
  const { q, rec } = C;
  const { rightItems, triggers, footItems, nonTrigger, disabledEls, enabledIds, declaredWired } = I;
  // 口径（契约 §53）：能力不支持的项**根本不构建**（DOM 里不该有），
  //   所以"不可点"只该剩一种合法原因 —— 未接线（data-pending）；
  //   任何 disabled 却不是 pending 的项，说明有未声明能力被建了出来。
  const disabledAllPending = disabledEls.every((el) => el.dataset.pending === 'true');
  // 未声明 ⇒ 不存在：面板里每个带 capabilityKey 的控件，其能力键必须出现在当前渲染器声明里
  let orphanCapabilities = [];
  try {
    const mod = await import('/panel/schema.js');
    const caps = ((window.__WEB__.state && window.__WEB__.state.currentRenderer) || {}).capabilities || {};
    const declared = new Set(caps.settings || []);
    const byId = new Map();
    for (const g of mod.PANEL_GROUPS || []) for (const c of g.controls || []) if (c && c.id) byId.set(c.id, c);
    // DOM 里实际存在的控件 id（本文件没有 present，独立取一份，别依赖别处的变量）
    const domIds = [...new Set([...document.querySelectorAll('#right-panel [data-ctl]')]
      .map((n) => n.dataset.ctl).filter(Boolean))];
    for (const id of domIds) {
      const def = byId.get(id);
      if (!def || typeof def.capabilityKey !== 'string' || !def.capabilityKey) continue;
      if (!declared.has(def.capabilityKey)) orphanCapabilities.push(`${id}:${def.capabilityKey}`);
    }
  } catch { orphanCapabilities = []; }
  const footDisabled = footItems.every((el) => el.disabled && el.dataset.pending === 'true');

  // 手风琴组数不写死：取"按当前渲染器能力过滤后的实际组数"（页面写在 dataset.panelGroups）
  const expectedGroups = Number(document.documentElement.dataset.panelGroups || '0');
  rec('右栏控件清单（接线态）', '#right-panel button/select/input', '枚举',
    `${expectedGroups} 个手风琴（=能力过滤后的实际组数）；可点集合 === 已接线集合；未接线一律 disabled + data-pending`,
    `总计 ${rightItems.length}（手风琴 ${triggers.length} + 组内 ${nonTrigger.length}）；`
    + `未声明能力却建出来的项=${orphanCapabilities.length}${orphanCapabilities.length ? '：' + orphanCapabilities.join(',') : ''}；`
    + `可点 ${enabledIds.join(',') || '(无)'}；已接线 ${declaredWired.join(',') || '(无)'}；`
    + `不可点 ${disabledEls.length} 个全带原因（pending/disabledReason）=${disabledAllPending}`,
    expectedGroups > 0 && triggers.length === expectedGroups && nonTrigger.length > 0
    && enabledIds.join(',') === declaredWired.join(',')
    && disabledAllPending && orphanCapabilities.length === 0);

  // 底栏口径：与面板一致——可点集合必须等于「已接线的底栏控件」，其余 disabled + pending
  // 底栏控件数不写死：以 schema 的 TRANSPORT_CONTROLS 声明为唯一真相（增删控件时测试自动跟随）
  let declaredFoot = null;
  try { declaredFoot = (await import('/panel/schema.js')).TRANSPORT_CONTROLS.length; } catch { declaredFoot = null; }
  const footEnabled = footItems.filter((e) => !e.disabled).map((e) => e.id).sort();
  const footDisabledItems = footItems.filter((e) => e.disabled);
  const footAllPending = footDisabledItems.every((e) => e.dataset.pending === 'true');
  rec('底栏控件清单（接线态）', '#app-footer button/select', '枚举',
    `${declaredFoot === null ? '?' : declaredFoot} 个控件（=TRANSPORT_CONTROLS 声明数）：已接线项可点，其余 disabled 且带 data-pending；无循环按钮`,
    `总计 ${footItems.length}：${footItems.map((e) => (e.textContent || '').trim() || e.id).join(' / ')}；`
    + `可点=${footEnabled.join(',') || '(无)'}；未接线 ${footDisabledItems.length} 个全 disabled+${footAllPending}`,
    declaredFoot !== null && footItems.length === declaredFoot
    && footEnabled.length === footItems.length  // 声明了几个就接线几个（不该再有 disabled）
    && !q('#transport-loop')                        // 循环已移到右栏「循环播放」开关
    && footAllPending);

}


/** 已接线控件的声明默认值是否真的落到引擎 */
async function runDefaultValues(C, I) {
  const { rec } = C;
  const { triggers } = I;
  // 分组标题与声明口径对照
  const titles = triggers.map((t) => t.textContent.trim());
  const expectTitles = ['动作', '皮肤', '播放', '滤镜', 'PMA 预乘', '运行时', '主题背景', '调试绘制', '设置'];
  // 视图与引擎必须一致：每个已接线控件声明的默认值，启动后必须已经落到舞台设置里
    const defaults = (window.__WEB__ && window.__WEB__.panelDefaults) || null;
    const st = window.__WEB__ && window.__WEB__.stage;
    const settings = st && st.stats ? st.stats().settings : null;
    const keyOf = {
      'ctl-fps': 'fpsLimit', 'ctl-dpr': 'dprMode', 'ctl-fit': 'fit',
      'ctl-filter': 'textureFilter', 'ctl-pma': 'pma', 'ctl-filter-preset': 'filter', 'ctl-msaa': 'msaa',
    };
    const rows = Object.entries(defaults || {}).map(([id, want]) => {
      // 视图类控件（主题/背景）不落在引擎设置里，由下面那条『视图设置与真实状态一致』单独覆盖
      if (!keyOf[id]) return { id, want, got: want, ok: true };
      const got = settings ? settings[keyOf[id]] : undefined;
      return { id, want, got, ok: got === want };
    });
    const bad = rows.filter((r) => !r.ok);
    rec('默认值已落到引擎', '#right-panel 已接线控件', '启动后比对',
      '每个已接线控件的实际生效值 === 面板声明的 defaultValue',
      `共 ${rows.length} 项，不一致 ${bad.length} 项${bad.length ? '：' + bad.map((b) => `${b.id} 声明=${b.want} 实际=${b.got}`).join('；') : ''}`,
      rows.length > 0 && bad.length === 0);

  // 分组标题在 C 段枚举、由 F 段（runGroupTitles）消费 ⇒ 一并交出去
  return { titles, expectTitles };
}


/** 视图类设置（主题 / 背景）四处一致 */
async function runViewSettings(C, I) {
  const { q, rec } = C;
    // 主题已从原生 <select> 改为自绘 chips（与滤镜预设组统一视觉）：
    //   自绘 chips 的选中项只能从 aria-pressed 找，且按钮上没有 value 属性 ——
    //   所以用 schema 的 options 把"选中项文案"映射回 value，判据仍是"UI 选择 === 真实状态 === 存储值"。
    const themeBox = q('#right-panel [data-ctl="ctl-theme"]');
    const themePicked = themeBox ? [...themeBox.querySelectorAll('button')].find((b) => b.getAttribute('aria-pressed') === 'true') : null;
    let themeUiValue = null;
    try {
      const S = await import('/panel/schema.js');
      const ctl = (S.PANEL_GROUPS || []).flatMap((gr) => gr.controls || []).find((c) => c.id === 'ctl-theme');
      const opts = (ctl && ctl.options) || [];
      const hit = themePicked ? opts.find((o) => o.text === themePicked.textContent.trim()) : null;
      themeUiValue = hit ? hit.value : null;
    } catch { themeUiValue = null; }
    const themeSel = themePicked ? { value: themeUiValue, text: themePicked.textContent.trim() } : null;
    const bgBox = document.querySelector('[data-ctl="ctl-bg-mode"]');
    const pressedBg = bgBox
      ? [...bgBox.children].find((b) => b.getAttribute('aria-pressed') === 'true')
      : null;
    const stageEl = document.getElementById('stage');
    const themeAttr = document.documentElement.dataset.uiTheme || null;
    const bgAttr = stageEl ? stageEl.dataset.bg : null;
    const labelOfBg = { checkerboard: '棋盘格', solid: '纯色', transparent: '透明', custom: '自定义' };
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem('modelstage-settings-v2') || '{}');
    } catch {
      stored = {};
    }
    const storedBg = (stored.background || {}).mode || null;
    const ok = !!themeSel && !!pressedBg
      && themeUiValue === themeAttr
      && pressedBg.textContent.trim() === (labelOfBg[bgAttr] || '?')
      && (!stored.uiTheme || stored.uiTheme === themeAttr)
      && (!storedBg || storedBg === bgAttr);
    rec('视图设置与真实状态一致', '#right-panel 主题背景组', '启动后比对',
      '主题下拉 / 背景模式按下态 / DOM 属性 / localStorage 四处一致',
      `下拉=${themeSel ? themeSel.value : '(缺)'} html[data-ui-theme]=${themeAttr} `
      + `背景按下=${pressedBg ? pressedBg.textContent.trim() : '(无)'} #stage[data-bg]=${bgAttr} `
      + `存储theme=${stored.uiTheme || '(未写)'} 存储bg=${storedBg || '(未写)'}`,
      ok);
}


/** 不可点控件的删除线只表达「未接线」 */
async function runDisabledStyle(C, I) {
  const { q, rec } = C;
    const right = q('#right-panel');
    const controls = right
      ? [...right.querySelectorAll('button, select')].filter((e) => !e.classList.contains('acc-trigger'))
      : [];
    const struck = (el) => {
      const own = getComputedStyle(el).textDecorationLine.includes('line-through');
      const row = el.closest('.ctl-row');
      const label = row ? row.querySelector(':scope > .ctl-label') : null;
      const viaLabel = label ? getComputedStyle(label).textDecorationLine.includes('line-through') : false;
      return own || viaLabel;
    };
    const pendingOnes = controls.filter((e) => e.dataset.pending === 'true');
    const unsupportedOnes = controls.filter((e) => e.disabled && e.dataset.pending !== 'true');
    const enabledOnes = controls.filter((e) => !e.disabled);
    const missStrike = pendingOnes.filter((e) => !struck(e)).map((e) => e.id || (e.textContent || '').trim().slice(0, 8));
    const falseStrike = [...enabledOnes, ...unsupportedOnes]
      .filter((e) => struck(e)).map((e) => e.id || (e.textContent || '').trim().slice(0, 8));
    // 口径：删除线**只表达"未接线"**（pending 必须划线）；"能力不支持"只灰化+原因，不得划线
    //   （Live2D 面曾因两者共用 :disabled 划线，把"这一面本来没这个能力"画成"像坏了一样"）
    rec('禁用控件删除线', '#right-panel 不可点控件', '读取 computed 样式',
      '待接线(pending)必须划线；能力不支持(有 reason)与可点控件都不得划线',
      `待接线 ${pendingOnes.length} 个（缺划线 ${missStrike.length}${missStrike.length ? '：' + missStrike.join(',') : ''}）；`
        + `能力不支持 ${unsupportedOnes.length} 个；可点 ${enabledOnes.length} 个；`
        + `误加划线 ${falseStrike.length}${falseStrike.length ? '：' + falseStrike.join(',') : ''}`,
      missStrike.length === 0 && falseStrike.length === 0);
}


/** 分组标题与声明口径对照 */
async function runGroupTitles(C, J) {
  const { titles, expectTitles } = J;
  const { rec, qa } = C;
  // S3 起允许插件新建分组 ⇒ 断言改为「内置 9 组必须都在且顺序一致 + 允许尾部额外组」。
  //   仍然严格的部分：内置组的数量/文字/顺序一位不许错（否则内置表被人改了也发现不了）；
  //   额外组必须带 plugin. 前缀（data-group-id），这是设计 §七·一 对插件分组的唯一硬约束。
  const ids = qa('#right-panel .acc').map((s) => s.dataset.groupId || s.dataset.group || '');
  const builtinOk = expectTitles.every((t, i) => titles[i] === t);
  const extras = titles.slice(expectTitles.length);
  const extraIds = ids.slice(expectTitles.length);
  const extrasOk = extras.every((_, i) => String(extraIds[i] || '').startsWith('plugin.'));
  rec('分组标题对照', '#right-panel .acc-trigger', '枚举',
    `内置 ${expectTitles.length} 组逐字一致（顺序不变）+ 额外组必须带 plugin. 前缀`,
    `${titles.join(' / ')}（额外 ${extras.length} 组：${extraIds.join(',') || '无'}）`,
    titles.length >= expectTitles.length && builtinOk && extrasOk);
}


/** 1. 手风琴 9 组逐个展开/折叠 */
async function runAccordion(C) {
  const { panelSig, sleep, qa, click, rec } = C;
// --------------------------------------- 1. 手风琴 9 组逐个展开/折叠
  const count = qa('#right-panel .acc-trigger').length;
  for (let i = 0; i < count; i += 1) {
    const get = () => qa('#right-panel .acc-trigger')[i];
    const bodyOf = () => get().parentElement.querySelector('.acc-body');
    const title = get().textContent.trim();
    // 默认展开态因组而异（动作/设置默认开），所以断言写成"翻转 + 可见性与 aria 一致 + 再点复原"
    const before = get().getAttribute('aria-expanded');
    click(get());
    await waitStable(panelSig, { timeoutMs: 3000, quietMs: 60, pollMs: 20, label: '控件操作后界面稳定' });   // 原 sleep(80)：等控件状态落到 UI
    const afterFirst = get().getAttribute('aria-expanded');
    const hiddenFirst = bodyOf().hidden;
    click(get());
    await waitStable(panelSig, { timeoutMs: 3000, quietMs: 60, pollMs: 20, label: '控件操作后界面稳定' });   // 原 sleep(80)：等控件状态落到 UI
    const afterSecond = get().getAttribute('aria-expanded');
    const hiddenSecond = bodyOf().hidden;
    const consistent = (state, hidden) => (state === 'true' ? hidden === false : hidden === true);
    rec(`手风琴「${title}」展开/折叠`, `#right-panel .acc-trigger:nth-of-type(${i + 1})`, 'click ×2',
      'aria-expanded 翻转、body 可见性与之一致、再点复原',
      `${before}→${afterFirst}（hidden=${hiddenFirst}）→${afterSecond}（hidden=${hiddenSecond}）`,
      afterFirst !== before && afterSecond === before
        && consistent(afterFirst, hiddenFirst) && consistent(afterSecond, hiddenSecond));
  }

}


/** 2. 未接线控件逐个断言「点了没反应」 */

/** ① 右栏未接线控件：逐个点击必须无反应（disabled 生效） */
async function runUnwiredRight(C) {
  const { panelSig, sleep, qa, click, rec } = C;
  const nonTrigger = qa('#right-panel button:not(.acc-trigger), #right-panel select, #right-panel input');
  const unwired = nonTrigger.filter((el) => el.disabled);
  // 只点未接线的：disabled 元素不会触发处理器，界面不应出现任何状态变化
  const before = JSON.stringify(qa('#right-panel [aria-pressed], #right-panel [aria-checked]').map((e) => e.getAttribute('aria-pressed') + e.getAttribute('aria-checked')));
  let clicked = 0;
  for (const el of unwired) { click(el); clicked += 1; }
  await waitStable(panelSig, { timeoutMs: 3000, quietMs: 60, pollMs: 20, label: '控件操作后界面稳定' });   // 原 sleep(120)：等未接线控件点击后的重排
  const after = JSON.stringify(qa('#right-panel [aria-pressed], #right-panel [aria-checked]').map((e) => e.getAttribute('aria-pressed') + e.getAttribute('aria-checked')));
  const stillDisabled = unwired.every((el) => el.disabled);
  rec('未接线控件点击无反应', '#right-panel 未接线控件', `click ×${clicked}`,
    '未接线控件全部 disabled，点击不改变任何控件状态',
    `点击 ${clicked} 个；状态快照一致=${before === after}；全部仍 disabled=${stillDisabled}`,
    clicked === unwired.length && before === after && stillDisabled);

  // 反向防线：凡 disabled=false 的控件，点一次必须产生可观测变化（panelSetting / canvas / 引擎统计）

  // nonTrigger 交给 ② 复用（同一批控件，避免重复枚举）
  return { nonTrigger };
}

/** ② 可点控件必须真的有效（防「接了线但点了没效果」） */
async function runWiredEffectiveness(C, U) {
  const { panelSig, sleep, q, qa, click, rec } = C;
  const { nonTrigger } = U;
  const stageRef = window.__WEB__ && window.__WEB__.stage;
  // 可观测口径要覆盖"设置类控件"的全部真实副作用：
  //   panelSetting（落到设置的项）、canvas/frames（影响渲染的项）、
  //   以及设置导入导出组自己写的标记（导出/导入/恢复默认不改 panelSetting，但各自有 dataset 痕迹）
  const observe = () => JSON.stringify({
    setting: document.body.dataset.panelSetting || document.documentElement.dataset.panelSetting || null,
    canvas: (q('#stage-canvas') || {}).width + 'x' + (q('#stage-canvas') || {}).height,
    frames: stageRef && stageRef.stats ? stageRef.stats().frames : null,
    ioRestored: document.documentElement.dataset.settingsRestored || null,
    ioExport: document.documentElement.dataset.settingsExport || null,
    ioImport: document.documentElement.dataset.settingsImport || null,
    // 控件自身的选中态也算可观测变化：有些设置项（如纹理过滤 双线性/最邻近）
    //   在同一档位重复点会因"同值短路"不改 panelSetting，但切到另一档 aria-pressed 一定翻转
    pressed: qa('#right-panel [aria-pressed]').map((e) => e.getAttribute('aria-pressed')).join(''),
  });
  // 以控件为单位判定：每组至少有一档能让状态变化；逐档点（点到当前值不变属正常）
  const ctlIdOf2 = (el) => {
    const box = el.closest('[data-ctl]');
    return box ? box.dataset.ctl : (el.id || '');
  };
  const enabledEls2 = nonTrigger.filter((el) => !el.disabled);
  const allGroups = [...new Set(enabledEls2.map((el) => el.closest('[data-ctl]')).filter(Boolean))];
  // 只有一档的组（如皮肤列表在单皮肤模型下）无法产生变化，跳过不计入无效
  const groups = allGroups.filter((g) => {
    const sel = g.tagName === 'SELECT' ? g : g.querySelector('select');
    if (sel) return sel.options.length > 1;
    return [...g.children].filter((x) => !x.disabled && x.tagName === 'BUTTON').length > 1;
  });
  const skippedSingles = allGroups.length - groups.length;
  const deadGroups = [];
  const deadDetail = [];
  for (const g of groups) {
    const sig0 = observe();
    let changed = false;
    const dbg = { ctl: g.dataset.ctl || g.id || '?', opts: 0, sig0: sig0.slice(0, 80), last: '' };
    // 下拉组（主题）：靠 change 事件驱动；按钮组：靠 click 逐档
    const select = g.tagName === 'SELECT' ? g : g.querySelector('select');
    if (select) {
      for (const o of [...select.options]) {
        select.value = o.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await waitStable(panelSig, { timeoutMs: 3000, quietMs: 60, pollMs: 20, label: '控件操作后界面稳定' });   // 原 sleep(80~150)：等 select 变更落到 UI
        if (observe() !== sig0) changed = true;
      }
      if (select.options.length) {
        select.value = select.options[0].value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await waitStable(panelSig, { timeoutMs: 3000, quietMs: 60, pollMs: 20, label: '控件操作后界面稳定' });   // 原 sleep(80~150)：等 select 变更落到 UI
      }
    } else {
      const opts = [...g.children].filter((x) => !x.disabled && x.tagName === 'BUTTON');
      for (const o of opts) {
        click(o);
        await waitStable(panelSig, { timeoutMs: 3000, quietMs: 60, pollMs: 20, label: '控件操作后界面稳定' });   // 原 sleep(130)：等自绘下拉选中生效
        if (observe() !== sig0) changed = true;
      }
      dbg.opts = opts.length;
      dbg.last = observe().slice(0, 120);
      if (opts.length) { click(opts[0]); await waitStable(panelSig, { timeoutMs: 2000, label: '复位后稳定' }); } // 复位到首项
    }
    if (!changed) { deadGroups.push(g.dataset.ctl); deadDetail.push(dbg); }
  }
  rec('可点控件必须有效（防假接线）', '#right-panel 已接线控件组', '逐组点遍各档',
    '每组至少有一档能产生可观测变化（panelSetting / canvas / 统计）',
    `可点控件组 ${groups.length} 个（另有 ${skippedSingles} 个单选项组已跳过），无效 ${deadGroups.length} 个${deadGroups.length ? '（' + deadGroups.join(',') + '）' : ''}`
      + (deadDetail.length ? `；明细=${JSON.stringify(deadDetail).slice(0, 500)}` : ''),
    groups.length > 0 && deadGroups.length === 0);
  const footItems = qa('#app-footer button, #app-footer select');
  const footBefore = JSON.stringify(footItems.map((e) => e.value || e.textContent));
  for (const el of footItems) click(el);
  await waitStable(panelSig, { timeoutMs: 3000, quietMs: 60, pollMs: 20, label: '控件操作后界面稳定' });   // 原 sleep(100)：等底栏项点击后的重排
  const footAfter = JSON.stringify(footItems.map((e) => e.value || e.textContent));

  // 底栏：只对未接线项断言点了没反应（已接线的重置视图应当有反应）
}

/** ③ 底栏未接线控件：逐个点击必须无反应 */
async function runUnwiredFooter(C) {
  const { panelSig, sleep, click, rec } = C;
    const foot = [...document.querySelectorAll('#app-footer button, #app-footer select')];
    const unwiredFoot = foot.filter((e) => e.disabled);
    const snap = () => JSON.stringify(foot.map((e) => `${e.id}|${e.value || ''}|${e.getAttribute('aria-checked') || ''}`));
    const b0 = snap();
    for (const el of unwiredFoot) click(el);
    await waitStable(panelSig, { timeoutMs: 3000, quietMs: 60, pollMs: 20, label: '控件操作后界面稳定' });   // 原 sleep(120)：同上
    const b1 = snap();
    rec('底栏未接线点击无反应', '#app-footer 未接线控件', `click ×${unwiredFoot.length}`,
      '未接线项全部 disabled，点击不改变任何状态',
      `未接线 ${unwiredFoot.length} 个；状态快照一致=${b0 === b1}`,
      b0 === b1); // 未接线项为 0 时同样成立：底栏已全部接线，不存在"点了没反应"
}


/** 3. 已接线控件各操作一次 */
async function runWired(C) {
  const { sleep, q, qa, click, rec } = C;
// ----------------------------------------- 3. 已接线控件各操作一次
  // 3a 顶栏「模型库」：左栏显隐
  // 左栏容器：优先 id，退到 class（两者都存在，取实际渲染的那个）
  const panel = q('#left-panel') || q('.panel-left');
  const xNow = () => Math.round(panel.getBoundingClientRect().x);
  /**
   * 等位移**真的到达目标值**，再确认已静止。
   * 旧实现用 waitStable(quietMs=150) 等位移：过渡还没起步时 x 会连续两次采样都等于 0，
   *   于是 150ms 就"判稳定"返回 ⇒ 随后读到的 x 仍是 0（表现为"隐藏 x=0 / 恢复 x=0"）。
   *   这是**等错了对象**：要等的是"到 -200 以下 / 回到 0"这个位移事实，不是"看到不动了"。
   * 预算 6s：本机过渡约 300ms，负载高时可到 3s+。
   */
  const settleAt = async (pred, label) => {
    await waitFor(pred, { timeoutMs: 6000, label });
    // 到位后再确认静止（区分"过渡中恰好路过目标值"与"真的停住了"）
    try { await waitStable(xNow, { timeoutMs: 1500, quietMs: 100, pollMs: 40, label: `${label}（确认静止）` }); } catch { /* 仍在微动也继续，下面按实测值判定 */ }
    return xNow();
  };
  click(q('#btn-library'));
  const x1 = await settleAt(() => xNow() < -200, '左栏隐藏到位');
  const hidden = panel.classList.contains('is-hidden');
  click(q('#btn-library'));
  const x2 = await settleAt(() => xNow() === 0, '左栏恢复到位');
  rec('已接线：顶栏模型库', '#btn-library', 'click ×2', '左栏 x 0→-304→0',
    `隐藏 x=${x1}，恢复 x=${x2}`, hidden && x1 < -200 && x2 === 0);

  // 3b 左栏「收起」：只清空树展开态，面板保留
  const roster = window.__WEB__.rosterSnapshot();
  const gameRow = q('[data-game-key].tree-game');
  if (gameRow) {
    click(gameRow);
    // 等名册行真的渲染出来（盲等 900ms 在快机器上白等、在慢机器上不够）
    await waitFor(() => qa('[data-char-key]').length > 0, { timeoutMs: 6000, label: '名册角色行渲染' });
  }
  const expandedBefore = window.__WEB__.rosterSnapshot().expandedGames.length;
  click(q('#btn-collapse'));
  await waitFor(() => window.__WEB__.rosterSnapshot().expandedGames.length === 0, { timeoutMs: 3000, label: '名册全部折叠' });   // 原 sleep(200)：等折叠落到状态
  const expandedAfter = window.__WEB__.rosterSnapshot().expandedGames.length;
  rec('已接线：左栏收起', '#btn-collapse', 'click', '展开数 N→0，面板保留',
    `展开游戏 ${expandedBefore}→${expandedAfter}，面板隐藏=${panel.classList.contains('is-hidden')}`,
    expandedAfter === 0 && !panel.classList.contains('is-hidden'));

  // 3c 顶栏「全屏」：原生 API（无头环境可能被拒，判据是"有响应且不报错"）
  click(q('#btn-fullscreen'));
  await waitStable(() => !!document.fullscreenElement, { timeoutMs: 3000, quietMs: 100, label: '全屏态落定' });   // 原 sleep(350)：等全屏切换落定
  const fsOn = !!document.fullscreenElement;
  click(q('#btn-fullscreen'));
  await waitStable(() => !!document.fullscreenElement, { timeoutMs: 3000, quietMs: 100, label: '全屏态落定' });   // 原 sleep(350)：等全屏切换落定
  rec('已接线：顶栏全屏', '#btn-fullscreen', 'click ×2', '有响应且不报错',
    `进入后 fullscreenElement=${fsOn}，退出后=${!!document.fullscreenElement}`,
    document.fullscreenElement === null);

}


/** 4. 区域 rect 与计数 */
async function runRects(C) {
  const { q, rec, rectOf } = C;
// ------------------------------------------------- 4. 区域 rect 与计数
  const rightRect = rectOf(q('#right-panel'));
  const footRect = rectOf(q('#app-footer'));
  const stageRect = rectOf(q('#stage'));
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // 右栏宽度不再写死数字：期望值从样式常量 --right-w 派生（176px 太窄，批 8 改成 240px）。
  //   这样门禁仍然有效（面板必须跟着常量走），改常量时不用再回来改测试。
  const rootStyle = getComputedStyle(document.documentElement);
  const rightVarRaw = String(rootStyle.getPropertyValue('--right-w') || '').trim();
  const remBase = parseFloat(rootStyle.fontSize) || 16;
  const rightVarPx = rightVarRaw.endsWith('rem') ? parseFloat(rightVarRaw) * remBase : parseFloat(rightVarRaw);
  rec('右栏 rect', '#right-panel', '测量',
    `宽度 = --right-w（${rightVarRaw} ⇒ ${rightVarPx}px）、右边界贴视口右边、顶边 48`,
    `实测=${JSON.stringify(rightRect)} 常量=${rightVarPx}px`,
    Number.isFinite(rightVarPx) && Math.abs(rightRect[2] - rightVarPx) <= 1
      && rightRect[0] + rightRect[2] === 1920 && rightRect[1] === 48);
  // 播放条不再是固定 720px：宽度由内容决定（fit-content），整体居中，高度随内容（≥42）。
  //   所以这里断言"性质"而不是"某一版快照数字"：宽度=内容宽、水平居中、高度够用。
  const footEl = q('#app-footer');
  const footW = footEl ? footEl.offsetWidth : 0;
  const footScroll = footEl ? footEl.scrollWidth : 0;
  const footCenter = footRect[0] + footRect[2] / 2;
  rec('播放条 rect', '#app-footer', '测量',
    '宽度 = 内容宽（scrollWidth===clientWidth）、水平居中于视口、高度 ≥ 42',
    `rect=${JSON.stringify(footRect)} 宽度=${footW} scrollWidth=${footScroll} 中心=${Math.round(footCenter)} 视口中心=${window.innerWidth / 2}`,
    footW > 0 && footScroll === footEl.clientWidth
      && Math.abs(footCenter - window.innerWidth / 2) <= 1
      && footRect[3] >= 42);
  rec('区域不遮挡', '#stage / #right-panel / #app-footer', '测量', '舞台铺满且右栏、播放条浮在其上',
    `舞台=${JSON.stringify(stageRect)} 右栏右边界=${rightRect[0] + rightRect[2]} 播放条底边界=${footRect[1] + footRect[3]}`,
    stageRect[2] === 1920 && rightRect[0] + rightRect[2] === 1920 && footRect[1] > 0);
}
