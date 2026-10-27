// ============================================================================
// tool/lib/runtime-package.mjs —— 运行时的**取包/校验/解压/落盘**核心（零依赖）
//
// 为什么拆出这一层：CLI（tool/fetch-runtimes.mjs）只该管参数与交互；
//   版本表、tgz 下载、tar 解析、integrity 校验、落盘这些"确定性逻辑"放这里，
//   才能被单测直接调用（不必起 CLI），也避免 CLI 文件膨胀到几百行。
//
// 合规边界（硬约束，别放宽）：
//   · Spine 4.0.1+  ：官方 npm。我们只是**替用户从上游取**，不托管、不再分发二进制。
//   · Spine 3.x     ：npm 没有（最早 4.0.1）⇒ 只引导（spine3Guide），不自取。
//   · Live2D Cubism Core：官方只在官网提供且下载须同意专有许可 ⇒ 只引导（live2dGuide），绝不代下。
//
// 实现约束：
//   · 解压自己算（zlib.gunzipSync + 自研 tar 头解析），**不 shell 出 tar**
//     —— 跨平台（Windows 未必有 tar）+ 项目踩过 noexec / tool-self-detection 的坑。
//   · 校验用 registry 给的 dist.integrity（sha512），比自己算 sha256 权威。
//   · 先写 .tmp-* 再 rename：校验或解压失败时磁盘上不留半截 js
//     （半截 js 被当合法运行时加载，报错会莫名其妙）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 项目根（tool/lib/ 的上两级） */
const ROOT = path.resolve(__dirname, '..', '..');

/** registry 元数据地址（scope 包必须把 / 写成 %2f，否则 404） */
const META_URL = 'https://registry.npmjs.org/@esotericsoftware%2fspine-webgl';
/** npm 上 Spine 运行时的最早版本（3.x 从来没发过，所以 3.x 只能引导） */
export const MIN_VERSION = '4.0.1';
/** 网络超时：元数据与 tarball 都只有几百 KB */
const META_TIMEOUT_MS = 15000;
const TARBALL_TIMEOUT_MS = 60000;
/** tar 块大小 */
const TAR_BLOCK = 512;

// ---------------- 错误分类 ----------------

/**
 * 造一个带分类码的错误（CLI 靠 code 决定退出码与人话）。
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
export function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---------------- 目录与版本 ----------------

/**
 * 数据根：与 web.sh / serve.mjs / 各 resolver 同一口径
 * （MODELSTAGE_DATA_ROOT 覆盖，缺省项目根）。
 * @returns {string}
 */
export function defaultDataRoot() {
  const env = (process.env.MODELSTAGE_DATA_ROOT || '').trim();
  return env ? path.resolve(env) : ROOT;
}

/**
 * 下载落点根：<dataRoot>/runtimes（内部再分 spine/<ver>/ 与 live2d/<ver>/）。
 * 下载物**绝不能**落进 src/*-runtimes/：npx / 只读安装场景下项目目录可能只读或临时。
 * @param {string} [dataRoot]
 * @returns {string}
 */
export function runtimesRoot(dataRoot) {
  return path.join(dataRoot || defaultDataRoot(), 'runtimes');
}

/**
 * 按语义版本比较（数值比较，不是字符串比较）。
 * 为什么不能用字符串排序：4.0.10 会被排到 4.0.9 前面，用户看到的"最新版"就是错的。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareSemver(a, b) {
  const left = String(a).split('.').map((x) => Number(x) || 0);
  const right = String(b).split('.').map((x) => Number(x) || 0);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 从 registry 版本表里挑出可下载的版本（>= 4.0.1），按语义版本升序。
 * **不硬编码任何版本表** —— 版本清单永远以 registry 为准。
 * @param {string[]} all registry 的 versions 键
 * @returns {string[]}
 */
