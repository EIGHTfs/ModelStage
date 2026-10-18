#!/usr/bin/env node
// shot-compare.mjs — 双站点快速截图对比工具
//
// 用法：
//   node tool/shot-compare.mjs                      # 默认对比 8803 主站 vs 8804 复刻版（各截当前页）
//   node tool/shot-compare.mjs --click              # 截图前先在两站各点一个模型（复刻版点列表首项）
//   node tool/shot-compare.mjs --only rb            # 只截复刻版
//   node tool/shot-compare.mjs --only main          # 只截主站
//
// 输出：/tmp/compare-<时间戳>/{main.png, rebuild.png}，并用 ffmpeg 拼一张左右对照图
//
// 依赖：本机 chrome-headless-shell（CDP）+ ffmpeg（两者都已在本机）。
// 说明：两站共用同一浏览器实例时无法同屏，故按「先 A 后 B」顺序导航截图。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const doClick = args.includes('--click');

const MAIN = 'http://127.0.0.1:8803/';
const RB = 'http://127.0.0.1:8804/';
const OUT_DIR = '/tmp/shot-compare/' + new Date().toISOString().replace(/[:.]/g, '-');

// chrome-headless-shell 位置（与 headless-browser-screenshot 的定位方式一致）
const CHROME = '/volume1/VirtualDSM/DeepSeekHarness/pwviewer/browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const ENV = {
  ...process.env,
  LD_LIBRARY_PATH: '/volume1/VirtualDSM/DeepSeekHarness/chromium-libs/root/usr/lib/x86_64-linux-gnu:/volume1/VirtualDSM/DeepSeekHarness/chromium-libs/root/lib/x86_64-linux-gnu:/volume1/VirtualDSM/DeepSeekHarness/chromium-libs/root/usr/lib',
  FONTCONFIG_FILE: '/volume1/VirtualDSM/DeepSeekHarness/fonts/fonts.conf',
};

function shot(url, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync(CHROME, [
    '--headless', '--no-sandbox', '--disable-gpu',
    '--window-size=1920,1080',
    `--screenshot=${out}`,
    '--virtual-time-budget=9000',   // 等 9 秒（模型加载/列表渲染）
    url,
  ], { env: ENV, timeout: 60000, encoding: 'utf8' });
  if (!fs.existsSync(out)) {
    console.error('截图失败:', url, '\n', (r.stderr || '').slice(-400));
    return false;
  }
  console.log('  ✅', out, (fs.statSync(out).size / 1024).toFixed(0) + 'KB');
  return true;
}

// 简易并排拼图（ffmpeg hstack，等高缩放到 900）
// 注意：filter_complex 含分号/方括号，必须作为单个参数整体传入且 shell 不参与解析，
//   execFileSync 本就不走 shell，之前失败是因为把 filter 拆成了多个 argv
function hstack(a, b, out) {
  const filter = '[0:v]scale=-2:900,setsar=1[a];[1:v]scale=-2:900,setsar=1[b];[a][b]hstack=inputs=2';
  const r = spawnSync('ffmpeg', ['-y', '-f', 'image2', '-i', a, '-f', 'image2', '-i', b, '-filter_complex', filter, '-frames:v', '1', out], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(out)) {
    console.error('  ⚠️ 拼图失败（不阻塞）:', (r.stderr || '').split('\n').slice(-3).join(' '));
    return;
  }
  console.log('  ✅', out);
}

console.log('输出目录:', OUT_DIR);
let ok = 0, total = 0;
if (only !== 'rb') { total++; if (shot(MAIN, path.join(OUT_DIR, 'main.png'))) ok++; }
if (only !== 'main') { total++; if (shot(RB, path.join(OUT_DIR, 'rebuild.png'))) ok++; }
if (ok === 2) hstack(path.join(OUT_DIR, 'main.png'), path.join(OUT_DIR, 'rebuild.png'), path.join(OUT_DIR, 'side-by-side.png'));
console.log(`完成 ${ok}/${total}`);
if (doClick) console.log('（提示：--click 参数需真实 CDP 会话点模型；headless --screenshot 模式不支持交互，点模型请用会话内 browser 工具后单独截图）');
