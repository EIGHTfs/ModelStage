// app/topbar-actions.js —— 顶栏两个"真动作"：截图导出、影院模式
//
// 为什么单独成模块：main.js 只做装配（≤400 行），动作实现放这里，顶栏与面板无关。
//
// 两条实现要点：
//   ① 截图不能直接 canvas.toDataURL()：WebGL 默认不保留绘制缓冲，合成后内容可能已经没了。
//      这里走 gl.readPixels（刚画完的同一任务里取），再翻转到 2D 画布，最后 toBlob 下载。
//      Live2D 覆盖层叠加同一张图上（drawImage），所以两种渲染器都能截到。
//   ② 影院模式只是切 <html data-cinema>，显隐与位移全在 style.css 里；JS 只负责状态切换
//      与"静止数秒淡出播放条"（data-idle），不碰任何几何。

import { stage } from './context.js';
import { stageStatus } from './status.js';
import { repaintActive } from '../render/playback.js';

/** 影院模式下静止多久把播放条淡出（毫秒）；鼠标一动就回来 */
const CINEMA_IDLE_MS = 3000;

let idleTimer = null;
/** 静止唤醒的监听器引用：单独存，不能挂在定时器句柄上（浏览器里 timeout id 是数字） */
let idleWake = null;

/** 文件名里的模型名：去掉路径分隔与空白，避免下载文件名非法 */
function safeName(raw) {
  return String(raw || 'model')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .slice(0, 48) || 'model';
}

/** 时间戳：YYYYMMDD-HHMMSS（本地时间，用户看文件名就能认时间） */
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 把舞台画布读成 2D 画布（含 Live2D 覆盖层）。
 * @returns {{canvas: HTMLCanvasElement, width: number, height: number, nonEmpty: number}|null}
 */
function composeStageCanvas() {
  const stageCanvas = document.getElementById('stage-canvas');
  if (!stageCanvas) return null;
  const w = stageCanvas.width;
  const h = stageCanvas.height;
  if (!w || !h) return null;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  let nonEmpty = 0;
  // 主画布：优先读像素（WebGL 缓冲不保留，readPixels 是唯一可靠取法）
  const gl = stageCanvas.getContext('webgl2') || stageCanvas.getContext('webgl');
  if (gl && typeof gl.readPixels === 'function') {
    try {
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const img = ctx.createImageData(w, h);
      // WebGL 原点在左下：逐行翻转，否则导出的图是上下颠倒的
      for (let y = 0; y < h; y += 1) {
        const src = (h - 1 - y) * w * 4;
        img.data.set(buf.subarray(src, src + w * 4), y * w * 4);
      }
      for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 8) nonEmpty += 1;
      ctx.putImageData(img, 0, 0);
    } catch { /* 读像素失败继续尝试 drawImage 兜底 */ }
  }
  if (nonEmpty === 0) {
    try { ctx.drawImage(stageCanvas, 0, 0); } catch { /* 兜底也失败就导出空白图 */ }
  }
  // Live2D 覆盖层：可见时叠上去（同一坐标系，origin 都在左上）
  const overlay = document.getElementById('live2d-overlay-canvas');
  if (overlay && overlay.width && overlay.height && overlay.offsetParent !== null) {
    try {
      const tmp = document.createElement('canvas');
      tmp.width = overlay.width;
      tmp.height = overlay.height;
      const tctx = tmp.getContext('2d');
      const ogl = overlay.getContext('webgl2') || overlay.getContext('webgl');
      if (tctx && ogl) {
        const obuf = new Uint8Array(overlay.width * overlay.height * 4);
        ogl.readPixels(0, 0, overlay.width, overlay.height, ogl.RGBA, ogl.UNSIGNED_BYTE, obuf);
        const oimg = tctx.createImageData(overlay.width, overlay.height);
        for (let y = 0; y < overlay.height; y += 1) {
          const src = (overlay.height - 1 - y) * overlay.width * 4;
          oimg.data.set(obuf.subarray(src, src + overlay.width * 4), y * overlay.width * 4);
        }
        tctx.putImageData(oimg, 0, 0);
        ctx.drawImage(tmp, 0, 0, out.width, out.height);
      }
    } catch { /* 覆盖层叠加失败不影响主画布 */ }
  }
  return { canvas: out, width: w, height: h, nonEmpty };
}

/**
 * 截图导出：canvas → blob → 触发下载；文件名带模型名与时间戳。
 * 内容同时留在 __WEB__.screenshotExport 供自动化断言（无头环境无法确认真实落盘）。
 */
