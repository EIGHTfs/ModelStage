// spine/runtime-hint.js —— 把「缺运行时怎么补」拼成一句可读提示
//
// 为什么 hint 要从服务端拿：提示里最有用的那条是**落地目录的绝对路径**，
//   而数据根（dataRoot）只有服务端知道 —— 前端自己拼只能写"某个目录"，用户还得猜。
//   服务端在 GET /spine-runtimes/index.json 的 runtimeHint 字段里给出模板，前端只做版本号替换。
//
// 为什么单独一个模块：canvas-runtime.js 与 runtimes.js 两条加载路径都要用它，
//   复制两份必然漂移（同一句话在两个文件里各说各话，是本项目反复栽过的坑）。
import { getJson } from '../infra/api.js';

/** hint 缓存（60s）：只在"加载失败"时才需要它，但失败可能连续发生，别每次都问服务端 */
const CACHE_TTL_MS = 60000;
let cache = null;   // { at:number, hint:object|null }

/**
 * 取服务端给的运行时提示模板（失败返回 null，绝不因此抛错）。
 * @returns {Promise<object|null>}
 */
export async function loadRuntimeHint() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.hint;
  let hint = null;
  try {
    const j = await getJson('/spine-runtimes/index.json', { cache: 'no-store' });
    hint = (j && j.runtimeHint) || null;
  } catch {
    hint = null;   // 拿不到就退回"没有 hint"的降级文案
  }
  cache = { at: Date.now(), hint };
  return hint;
}

/** 模板占位替换：服务端给的模板里用 {ver} 表示版本号 */
function fill(tpl, ver) {
  return String(tpl || '').split('{ver}').join(String(ver));
}

/** Spine 3.x 判断（3.x 官方没有 npm 包，只能给出 curl 自备的引导） */
function isSpine3(ver) {
  return String(ver || '').trim().startsWith('3.');
}

/**
 * Spine 运行时缺失的可读提示。
 * @param {string} ver 版本号（如 '4.1'）
 * @param {object|null} hint 服务端给的模板
 * @param {number|null} status HTTP 状态（拿得到就带上，方便判断是"没这个版本"还是"服务端没起来"）
 * @returns {string}
 */
export function spineMissingHint(ver, hint, status) {
  const h = hint || {};
  const head = `运行时 ${ver} 加载失败${status ? `（HTTP ${status}）` : ''}。`;
  if (isSpine3(ver)) {
    const lines = [head, `缺少 Spine ${ver} 运行时。官方 npm 未发布 3.x（最早 4.0.1），只能自备：`];
    if (h.spine3Curl) lines.push(`  ${fill(h.spine3Curl, ver)}`);
    if (h.spine3Note) lines.push(`  （${h.spine3Note}）`);
    return lines.join('\n');
  }
  const lines = [head, `缺少 Spine ${ver} 运行时。可执行：${fill(h.spineFetch || 'node tool/fetch-runtimes.mjs --spine {ver}', ver)}`];
  if (h.spineTarget) lines.push(`  （或把 spine-webgl-${ver}.js 放到 ${fill(h.spineTarget, ver)}）`);
  return lines.join('\n');
}

/**
 * Live2D 运行时缺失的可读提示。
 * `serverError` 是服务端 503/404 响应体里的 error 文本（已包含官网 URL 与目标目录）。
 * @param {string} url 加载失败的脚本地址
 * @param {string} [serverError]
 * @returns {string}
 */
export function live2dMissingHint(url, serverError) {
  const head = `Live2D 运行时加载失败：${url}`;
  return serverError ? `${head}\n${serverError}` : head;
}
