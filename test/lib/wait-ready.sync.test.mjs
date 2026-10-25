// test/lib/wait-ready.sync.test.mjs —— 页内工具的「单一权威副本」漂移门禁
//
// 为什么需要：页内脚本不能 import，工具只能以文本块形式存在于各测试脚本里。
//   一旦有人只改一处，就会出现"各文件行为不一致"——正是当初"每个文件各写一份 waitFor"的病根。
//   这里逐字节比对：每个带标记块的脚本，其块内容必须与 test/lib/wait-ready.mjs 的 IN_PAGE 完全相同。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IN_PAGE } from './wait-ready.mjs';

const TEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BEGIN = '// [wait-ready] begin';
const END = '// [wait-ready] end';

// IN_PAGE 是模板字符串，内部出现反引号会**截断**整个字符串（实测报 "Unexpected token 'const'"）。
//   这条断言把这个坑钉死：以后往里加注释时用了反引号，这里先红。
test('IN_PAGE 源文本内不得出现反引号', () => {
  const banned = IN_PAGE.includes('`');
  assert.equal(banned, false, 'IN_PAGE 里出现了反引号 —— 会把模板字符串截断；请改用「」或单引号');
});

test('带标记的测试脚本，其 wait-ready 块必须与权威副本逐字节一致', () => {
  const files = fs.readdirSync(TEST_DIR).filter((n) => n.endsWith('.js'));
  const marked = [];
  for (const n of files) {
    const src = fs.readFileSync(path.join(TEST_DIR, n), 'utf8');
    const b = src.indexOf(BEGIN);
    if (b < 0) continue;
    const e = src.indexOf(END, b);
    assert.ok(e > b, `${n}: 标记块未闭合（缺 ${END}）`);
    marked.push(n);
    assert.equal(src.slice(b, e + END.length), IN_PAGE,
      `${n}: wait-ready 块与 test/lib/wait-ready.mjs 不一致 → 跑 node test/lib/apply-wait-ready.mjs --write`);
  }
  assert.ok(marked.length > 0, '没有任何测试脚本带 wait-ready 标记块（说明注入没生效）');
});