export function exportScreenshot() {
  // 先让**当前渲染面**补一帧：暂停时引擎/渲染循环都停着，不补就会截到旧帧或空帧
  try { repaintActive(state.surface); } catch { /* 画不出新帧就用现成缓冲 */ }
  try {
    const engine = stage && stage.debug ? stage.debug().engine : null;
    if (engine && typeof engine.presentFirstFrame === 'function') engine.presentFirstFrame();
  } catch { /* 引擎不支持就用现成缓冲 */ }
  const composed = composeStageCanvas();
  if (!composed) {
    stageStatus('截图失败：舞台画布尚未就绪', 'error');
    return false;
  }
  // 模型名优先取名册选中的那个；直连 stage.load（脚本/恢复）时没有 selectedModel，
  //   回落到引擎侧记的模型名，避免导出成 modelstage-model-*.png 这种没信息量的名字
  let modelName = (window.__WEB__ && window.__WEB__.state && window.__WEB__.state.selectedModel)
    ? window.__WEB__.state.selectedModel.name : null;
  if (!modelName) {
    try {
      const snap = stage && typeof stage.stats === 'function' ? stage.stats() : null;
      modelName = (snap && snap.model && snap.model.name) || null;
    } catch { modelName = null; }
  }
  const model = modelName || 'model';
  const filename = `modelstage-${safeName(model)}-${stamp(new Date())}.png`;
  const finish = (bytes) => {
    window.__WEB__ && (window.__WEB__.screenshotExport = {
      filename, bytes, width: composed.width, height: composed.height, nonEmpty: composed.nonEmpty,
    });
    document.documentElement.dataset.screenshot = `${filename}|${bytes}`;
    stageStatus(`已导出截图：${filename}（${composed.width}×${composed.height}，${bytes} 字节）`, 'info', { show: true });
  };
  try {
    if (typeof composed.canvas.toBlob === 'function') {
      composed.canvas.toBlob((blob) => {
        const bytes = blob ? blob.size : 0;
        if (blob) {
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = filename;
          document.body.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        finish(bytes);
      }, 'image/png');
      return true;
    }
    // 极老环境兜底：dataURL 直接当下载地址
    const href = composed.canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = href;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    finish(href.length);
    return true;
  } catch (err) {
    stageStatus(`截图失败：${(err && err.message) || err}`, 'error');
    return false;
  }
}

/** 影院模式下的静止淡出：鼠标一动把 data-idle 切回 off，静止 CINEMA_IDLE_MS 后再切 on */
function startIdleWatch() {
  stopIdleWatch();
  const root = document.documentElement;
  const wake = () => {
    root.dataset.idle = 'off';
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (root.dataset.cinema === 'on') root.dataset.idle = 'on';
    }, CINEMA_IDLE_MS);
  };
  wake();
  idleWake = wake;
  window.addEventListener('pointermove', wake, { passive: true });
  window.addEventListener('pointerdown', wake, { passive: true });
}

function stopIdleWatch() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (idleWake) {
    window.removeEventListener('pointermove', idleWake);
    window.removeEventListener('pointerdown', idleWake);
    idleWake = null;
  }
  document.documentElement.dataset.idle = 'off';
}

/**
 * 影院模式开/关：只切 <html data-cinema>，显隐与位移全交给 style.css。
 * @param {boolean} [force] 传 true/false 强制设值；不传则翻转
 * @returns {boolean} 切换后的状态
 */
export function toggleCinema(force) {
  const root = document.documentElement;
  const next = typeof force === 'boolean' ? force : root.dataset.cinema !== 'on';
  root.dataset.cinema = next ? 'on' : 'off';
  const btn = document.getElementById('btn-cinema');
  if (btn) btn.setAttribute('aria-pressed', String(next));
  syncSidebarButtons(); // 影院模式隐藏了两侧栏，两个开关的高亮也要跟着灭/亮
  if (next) startIdleWatch(); else stopIdleWatch();
  stageStatus(`影院模式：${next ? '开（隐藏顶栏与左右栏，Esc 退出）' : '关'}`, 'info', { show: true });
  return next;
}

/**
 * 边栏"实际可见"判定：收起是靠 translateX 移出视口，所以看几何而不是看状态变量。
 * 这样影院模式、面板头「收起菜单」、按钮切换、CSS 过渡中都能得到同一口径的答案。
 * @param {HTMLElement|null} el
 * @param {'left'|'right'} side
 * @returns {boolean}
 */
