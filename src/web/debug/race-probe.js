// race-probe.js —— 竞态验收探针（跨 kind 连点，last-wins 后终态必须非空白）
//
// 判空白的方式（重要）：
//   · 终态 spine 面 → stage.samplePixels().ratio（读的是 Spine WebGL 画布）
//   · 终态 Live2D 面 → 不能用 samplePixels（那是 Spine 画布，此时被隐藏），
//     改用 live2d.collectCmp() 的 extract.opaqueRatio（PIXI extract 出模型实际画出来的像素占比）
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const w = window.__WEB__;
  const stageEl = q('#stage');
  for (let i = 0; i < 80 && qa('[data-group-key]').length === 0; i += 1) await sleep(150);

  const trajectory = [];
  let last = '__init__';
  const watch = setInterval(() => {
    const v = stageEl.getAttribute('data-stage-mode');
    if (v !== last) { last = v; trajectory.push(v); }
  }, 30);

  // 取样不写死任何资源根/模型名：从**页面当前已加载的数据**里各找一条 Spine 与 Live2D。
  //   页面没有已加载角色时，先点第一个游戏的「加载」（这是用户在页面上的等价动作，不是硬编码）。
  const pickSample = async () => {
    if (qa('[data-model-id]').length === 0) {
      const loadBtn = q('#roster-list .tree-game button');
      if (loadBtn) loadBtn.click();
      for (let i = 0; i < 600 && qa('[data-model-id]').length === 0; i += 1) await sleep(100);
    }
    const rows = qa('[data-model-id]');
    const labelOf = (row) => (row.textContent || '');
    const spineRow = rows.find((row) => /\bspine\b/i.test(labelOf(row)));
    const live2dRow = rows.find((row) => /live2d/i.test(labelOf(row)));
    const idOf = (row) => (row ? { modelId: row.dataset.modelId, rootId: row.dataset.rootId || '' } : null);
    return { spine: idOf(spineRow), live2d: idOf(live2dRow) };
  };

  const clickById = async (ref) => {
    if (!ref || !ref.modelId) return false;
    let row = qa('[data-model-id]').find((n) => n.dataset.modelId === ref.modelId);
    if (!row) {                                  // 行被折叠/重渲染过：展开一次再找
      const group = q(`[data-group-key].tree-game`);
      if (group) group.click();
      for (let i = 0; i < 60 && !row; i += 1) { await sleep(100); row = qa('[data-model-id]').find((n) => n.dataset.modelId === ref.modelId); }
    }
    if (!row) return false;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  };

  /** 终态"画面上有没有东西"的量化：按当前面选口径 */
  const contentRatio = async () => {
    if (stageEl.getAttribute('data-stage-mode') === 'live2d') {
      const rec = w.live2d.collectCmp('race-probe');
      const ex = rec && rec.extract;
      return ex && typeof ex.opaqueRatio === 'number' ? +ex.opaqueRatio.toFixed(4) : null;
    }
    return +w.stage.samplePixels().ratio.toFixed(4);
  };

  const sample = await pickSample();
  if (!sample.spine || !sample.live2d) {
    clearInterval(watch);
    return { failed: 1, rounds: [], skipped: true,
      reason: `页面里找不到同一批已加载数据中的 Spine 与 Live2D 各一条（spine=${JSON.stringify(sample.spine)} live2d=${JSON.stringify(sample.live2d)}）` };
  }
  const L = sample.live2d;
  const S = sample.spine;
  const rounds = [];
  for (const gap of [60, 150, 300]) {
    for (const pair of [[L, S, 'spine'], [S, L, 'live2d']]) {
      const [first, second, wantMode] = pair;
      trajectory.length = 0;
      const a = await clickById(first);
      await sleep(gap);
      const b = await clickById(second);
      // 等到切换真正落定（首次装载 Live2D 要按需加载运行时库，固定 sleep 会误判成"还在 loading"）
      for (let i = 0; i < 120 && stageEl.getAttribute('data-stage-mode') === 'loading'; i += 1) await sleep(150);
      await sleep(1200);
      const s = w.stage.stats();
      const ratio = await contentRatio();
      rounds.push({
        gapMs: gap,
        lastClick: second.modelId,
        clicked: [a, b],
        mode: stageEl.getAttribute('data-stage-mode'),
        wantMode,
        modeOk: stageEl.getAttribute('data-stage-mode') === wantMode,
        live2dActive: !!(w.live2d && w.live2d.isActive()),
        contentRatio: ratio,
        nonBlank: ratio !== null && ratio > 0.05,
        lastError: s.lastError,
        stageReady: document.documentElement.dataset.stageReady,
        hadLoading: trajectory.includes('loading'),
        visibleFacesAtEnd: qa('#stage canvas').filter((c) => getComputedStyle(c).visibility !== 'hidden'
          && getComputedStyle(c.parentElement || c).display !== 'none').length,
        trajectory: trajectory.slice(0, 10).join('>'),
      });
    }
  }
  clearInterval(watch);
  const logs = (w.stageLog || []).slice(-10).map((x) => `${x.level}:${x.line}`.slice(0, 88));
  const failed = rounds.filter((r) => !r.modeOk || !r.nonBlank || r.lastError || !r.hadLoading).length;
  return { failed, rounds, logs };
})()