export function pickDownloadableVersions(all) {
  return (Array.isArray(all) ? all : [])
    .filter((v) => /^\d+\.\d+\.\d+/.test(String(v)))
    .filter((v) => compareSemver(v, MIN_VERSION) >= 0)
    .sort(compareSemver);
}

// ---------------- 网络 ----------------

/**
 * 取 registry 元数据。
 * @param {{metaUrl?: string}} [opts]
 * @returns {Promise<object>}
 */
export async function fetchMeta(opts = {}) {
  const url = opts.metaUrl || META_URL;
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(META_TIMEOUT_MS) });
  } catch (e) {
    throw fail('network', `网络不可达：取版本元数据失败（${(e && e.message) || e}）`);
  }
  if (res.status === 404) throw fail('not-found', `registry 上找不到这个包（HTTP 404）：${url}`);
  if (!res.ok) throw fail('http', `取版本元数据失败：HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw fail('parse', `版本元数据不是合法 JSON：${(e && e.message) || e}`);
  }
}

/**
 * 下载 tarball 到内存。
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function downloadTarball(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS) });
  } catch (e) {
    throw fail('network', `网络不可达：下载 tarball 失败（${(e && e.message) || e}）`);
  }
  if (res.status === 404) throw fail('not-found', `tarball 地址 404（版本或地址不对）：${url}`);
  if (!res.ok) throw fail('http', `下载 tarball 失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw fail('empty', '下载到的 tarball 是空的');
  return buf;
}

// ---------------- tar 解析（零依赖） ----------------

/**
 * 读 tar 头的八进制数字字段。
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} len
 * @returns {number}
 */
function readOctal(buf, start, len) {
  const raw = buf.subarray(start, start + len).toString('latin1').replace(/\0.*$/, '').trim();
  if (!raw) return 0;
  // GNU base-256：最高位置 1 时是二进制大整数（少见；出现了返回 0 交给后续跳过，不瞎算）
  if (raw.charCodeAt(0) & 0x80) return 0;
  const n = parseInt(raw, 8);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 读 C 字符串字段（以 \0 截断）。
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} len
 * @returns {string}
 */
function readStr(buf, start, len) {
  return buf.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
}

/**
 * 解析 tar 字节流，产出所有**普通文件**。
 *
 * 只实现真正会遇到的几种 typeflag：
 *   '0' / '\0' 普通文件 · '5' 目录（跳过） · 'L' GNU 长文件名（覆盖下一个条目名）
 *   'x' pax 扩展头（含 path= 覆盖名）· 'g' 全局 pax（跳过）
 * **不认识的一律按 size 跳过、绝不猜** —— 跳错一个字节后面全错位，这是自研 tar 最常见的 bug。
 *
 * @param {Buffer} tar
 * @param {(entry: {name: string, data: Buffer}) => void} onFile
 */
