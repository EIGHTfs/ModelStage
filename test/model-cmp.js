// model-cmp.js（测试脚本）—— 三模型 × 四状态的 MODELCMP 对比
//
// 用途：按 docs/设计/相机.md 第 4 节，对「异常模型 + 2 个正常模型」
//   在同一流程下采集同一组指标（默认 / 0.6×+拖 200 / 0.3× / 1.5×），一次性输出全部记录。
// 用法：node tool/check-console.mjs http://127.0.0.1:8804/ --json --script test/model-cmp.js
//
// 为什么要在缩放/拖动后再采：默认 fit 恰好把画面挡住，异常在这些状态下才暴露。

(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const w = window.__WEB__;
  const stage = q('#stage');
  const mode = () => (stage ? stage.getAttribute('data-stage-mode') : null);

  const targets = [
    { char: 'abeikelongbi', modelId: 'abeikelongbi_3', label: '异常' },
    { char: 'adaerbote', modelId: 'adaerbote_2', label: '正常' },
    { char: 'aijier', modelId: 'aijier_2', label: '正常' },
  ];

  const errors = [];
  const collectOne = async (t) => {
    const input = q('#roster-search');
    if (!input) throw new Error('没有搜索框');
    input.value = t.char;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  // 不能换：轮询间隔（等名册出变体行）
    for (let i = 0; i < 120 && !qa('[data-model-id]').length; i += 1) await sleep(120);
  // 不能换：轮询间隔（同上）
    await sleep(250);
    const row = qa('[data-model-id]').find((n) => n.dataset.modelId === t.modelId)
      || qa('[data-model-id]').find((n) => /live2d-/.test(n.dataset.modelId || ''));
    if (!row) {
      errors.push(`${t.modelId}: 名册里没有该变体`);
      return;
    }
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // 等装载完成：mode=live2d 且该模型已有 default 记录
    let ok = false;
    for (let i = 0; i < 120; i += 1) {
  // 不能换：切换后的观察窗口（无完成信号，等画面落定再截）
      await sleep(150);
      const has = (w.modelCmp || []).some((r) => r.id && row.dataset.modelId && r.id.includes(t.modelId) && r.tag === 'default');
      if (mode() === 'live2d' && has) { ok = true; break; }
    }
    if (!ok) {
      const hint = (q('#stage-hint') || {}).textContent || '';
      errors.push(`${t.modelId}: 未进入 live2d（mode=${mode()}，hint=${hint.slice(0, 60)}）`);
      return;
    }
    const cam = w.renderer && w.renderer.camera;
    // 不能换：截图前的采样余量（collectCmp 没有完成信号，只能给一小段余量让画面落定）
    const shot = async (tag) => { await sleep(250); try { w.live2d.collectCmp(tag); } catch (e) { errors.push(`${t.modelId}/${tag}: ${e.message}`); } };
    // ② 缩小到 0.6× 并拖动 200px
    try { cam.zoomTo(0.6); cam.panBy(200, 0); } catch (e) { errors.push(`${t.modelId}/zoom0.6: ${e.message}`); }
    await shot('zoom0.6_pan200');
    // ③ 缩小到 0.3×
    try { cam.zoomTo(0.3); } catch (e) { errors.push(`${t.modelId}/zoom0.3: ${e.message}`); }
    await shot('zoom0.3');
    // ④ 放大到 1.5×
    try { cam.zoomTo(1.5); } catch (e) { errors.push(`${t.modelId}/zoom1.5: ${e.message}`); }
    await shot('zoom1.5');
    try { cam.reset(); } catch { /* 忽略 */ }
  // 不能换：对比前的观察窗口
    await sleep(150);
  };

  for (const t of targets) {
    try {
      await collectOne(t);
    } catch (e) {
      errors.push(`${t.modelId}: ${e.message}`);
    }
  }
  return { errors, records: (w.modelCmp || []).slice(-40) };
})()
