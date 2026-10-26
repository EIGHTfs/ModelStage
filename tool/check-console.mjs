#!/usr/bin/env node
// check-console.mjs —— 用 CDP 打开页面，全程监听控制台/异常/失败请求；可选先跑一段页面动作脚本
//
// 做什么：
//   1. 起一个无头 chromium（自探测路径，可用 CHROME_BIN 覆盖），打开目标 URL；
//   2. 监听四类"出错信号"：console.error / 未捕获异常 / 浏览器日志 error / HTTP>=400 与请求失败；
//   3. 可选 --script <file>：把文件内容当页面脚本执行（支持 await），用来做"穷举点击 + 断言"，
//      脚本的返回值（JSON 可序列化）会随报告一起打印 —— 这样一次运行就同时拿到
//      "操作结果"和"这段操作期间有没有报错"；
//   4. 有错则非零退出（CI/验收可直接用退出码判定）。
//
// 为什么不用浏览器扩展/Playwright：本项目零依赖，且需要"加载前就开始监听"，
//   只有 CDP 的 Runtime/Log/Network 事件能在首字节之前挂上监听。
//
// 用法：
//   node tool/check-console.mjs http://127.0.0.1:8804/
//   node tool/check-console.mjs http://127.0.0.1:8804/ --script /tmp/actions.js --wait 3000
//   node tool/check-console.mjs http://127.0.0.1:8804/ --json --shot /tmp/page.png
// 参数：
//   --wait <ms>    打开后等待时长（默认 3000；脚本执行在等待之后）
//   --script <f>   页面动作脚本文件（内容为 JS，可含 await；返回值需可 JSON 序列化）
//   --shot <path>  额外截图保存路径
//   --json         只输出 JSON 报告（便于管道处理）
//   --allow-warn   把 console.warn 也当问题（默认不算错）
// 退出码：0 = 无错误；1 = 运行失败；2 = 发现错误信号

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 兄弟目录候选：项目可能嵌在 <base>/工作区/ModelStage，也可能直接是 <base>/ModelStage
const SIBLINGS = [path.resolve(ROOT, '..'), path.resolve(ROOT, '..', '..')];

import { acquireTestLock as acquireLock, releaseOnExit as releaseLockOnExit, describeHolder as describeLockHolder, EXIT_SKIPPED as EXIT_LOCK_SKIPPED } from './lib/test-lock.mjs';

// ---------------------------------------------------------------- 参数解析
const argv = process.argv.slice(2);
const url = argv.find((a) => /^https?:\/\//.test(a));
if (!url) {
  console.error('用法: node tool/check-console.mjs <url> [--wait ms] [--script file] [--shot png] [--json] [--allow-warn]');
  process.exit(1);
}
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(name);
const WAIT_MS = Number(argOf('--wait', '3000'));
const SCRIPT_FILE = argOf('--script', null);
// 结果落盘路径：stdout 在本机（SMB 挂载 + 管道捕获）实测**偶发丢输出** ——
//   同一条命令连跑四次，两次 0 字节、一次尾部少 3 字节，退出码却都是 0。
//   这类 flaky 无法靠"等冲刷"解决，所以支持把同一份 JSON 额外写进文件，
//   由调用方读文件而不是读 stdout（文件写入同步，确定性强）。
const OUT_FILE = argOf('--out', null);

// 并发互斥：单独跑本工具也算"一个测试实例"（它会起浏览器、跑页面脚本）。
//   被 test-all 调用时环境里有 DSH_TEST_LOCK_HELD=1，不会重复加锁。
const CONSOLE_LOCK = acquireLock({ root: ROOT, label: 'check-console', tool: `node tool/check-console.mjs ${process.argv.slice(2).join(' ')}` });
if (!CONSOLE_LOCK.acquired) {
  console.error('⏭️  跳过：已有测试实例在跑（并发互斥，退出码 75）');
  console.error(`   持有者：${describeLockHolder(CONSOLE_LOCK.holder)}`);
  console.error(`   锁文件：${CONSOLE_LOCK.file}`);
  process.exit(EXIT_LOCK_SKIPPED);
}
if (CONSOLE_LOCK.tookOver) {
  const why = CONSOLE_LOCK.pidReused ? '  ← 该 PID 已被系统复用给新进程，原持有者早已退出' : '';
  console.warn(`⚠ 接管陈旧锁（原持有者 ${describeLockHolder(CONSOLE_LOCK.holder)}）${why}`);
}
releaseLockOnExit(CONSOLE_LOCK);
// 清理历史残留的 profile 目录：每次运行会建 /tmp/check-console-profile-<pid>，
//   进程被 Ctrl-C / kill 时不会自己删。只删**持有者已死**的那些（别误删正在跑的）。
for (const name of fs.readdirSync('/tmp').filter((n) => n.startsWith('check-console-profile-'))) {
  const pid = Number(name.slice('check-console-profile-'.length));
  if (!Number.isInteger(pid) || pid <= 0) continue;
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (alive) continue;
  try { fs.rmSync(path.join('/tmp', name), { recursive: true, force: true }); } catch { /* 删不掉不影响运行 */ }
}

const SHOT = argOf('--shot', null);
const JSON_ONLY = flag('--json');
const WARN_IS_ERROR = flag('--allow-warn');

// ------------------------------------------------------------ chromium 探测
// 自探测而不是写死：本机有项目自带的无头壳，也可能有系统 chromium。
function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  // 浏览器目录：CHROME_DIR 显式指定；否则按「项目根的上一级 / 上两级」探测 pwviewer/browsers
  //   （项目在不同机器上可能嵌在不同层级）。不写真机绝对路径，避免带出个人目录结构。
  const base = process.env.CHROME_DIR
    || SIBLINGS.map((b) => path.join(b, 'pwviewer', 'browsers')).find((d) => fs.existsSync(d))
    || '';
  const cands = [];
  try {
    for (const d of fs.readdirSync(base)) {
      if (!d.startsWith('chromium')) continue;
      for (const sub of fs.readdirSync(path.join(base, d))) {
        const p = path.join(base, d, sub, 'chrome-headless-shell');
        if (fs.existsSync(p)) cands.push(p);
      }
    }
  } catch { /* 目录不存在就跳过 */ }
  cands.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome');
  for (const c of cands) if (fs.existsSync(c)) return c;
  // 最后退回 PATH 查找（which 不存在时静默）
  for (const name of ['chrome-headless-shell', 'chromium', 'google-chrome']) {
    try {
      const p = execFileSync('which', [name], { encoding: 'utf8' }).trim();
      if (p) return p;
    } catch { /* 没找到 */ }
  }
  return null;
}

