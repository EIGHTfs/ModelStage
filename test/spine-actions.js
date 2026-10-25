// spine-actions.js —— Spine 渲染最小闭环的验收脚本（M4）
//
// 用途：在真实页面里跑完 M4 的五条验收，把数值一并回传：
//   1. 真渲染：非背景像素占比 > 5%（给数值）
//   2. 动作在动：间隔 500ms 两帧签名不同
//   3. 版本匹配：3.8 与 4.1 模型都能出画，且各自加载了对应运行时
//   4. 连切 3 个模型不泄漏：canvas 数量恒为 1、WebGL 上下文 1 个、贴图/骨架逐次释放
//   5. UI 路径：从名册点选一个 Spine 变体 → 舞台出画（证明接线，而不只是调 API）
//
// 用法（项目根执行；地址由参数给，脚本内不写死）：
//   node tool/check-console.mjs http://127.0.0.1:8804/ --script test/spine-actions.js
//
// 形态：整段是自求值 async IIFE（工具原样求值并 await），因此也能通过 node --check。
// 返回：{ total, failed, results:[...], summary:{...} }

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
const results = [];
const rec = (name, sel, action, expect, actual, ok) => results.push({ name, sel, action, expect, actual, ok: !!ok });
const stage = () => window.__WEB__ && window.__WEB__.stage;
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

const MIN_RATIO = 0.05; // 验收线：非背景像素 > 5%

// ---------------------------------------------------------------- 前置自证
// 本机配置里至少要有一个"能扫出模型"的资源根，否则整份脚本 skipped（不 fail、不崩）。
// 这一步替代了原来"写死某个资源根一定有某个模型"的隐含前提。
{
  let hasAnyModel = false;
  try {
    const roots = ((await (await fetch('/api/roots')).json()).roots) || [];
    for (const r of roots) {
      const j = await (await fetch(`/api/spine/models?root=${encodeURIComponent(r.id)}`)).json();
      if ((j.models || []).length) { hasAnyModel = true; break; }
    }
  } catch { hasAnyModel = false; }
  if (!hasAnyModel) {
    results.push({
      name: '（整套跳过）无可用 Spine 模型', sel: '/api/roots', action: '前置自证',
      expect: '本机配置里至少有一个资源根能扫出模型',
      actual: 'skipped：当前配置里没有任何可加载的 Spine 模型（整套未验证）', ok: true, skipped: true,
    });
    // skipped === total ⇒ 整套未验证，runner 会把它标成「实际未验证」警告（不当作通过）
    return JSON.stringify({ total: results.length, skipped: results.length, failed: 0, results }, null, 1);
  }
}

/**
 * 记一条"环境缺数据"的跳过。**与 fail 严格区分**：
 *   ok=true（不影响 failed 计数）+ skipped=true（单独计数）+ 必须写清缺的是哪类数据。
 * 只有"枚举完整候选集后确认零候选"才走这里；装载/断言失败一律仍是 fail。
 */
function skip(name, sel, expect, reason) {
  results.push({ name, sel, action: 'skip', expect, actual: `skipped：${reason}`, ok: true, skipped: true });
}

/**
 * 全库扫描（/api/roots → 每根 /api/spine/models），结果缓存。
 *
 * ⚠️ 两个环境事实（踩过）：
 *   ① `/api/roots` 里 5 个根的 `kind` **全是 'spine'**（连 Live2D 根也是）⇒ 不能靠 r.kind 判断渲染器；
 *   ② 多个根可能同名（三个根都叫「碧蓝航线」）⇒ 任何"按名字数根"的断言都要按 name 分组算。
 *
 * @returns {Promise<{roots:object[], items:object[], errors:string[]}>} items 每项带 rootId/rootName
 */
let scanCache = null;
async function scanAll() {
  if (scanCache) return scanCache;
  const out = { roots: [], items: [], errors: [] };
  try {
    const rs = ((await (await fetch('/api/roots')).json()).roots) || [];
    out.roots = rs.filter((r) => r.enabled !== false);
  } catch (e) { out.errors.push(`/api/roots 失败：${e.message}`); }
  for (const r of out.roots) {
    try {
      const j = await (await fetch(`/api/spine/models?root=${encodeURIComponent(r.id)}`)).json();
      for (const m of (j.models || [])) out.items.push({ ...m, rootId: r.id, rootName: r.name });
    } catch (e) { out.errors.push(`${r.id}：${e.message}`); }
  }
  scanCache = out;
  return out;
}

