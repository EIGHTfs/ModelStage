// debug/upload.js —— 把页面内存里的调试日志上传到服务端「调试日志上传」按钮的行为
//
// 背景：调试日志只在内存（刷新即丢），用户描述问题时说不清、AI 又读不到浏览器。这个按钮把
//   当前日志一次性交给服务端落盘（data/logs/），之后 AI 用 GET /api/diag/uploads 就能自己查到文件。
//
// 数据源**只从统一工厂取**（infra/log.js 的 recent）：那里的内容已经同时包含
//   stageStatus 状态行（tag='stage'）与 diag 事件（tag='diag'）——这正是"走工厂化"的验证点，
//   也避免出现"面板有、上传缺"的半套日志。
//
// 三态必须可见（不许静默）：
//   上传中 → 按钮禁用 + 文案「上传中…」
//   成功   → 「已上传：diag-….json（N 条 / X KB）」
//   失败   → 「上传失败：<原因>（点按钮重试）」
// 同时把状态写进 <html> 的 dataset（logUpload / logUploadMsg / logUploadCount），供自动化断言。

import { postJson } from '../infra/api.js';
import { recent } from '../infra/log.js';

/** 一次最多捞多少条：与后端默认 maxCount 对齐（后端还会按配置再截一次） */
const MAX_UPLOAD_COUNT = 5000;

/** 字节数转人话（KB/MB 保留一位小数） */
function humanBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

/**
 * 收集要上传的日志与上下文。
 * meta 是为了"离线也能定位"：哪一版、哪个页面、什么模型/渲染器、什么浏览器。
 * @param {() => object} readState 取应用状态的函数（避免本模块直接依赖 context.js）
 * @returns {{logs: object[], meta: object, truncated: boolean}}
 */
export function collectPayload(readState) {
  const all = recent();                       // 工厂里的全部（受 LOG_LIMIT 限制）
  const truncated = all.length > MAX_UPLOAD_COUNT;
  const logs = truncated ? all.slice(-MAX_UPLOAD_COUNT) : all;
  let app = {};
  try { app = (typeof readState === 'function' ? readState() : null) || {}; } catch { app = {}; }
  const model = app.selectedModel || null;
  const meta = {
    version: app.version || '',
    url: typeof location !== 'undefined' ? location.href : '',
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    at: Date.now(),
    model: model ? (model.id || model.name || null) : null,
    renderer: app.renderer || null,
    count: logs.length,
    clientTruncated: truncated,
  };
  return { logs, meta, truncated };
}

/**
 * 建一个上传器：把按钮与状态文本接起来。
 * @param {{
 *   button: HTMLButtonElement,
 *   statusEl?: HTMLElement,
 *   readState?: () => object,
 *   post?: (path: string, body: object) => Promise<any>,
 * }} opts
 * @returns {{run: () => Promise<object|null>, state: () => string, destroy: () => void}}
 */
export function createUploader(opts) {
  const { button, statusEl } = opts;
  const readState = opts.readState;
  const post = typeof opts.post === 'function' ? opts.post : postJson;
  let current = 'idle';
  let lastResult = null;

  /** 统一写状态：按钮文案/禁用、状态文本、<html> dataset 三处同源 */
  function paint(next, text) {
    current = next;
    if (button) {
      button.disabled = next === 'uploading';
      // 文案用独立 span（避免把图标冲掉）：没有就退回纯文本
      const label = button.querySelector('[data-upload-label]');
      const word = next === 'uploading' ? '上传中…' : '上传日志';
      if (label) label.textContent = word;
      else button.textContent = word;
      button.setAttribute('aria-busy', String(next === 'uploading'));
    }
    if (statusEl) {
      statusEl.textContent = text || '';
      statusEl.hidden = !text;
    }
    if (typeof document !== 'undefined' && document.documentElement) {
      const ds = document.documentElement.dataset;
      ds.logUpload = next;
      ds.logUploadMsg = text || '';
    }
  }

  /** 执行一次上传（幂等：上传中再点无效） */
  async function run() {
    if (current === 'uploading') return null;
    const { logs, meta } = collectPayload(readState);
    if (!logs.length) {
      paint('fail', '上传失败：当前还没有日志可上传');
      return null;
    }
    paint('uploading', `上传中…（${logs.length} 条）`);
    try {
      const res = await post('/api/diag/upload', { logs, meta });
      if (!res || res.ok !== true) throw new Error((res && res.error) || '服务端未确认');
      lastResult = res;
      const extra = res.truncated ? '（服务端按上限截断）' : '';
      paint('ok', `已上传：${res.file}（${res.count} 条 / ${humanBytes(res.bytes)}）${extra}`);
      if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.dataset.logUploadCount = String(res.count);
        document.documentElement.dataset.logUploadFile = String(res.file || '');
      }
      return res;
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      paint('fail', `上传失败：${reason}（点按钮重试）`);
      return null;
    }
  }

  return {
    run,
    state: () => current,
    lastResult: () => lastResult,
    /** 复位到空闲（重新打开面板/清空日志时用） */
    reset: () => paint('idle', ''),
  };
}
