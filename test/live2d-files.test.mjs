// test/live2d-files.test.mjs —— Live2D 文件表"同名不再静默覆盖"（node --test，无需浏览器）
//
// 为什么要有这个套件：spine 侧那轮花了四轮才定位"同名资源被覆盖 ⇒ atlas 与 skel 跨套 ⇒ 黑屏"，
//   而它在日志里的表现只是 "Region not found in atlas: BG"。live2d 侧不能照抄 spine 的 pathID 改名
//   （Cubism 靠包内 model3.json 的 FileReferences 按**原始文件名**引用，改名就断），
//   所以这里的正确修法是"同名同内容合并 / 同名不同内容抛可读错误"，而不是"改名区分"。
//
// 判据必须覆盖**同名且不同**这条分支 —— 只测"单份正常"抓不到覆盖 bug（spine 侧就是这么漏的）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 从插件源码里取 api.__test 的两个函数（插件是经典脚本，挂在 globalThis 上） */
function loadTestHooks() {
  const file = path.join(ROOT, 'plugins', 'unity-live2d-bundle', 'index.js');
  const src = fs.readFileSync(file, 'utf8');
  // 只取两个纯函数体：它们不依赖 lib/NS（除传入的 ns.errors），可安全 eval
  const grab = (name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start > 0, `源码里找不到 ${name}`);
    // 从 function 关键字开始，按大括号配平截取
    let i = src.indexOf('{', start);
    let depth = 0;
    for (; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) { i += 1; break; }
      }
    }
    return src.slice(start, i);
  };
  const body = `${grab('sameBytes')}\n${grab('putFile')}\nreturn { sameBytes, putFile };`;
  // 为什么走 vm 而不是 new Function：new Function 与 eval 同源，安全基线不允许；
  //   vm 沙箱是本项目插件测试的既有加载方式，作用域可控且能显式注入依赖。
  const sandbox = { MIME_OCTET: 'application/octet-stream', console, Blob };
  vm.createContext(sandbox);
  return vm.runInContext(`(function(){ ${body} })()`, sandbox);
}

const { sameBytes, putFile } = loadTestHooks();

/** 最小 errors 实现（插件里用 NS.errors.fail(code, msg) 造带 code 的 Error） */
const fakeNs = {
  errors: {
    fail(code, msg) {
      const e = new Error(msg);
      e.code = code;
      return e;
    },
  },
};

/** 造一个干净的写入上下文 */
function freshCtx() {
  return { files: new Map(), written: new Map() };
}

test('sameBytes：逐字节比较', () => {
  assert.equal(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false, '长度不同');
  assert.equal(sameBytes(null, new Uint8Array([1])), false);
});

test('同名 + 同内容 ⇒ 合并，不报错', () => {
  const ctx = freshCtx();
  const bytes = new Uint8Array([7, 8, 9]);
  putFile(ctx.files, ctx.written, 'textures/a.png', bytes, 'image/png', fakeNs);
  // 第二次写同一份内容：必须不抛
  assert.doesNotThrow(() => putFile(ctx.files, ctx.written, 'textures/a.png', new Uint8Array([7, 8, 9]), 'image/png', fakeNs));
  assert.equal(ctx.files.size, 1, '同内容不应产生第二份');
});

test('同名 + 不同内容 ⇒ 抛可读错误（带资源名），绝不静默覆盖', () => {
  const ctx = freshCtx();
  putFile(ctx.files, ctx.written, 'moc3.moc3', new Uint8Array([1, 2, 3]), undefined, fakeNs);
  let err = null;
  try {
    putFile(ctx.files, ctx.written, 'moc3.moc3', new Uint8Array([9, 9, 9]), undefined, fakeNs);
  } catch (e) { err = e; }
  assert.ok(err, '同名不同内容必须抛错');
  assert.equal(err.code, 'ULB_ERR_MODEL_BUILD');
  assert.match(err.message, /moc3\.moc3/, '错误里必须带资源名');
  assert.match(err.message, /同名资源/, '错误要说明是同名冲突');
  // 关键：先写的那份不能被替换
  assert.equal(ctx.files.size, 1);
  assert.equal(ctx.written.get('moc3.moc3')[0], 1, '原始那份必须还在');
});

test('不同名 ⇒ 各写各的（零回归）', () => {
  const ctx = freshCtx();
  putFile(ctx.files, ctx.written, 'a.png', new Uint8Array([1]), 'image/png', fakeNs);
  putFile(ctx.files, ctx.written, 'b.png', new Uint8Array([2]), 'image/png', fakeNs);
  assert.equal(ctx.files.size, 2);
});

test('源码契约：files.set 只允许出现在 putFile 内部（唯一写入入口）', () => {
  // 为什么钉这条：putFile 承担"同名冲突检测"，一旦有人在别处直接 files.set，
  //   就会绕过冲突判定静默覆盖 —— 表现是少一份文件、渲染错乱，而日志看不出原因。
  //   把"唯一入口"从自觉变成断言，后来的人才绕不过去。
  const src = fs.readFileSync(path.join(ROOT, 'plugins', 'unity-live2d-bundle', 'index.js'), 'utf8');
  const hits = (src.match(/files\.set\(/g) || []).length;
  assert.equal(hits, 1, `files.set 应只出现 1 次（在 putFile 内），实际 ${hits} 次`);
});