/** 扫描摘要：拼进 skip 原因，用来分辨"环境真没这类数据"还是"发现逻辑写错了" */
function scanDigest(scan) {
  const byVer = {};
  for (const m of scan.items) byVer[m.version || '?'] = (byVer[m.version || '?'] || 0) + 1;
  return `扫了 ${scan.roots.length} 个根、共 ${scan.items.length} 个模型；版本分布 ${JSON.stringify(byVer)}`
    + (scan.errors.length ? `；扫描失败 ${scan.errors.length} 处` : '');
}

/**
 * 按**结构条件**发现一个模型（绝不按模型名/根名匹配 —— 那都是本机数据）。
 * @param {(m:object)=>boolean} where 结构条件，例如 m => m.version === '3.8' && m.format === 'skel'
 * @returns {Promise<{model:object, rootId:string}|null>} null = 环境里没有这类模型，调用方负责 skip
 */
async function discover(where) {
  const scan = await scanAll();
  const m = scan.items.find(where);
  return m ? { model: m, rootId: m.rootId } : null;
}

/** 连切用的模型池：全部 Spine 模型（按 根+名 去重，顺序稳定） */
async function spinePool() {
  const scan = await scanAll();
  const seen = new Set();
  const out = [];
  for (const m of scan.items) {
    const key = `${m.rootId}/${m.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

/** 加载 + 采样两帧（间隔 500ms），返回渲染指标（**只收 model**：根名与测量无关，删掉形参以杜绝写死根名） */
async function measure(model) {
  // 显式两步：组装（Assets 层）→ 装载；组装失败会在这里就变成 state='error'
  const doc = await stage().buildDocument(model);
  await stage().load({ document: doc });
  // 不同模型的默认动作不一样（有的默认停在静止姿势）⇒ 先显式播一个有正时长的动作，
  //   否则"两帧签名不同"会把静止默认姿态误判成"动作没在动"（数据差异被当成功能缺陷）
  try {
    const details = typeof stage().animationDetails === 'function' ? stage().animationDetails() : [];
    const pickAnim = details.find((a) => a.duration > 0) || details[0];
    if (pickAnim && typeof stage().setAnimation === 'function') stage().setAnimation(pickAnim.name);
    if (typeof stage().play === 'function') stage().play();
  } catch { /* 没有动作清单就按原样测（后面断言会如实报告） */ }
  // 保留固定等待：这里直连舞台 API（不经 renderer.mount），就绪信号的 model 阶段不参与，
  //   拿信号等会永远等不到；首帧绘制后再采样才有意义。
  await waitFrames(2, { timeoutMs: 12000, label: '装载/重建后推进 2 帧' });   // 原固定等待：等首帧绘制再采样
  const a = stage().samplePixels();
  // 不能换：像素采样前的短固定等待——采样本身没有完成回调，且此时已先过了
  //   waitStage(model,painted)，这里是留给最后一帧的余量。
  await sleep(500);
  const b = stage().samplePixels();
  const d = stage().debug();
  return {
    name: model.name,
    version: model.version,
    runtimeKey: d.track ? undefined : undefined,
    ratio: a.ratio,
    nonBg: a.nonBg,
    total: a.total,
    // 画面在变（两次采样像素签名不同）+ 渲染循环在跑（引擎自报，不是计数）
    moving: a.signature !== b.signature,
    alive: loopAlive(stage()),
    framesHint: d.frames,
    lastError: d.lastError,
  };
}

// -------------------------------------------------- 0. 舞台就绪（WebGL 上下文）
{
  const s = stage();
  const ok = !!s && document.documentElement.dataset.stageContext === 'webgl';
  rec('舞台/WebGL 上下文', '#stage-canvas', '读取',
    'stage 已创建且 context=webgl',
    `stage=${!!s} context=${document.documentElement.dataset.stageContext}`,
    ok);
}

// -------------------------------------------- 1. 真渲染（3.8）+ 2. 动作在动
let r38 = null;
{
  const hit = await discover((m) => m.version === '3.8' && m.format === 'skel');
  if (!hit) {
    const why = `环境里没有 3.8 的 skel 模型（${scanDigest(await scanAll())}）`;
    skip('真渲染（3.8 模型）', '#stage-canvas', `非背景像素 > ${MIN_RATIO * 100}%`, why);
    skip('动作在动（间隔 500ms 两帧）', '#stage-canvas', '两帧像素签名不同', why);
  } else {
    const model = hit.model;
    r38 = await measure(model);
    rec('真渲染（3.8 模型）', '#stage-canvas', 'load → readPixels',
      `非背景像素 > ${MIN_RATIO * 100}%`,
      `${model.name} v${model.version}：nonBg=${r38.nonBg}/${r38.total} = ${(r38.ratio * 100).toFixed(2)}%，lastError=${r38.lastError}`,
      r38.ratio > MIN_RATIO && !r38.lastError);

    rec('动作在动（间隔 500ms 两帧）', '#stage-canvas', 'load → 500ms → 再采样',
      '两帧像素签名不同（且在推进帧）',
      `moving=${r38.moving} loopAlive=${r38.alive}（frames=${r38.framesHint} 仅供参考，不作判据）`,
      r38.moving === true && r38.alive === true);
  }
}

// ------------------------------------------------ 3. 版本匹配（4.1 模型）
let r41 = null;
{
  const hit = await discover((m) => m.version === '4.1' && m.format === 'skel');
  if (!hit) {
    skip('版本匹配（4.1 模型）', '#stage-canvas', '4.1 模型能出画且加载了 spine-webgl-4.1.js',
      `环境里没有 4.1 的 skel 模型（${scanDigest(await scanAll())}）`);
  } else {
  const model = hit.model;
  r41 = await measure(model);
  const loaded = performance.getEntriesByType('resource')
    .map((e) => e.name)
    .filter((u) => u.includes('/spine-runtimes/spine-webgl-'));
  const has41 = loaded.some((u) => u.includes('spine-webgl-4.1.js'));
  rec('版本匹配（4.1 模型）', '#stage-canvas', 'load → readPixels',
    '4.1 模型能出画且加载了 spine-webgl-4.1.js',
    `${model.name} v${model.version}：ratio=${(r41.ratio * 100).toFixed(2)}% 已加载运行时=${loaded.map((u) => u.split('/').pop()).join(',')}`,
    r41.ratio > MIN_RATIO && has41);
  }
}

// ------------------------------------- 4. 连切 3 个模型：上下文/贴图不泄漏
{
  // 按 id 数 Spine 画布：Live2D 覆盖层画布（#live2d-overlay-canvas）启动即存在，
  //   统计全部 canvas 会把「设计上的第二块画布」误判成泄漏。
  const beforeCanvas = qa('#stage-canvas').length;
  // 测的是「上下文/贴图泄漏」，与具体模型无关 ⇒ 从全库取最多 3 个（去重）。
  //   环境只有 1 个模型时**降级为同一模型连切 3 次**（刻意不 skip：skip 掉等于精简环境下泄漏检测永不生效）。
  const pool = await spinePool();
  const seq = pool.length ? Array.from({ length: 3 }, (_, i) => pool[i % pool.length]) : [];
  const ratios = [];
  for (const model of seq) {
    const r = await measure(model);
    ratios.push(`${model.name}:${(r.ratio * 100).toFixed(2)}%`);
  }
  const st = stage().stats();
  const afterCanvas = qa('#stage-canvas').length;
  const degraded = pool.length > 0 && pool.length < 3;
  rec('连切 3 个模型不泄漏', '#stage-canvas',
    degraded ? `load ×3（环境仅 ${pool.length} 个可用模型，同一模型连切）` : 'load ×3（3 个不同模型）',
    '#stage-canvas 数量恒为 1、上下文 1 个、每次 load 都有对应 dispose、全程无 lastError',
    `${degraded ? `降级：环境只有 ${pool.length} 个模型，改为同一模型连切 3 次；` : ''}#stage-canvas ${beforeCanvas}→${afterCanvas}；contexts=${st.contexts}；loads=${st.loads}；disposes=${st.disposes}；runtimeKeys=${st.runtimeKeys.join('+')}；各次 ratio=${ratios.join(' ')}；lastError=${st.lastError}`,
    pool.length > 0 && beforeCanvas === 1 && afterCanvas === 1 && st.contexts === 1
      && st.disposes >= st.loads - 1 && !st.lastError);
}

