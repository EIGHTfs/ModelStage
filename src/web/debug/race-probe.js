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
  for (let i = 0; i < 80 && qa('[data-game-key]').length === 0; i += 1) await sleep(150);

  const trajectory = [];
  let last = '__init__';
  const watch = setInterval(() => {
    const v = stageEl.getAttribute('data-stage-mode');
    if (v !== last) { last = v; trajectory.push(v); }
  }, 30);

  const click = async (kw, root) => {
    const input = q('#roster-search');
    input.value = kw;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    for (let i = 0; i < 140 && qa('[data-model-id]').length === 0; i += 1) await sleep(150);
    await sleep(250);
    const row = qa('[data-model-id]').find((n) => n.dataset.rootId === root);
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

  const L = ['abeikelongbi', 'azurlane'];
  const S = ['aijier', 'azurlane_spine'];
  const rounds = [];
  for (const gap of [60, 150, 300]) {
    for (const pair of [[L, S, 'spine'], [S, L, 'live2d']]) {
      const [first, second, wantMode] = pair;
      trajectory.length = 0;
      const a = await click(first[0], first[1]);
      await sleep(gap);
      const b = await click(second[0], second[1]);
      // 等到切换真正落定（首次装载 Live2D 要按需加载运行时库，固定 sleep 会误判成"还在 loading"）
      for (let i = 0; i < 120 && stageEl.getAttribute('data-stage-mode') === 'loading'; i += 1) await sleep(150);
      await sleep(1200);
      const s = w.stage.stats();
      const ratio = await contentRatio();
      rounds.push({
        gapMs: gap,
        lastClick: second[1],
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
