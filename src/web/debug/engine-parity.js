// engine-parity.js —— 新旧引擎逐项对照（相机 + 动画），两种模式各跑一遍
//
// 用法：
//   node tool/check-console.mjs http://127.0.0.1:8804/                 --json --script src/web/debug/engine-parity.js
//   node tool/check-console.mjs http://127.0.0.1:8804/?legacy-engine=1 --json --script src/web/debug/engine-parity.js
// 判据（外部比较）：
//   · 相机：userScale / camera.zoom / position / viewport 逐步 ===
//   · 动画：动作名集合相等、当前动作名与时长 ===、seek 后 trackTime 差 < 0.016、defaultMix/timeScale/loop ===
//
// 为什么只读引擎内部状态：这些都是"对外可观测"的量，且两个引擎用的是同一套 spine 对象结构。

(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stage = window.__WEB__.stage;
  // 模型可通过 URL 指定：?parity-root=bd2&parity-model=npc000001（默认 azurlane_spine / aijierM）
  const qs = new URLSearchParams(window.location.search);
  const rootId = qs.get('parity-root') || 'azurlane_spine';
  const modelName = qs.get('parity-model') || 'aijierM';
  const cat = await (await fetch(`/api/catalog?root=${rootId}`)).json();
  const model = (cat.entries || []).find((x) => x.name === modelName);
  if (!model) return { error: `找不到 ${rootId}/${modelName}` };
  await stage.load({ root: model.rootId, model });
  for (let i = 0; i < 40 && !stage.stats().model; i += 1) await sleep(150);
  await sleep(600);

  const engine = () => stage.debug().engine;

  // ---------------------------------------------------------------- 相机段
  const camSnap = (step) => {
    const d = stage.debug();
    const e = d.engine;
    const cam = e && e.camera;
    return {
      step,
      userScale: e ? e.getCameraZoom() : null,
      camZoom: cam && cam.zoom !== undefined ? cam.zoom : null,
      posX: cam && cam.position ? cam.position.x : null,
      posY: cam && cam.position ? cam.position.y : null,
      vpW: cam ? (cam.viewportWidth ?? null) : null,
      vpH: cam ? (cam.viewportHeight ?? null) : null,
      lastError: d.lastError,
    };
  };
  const cam = stage.camera;
  const camera = [camSnap('load')];
  for (let i = 1; i <= 3; i += 1) { cam.zoomStep(1); camera.push(camSnap(`zoomStep(+1)#${i}`)); }
  for (let i = 1; i <= 2; i += 1) { cam.zoomStep(-1); camera.push(camSnap(`zoomStep(-1)#${i}`)); }
  cam.panBy(100, 50);
  camera.push(camSnap('panBy(100,50)'));
  cam.reset();
  camera.push(camSnap('reset'));

  // ---------------------------------------------------------------- 动画段
  /** 读当前 track 的可观测状态（两引擎结构一致：state.getCurrent(0)） */
  const animSnap = (step) => {
    const e = engine();
    const st = e && e.state;
    let tr = null;
    try { tr = st && typeof st.getCurrent === 'function' ? st.getCurrent(0) : null; } catch { tr = null; }
    const a = tr && tr.animation ? tr.animation : null;
    return {
      step,
      name: a ? a.name : null,
      duration: a ? (Number(a.duration) || 0) : null,
      trackTime: tr && typeof tr.trackTime === 'number' ? tr.trackTime : null,
      loop: tr ? !!tr.loop : null,
      timeScale: st && st.timeScale !== undefined ? st.timeScale : null,
      defaultMix: e && e.stateData ? e.stateData.defaultMix : null,
      lastError: stage.debug().lastError,
    };
  };

  const e0 = engine();
  const anims = ((e0 && e0.skeletonData && e0.skeletonData.animations) || [])
    .map((a) => ({ name: a.name, duration: Number(a.duration) || 0 }));
  const actions = anims.map((a) => a.name).sort();
  const timed = anims.filter((a) => a.duration > 0.01).sort((a, b) => b.duration - a.duration);
  const first = timed[0];
  const second = timed[1];
  const zero = anims.find((a) => a.duration <= 0.01);

  const animation = [{ step: 'actions', actions, lastError: stage.debug().lastError }];
  if (first) {
    stage.setAnimation(first.name, true);
    await sleep(250);
    animation.push(animSnap(`setAnimation(${first.name})`));
    // seek 必须"同步读"：sleep 会让主循环把 trackTime 推走，跨引擎比较就变成比"各自过了多久"
    for (const t of [0.5, 1.0, Math.max(0, first.duration - 0.1)]) {
      stage.seek(t);
      const snap = animSnap(`seek(${t.toFixed(2)})`);
      snap.target = t;
      snap.error = snap.trackTime === null ? null : Math.abs(snap.trackTime - t);
      animation.push(snap);
    }
  }
  if (second) {
    try { engine().setMixTime(0.2); } catch { /* 有的版本无此入口 */ }
    stage.setAnimation(second.name, true);
    await sleep(250);
    animation.push(animSnap(`mix0.2→setAnimation(${second.name})`));
  }
  try { engine().setSpeed(2); } catch { /* 忽略 */ }
  await sleep(120);
  animation.push(animSnap('setSpeed(2)'));
  try { engine().setLoop(false); } catch { /* 忽略 */ }
  await sleep(120);
  animation.push(animSnap('setLoop(false)'));
  if (zero) {
    stage.setAnimation(zero.name, true);
    await sleep(400);
    animation.push(animSnap(`zero-duration(${zero.name}, ${zero.duration}s)`));
  } else {
    animation.push({ step: 'zero-duration', skipped: true });
  }

  return {
    engine: qs.get('legacy-engine') === '1' ? 'legacy' : 'new',
    model: { root: rootId, name: modelName },
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    camera,
    animation,
  };
})()
