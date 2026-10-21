// diag-hud.js —— 渲染诊断 HUD（仅 URL 带 `?diag=1` 时创建）
//
// 为什么做成独立模块：诊断面板只读、零依赖、且不在正常路径上；
//   单独一个文件便于审查「它绝不参与渲染决策」，也便于将来整文件删除。
//
// 用法（在 createLive2DStage 内）：
//   installDiagHud({ getRendererInfo: rendererInfo, readCanvasPixels, overlayCanvasId });
// 行为：不带 `diag=1` ⇒ 什么都不创建；带 ⇒ 右下角面板，每 500ms 刷新。

/**
 * 安装诊断 HUD。
 * @param {{
 *   getRendererInfo: () => object|null,
 *   readCanvasPixels: (points: Array<[number, number]>) => Promise<Array<object>|null>,
 *   overlayCanvasId: string,
 *   log?: (message: string) => void,
 * }} options
 */
export function installDiagHud({ getRendererInfo, readCanvasPixels, overlayCanvasId, log } = {}) {
  try {
    if (typeof document === 'undefined') return;
    // 只认 diag=1；其它参数一律不启用（对正常渲染零影响）
    const enabled = /[?&]diag=1(?:&|$)/.test(window.location.search || '');
    if (!enabled) return { stop() {} };
    if (document.getElementById('l2d-diag')) return;

    const box = document.createElement('div');
    box.id = 'l2d-diag';
    box.style.cssText = [
      'position:fixed',
      'right:8px',
      'bottom:8px',
      'z-index:99999',
      'max-width:480px',
      'background:rgba(12,14,16,.93)',
      'color:#e8e8e8',
      'border:1px solid #3a3f45',
      'border-radius:6px',
      'font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'padding:8px 10px',
      'white-space:pre-wrap',
      'box-shadow:0 4px 16px rgba(0,0,0,.45)',
    ].join(';');

    const head = document.createElement('div');
    head.style.cssText = 'cursor:pointer;color:#8fd;margin-bottom:4px;user-select:none';
    head.textContent = '【渲染诊断】点此折叠';
    const body = document.createElement('div');
    box.appendChild(head);
    box.appendChild(body);
    document.body.appendChild(box);

    let collapsed = false;
    head.addEventListener('click', () => {
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : 'block';
      head.textContent = collapsed ? '【渲染诊断】已折叠（点此展开）' : '【渲染诊断】点此折叠';
    });

    /** 尺寸描述：attr / client */
    const sizes = (el) => (el ? `${el.width}x${el.height} / ${el.clientWidth}x${el.clientHeight}` : 'n/a');

    const update = async () => {
      if (collapsed) return;
      try {
        const stageEl = document.getElementById('stage');
        const spineCv = document.getElementById('stage-canvas');
        const overlayCv = document.getElementById(overlayCanvasId);
        const ri = (() => {
          try { return getRendererInfo ? getRendererInfo() : null; } catch { return null; }
        })();
        // 尺寸链路诊断：真机旋转后看这两行就能分清
        //   「事件没发（计数全 0）」/「发了但 DOM 尺寸没变（geo 与 dom 相同且都旧）」
        //   /「尺寸变了但下游没跟上（geo≠dom 或 Δ 很大）」
        // 放在「模型未就绪」早退之前：旋转排查常常发生在装载前/装载失败时，这两行必须始终可见。
        const ss = (() => {
          try { return window.__WEB__ && window.__WEB__.surface ? window.__WEB__.surface.stats() : null; } catch { return null; }
        })();
        const ssRows = [];
        if (ss && ss.trigger) {
          const t = ss.trigger;
          const dom = ss.domSize ? `${ss.domSize.width}x${ss.domSize.height}` : 'n/a';
          const age = ss.lastChangeAt ? `${Math.round(performance.now() - ss.lastChangeAt)}ms前` : 'n/a';
          ssRows.push(`geo ${ss.size.width}x${ss.size.height}   dom ${dom}   dpr ${ss.dpr}   末次变化 ${age}`);
          ssRows.push(`trig ro ${t.resizeObserver} / resize ${t.resize} / orient ${t.orientationchange} / vv ${t.visualViewport}`);
        }
        if (!ri) {
          body.textContent = [
            `等待模型…（app 尚未就绪）`,
            `viewport ${window.innerWidth}x${window.innerHeight}`,
            ...ssRows,
          ].join('\n');
          return;
        }
        const rows = [
          `viewport ${window.innerWidth}x${window.innerHeight}`,
          `stageMode ${stageEl ? stageEl.dataset.stageMode || 'n/a' : 'n/a'}   #stage.bg ${stageEl ? getComputedStyle(stageEl).backgroundColor : 'n/a'}`,
          `#stage-canvas    attr/client ${sizes(spineCv)}   visibility ${spineCv ? getComputedStyle(spineCv).visibility : 'n/a'}`,
          `#live2d-overlay  attr/client ${sizes(overlayCv)}   bg ${overlayCv ? getComputedStyle(overlayCv).backgroundColor : 'n/a'}`,
          `PIXI  w ${ri ? ri.width : '?'} h ${ri ? ri.height : '?'} res ${ri ? ri.resolution : '?'}`,
          ...ssRows,
        ];
        if (overlayCv && overlayCv.clientWidth > 0 && overlayCv.clientHeight > 0 && readCanvasPixels) {
          const w = overlayCv.clientWidth;
          const h = overlayCv.clientHeight;
          const px = await readCanvasPixels([[4, 4], [w - 4, 4], [4, h - 4], [w - 4, h - 4], [Math.floor(w / 2), Math.floor(h / 2)]]);
          if (px) {
            const alphaAt = (i) => (px[i] && px[i].rgba ? px[i].rgba[3] : '?');
            rows.push(`calls ${ri?.clearCalls ?? '?'} / bufFv ${ri?.clearBufferCalls?.fv ?? '?'} / bufFi ${ri?.clearBufferCalls?.fi ?? '?'} / wrMask ${(ri?.colorWriteMask || []).map((v) => (v ? 1 : 0)).join('') || '?'} / ctxAlpha ${ri?.contextAlpha === true ? 1 : ri?.contextAlpha === false ? 0 : '?'}`);
          }
        }
        body.textContent = rows.join('\n');
      } catch (err) {
        body.textContent = `diag error: ${err && err.message ? err.message : err}`;
      }
    };

    update();
    const timer = setInterval(() => { try { update(); } catch (e) { if (window.console && console.warn) console.warn('[diag-hud]', e && e.message); } }, 500);
    return { stop() { try { clearInterval(timer); } catch { /* 忽略 */ } } };
    if (typeof log === 'function') log('诊断 HUD 已启用（?diag=1）');
  } catch {
    /* 诊断失败不影响渲染 */
  }
}

export default installDiagHud;
