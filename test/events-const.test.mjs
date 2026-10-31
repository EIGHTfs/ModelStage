// test/events-const.test.mjs —— 事件名必须是常量，不许再散落成字面量
//
// 为什么有这条：事件名原先以字符串字面量分散在派发点与监听点，被一次批量重命名改坏过
//   （`spineviewer:plugins-loaded` → `spineviewer:plugins-ctx.loaded`），后果是
//   "卸载后面板不重建 / document.files 就绪后不重绘"——不报错、只静默失效。
// 两道保护：
//   ① EVENTS 的值必须与协议一致（改值会红）
//   ② src/web 下（除 infra/events.mjs 自身）**不许**出现该前缀的字面量（再手写一遍会红）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EVENTS } from '../src/web/infra/events.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(HERE, '..', 'src', 'web');
const ALLOWED_FILE = path.join(WEB_ROOT, 'infra', 'events.mjs');
const PREFIX = 'spineviewer:';

/** 递归列出 src/web 下的 js/mjs 文件（跳过 events.mjs 自身） */
function listSources(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) { out.push(...listSources(full)); continue; }
    if (!/\.(m?js)$/.test(name.name)) continue;
    if (path.resolve(full) === path.resolve(ALLOWED_FILE)) continue;
    out.push(full);
  }
  return out;
}

test('EVENTS 的值与协议一致（改名/改值必须同步改这里）', () => {
  assert.equal(EVENTS.PLUGINS_LOADED, 'spineviewer:plugins-loaded');
  assert.equal(EVENTS.PLUGIN_REGISTERED, 'spineviewer:plugin-registered');
  assert.equal(EVENTS.NOTIFY, 'spineviewer:notify');
  // 冻结：运行期不许被改写（防止某处插件代码把常量改掉）
  assert.ok(Object.isFrozen(EVENTS), 'EVENTS 必须是 Object.freeze 的');
});

test('src/web 下不许再出现事件名字面量（除 infra/events.mjs）', () => {
  const hits = [];
  for (const file of listSources(WEB_ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (line.includes(PREFIX)) hits.push(`${path.relative(WEB_ROOT, file)}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(hits, [],
    `事件名必须用 EVENTS 常量（infra/events.mjs）。发现字面量：\n${hits.join('\n')}`);
});