function isPanelOnScreen(el, side) {
  if (!el) return false;
  const root = document.documentElement;
  // ① 状态量优先：影院模式 / 收起状态 / is-hidden 都是"确定要隐藏"，过渡动画没走完也该立刻判定为隐藏，
  //    否则点击后要等 transitionend 才更新高亮，读起来像"慢了半拍"。
  const declaredHidden = side === 'left'
    ? (root.dataset.cinema === 'on' || root.dataset.left === 'off' || el.classList.contains('is-hidden'))
    : (root.dataset.cinema === 'on' || root.dataset.right === 'off');
  if (declaredHidden) return false;
  // ② 几何兜底：没有被状态量宣布隐藏时，以真实位置为准（窗口过窄/面板被外部样式挤掉等情况）
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  return side === 'left' ? r.right > 8 : r.left < window.innerWidth - 8;
}

/**
 * 把顶栏两个边栏开关的高亮同步到边栏的真实显隐状态。
 * 高亮只认这一处结论：按钮自己 toggle class 不算，影院模式关掉边栏时也必须跟着灭。
 * @returns {{leftOn: boolean, rightOn: boolean}}
 */
export function syncSidebarButtons() {
  const leftOn = isPanelOnScreen(document.getElementById('left-panel'), 'left');
  const rightOn = isPanelOnScreen(document.getElementById('right-panel'), 'right');
  const btnLeft = document.getElementById('btn-library');
  const btnRight = document.getElementById('btn-menu');
  if (btnLeft) {
    btnLeft.setAttribute('aria-pressed', String(leftOn)); // 高亮态由 aria-pressed 驱动（样式在 components.css）
    btnLeft.setAttribute('aria-expanded', String(leftOn));
    btnLeft.dataset.sidebarState = leftOn ? 'shown' : 'hidden';
  }
  if (btnRight) {
    btnRight.setAttribute('aria-pressed', String(rightOn));
    btnRight.dataset.sidebarState = rightOn ? 'shown' : 'hidden';
  }
  document.documentElement.dataset.leftState = leftOn ? 'on' : 'off';
  document.documentElement.dataset.rightState = rightOn ? 'on' : 'off';
  return { leftOn, rightOn };
}

/**
 * 订阅所有会改变边栏显隐的动作（按钮/影院/收起/过渡/缩放），统一回调同步高亮。
 * 只绑一次；CSS 过渡结束再同步一次，避免"点完立刻读位置"读到动画中间值。
 */
export function bindSidebarStateSync() {
  if (bindSidebarStateSync.done) return false;
  bindSidebarStateSync.done = true;
  for (const id of ['left-panel', 'right-panel']) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('transitionend', () => syncSidebarButtons());
  }
  window.addEventListener('resize', () => syncSidebarButtons());
  syncSidebarButtons();
  return true;
}

/**
 * 右侧控制面板显隐（顶栏「菜单」与面板头「收起菜单」共用一个开关）。
 * 状态写在 <html data-right>，位移与淡出全在 style.css；顶栏按钮 aria-pressed 同步，
 * 这样"面板被收起后怎么找回来"有明确答案：顶栏「菜单」。
 * @param {boolean} [force] 传 true/false 强制设值；不传则翻转
 * @returns {boolean} 切换后的状态（true=显示）
 */
export function toggleRightPanel(force) {
  const root = document.documentElement;
  const open = typeof force === 'boolean' ? force : root.dataset.right === 'off';
  root.dataset.right = open ? 'on' : 'off';
  syncSidebarButtons(); // 高亮跟随真实显隐（不在这里自己写 class）
  stageStatus(`右侧控制面板：${open ? '显示' : '收起（顶栏「菜单」可再打开）'}`, 'info', { show: true });
  return open;
}

/**
 * 影院模式的快速开关：Esc 退出 + **舞台中心区域双击**进出。
 * 为什么限定中心区域：四角/边缘留给拖拽与面板操作，避免"想微调视角却把界面收掉"。
 * 双击判定用原生 dblclick（两次 click 间隔由浏览器判定），无需自己计时。
 */
export function bindCinemaKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.documentElement.dataset.cinema === 'on') toggleCinema(false);
  });

  const stageEl = document.getElementById('stage');
  if (stageEl) {
    stageEl.addEventListener('dblclick', (e) => {
      const box = stageEl.getBoundingClientRect();
      if (!box.width || !box.height) return;
      // 中心 60% 区域内才算"中心双击"
      const nx = (e.clientX - box.left) / box.width;
      const ny = (e.clientY - box.top) / box.height;
      const inCenter = nx > 0.2 && nx < 0.8 && ny > 0.2 && ny < 0.8;
      if (!inCenter) return;
      e.preventDefault();
      toggleCinema();
    });
  }
}