const CHROME = findChrome();
if (!CHROME) {
  console.error('未找到 chromium/chrome-headless-shell：请设置 CHROME_BIN 环境变量');
  process.exit(1);
}

// 本机无头壳依赖用户态库与字体配置；目录存在才注入，换机器不会误设
const ENV = { ...process.env };
// 用户态库 sysroot：本机系统里没有 libatk / libnss3 / libgbm 等（极简环境），
//   无头壳要从 sysroot 里借。sysroot 位置会变（历史上在 chromium-libs/root，
//   后来迁到 pwviewer/lib），所以**按候选列表探测**而不是写死一个；
//   也可用 CHROME_LIBS 显式指定 sysroot 根目录。
const LIB_SYSROOT_CANDIDATES = process.env.CHROME_LIBS
  ? [process.env.CHROME_LIBS]
  : [
    ...SIBLINGS.map((b) => path.join(b, 'pwviewer', 'lib')),
    ...SIBLINGS.map((b) => path.join(b, 'chromium-libs', 'root')),
  ];
const LIB_SUBDIRS = ['usr/lib/x86_64-linux-gnu', 'lib/x86_64-linux-gnu', 'usr/lib', 'lib'];
const libDirs = [];
for (const root of LIB_SYSROOT_CANDIDATES) {
  for (const sub of LIB_SUBDIRS) {
    const dir = `${root}/${sub}`;
    if (fs.existsSync(dir)) libDirs.push(dir);
  }
}
if (libDirs.length) ENV.LD_LIBRARY_PATH = [...libDirs, ENV.LD_LIBRARY_PATH || ''].filter(Boolean).join(':');
const fontConf = process.env.FONTCONFIG_FILE
  || SIBLINGS.map((b) => path.join(b, 'fonts', 'fonts.conf')).find((f) => fs.existsSync(f))
  || '';
if (fs.existsSync(fontConf)) ENV.FONTCONFIG_FILE = fontConf;

// ------------------------------------------------------------- CDP 极简客户端
const getJson = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

function writeFrame(sock, payload) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  sock.write(Buffer.concat([header, mask, masked]));
}

function connectWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(+u.port, u.hostname, () => {
      sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\n`
        + `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = Buffer.alloc(0);
    let handshaken = false;
    let msgHandler = null;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        buf = buf.slice(idx + 4);
        handshaken = true;
        resolve({
          send: (s) => writeFrame(sock, Buffer.from(s, 'utf8')),
          on: (ev, fn) => { if (ev === 'message') msgHandler = fn; },
          close: () => sock.end(),
        });
        return;
      }
      while (buf.length >= 2) {
        const len7 = buf[1] & 0x7f;
        let offset = 2;
        let len = len7;
        if (len7 === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); offset = 4; }
        else if (len7 === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
        if (buf.length < offset + len) break;
        const payload = buf.slice(offset, offset + len);
        buf = buf.slice(offset + len);
        if (msgHandler && payload.length) msgHandler(payload.toString('utf8'));
      }
    });
    sock.on('error', reject);
  });
}

// ------------------------------------------------------------------- 主流程
const problems = [];   // {kind, text}
const aborted = [];    // 请求中止（页面卸载/取消）：单独归类，不算页面问题
const all = [];        // 全部控制台条目（报告用）
const responses = [];  // {status, url} 供 Network 证据

async function main() {
  const port = 9788;
  const profile = `/tmp/check-console-profile-${process.pid}`;
  const chrome = spawn(CHROME, [
    '--headless', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${port}`, '--window-size=1920,1080',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { env: ENV });
  const cleanup = () => { try { chrome.kill('SIGKILL'); } catch { /* 已退出 */ } };
  process.on('exit', cleanup);

  let target = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* 端点还没起来 */ }
  }
  if (!target) throw new Error('chromium 未就绪（debug 端点无响应）');

  const ws = await connectWs(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const p = msg.params;
      const text = (p.args || []).map((a) => (a.value !== undefined ? a.value : (a.description || a.type))).join(' ');
      all.push({ type: p.type, text });
      if (p.type === 'error') problems.push({ kind: 'console.error', text });
      if (p.type === 'warning' && WARN_IS_ERROR) problems.push({ kind: 'console.warn', text });
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      const desc = (d.exception && d.exception.description) || d.text || '';
      problems.push({ kind: '未捕获异常', text: desc.split('\n')[0] });
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      all.push({ type: `log.${e.level}`, text: e.text });
      if (e.level === 'error') problems.push({ kind: '浏览器日志', text: `${e.text}${e.url ? ` (${e.url})` : ''}` });
    }
    if (msg.method === 'Network.responseReceived') {
      const r = msg.params.response;
      responses.push({ status: r.status, url: r.url });
      if (r.status >= 400) problems.push({ kind: `HTTP ${r.status}`, text: r.url });
    }
    if (msg.method === 'Network.loadingFailed') {
      const p = msg.params;
      const errText = p.errorText || '';
      /**
       * 把「请求被取消」与「真网络错误」分开归类。
       *
       * 为什么必须分开：ERR_ABORTED / NS_BINDING_ABORTED 是"请求被取消"（页面卸载、导航、
       *   AbortController、keepalive 上报在页面关闭瞬间被打断），不是网络故障；真网络错误是
       *   ERR_CONNECTION_REFUSED / ERR_NAME_NOT_RESOLVED 这一类。混在一起会让"发出后立刻关页面"
       *   的功能凭空产生一堆假 problem，把真异常淹掉（实测：一次过渡埋点让 problems 从 10 涨到 47）。
       * 处置：中止的单独计数、单独打印一行，**不计入 problems、不影响退出码**。
       */
      const isAbort = /ERR_ABORTED|NS_BINDING_ABORTED/i.test(errText) || /cancel/i.test(errText);
      if (isAbort) aborted.push({ kind: '请求中止', text: `${errText} (${p.type})` });
      else problems.push({ kind: '请求失败', text: `${errText} (${p.type})` });
    }
  });
  // 请求超时兜底：CDP 的响应靠消息回调 resolve；对端把 ws 关掉时消息永远不来，
  //   promise 就一直挂着 —— 而挂着的 promise **不占事件循环**，进程会在事件循环空转后
  //   静默退出（退出码 0、stdout 零字节）。下游因此把它当成"没产出结构化结果"的假失败。
  //   实测就是这个症状：panel-actions 偶发 0 字节且 `--trace-exit` 完全无输出。
  //   给每个请求明确上限，卡住就抛错，让失败可见。
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    // 页面脚本可能跑几十秒（Runtime.evaluate 要等脚本返回），给它更长的上限
    const limitMs = method === 'Runtime.evaluate' ? 300000 : 20000;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 请求超时（${method}，${limitMs}ms 无响应）`));
    }, limitMs);
    pending.set(id, (v) => { clearTimeout(timer); resolve(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable', {});
  await send('Log.enable', {});
  await send('Network.enable', {});
  await send('Page.enable', {});
  await send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, WAIT_MS));

  // 可选：执行页面动作脚本（穷举点击 + 断言）
  // 约定：脚本文件内容必须是一个**自求值表达式**（如 `(async () => { … })()`），
  //   工具原样求值、等待 Promise，把返回值当结果。
  // 为什么不在这里包一层 async 函数：包了之后脚本只能靠顶层 return 交结果，
  //   而 `node --check <脚本>` 会因"顶层 await/return"报错；让脚本自带 IIFE 则两边都成立。
  let scriptResult = null;
  let scriptError = null;
  if (SCRIPT_FILE) {
    const code = fs.readFileSync(SCRIPT_FILE, 'utf8');
    const r = await send('Runtime.evaluate', {
      expression: code, awaitPromise: true, returnByValue: true,
    });
    if (r.result && r.result.exceptionDetails) {
      scriptError = r.result.exceptionDetails.text
        + ' ' + ((r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) || '');
      problems.push({ kind: '动作脚本异常', text: scriptError.split('\n')[0] });
    } else {
      scriptResult = r.result && r.result.result ? r.result.result.value : null;
    }
    // 脚本跑完再等一拍，收集脚本期间异步产生的错误
    await new Promise((r2) => setTimeout(r2, 300));
  }

  let shotPath = null;
  if (SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data) {
      shotPath = path.resolve(SHOT);
      fs.mkdirSync(path.dirname(shotPath), { recursive: true });
      fs.writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));
    }
  }

  ws.close();
  cleanup();

  const report = {
    url,
    ok: problems.length === 0,
    problemCount: problems.length,
    problems,
    abortedCount: aborted.length,
    aborted: aborted.slice(0, 40),
    scriptResult,
    scriptError,
    screenshot: shotPath,
    consoleEntries: all.length,
    responses: responses.filter((r) => !/\.(png|jpg|webp)$/i.test(r.url)).slice(-40),
  };
  const reportJson = JSON.stringify(report, null, 1);
  // 先同步落盘（调用方优先读它），再照常打到 stdout（人看日志用）。
  //   顺序很关键：落盘在前，保证即使 stdout 被截断，结构化结果也已完整写出。
  if (OUT_FILE) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(OUT_FILE)), { recursive: true });
      fs.writeFileSync(path.resolve(OUT_FILE), reportJson, 'utf8');
    } catch (e) {
      console.error('[check-console] 结果落盘失败:', e.message);
    }
  }
  if (JSON_ONLY) {
    console.log(reportJson);
  } else {
    console.log(`\n[check-console] ${url}`);
    console.log(`  控制台条目 ${all.length} 条 / 网络响应 ${responses.length} 个`);
    if (scriptResult !== null) {
      console.log('  动作脚本返回值：');
      console.log(typeof scriptResult === 'string' ? scriptResult : JSON.stringify(scriptResult, null, 1));
    }
    if (problems.length) {
      console.log(`\n  ❌ 发现 ${problems.length} 个问题：`);
      for (const p of problems) console.log(`    - [${p.kind}] ${p.text}`);
    } else {
      console.log('\n  ✅ 零错误（无 console.error / 未捕获异常 / 4xx-5xx / 请求失败）');
    }
    if (aborted.length) {
      // 中止不是错误：只告知存在（页面关闭瞬间的正常现象），不参与判定
      console.log(`  ℹ️  请求中止(页面卸载/取消)：${aborted.length} 条（不计入问题）  例：${aborted[0].text}`);
    }
    if (shotPath) console.log(`  截图: ${shotPath}`);
  }
  // 不能直接 process.exit()：它会与 stdout 的异步冲刷竞争，把还没落盘的输出截掉。
  //   实测症状是「退出码 0 但 stdout 为 0 字节（或尾部少几个字节）」，且**偶发** ——
  //   同一条命令连跑三次，一次 0 字节、两次正常；下游 test-all 因此报「没产出结构化结果」假失败。
  //   治法：先主动收尾（杀子进程 / 关 ws），只设 exitCode 让事件循环自然结束 ——
  //   自然结束会完整冲刷 stdout；再用 unref 定时器兜底（不阻塞自然退出）。
  cleanup();
  try { ws.close(); } catch { /* 已关闭 */ }
  const exitCode = problems.length ? 2 : 0;
  process.exitCode = exitCode;
  setTimeout(() => process.exit(exitCode), 2000).unref();
}

main().catch((e) => {
  console.error('[check-console] 运行失败:', e.message);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 2000).unref();
});