// ------------------------------------------- 5. UI 路径：名册点选 → 出画
{
  // 不按名字搜索（角色名/模型名都是本机数据）：点当前名册里的**第一个角色行**，
  //   再点它展开出的第一个**非 Live2D 变体**——"点角色 → 出现变体 → 点变体 → 出画"才是要验的链路。
  let target = qa('[data-char-key].tree-char')[0] || null;
  if (!target) {
    // 依次尝试展开各个游戏节点（哪个先出角色行就用哪个）——不假定"第一个游戏一定有角色"
    const games = qa('[data-game-key].tree-game');
    for (const g of games.slice(0, 4)) {
      if (g.getAttribute('aria-expanded') !== 'true') g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      try {
        await waitFor(() => qa('[data-char-key].tree-char').length > 0,
          { timeoutMs: 20000, label: '展开游戏后出现角色行' });
        target = qa('[data-char-key].tree-char')[0] || null;
        if (target) break;
      } catch { /* 这个游戏没有角色行，换下一个 */ }
    }
  }
  if (!target) {
    skip('UI 路径：名册点选 → 渲染', '#roster-list', '点角色 → 出现变体 → 点变体 → 出画',
      '名册里没有任何角色行（当前配置没有可用模型）');
  } else {
    if (target.getAttribute('aria-expanded') !== 'true') {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    await waitFor(() => qa('[data-model-id]').length > 0,
      { timeoutMs: 8000, label: '角色展开后出现变体行' });
    const variants = qa('[data-model-id]');
    const clicked = variants.find((n) => !/^live2d/i.test(n.dataset.modelId || '')) || variants[0];
    if (!clicked) {
      skip('UI 路径：名册点选 → 渲染', '#roster-list', '点角色 → 出现变体 → 点变体 → 出画',
        `角色「${(target.textContent || '').trim().slice(0, 20)}」展开后没有任何变体行`);
    } else {
      // 点变体走 model-actions → renderer.mount ⇒ model 阶段会 reset 后重新走三级，
      //   用"本轮之后"才有意义的边沿等待（sinceAt），比盲等既快又能立刻暴露 failed
      const modelAtBefore = readySnap('model').at || 0;
      clicked.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await waitStage('model', 'interactive', { sinceAt: modelAtBefore, timeoutMs: 20000 });
      const s = stage().samplePixels();
      const d = stage().debug();
      rec('UI 路径：名册点选 → 渲染', clicked.dataset.modelId, 'click',
        '点变体行后舞台出画（非背景像素 > 5%）',
        `ratio=${(s.ratio * 100).toFixed(2)}% frames=${d.frames} lastError=${d.lastError} 提示=${(q('#stage-hint') || {}).textContent || ''}`,
        s.ratio > MIN_RATIO && !d.lastError);
    }
  }
}

// -------------------------------- 2b. 成功装载必须清掉上一次的 lastError（防"一次失败永久染红"）
{
  // 失败方式选"参数校验失败"：不联网、不动 loads/disposes 计数，但仍会写入 lastError，
  //   正好单测"下一次成功装载是否把旧错误清掉"（不清会让后续所有采样格都带旧错误）
  let failed = false;
  // 这条要覆盖的正是「组装失败」：先组装出 error 文档，再让装载拒绝它
  try {
    const badDoc = await stage().buildDocument({ name: 'x' });
    await stage().load({ document: badDoc });
  } catch { failed = true; }
  // 等"错误已被写入"（不固定时长）：装错之后 lastError 必须出现，这是后续"能清除"的前提
  let afterFail = null;
  try {
    await waitFor(() => !!stage().stats().lastError, { timeoutMs: 2000, label: '失败后 lastError 已写入' });
  } catch { /* 记下来由下面的子项判断负责报告 */ }
  afterFail = stage().stats().lastError;
  const hitRe = await discover((m) => m.version === '3.8' && m.format === 'skel');
  if (!hitRe) {
    const why = `环境里没有可用来"重装载"的 3.8 skel 模型（${scanDigest(await scanAll())}）`;
    skip('成功装载清除上一次的错误', '#stage-canvas', '失败后 lastError 非空；随后成功装载后回到 null', why);
  } else {
  const ok2 = await measure(hitRe.model);
  // 等"错误已清除"（不固定时长）：这是本用例的核心判据，固定 sleep 在负载高时会踩空
  let cleared = false;
  try {
    await waitFor(() => !stage().stats().lastError, { timeoutMs: 3000, label: '上次错误已清除' });
    cleared = true;
  } catch { cleared = false; }
  const afterOk = stage().stats().lastError;
  // 子项拆开上报：组合布尔一旦为假，光看 actual 分不清是"没写入"、"没清除"还是"重装载没出画"，
  //   下一次红时 actual 自己就把原因写清楚（省一轮复现）
  const sub = [
    failed ? '失败被拒=yes' : '失败被拒=no',
    afterFail ? '错误已写入' : '错误未写入',
    cleared ? '错误已清除' : '错误未清除',
    `重装载 ratio=${(ok2.ratio * 100).toFixed(2)}%${ok2.ratio > MIN_RATIO ? '' : '（低于阈值）'}`,
  ].join('；');
  rec('成功装载清除上一次的错误', '#stage-canvas', '失败 → 成功',
    '失败后 lastError 非空；随后一次成功装载后 lastError 回到 null',
    `${sub}；失败后=${String(afterFail).slice(0, 30) || 'null'}；成功后=${String(afterOk).slice(0, 30) || 'null'}`,
    failed && !!afterFail && cleared && !afterOk && ok2.ratio > MIN_RATIO);
  }
}

// -------------------------------- 2c. DPR 四档 + MSAA 开→关→开（B4b 长期门禁）
{
  const hitDpr = await discover((m) => m.version === '3.8' && m.format === 'skel');
  if (!hitDpr) {
    const why = `环境里没有 3.8 skel 模型（${scanDigest(await scanAll())}）`;
    skip('DPR 四档', '#stage-canvas', 'backing store === CSS 尺寸 × 生效 DPR', why);
    skip('MSAA 开→关→开', '#stage-canvas', '每轮重建后仍出画、首末 ratio 一致', why);
  } else {
  const model = hitDpr.model;
  const docA = await stage().buildDocument(model);
  await stage().load({ document: docA });
  await waitFrames(2, { timeoutMs: 12000, label: '装载/重建后推进 2 帧' });   // 原固定等待：等模型首帧绘制（信号）
  const cv = document.getElementById('stage-canvas');
  const rows = [];
  // 判据：backing store 必须等于「CSS 尺寸 × 引擎当前生效 DPR」，且 drawingBuffer 与画布一致
  //   （DPR 生效但 viewport 没跟上时，表现为只有一部分画面在动，肉眼很难发现）
  for (const mode of ['1', '1.5', '2', 'auto']) {
    stage().setDprMode(mode);
    await waitFrames(2, { label: '改动后推进 2 帧' });   // 原固定等待：等下一帧把 DPR 改动画出来
    const e = stage().debug().engine;
    const eff = e.getEffectiveDpr(window.devicePixelRatio || 1);
    rows.push({ mode, want: Math.round(cv.clientWidth * eff), got: cv.width, eff, buf: e.gl.drawingBufferWidth });
  }
  const bad = rows.filter((r) => Math.abs(r.got - r.want) > 1 || r.buf !== r.got);
  rec('DPR 四档落到画布', '#stage-canvas', 'dprMode 1 / 1.5 / 2 / auto',
    'canvas.width === cssW × 生效DPR，且 drawingBuffer 与画布一致',
    rows.map((r) => `${r.mode}:${r.got}px(期望${r.want},dpr=${r.eff})`).join(' '),
    bad.length === 0);
  stage().setDprMode('auto');
  await waitFrames(2, { label: '改动后推进 2 帧' });   // 原固定等待：等下一帧把 DPR 改动画出来

  // MSAA：每次切换都重建上下文，重建后必须仍能出画、且首末 ratio 回到原值、contexts 不涨
  const seq = [];
  for (const on of [true, false, true]) {
    await stage().rebuildWithAntialias(on);
    await waitFrames(2, { timeoutMs: 12000, label: '装载/重建后推进 2 帧' });   // 原固定等待：重建后等首帧
    const e = stage().debug().engine;
    const attrs = e && e.gl && e.gl.getContextAttributes ? e.gl.getContextAttributes() : {};
    seq.push({
      aa: !!attrs.antialias,
      ratio: stage().samplePixels().ratio,
      ctx: stage().stats().contexts,
      canvases: document.querySelectorAll('canvas').length,
      err: stage().stats().lastError,
    });
  }
  const restored = Math.abs(seq[2].ratio - seq[0].ratio) < 0.01;
  rec('MSAA 开→关→开', '#stage-canvas', 'rebuildWithAntialias ×3',
    '每轮重建后仍出画；首末 ratio 一致（<1pt）；contexts 不泄漏；lastError=null',
    seq.map((s) => `aa=${s.aa} ratio=${(s.ratio * 100).toFixed(2)}% ctx=${s.ctx} 画布=${s.canvases} err=${s.err || 'null'}`).join(' | '),
    seq.every((s) => s.ratio > MIN_RATIO && !s.err) && restored && seq[0].ctx === 1);
  }
}

// ------------- 2d. 调试绘制八类 + 部件过滤 + 皮肤（B5 长期门禁，逐项要有实测证据）
{
  // 需要"有 slot/attachment 的 3.8 模型"——按结构条件发现，不按角色名
  const hitDbg = await discover((m) => m.version === '3.8' && m.format === 'skel');
  if (!hitDbg) {
    const why = `环境里没有 3.8 skel 模型（${scanDigest(await scanAll())}）`;
    skip('调试绘制逐项生效', '#stage-canvas', '至少 5 类产生可见绘制', why);
    skip('不可实现的调试项如实上报', '#stage-canvas', 'debugUnsupported 含 drawPoints', why);
    skip('皮肤列表/切换/未知皮肤', '#stage-canvas', '列表 === 骨架声明', why);
  } else {
  const model = hitDbg.model;
  const docA = await stage().buildDocument(model);
  await stage().load({ document: docA });
  await waitFrames(2, { timeoutMs: 12000, label: '装载/重建后推进 2 帧' });   // 原固定等待：等模型首帧绘制（信号）
  try { stage().pause(); stage().seek(0.5); } catch { /* 固定姿态才能比像素 */ }
  // 不能换：本段 stage 已 pause()（固定姿态才能比像素），帧计数不再推进，没有帧信号可等
  await sleep(220);
  const ratioOf = () => +stage().samplePixels().ratio.toFixed(4);
  const base = ratioOf();

  // 八类里"该模型有数据"的七类必须真的改变画面；关闭后必须回基线。
  //   points 不在此列：3.8/4.1 的 SkeletonDebugRenderer 都没有 drawPoints 属性（下面单独断言如实上报）
  const KEYS = ['bones', 'meshes', 'regions', 'clipping', 'hulls', 'paths', 'boundingBoxes'];
  const rows2 = [];
  for (const key of KEYS) {
    stage().setDebug({ [key]: true });
    // 不能换：本段 stage 已 pause()（固定姿态才能比像素），帧计数不再推进，没有帧信号可等
    await sleep(280);
    const on = ratioOf();
    stage().setDebug({ [key]: false });
    // 不能换：本段 stage 已 pause()（固定姿态才能比像素），帧计数不再推进，没有帧信号可等
    await sleep(220);
    rows2.push({ key, deltaPt: +((on - base) * 100).toFixed(2), back: Math.abs(ratioOf() - base) < 0.002 });
  }
  const effective = rows2.filter((r) => r.deltaPt > 0.05).length;
  rec('调试绘制逐项生效', '#stage-canvas', 'setDebug({key:true}) 逐个',
    '至少 5 类产生可见绘制（ratio 上升）且关闭后回到基线',
    `${rows2.map((r) => `${r.key}:${r.deltaPt > 0 ? '+' : ''}${r.deltaPt}pt${r.back ? '' : '(未复原)'}`).join(' ')} → 生效 ${effective}/7`,
    effective >= 5 && rows2.every((r) => r.back));

  // 运行时画不出来的调试项必须如实上报（不许静默）
  stage().setDebug({ points: true });
  // 不能换：本段 stage 已 pause()（固定姿态才能比像素），帧计数不再推进，没有帧信号可等
  await sleep(280);
  const unsupported = (stage().debug().engine.getRendererInfo().debugUnsupported) || [];
  stage().setDebug({ points: false });
  // 不能换：本段 stage 已 pause()（固定姿态才能比像素），帧计数不再推进，没有帧信号可等
  await sleep(200);
  rec('不可实现的调试项如实上报', '#stage-canvas', 'setDebug({points:true})',
    'debugUnsupported 必须含 drawPoints（该运行时没有 drawPoints 属性）',
    `debugUnsupported=${JSON.stringify(unsupported)}`,
    unsupported.includes('drawPoints'));

  // 部件过滤（setPartFilter）用例已移除：该功能按需求整项下线，舞台 API 一并删除，
  //   用例的主体不存在了，继续保留只会变成"测一个已不存在的接口"。
  //   引擎侧 setSlotFilter（更底层的能力）未删，仍可被子类能力复用。

  // 皮肤：列表与骨架声明一致；切 default 成功；不存在的皮肤必须返回 false 且不污染设置；fit 基准不被污染
  const e = stage().debug().engine;
  const declared = ((e.skeletonData && e.skeletonData.skins) || []).map((s) => s.name);
  const listed = stage().getSkins();
  const zoomBefore = stage().getView().userScale;
  const okDefault = stage().setSkin('default');
  // 不能换：本段 stage 已 pause()（固定姿态才能比像素），帧计数不再推进，没有帧信号可等
  await sleep(250);
  const okBogus = stage().setSkin('__no_such_skin__');
  // 不能换：本段 stage 已 pause()（固定姿态才能比像素），帧计数不再推进，没有帧信号可等
  await sleep(250);
  const zoomAfter = stage().getView().userScale;
  rec('皮肤列表/切换/未知皮肤', '#stage-canvas', "getSkins → setSkin('default') → setSkin('__no_such_skin__')",
    '列表 === 骨架声明；default 可切；未知皮肤返回 false 且 settings.skin 不被写脏；换皮肤不动 fit 基准',
    `declared=${JSON.stringify(declared)} listed=${JSON.stringify(listed)} okDefault=${okDefault} okBogus=${okBogus} settings.skin=${stage().stats().settings.skin} zoom ${zoomBefore}→${zoomAfter}`,
    declared.length === listed.length && declared.every((n, i) => n === listed[i])
      && okDefault === true && okBogus === false
      && stage().stats().settings.skin === 'default'
      && zoomBefore === zoomAfter);
  }
}

// ------------------------------- 2e. Live2D dpr 接线（切 overlayCanvas 尺寸 + PIXI resolution）
{
  // 不写死模型名/根名：遍历所有根问 /api/live2d/models，取第一个 Live2D 模型（名字只用于填搜索框）
  let l2dHit = null;
  const scanL = await scanAll();
  for (const r of scanL.roots) {
    try {
      const j = await (await fetch(`/api/live2d/models?root=${encodeURIComponent(r.id)}`)).json();
      const m = (j.models || [])[0];
      if (m) { l2dHit = { model: m, rootId: r.id }; break; }
    } catch { /* 该根没有 Live2D 接口/无模型，继续 */ }
  }
  if (!l2dHit) {
    skip('Live2D dpr 落到 PIXI 与画布', '#live2d-overlay-canvas',
      'resolution === 所选 dpr，且 overlay 画布宽 === cssW × dpr',
      `环境里没有 Live2D 模型（${scanDigest(scanL)}）`);
  } else {
  // 走 API 直装（与 anim-list 的 pickLive2d 同一手法）：
  //   名册不一定把 Live2D 模型渲染成角色/变体行（本机 '天命之子' 根有模型但 roster chars=0），
  //   靠点名册会永远 skip —— 而这一条要验的是 renderer('live2d').setSetting('dpr') 的接线，与名册无关。
  let switched = false;
  try {
    const doc = await window.__WEB__.surface.buildDocument({
      ...l2dHit.model, kind: 'live2d', rootId: l2dHit.rootId, rootName: l2dHit.model.rootName || '',
      entry: { url: l2dHit.model.modelUrl },
    });
    await window.__WEB__.state.currentRenderer.mount(doc);
    await waitFor(() => window.__WEB__.state.surface.stageMode() === 'live2d',
      { timeoutMs: 15000, label: '切到 Live2D 面' });
    switched = true;
  } catch (e) { switched = false; }
  if (!switched) {
    skip('Live2D dpr 落到 PIXI 与画布', '#live2d-overlay-canvas',
      'resolution === 所选 dpr，且 overlay 画布宽 === cssW × dpr',
      `Live2D 模型装载失败（${l2dHit.rootId}/${l2dHit.model.name}），无法验证 dpr 接线`);
  } else {
  const l2d = window.__WEB__.surface && window.__WEB__.surface.renderer
    ? window.__WEB__.surface.renderer('live2d')
    : null;
  const cv = document.getElementById('live2d-overlay-canvas');
  const rows3 = [];
  if (l2d && cv) {
    for (const dpr of ['1', '1.5', '2']) {
      const okSet = l2d.setSetting('dpr', dpr);
      // Live2D 走独立 overlay 循环，stage.debug().frames 数不到它 ⇒ 用**它自己的可观察结果**等：
      //   画布宽度应当变成 cssW × dpr（这正是本用例要断言的事实，等它到位比猜时间更准）。
      await waitFor(() => Math.abs(cv.width - Math.round(cv.clientWidth * Number(dpr))) <= 1,
        { timeoutMs: 2000, label: 'overlay 画布宽度跟上 dpr=' + dpr });
      rows3.push({
        dpr, okSet,
        resolution: +Number(l2d.getSetting('dpr')).toFixed(3),
        canvasW: cv.width,
        cssW: cv.clientWidth,
        want: Math.round(cv.clientWidth * Number(dpr)),
        got: Number(l2d.getSetting('dpr')) === Number(dpr),
      });
    }
    l2d.setSetting('dpr', 'auto');
    await waitFor(() => Number(l2d.getSetting('dpr')) > 0, { timeoutMs: 2000, label: 'dpr 复位为 auto' });   // 原固定等待：等 PIXI resolution/画布尺寸生效
  }
  rec('Live2D dpr 落到 PIXI 与画布', '#live2d-overlay-canvas', "setSetting('dpr', 1 / 1.5 / 2)",
    'renderer.resolution === 所选 dpr，且 overlay 画布宽 === cssW × dpr',
    rows3.map((r) => `dpr=${r.dpr}:resolution=${r.resolution} 画布=${r.canvasW}(期望${r.want})`).join(' '),
    rows3.length === 3 && rows3.every((r) => r.okSet === true && r.got && Math.abs(r.canvasW - r.want) <= 1));
  }
  }
}

// ------------------------------------------------------------ 汇总
const st = stage().stats();
return JSON.stringify({
  total: results.length,
  failed: results.filter((r) => !r.ok).length,
  // skip 与 fail 分开计数：skip = 环境缺数据（不计入 failed），但必须在汇总里可见
  skipped: results.filter((r) => r.skipped === true).length,
  summary: {
    ratio38: +((r38 && r38.ratio) || 0).toFixed(4),
    ratio41: +((r41 && r41.ratio) || 0).toFixed(4),
    runtimeKeys: st.runtimeKeys,
    loads: st.loads,
    disposes: st.disposes,
    contexts: st.contexts,
    canvases: qa('canvas').length,
  },
  results,
}, null, 1);
})();
