// engine-b1.js（测试脚本）—— B1 验收：新引擎按真实取样判定
//
// 判据（两条同时满足才算过）：
//   ① samplePixels().ratio > 0.05 —— 真的画出内容（不拿 frames / 不报错当证据）
//   ② stats().lastError === null —— 渲染循环里没有"被 catch 掉"的每帧失败
// 覆盖：3.8 → 4.1 → 3.8 版本往返（每一步都重新判定，防止"第一次能画、切回来坏了"）。
// 用法：node tool/check-console.mjs http://127.0.0.1:8804/ --json --script test/engine-b1.js

(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stage = window.__WEB__.stage;
  const results = [];

  /**
   * 全库扫描（/api/roots → 每根 /api/spine/models），按**版本结构**发现模型，不按名字/根名。
   * ⚠️ 环境事实：/api/roots 的 kind 全是 'spine'（含 Live2D 根），root 名还可能重名 ⇒ 只按 name 分组用。
   */
  async function scanAll() {
    const out = { roots: [], items: [], errors: [] };
    try {
      const rs = ((await (await fetch('/api/roots', { cache: 'no-store' })).json()).roots) || [];
      out.roots = rs.filter((r) => r.enabled !== false);
    } catch (e) { out.errors.push(`/api/roots：${e.message}`); }
    for (const r of out.roots) {
      try {
        const j = await (await fetch(`/api/spine/models?root=${encodeURIComponent(r.id)}`, { cache: 'no-store' })).json();
        for (const m of (j.models || [])) out.items.push({ ...m, rootId: r.id, rootName: r.name });
      } catch (e) { out.errors.push(`${r.id}：${e.message}`); }
    }
    return out;
  }

  const scan = await scanAll();
  const byVer = {};
  for (const m of scan.items) byVer[m.version || '?'] = (byVer[m.version || '?'] || 0) + 1;
  const digest = `扫了 ${scan.roots.length} 个根、共 ${scan.items.length} 个模型；版本分布 ${JSON.stringify(byVer)}`;
  const findVer = (v) => scan.items.find((m) => m.version === v);   // 结构条件：版本号

  const m38 = findVer('3.8');
  const m41 = findVer('4.1');
  // 4 步：两个版本各一次、再各往返一次。缺哪个版本就只跳过**相关那几步**（不整套跳过）
  const steps = [
    { label: '3.8', model: m38, need: '3.8' },
    { label: '4.1', model: m41, need: '4.1' },
    { label: '3.8（往返）', model: m38, need: '3.8' },
    { label: '4.1（往返）', model: m41, need: '4.1' },
  ];

  for (const step of steps) {
    const model = step.model;
    if (!model) {
      // 环境缺该版本 ⇒ skip（不是 fail）。原因带上扫描摘要，能区分"真没数据"和"发现逻辑写错"
      results.push({
        step: step.label, ok: true, skipped: true,
        error: `skipped：环境里没有 v${step.need} 的模型（${digest}）`,
      });
      continue;
    }
    try {
      const doc = await stage.buildDocument(model);   // 传条目本身（root 只用于展示）
      await stage.load({ document: doc });
    } catch (e) {
      results.push({ step: step.label, model: model.name, ok: false, error: `load 抛错：${e.message}` });
      continue;
    }
    // 等两帧：装载完成不代表首帧已经画出来。用 rAF 当信号（渲染循环本身就是 rAF 驱动的），
    //   不再盲等 600ms —— 慢机器不够、快机器白等。
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const st = stage.stats();
    let sample = null;
    try { sample = stage.samplePixels(); } catch (e) { sample = { ratio: null, error: e.message }; }
    const ratio = sample && typeof sample.ratio === 'number' ? +sample.ratio.toFixed(4) : null;
    const err = st.lastError;
    results.push({
      step: step.label,
      model: model.name,
      version: model.version,
      runtimeVersion: st.runtimeVersion,
      ratio,
      lastError: err,
      canvas: [st.settings && st.settings.dpr, document.querySelector('#stage-canvas').width, document.querySelector('#stage-canvas').height],
      ok: ratio !== null && ratio > 0.05 && !err,
    });
  }
  const failed = results.filter((r) => !r.ok).length;
  const skipped = results.filter((r) => r.skipped === true).length;
  return { total: results.length, failed, skipped, scan: digest, results };
})()
