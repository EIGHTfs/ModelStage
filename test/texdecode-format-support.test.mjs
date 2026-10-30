// test/texdecode-format-support.test.mjs —— 「能不能解码」只能有一个真相
//
// 背景（这是一次**不一致修复**，不是重构）：
//   预检侧 bundle-probe.formatSupport() 曾以 `!!texdecode.FORMATS[fmt]` 判"支持"，
//   而解码侧 decode() 只认 DECODERS 表。48 ETC2_RGBA1 在 FORMATS 里有条目、DECODERS 里从未登记
//   ⇒ 预检报"支持"、真正解包时抛 ULB_ERR_TEX_DECODE，同一件事两套判据。
//   现在能力判定统一到 texdecode.canDecode(fmt)（只认 DECODERS），FORMATS 退回"命名/尺寸"用途。
//
// 为什么用属性式断言（遍历 FORMATS 全量比对）而不是挑几个格式：
//   这类"两套判据"的 bug 特征是**只在个别格式上分歧**（48 就是一个），
//   挑样本必然漏；遍历全部 key 才能保证"将来新增格式时两边不会再次分叉"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 与生产一致的装载顺序；各副本独立上下文，互不污染 */
const LOAD_ORDER = ['errors.js', 'etc2.js', 'dxt.js', 'texdecode.js'];

/**
 * 在干净上下文里加载一份 lib。
 * @param {string} dir 相对 ROOT 的 lib 目录
 * @param {boolean} withProbe 是否再加载 bundle-probe.js（只有 live2d 那份有）
 */
function loadLib(dir, withProbe = false) {
  const ctx = vm.createContext({});
  ctx.globalThis = ctx;
  const files = withProbe ? [...LOAD_ORDER, 'bundle-probe.js'] : LOAD_ORDER;
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
    vm.runInContext(src, ctx, { filename: `${dir}/${f}` });
  }
  return ctx.__ULB__;
}

const LIBS = {
  live2d: 'plugins/unity-live2d-bundle/lib',
  spine: 'plugins/unity-spine-bundle/lib',
};

test('两份 lib 副本的 texdecode 都导出 canDecode', () => {
  for (const [name, dir] of Object.entries(LIBS)) {
    const NS = loadLib(dir);
    assert.equal(typeof NS.texdecode.canDecode, 'function', `${name} 副本缺 canDecode`);
  }
});

test('canDecode 对 FORMATS 里每个格式都与"decode 能不能真跑"一致', () => {
  const NS = loadLib(LIBS.live2d);
  const { FORMATS, canDecode } = NS.texdecode;
  const keys = Object.keys(FORMATS).map(Number);
  assert.ok(keys.length > 0, 'FORMATS 为空，测试无意义');

  for (const fmt of keys) {
    const f = FORMATS[fmt];
    // 造一份"刚好够大"的数据：只要能走到解码器即可（内容不重要，只判"有没有分发分支"）
    const need = f.block || 1;
    const data = new Uint8Array(need);
    let decodable = true;
    try {
      NS.texdecode.decode({ format: fmt, name: f.name, width: 1, height: 1 }, data, { flipY: false });
    } catch (e) {
      // 只把"没有分发分支"算作不可解码；其它错误（如尺寸不足）不影响能力判定
      if (e && e.code === 'ULB_ERR_TEX_DECODE') decodable = false;
    }
    assert.equal(canDecode(fmt), decodable,
      `格式 ${fmt}(${f.name})：canDecode=${canDecode(fmt)} 但 decode 实测 decodable=${decodable}`);
  }
});

test('48 ETC2_RGBA1：FORMATS 有条目、canDecode=true、能解一个 4×4 块', () => {
  const NS = loadLib(LIBS.live2d);
  assert.ok(NS.texdecode.FORMATS[48], 'FORMATS 里应当仍有 48（命名/尺寸仍需要它）');
  // 本条曾断言"48 从未实现解码"——那是当时真实的能力缺口（整包报 ULB_ERR_TEX_DECODE 的原因）。
  // 现在 48 已实现（ETC2 RGB 块 + 每 4×4 块 8 字节 1bit alpha 平面），断言随之改为"可解"。
  assert.equal(NS.texdecode.canDecode(48), true, '48 已登记解码器，canDecode 必须是 true');
  const out = NS.texdecode.decode(
    { format: 48, name: 'ETC2_RGBA1', width: 4, height: 4 },
    new Uint8Array(16), // 一个 4×4 块 = 8 字节 RGB 块 + 8 字节 alpha 平面
    { flipY: false },
  );
  // decode() 返回裸 RGBA 字节（不是 {data} 包装）。
  // 注意：lib 跑在 vm 的独立 realm 里 ⇒ 它的 Uint8Array 与本文件的 Uint8Array 不是同一个构造函数，
  //   所以只能判"是不是 TypedArray" + 长度，不能用 instanceof Uint8Array（会恒假）。
  assert.ok(ArrayBuffer.isView(out) && out.length === 4 * 4 * 4, '4×4 ETC2_RGBA1 应解出 16×4 字节 RGBA');
  // 命名能力不受影响：面板/预检仍要显示 "ETC2_RGBA1" 而不是 "未知格式 48"
  assert.equal(NS.texdecode.formatName(48), 'ETC2_RGBA1');
});

test('预检 formatSupport 的 supported 与 canDecode 全量一致（这是本次修复的核心）', () => {
  const NS = loadLib(LIBS.live2d, true);
  assert.equal(typeof NS.bundleProbe.formatSupport, 'function', 'bundle-probe 未挂载');
  const { FORMATS, canDecode } = NS.texdecode;

  for (const fmt of Object.keys(FORMATS).map(Number)) {
    const got = NS.bundleProbe.formatSupport(fmt);
    assert.equal(got.supported, canDecode(fmt),
      `格式 ${fmt}(${FORMATS[fmt].name})：formatSupport.supported=${got.supported} 与 canDecode=${canDecode(fmt)} 不一致`);
  }
  // 显式钉住 48 的现状：曾经"被报成支持但其实没实现"（假支持），现在真的实现了
  //   ⇒ 断言从 false 改为 true；上面那条循环仍然负责"预检口径必须与 DECODERS 一致"这个结构约束
  assert.equal(NS.bundleProbe.formatSupport(48).supported, true, '48 已实现，预检必须报支持');
  assert.equal(NS.bundleProbe.formatSupport(48).formatName, 'ETC2_RGBA1', '48 的显示名仍要可读');
});

test('未知格式：formatSupport 报不支持，且不抛错', () => {
  const NS = loadLib(LIBS.live2d, true);
  const got = NS.bundleProbe.formatSupport(9999);
  assert.equal(got.supported, false);
  assert.ok(typeof got.formatName === 'string' && got.formatName.length > 0, '未知格式也要有可读名字');
});
