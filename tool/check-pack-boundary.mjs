#!/usr/bin/env node
// tool/check-pack-boundary.mjs —— 发布前检查"包里到底装了什么"
//
// 为什么要有它：`files` 白名单是**放行式**的，多写一个目录就会把内部残留一起发出去。
//   实测踩过两次：`plugins/.trash/`（含内部卡点清单与自测脚本）和 `tool/.tmp-*`（临时等价脚本）
//   都被整目录放行带进了包 —— 体积只多 120KB，但那是**内部工作残留被公开**。
//   这类问题看 package.json 看不出来，只有真打包才知道。
//
// 判据两条：
//   ① 禁止项：包内不得出现 .trash / .tmp- / .bak / node_modules / .git / .env / storage
//   ② 必需项：运行时真正会 import 的文件必须在包里（漏了它，装出来的包一启动就崩）
//
// 用法：node tool/check-pack-boundary.mjs [--keep]
//   默认打包到临时目录并在结束时删除；--keep 保留 tgz 便于人工查看。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 禁止出现在包里的路径特征（命中任意一条即失败） */
const FORBIDDEN = [
  { re: /(^|\/)\.trash\//, why: '回收站目录（内部工作残留）' },
  { re: /(^|\/)\.tmp-/, why: '临时脚本' },
  { re: /\.bak$/, why: '备份文件' },
  { re: /(^|\/)node_modules\//, why: '依赖目录（npm 会自动排除，出现说明 files 写错了）' },
  { re: /(^|\/)\.git\//, why: '版本库' },
  { re: /(^|\/)\.env/, why: '环境变量文件（可能含凭据）' },
  { re: /^package\/storage\//, why: '运行时数据目录' },
];

/**
 * 运行时必需项：这些文件被 src/ 直接 import（或按路径读），缺一个装出来的包就跑不起来。
 * 为什么写死清单而不自动扫描：这份清单本身就是"哪些 tool/ 文件属于运行时"的**唯一表述**，
 *   自动扫描会把测试/维护脚本也算进去（那正是我们想排除的）。
 *   加新的运行时依赖时，这里与 package.json 的 files 要一起加 —— 两边漏一边本脚本会报。
 */
const REQUIRED = [
  'package/package.json',
  'package/bin/modelstage.mjs',
  'package/src/server/serve.mjs',
  'package/tool/parse-jsonc.mjs',              // registry/config/diag-upload 都 import 它
  'package/tool/resolve-live2d-runtimes.mjs',  // data/live2d.mjs import
  'package/tool/lib/runtime-package.mjs',      // http/static.mjs import
  'package/tool/lib/runtime-guides.mjs',       // routes/data.mjs import
  'package/tool/spine-motion-rules.json',      // data/model-meta.mjs 按路径读
  'package/plugins/unity-live2d-bundle/plugin.json',
  'package/plugins/unity-spine-bundle/plugin.json',
];

function pack() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-pack-'));
  const out = execFileSync('npm', ['pack', '--pack-destination', outDir], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const tgz = path.join(outDir, out.split('\n').pop().trim());
  if (!fs.existsSync(tgz)) throw new Error(`打包产物不存在：${tgz}`);
  return { tgz, outDir };
}

function listFiles(tgz) {
  const out = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

const keep = process.argv.includes('--keep');
const { tgz, outDir } = pack();
const files = listFiles(tgz);
const problems = [];

for (const f of files) {
  for (const rule of FORBIDDEN) {
    if (rule.re.test(f)) {
      problems.push(`✗ 不该进包：${f}（${rule.why}）`);
      break;
    }
  }
}
for (const need of REQUIRED) {
  if (!files.includes(need)) problems.push(`✗ 缺必需文件：${need}`);
}

const sizeMb = (fs.statSync(tgz).size / 1048576).toFixed(2);
console.log(`包内 ${files.length} 个文件 · tgz ${sizeMb}MB · ${path.basename(tgz)}`);

if (problems.length) {
  console.error(`\n发布前检查失败（${problems.length} 项）：`);
  for (const p of problems) console.error('  ' + p);
  console.error('\n改 package.json 的 files 白名单后重跑本脚本。');
  if (!keep) fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}

console.log('✓ 边界检查通过：无禁止项、必需文件齐全');
if (keep) console.log(`  产物保留在 ${tgz}`);
else fs.rmSync(outDir, { recursive: true, force: true });
