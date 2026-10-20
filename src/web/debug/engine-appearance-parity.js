// engine-appearance-parity.js —— B4a 外观层新旧像素对照（PMA 四档 / 滤镜 12 档 / rebuildTextures / 降级）
//
// 用法（两种引擎各跑一次，再外部比表）：
//   node tool/check-console.mjs http://127.0.0.1:8804/                     --json --script src/web/debug/engine-appearance-parity.js
//   node tool/check-console.mjs http://127.0.0.1:8804/?legacy-engine=1     --json --script src/web/debug/engine-appearance-parity.js
//
// 测量口径（关键）：每次采样前都 pause + seek 到同一时刻 —— 动画在跑会让 signature 每次都不同，
//   "切回 original 是否复原"就没法判断；固定姿态后 ratio / 平均色 / signature 才可比。

(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stage = window.__WEB__.stage;
  const engine = () => stage.debug().engine;
  const qs = new URLSearchParams(window.location.search);
  const TARGETS = [
    { root: 'azurlane_spine', name: 'aijierM' },
    { root: 'bd2', name: 'npc000001' },
  ];
  const PMA_MODES = ['auto', 'premultiplied', 'straight', 'upload'];
  const FILTERS = ['original', 'bright', 'soft', 'mono', 'warm', 'cool', 'fresh', 'sepia', 'tealorange', 'cyber', 'negative', 'woodcut'];

  /** 固定姿态（停播放 + seek 到 t），让多次像素采样可比 */
  async function pose(t = 0.5) {
    try { stage.pause(); } catch { /* 忽略 */ }
    try { stage.seek(t); } catch { /* 忽略 */ }
    await sleep(220);
  }

  /** ratio + 平均色（只算不透明像素）+ 稀疏签名 */
  function pixels() {
    const sp = stage.samplePixels();
    const gl = engine() && engine().gl;
    let mean = null;
    if (gl) {
      try {
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let i = 0; i < buf.length; i += 4) {
          if (buf[i + 3] <= 8) continue;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n += 1;
        }
        mean = n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null;
      } catch { mean = null; }
    }
    return { ratio: +(sp.ratio || 0).toFixed(4), signature: sp.signature || null, mean };
  }

  const out = {
    engine: qs.get('legacy-engine') === '1' ? 'legacy' : 'new',
    models: [], pma: [], filters: [], restore: {}, rebuild: {}, degraded: {},
  };

  for (const target of TARGETS) {
    const cat = await (await fetch(`/api/catalog?root=${target.root}`, { cache: 'no-store' })).json();
    const entry = (cat.entries || []).find((x) => x.name === target.name);
    if (!entry) { out.models.push({ ...target, error: 'not found' }); continue; }
    // INV-10：被取代属预期业务错误，这里必须接住 —— 直接 await 抛出会变成未捕获拒绝，污染零错误门禁
    let loadError = null;
    try {
      await stage.load({ root: entry.rootId, model: entry });
    } catch (e) {
      loadError = String((e && e.message) || e);
    }
    await sleep(1000);
    out.models.push({ root: target.root, name: target.name, version: entry.version, loadError });
    if (loadError) continue;

    // ---- PMA 四档（逐档重建，固定姿态后采样）
    for (const mode of PMA_MODES) {
      try { await engine().rebuildTextures(mode); } catch { /* 记在 lastError */ }
      await pose();
      const px = pixels();
      const info = engine().pmaInfo || {};
      out.pma.push({
        model: target.name, mode,
        effective: info.effectiveMode || null, blend: info.blendMode || null,
        degraded: !!info.degraded, gpuUnpack: !!engine().gpuUnpack,
        detection: engine().pmaDetection ? engine().pmaDetection.reason : null,
        ratio: px.ratio, mean: px.mean, lastError: stage.stats().lastError,
      });
    }

    // ---- 滤镜 12 档（先回 auto，再逐个切；最后回 original 看是否复原）
    try { await engine().rebuildTextures('auto'); } catch { /* 忽略 */ }
    await pose();
    const base = pixels();
    out.restore[target.name] = { beforeFilter: base, afterOriginal: null };
    for (const id of FILTERS) {
      engine().setFilter(id);
      await sleep(180);
      const px = pixels();
      out.filters.push({ model: target.name, id, ratio: px.ratio, mean: px.mean, signature: px.signature, lastError: stage.stats().lastError });
    }
    engine().setFilter('original');
    await pose();
    out.restore[target.name].afterOriginal = pixels();

    // ---- rebuildTextures 后 vs 从头加载（动画名 / 皮肤 / ratio）
    await pose();
    const fresh = { anim: engine().animationName, skins: engine().getSkins().slice(0, 3), ratio: pixels().ratio };
    await engine().rebuildTextures('auto');
    await pose();
    out.rebuild[target.name] = {
      fresh,
      afterRebuild: { anim: engine().animationName, skins: engine().getSkins().slice(0, 3), ratio: pixels().ratio },
    };

    // ---- 降级：强制"运行时不支持直通"，straight 应转 upload + degraded + warn
    const before = (window.__WEB__.stageLog || []).length;
    engine().supportsStraightAlpha = false;
    await engine().rebuildTextures('straight');
    const info = engine().pmaInfo || {};
    out.degraded[target.name] = {
      effective: info.effectiveMode || null, blend: info.blendMode || null,
      degraded: !!info.degraded, needPremultiply: !!info.needPremultiply,
      warn: ((window.__WEB__.stageLog || []).slice(before).map((x) => x.line).find((l) => /直通/.test(l)) || null),
      lastError: stage.stats().lastError,
    };
    engine().supportsStraightAlpha = true;
    await engine().rebuildTextures('auto');
  }

  return out;
})()