export function walkTar(tar, onFile) {
  let off = 0;
  let longName = '';
  let paxPath = '';
  while (off + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(off, off + TAR_BLOCK);
    // 全 0 块 = 归档结束（规范是两个连续 0 块；确认下一块也空就停，避免把中间空洞当结束）
    if (header.every((b) => b === 0)) {
      const next = off + TAR_BLOCK;
      const nextEmpty = next + TAR_BLOCK > tar.length
        || tar.subarray(next, next + TAR_BLOCK).every((b) => b === 0);
      if (nextEmpty) return;
      off = next;
      continue;
    }
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = readStr(header, 345, 155);
    let name = readStr(header, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const dataStart = off + TAR_BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    const nextOff = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    if (type === 'L') {
      // GNU 长名：本块数据就是下一个条目的名字
      longName = data.toString('utf8').replace(/\0.*$/s, '');
    } else if (type === 'x') {
      // pax 扩展头：形如 "26 path=package/dist/iife/x.js\n"
      const text = data.toString('utf8');
      const m = /(?:^|\n)\d+ path=([^\n]+)/.exec(text);
      if (m) paxPath = m[1];
    } else if (type === '0' || type === '\0' || type === '7') {
      const finalName = paxPath || longName || name;
      if (finalName) onFile({ name: finalName, data: Buffer.from(data) });
      longName = '';
      paxPath = '';
    } else {
      // 目录 / 链接 / 全局 pax：不产生数据，但要把待用的长名清掉
      longName = '';
      paxPath = '';
    }
    off = nextOff;
  }
}

/**
 * 从 tgz 里取出需要的文件（IIFE 构建 + LICENSE）。
 *
 * 为什么挑 dist/iife/ 而不是 package.json 的 main：
 *   main 指向 dist/index.js，那是 **ESM**（`export * from "./AssetManager"`），
 *   而我们的加载器要的是**挂全局 `var spine` 的 IIFE 构建**（浏览器当普通脚本执行；
 *   node 侧把源码包成表达式取回 spine 对象，见 tool/lib/spine-runtime.mjs 的沙箱加载）。
 *   包里恰好自带 dist/iife/spine-webgl.js，所以固定取它。
 *
 * @param {Buffer} tgz
 * @returns {{js: {path: string, text: string}, license: {path: string, text: string}|null, files: string[]}}
 */
export function extractRuntime(tgz) {
  let raw;
  try {
    raw = zlib.gunzipSync(tgz);
  } catch (e) {
    throw fail('gunzip', `解压 tarball 失败（不是合法 gzip）：${(e && e.message) || e}`);
  }
  const wanted = [];
  const all = [];
  walkTar(raw, ({ name, data }) => {
    all.push(name);
    if (/\/dist\/iife\/spine-webgl(\.[\w-]+)?\.js$/.test(name) && !name.endsWith('.map')) {
      wanted.push({ name, data });
    } else if (/\/LICENSE(\.(md|txt))?$/i.test(name)) {
      wanted.push({ name, data });
    }
  });

  // 优先非压缩版（与项目里既有的 spine-webgl-x.y.js 同构，排查时人类可读）
  const jsCandidates = wanted.filter((w) => /\.js$/.test(w.name));
  const pick = jsCandidates.find((w) => /\/spine-webgl\.js$/.test(w.name)) || jsCandidates[0];
  if (!pick) {
    throw fail('layout', `包结构里没有 dist/iife/spine-webgl*.js（找到 ${all.length} 个文件）。`
      + '上游可能改了打包布局，需要更新选取规则（不要退回 main：那是 ESM）');
  }
  const text = pick.data.toString('utf8');
  if (!/var\s+spine\s*=/.test(text)) {
    throw fail('layout', `取到的 ${pick.name} 不是"挂全局 spine"的构建（首 120 字符：${text.slice(0, 120)}）`);
  }
  const lic = wanted.find((w) => /LICENSE/i.test(w.name)) || null;
  return {
    js: { path: pick.name, text },
    license: lic ? { path: lic.name, text: lic.data.toString('utf8') } : null,
    files: all,
  };
}

/**
 * 剥掉 `//# sourceMappingURL=...` 行。
 * 为什么必须剥：.map 不落地，留着这行会让 devtools 为一个不存在的文件报 404（噪音）。
 * @param {string} text
 * @returns {string}
 */
export function stripSourceMapRef(text) {
  return text.replace(/^\/\/[#@]\s*sourceMappingURL=.*$/gm, '').replace(/\n{3,}/g, '\n\n');
}

// ---------------- 校验与落盘 ----------------

/**
 * 校验 tarball 的 sha512（npm 的 dist.integrity 形如 `sha512-<base64>`）。
 * @param {Buffer} buf
 * @param {string} integrity
 * @param {(alg: string, buf: Buffer) => string} [hashFn] 测试可注入
 */
export function verifyIntegrity(buf, integrity, hashFn) {
  const m = /^(sha512|sha256|sha1)-(.+)$/.exec(String(integrity || '').trim());
  if (!m) throw fail('integrity-format', `integrity 字段格式不认识：${String(integrity).slice(0, 60)}`);
  const [, alg, want] = m;
  const got = hashFn
    ? hashFn(alg, buf)
    : crypto.createHash(alg).update(buf).digest('base64');
  if (got !== want) {
    throw fail('integrity', `integrity 校验失败（${alg}）：期望 ${want.slice(0, 16)}… 实际 ${got.slice(0, 16)}…`);
  }
}

/**
 * 原子写：先写同目录 .tmp-*，成功后 rename。
 * @param {string} file
 * @param {string|Buffer} content
 */
function writeAtomic(file, content) {
  const tmp = path.join(path.dirname(file), `.tmp-${process.pid}-${path.basename(file)}`);
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不掩盖原始错误 */ }
    throw fail('write', `落点不可写：${file}（${(e && e.message) || e}）`);
  }
}

/**
 * 下载并落地一个 Spine 版本。
 * @param {string} version
 * @param {{dir?: string, dataRoot?: string, metaUrl?: string, log?: (s: string) => void}} opts
 * @returns {Promise<{version: string, dir: string, jsFile: string, licenseFile: string|null, sourceFile: string}>}
 */
export async function fetchSpine(version, opts = {}) {
  const log = opts.log || (() => {});
  const meta = await fetchMeta(opts);
  const versions = meta && meta.versions ? meta.versions : {};
  const info = versions[version];
  if (!info) {
    // 版本表有 200+ 条，全列出来终端就没法看 ⇒ 只报最新几个 + 总数
    const avail = pickDownloadableVersions(Object.keys(versions));
    const tailList = avail.slice(-6).join(' / ') || '(取不到版本表)';
    throw fail('version', `版本 ${version} 不存在。最近的可下载版本：${tailList}`
      + `（共 ${avail.length} 个，用 --list 查看全部）`);
  }
  const tarball = info.dist && info.dist.tarball;
  const integrity = info.dist && info.dist.integrity;
  if (!tarball) throw fail('meta', `registry 没给 ${version} 的 dist.tarball`);
  if (!integrity) throw fail('meta', `registry 没给 ${version} 的 dist.integrity（无法校验，拒绝落地）`);

  log(`下载 ${version} …`);
  const tgz = await downloadTarball(tarball);
  log(`校验 integrity（${Math.round(tgz.length / 1024)}KB）…`);
  verifyIntegrity(tgz, integrity);

  const { js, license, files } = extractRuntime(tgz);
  const clean = stripSourceMapRef(js.text);

  const root = opts.dir || runtimesRoot(opts.dataRoot);
  const targetDir = path.join(root, 'spine', version);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (e) {
    throw fail('write', `落点不可写：${targetDir}（${(e && e.message) || e}）`);
  }

  // 文件名必须归一化成 resolver 认的名字：它按 `spine-webgl-<ver>.js` 拼路径，
  //   包里原名是 dist/iife/spine-webgl.js —— 不归一化就是"文件在、但引擎找不到"
  const jsFile = path.join(targetDir, `spine-webgl-${version}.js`);
  writeAtomic(jsFile, clean);

  let licenseFile = null;
  if (license) {
    licenseFile = path.join(targetDir, 'LICENSE');
    writeAtomic(licenseFile, license.text);
  }

  const sourceFile = path.join(targetDir, 'SOURCE.json');
  writeAtomic(sourceFile, JSON.stringify({
    package: '@esotericsoftware/spine-webgl',
    version,
    tarball,
    integrity,
    packageFile: js.path,
    packageFiles: files.length,
    fetchedAt: new Date().toISOString(),
    tool: 'tool/fetch-runtimes.mjs',
    note: 'Spine Runtimes 使用 Esoteric Software 自定义许可（非 MIT）；使用方需自行遵守，商用需 Spine 授权。',
  }, null, 2));

  log(`已落地：${jsFile}`);
  return { version, dir: targetDir, jsFile, licenseFile, sourceFile };
}
