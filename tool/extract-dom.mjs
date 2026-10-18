#!/usr/bin/env node
// extract-dom.mjs — 连 CDP 从运行中的 8803 页面提取原版 UI DOM 存为组件文件
//
// 为什么独立起 CDP：browser_execute 回传大字符串会被 console/结果通道截断，
//   直接在本机起 headless chrome 打开 8803 提取，落盘无大小限制。
//
// 用法：node tool/extract-dom.mjs
// 产物：rebuild/components/{topbar,sidebar-left,sidebar-right,footer}.html

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// 注意：URL.pathname 是 URL 编码的（中文目录变 %E5...），必须 fileURLToPath 解码，
//   否则 ROOT 会带 % 转义字面量，文件写到错误目录（实测踩坑）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'rebuild', 'components');
const CHROME = '/volume1/VirtualDSM/DeepSeekHarness/pwviewer/browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const ENV = {
  ...process.env,
  LD_LIBRARY_PATH: '/volume1/VirtualDSM/DeepSeekHarness/chromium-libs/root/usr/lib/x86_64-linux-gnu:/volume1/VirtualDSM/DeepSeekHarness/chromium-libs/root/lib/x86_64-linux-gnu:/volume1/VirtualDSM/DeepSeekHarness/chromium-libs/root/usr/lib',
  FONTCONFIG_FILE: '/volume1/VirtualDSM/DeepSeekHarness/fonts/fonts.conf',
};

// 极简 CDP 客户端：起 chrome --remote-debugging-port，websocket 逐条收发
async function extract() {
  const port = 9777;
  const chrome = spawn(CHROME, [
    '--headless', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${port}`,
    '--window-size=1920,1080',
    '--user-data-dir=/tmp/cdp-extract-profile',
    'http://127.0.0.1:8803/',
  ], { env: ENV });
  process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

  // 等 debug 端点就绪
  let target = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      target = list.find(t => t.type === 'page' && t.url.includes('8803'));
      if (target) break;
    } catch {}
  }
  if (!target) throw new Error('未等到页面 target');
  // 等首屏渲染（模型列表加载）
  await new Promise(r => setTimeout(r, 9000));

  const ws = await connectWs(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  // 等原版模型列表出现（原版 React 挂载完成）
  for (let i = 0; i < 20; i++) {
    const r = await send('Runtime.evaluate', { expression: 'document.querySelectorAll("aside").length + "|" + document.querySelectorAll("[data-mid]").length', returnByValue: true });
    const v = r.result?.result?.value || '';
    if (v.startsWith('2|') && v !== '2|0') break;
    await new Promise(r2 => setTimeout(r2, 1000));
  }

  // 提取四大区块（一次 evaluate 拿全部，returnByValue 走 CDP 无截断）
  const expr = `JSON.stringify((() => {
    const root = document.getElementById('root');
    const header = root.querySelector('header');
    const asides = [...root.querySelectorAll('aside')];
    const footer = root.querySelector('footer');
    return { header: header?.outerHTML||'', asideLeft: asides[0]?.outerHTML||'', asideRight: asides[1]?.outerHTML||'', footer: footer?.outerHTML||'' };
  })())`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const json = JSON.parse(r.result.result.value);
  ws.close();

  fs.mkdirSync(OUT, { recursive: true });
  const tpl = (name, html) => '<!-- ' + name + '：DOM 提取自原版 原版 渲染产物，类名/图标原样保留，自建 JS 只绑事件不重构结构 -->\n' + html;
  fs.writeFileSync(path.join(OUT, 'topbar.html'), tpl('顶栏 header', json.header));
  fs.writeFileSync(path.join(OUT, 'sidebar-left.html'), tpl('左栏 模型库 aside', json.asideLeft));
  fs.writeFileSync(path.join(OUT, 'sidebar-right.html'), tpl('右栏 控制菜单 aside', json.asideRight));
  fs.writeFileSync(path.join(OUT, 'footer.html'), tpl('底栏 播放条 footer', json.footer));
  for (const f of ['topbar', 'sidebar-left', 'sidebar-right', 'footer']) {
    const s = fs.statSync(path.join(OUT, f + '.html'));
    console.log('  ' + f + '.html: ' + (s.size / 1024).toFixed(1) + 'KB');
  }
  chrome.kill('SIGKILL');
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// 极简 websocket 客户端（只实现本场景需要的：文本帧收发，无分片压缩）
import net from 'node:net';
import crypto from 'node:crypto';
function connectWs(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(+u.port, u.hostname, () => {
      sock.write('GET ' + u.pathname + u.search + ' HTTP/1.1\r\n'
        + 'Host: ' + u.host + '\r\n'
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: ' + key + '\r\n'
        + 'Sec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = Buffer.alloc(0);
    let handshaken = false;
    let opened = false;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        buf = buf.slice(idx + 4);
        handshaken = true;
        // WebSocket 帧解析（客户端收：可能带 mask）
        opened = true;
        resolve({ send: (s) => writeFrame(sock, Buffer.from(s, 'utf8')), on: (ev, fn) => { if (ev === 'message') msgHandler = fn; }, close: () => sock.end() });
        return;
      }
      // 解析所有完整帧
      while (buf.length >= 2) {
        const len7 = buf[1] & 0x7f;
        let offset = 2, len = len7;
        if (len7 === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); offset = 4; }
        else if (len7 === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
        if (buf.length < offset + len) break;
        let payload = buf.slice(offset, offset + len);
        const masked = buf[1] & 0x80;
        if (masked) { payload = Buffer.from(payload); }
        buf = buf.slice(offset + len);
        if (msgHandler && payload.length) msgHandler(payload.toString('utf8'));
      }
    });
    sock.on('error', reject);
    let msgHandler = null;
  });
}

function writeFrame(sock, payload) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.from([0x81, 0x80 | len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  sock.write(Buffer.concat([header, mask, masked]));
}

extract().then(() => console.log('提取完成')).catch(e => { console.error('失败:', e.message); process.exit(1); });
