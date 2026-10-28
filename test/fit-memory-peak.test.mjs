// test/fit-memory-peak.test.mjs —— 标定工具的判定与输出格式
//
// 为什么只测纯函数：这个工具的价值在"判定口径"和"输出能不能直接粘"，而真测量需要大样本（不入库、CI 跑不了）。
//   所以把口径做成纯函数（buildRows / hasUnderEstimate / suggestPoints / suggestSnippet / peakFormula）逐个钉死。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  peakFormula, buildRows, hasUnderEstimate, suggestPoints, suggestSnippet, formatTable,
} from '../tool/fit-memory-peak.mjs';

const MB = 1024 * 1024;

test('① 峰值口径与服务端同式：起始 RSS + 本次 VmHWM 增量（没创新高就取起始 RSS）', () => {
  // 创新高：100 + (500-120) = 480
  assert.equal(peakFormula({ rss: 100 * MB, peak: 120 * MB }, { rss: 300 * MB, peak: 500 * MB }), 480 * MB);
  // 没创新高（HWM 只增不减）：取起始 RSS，不能出现负增量
  assert.equal(peakFormula({ rss: 400 * MB, peak: 900 * MB }, { rss: 380 * MB, peak: 900 * MB }), 400 * MB);
});

test('② 低估判定：declared < measured ⇒ low=true，倍数 > 1', () => {
  const rows = buildRows([
    { pack: '/a', decompressedMb: 8.55, measuredBytes: 355 * MB, declaredBytes: 192 * MB },
    { pack: '/b', decompressedMb: 2.76, measuredBytes: 100 * MB, declaredBytes: 151 * MB },
  ]);
  assert.equal(rows[0].low, true, '实测 355 > 声明 192 ⇒ 低估');
  assert.equal(rows[0].ratio, 1.85, '倍数 = 实测/声明');
  assert.equal(rows[1].low, false, '实测 100 < 声明 151 ⇒ 不算低估');
  assert.equal(hasUnderEstimate(rows), true);
  assert.equal(hasUnderEstimate([rows[1]]), false, '全都不低估时返回 false（决定退出码 0）');
});

test('③ 建议表：按解压量升序、取同档最大实测、乘余量并向上取整', () => {
  const pts = suggestPoints([
    { decompressedMb: 8.55, measuredMb: 300 },
    { decompressedMb: 2.76, measuredMb: 131 },
    { decompressedMb: 8.55, measuredMb: 355 },   // 同档更大 ⇒ 取 355（上包络）
  ], { margin: 1.15 });
  assert.deepEqual(pts, [[2.76, 151], [8.55, 409]], '2.76→ceil(131×1.15)=151；8.55→ceil(355×1.15)=409');
  // 余量可调
  assert.deepEqual(suggestPoints([{ decompressedMb: 10, measuredMb: 100 }], { margin: 1 }), [[10, 100]]);
});

test('④ 输出片段可直接粘贴：含 LZMA_PEAK_POINTS 与 PEAK_MARGIN，并标注基准', () => {
  const s = suggestSnippet([[2.76, 151], [8.55, 409]], { margin: 1.15, basis: 'inproc' });
  assert.match(s, /const LZMA_PEAK_POINTS = \[\[2\.76, 151\], \[8\.55, 409\]\];/);
  assert.match(s, /const PEAK_MARGIN = 1\.15;/);
  assert.match(s, /VmHWM/, '必须写明基准是服务端进程内 VmHWM 增量');
  // child 基准要明确警告不能拿去标表
  assert.match(suggestSnippet([[1, 2]], { basis: 'child' }), /不要拿去标表/);
});

test('⑤ 表格格式：四列齐全，低估项显式标出百分比', () => {
  const rows = buildRows([
    { pack: '/x/lzma', decompressedMb: 21.37, measuredBytes: 869 * MB, declaredBytes: 647 * MB },
  ]);
  const text = formatTable(rows);
  assert.match(text, /解压MB \| 实测峰值 \| 当前声明 \| 倍数 \| 判定/);
  assert.match(text, /21\.4 \|.*869 \|.*647 \|.*1\.34 \| 低估（\+34%）/);
});

test('⑥ 声明为 0（插件算不出）时倍数记 0，不误判成"无穷大低估"', () => {
  const rows = buildRows([{ pack: '/z', decompressedMb: 5, measuredBytes: 200 * MB, declaredBytes: 0 }]);
  assert.equal(rows[0].ratio, 0);
  assert.equal(rows[0].low, true, '声明 0 而实测 200 ⇒ 仍应视为低估（不能放过）');
});
