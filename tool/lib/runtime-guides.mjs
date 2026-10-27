// ============================================================================
// tool/lib/runtime-guides.mjs —— 缺运行时时的**引导文案**（3.x / Live2D 只引导，不自取）
//
// 为什么单独一个文件：这些是"给用户看的文本"，与取包/校验逻辑无关；
//   同一段文案要同时被 CLI（终端）与 resolver（错误消息，会进调试日志）使用，
//   放独立文件后两边 import 同一份 —— 各写一套必然出现"终端说 A、日志说 B"。
// ============================================================================

import path from 'node:path';
import { MIN_VERSION, runtimesRoot } from './runtime-package.mjs';

/**
 * Spine 3.x 的获取引导。
 *
 * 为什么不是"去 GitHub releases 下载"：实测该 repo **releases 数为 0**，
 *   用户按要求去只会看到空页面。可用的是 tag 下的 build 产物（实测 3.6/3.7/3.8 均 200）。
 * @param {string} version
 * @param {string} dataRoot
 * @returns {string}
 */
export function spine3Guide(version, dataRoot) {
  const v = version || '3.8';
  const dir = path.join(runtimesRoot(dataRoot), 'spine', v);
  const url = `https://raw.githubusercontent.com/EsotericSoftware/spine-runtimes/${v}/spine-ts/build/spine-webgl.js`;
  return [
    `缺少 Spine ${v} 运行时。官方 npm 未发布 3.x（最早只有 ${MIN_VERSION}），只能自备：`,
    `  mkdir -p "${dir}"`,
    `  curl -L -o "${path.join(dir, `spine-webgl-${v}.js`)}" \\`,
    `    ${url}`,
    '  （该文件是"挂全局 spine"的构建，可以直接被引擎加载；上面已按目标名保存，无需再改名）',
    `  也可以把已有的 spine-webgl.js 放到该目录并命名为 spine-webgl-${v}.js，或设 SPINE_RUNTIME_DIR`,
    '提示：4.x 可以直接用本工具下载（node tool/fetch-runtimes.mjs --spine 4.1），3.x 官方没有 npm 包。',
  ].join('\n');
}

/**
 * Live2D Cubism Core 的获取引导（**只引导，绝不代下**）。
 * @param {string} dataRoot
 * @param {string} [verDir] 目标版本目录名（如 v6-6.5.3）
 * @returns {string}
 */
export function live2dGuide(dataRoot, verDir) {
  const dir = path.join(runtimesRoot(dataRoot), 'live2d', verDir || '<版本目录>');
  return [
    '缺少 Live2D Cubism Core 运行时。请到官网下载：',
    '  https://www.live2d.com/en/sdk/download/web/',
    `把下载到的主库文件放到：${dir}`,
    '  需要 live2dcubismcore.js（以及 pixi.min.js / index.min.js，若使用 pixi-live2d-display）',
    '本工具不会代下 Live2D：官方下载需要你本人同意专有软件许可，代替下载等于绕过该环节。',
  ].join('\n');
}

/**
 * 打印用的许可提示（每次下载前都要让用户看见）。
 * @param {string} version
 * @returns {string}
 */
export function licenseNotice(version) {
  return [
    `Spine ${version} 运行时来自官方 npm 包 @esotericsoftware/spine-webgl。`,
    '许可：Spine Runtimes License Agreement（Esoteric Software 自定义许可，**非 MIT**）。',
    '  · 使用即表示你同意该许可；商用需要 Spine 授权（详见落地目录里的 LICENSE）。',
    '  · 本工具只是替你从上游取，不托管、不再分发任何运行时二进制。',
  ].join('\n');
}
