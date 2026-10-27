#!/usr/bin/env node
// bin/modelstage.mjs —— npx / 全局安装时的启动入口（薄封装）
//
// 职责只有三件：解析命令行参数 → 翻译成 serve.mjs 认识的环境变量 → import 真正的服务入口。
// 为什么不在 bin 里复制启动逻辑：src/server/serve.mjs 是唯一的服务入口（路由表、插件宿主、
//   静态托管、就绪信号都在里面）。复制一份就等于有两套启动语义，迟早漂移 ——
//   本项目已经因为"两套实现"返工过多次（两套调度、两份解码副本）。
//
// 环境变量与参数的对应关系（与 web.sh 完全一致，两种方式等价）：
//   --port <n>          → PORT
//   --data-root <path>  → MODELSTAGE_DATA_ROOT

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.join(HERE, '..', 'package.json');

const USAGE = `用法：modelstage [选项]

  --port <n>           监听端口（默认 8804，等价于环境变量 PORT）
  --data-root <path>   数据根目录：日志 / 解包缓存 / 配置的持久化位置
                       （等价于环境变量 MODELSTAGE_DATA_ROOT；缺省 = 项目根）
                       用 npx 运行时建议显式指定一个**可写且持久**的目录
  -h, --help           显示本帮助
  -v, --version        显示版本号（读 package.json，它是版本号唯一权威）

示例：
  npx . --port 8804 --data-root ~/modelstage-data
  PORT=8804 MODELSTAGE_DATA_ROOT=~/modelstage-data npx .

运行时库（Spine / Live2D 的 runtimes）不随包分发：npx 直跑需自行准备运行时目录，
或用 SPINE_RUNTIME_DIR / LIVE2D_SEARCH_ROOTS 指定已有的搜索根。`;

/** 参数错误：打一行原因 + 完整用法，退出码 1（不用异常栈吓人） */
function fail(message) {
  process.stderr.write(`modelstage: ${message}\n\n${USAGE}\n`);
  process.exit(1);
}

/**
 * 解析 argv。只认两个带值的长选项与 -h/-v，不引第三方参数解析库。
 * 同时支持 `--port 8804` 与 `--port=8804` 两种写法（后者在 npx 传参时更常见）。
 */
function parseArgs(argv) {
  const parsed = { port: null, dataRoot: null, help: false, version: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') parsed.help = true;
    else if (arg === '-v' || arg === '--version') parsed.version = true;
    else if (arg === '--port') { const v = argv[(i += 1)]; if (!v) fail('--port 缺少取值'); parsed.port = v; }
    else if (arg.startsWith('--port=')) parsed.port = arg.slice('--port='.length);
    else if (arg === '--data-root') { const v = argv[(i += 1)]; if (!v) fail('--data-root 缺少取值'); parsed.dataRoot = v; }
    else if (arg.startsWith('--data-root=')) parsed.dataRoot = arg.slice('--data-root='.length);
    else fail(`未知参数：${arg}`);
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

if (args.version) {
  // 用 fs 读而不是 `import pkg from './package.json' with { type: 'json' }`：
  //   import attributes 在 Node 20/22 之间行为不一致（实验特性），fs 读在任何版本都稳定
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

if (args.port !== null) {
  // 端口必须能转成整数：serve.mjs 用的是 Number(process.env.PORT) || 8804，
  //   传个 "abc" 会静默回落到 8804 —— 看上去启动了、其实端口不是期望的那个，这里提前拦下
  if (!/^\d+$/.test(args.port)) fail(`--port 必须是整数，收到 ${args.port}`);
  process.env.PORT = args.port;
}

if (args.dataRoot) {
  // 转成绝对路径：serve.mjs 会把它当数据根拼日志与缓存路径，相对路径会随 cwd 漂移
  process.env.MODELSTAGE_DATA_ROOT = path.resolve(args.dataRoot);
}

// 交给真正的服务入口：它是模块顶层直接 listen 的，import 即启动，无需再 await 返回值
await import('../src/server/serve.mjs');
