#!/usr/bin/env node
// parse-jsonc.mjs — 带注释的 JSON 解析（JSONC），零依赖
//
// 为什么需要：标准 JSON 不支持注释，但配置文件是人要反复手改的，没注释很难维护。
//   用 YAML 能原生支持注释，但要引入依赖（本项目刻意保持零依赖，见 zero-dep 规范）。
//   折中方案：JSON + 轻量注释剥离，既零依赖，又能写 // 与 /* */ 注释。
//
// 关键正确性要求（易踩坑）：
//   剥离注释时必须**跳过字符串内部**，否则会误伤路径/URL 里的 // 或 /*，
//   例如 "path": "https://example.com/a//b" 里的 // 不是注释。
//   本实现逐字符扫描并跟踪字符串状态（含转义 \" 处理），只在字符串外剥离。
//
// 用法：
//   const { parseJsonc } = await import('./parse-jsonc.mjs');
//   const cfg = parseJsonc(fs.readFileSync(file, 'utf8'));

/**
 * 剥离 JSONC 文本中的注释（保留字符串原样）。
 * @param {string} text 原始文本
 * @returns {string} 可被 JSON.parse 解析的文本
 */
export function stripComments(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (inStr) {
      out += ch;
      if (esc) { esc = false; }
      else if (ch === '\\') { esc = true; }
      else if (ch === '"') { inStr = false; }
      i++;
      continue;
    }

    // 字符串开始
    if (ch === '"') { inStr = true; out += ch; i++; continue; }

    // 行注释 //
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue; // 换行由下一轮原样输出，保持行号对齐
    }

    // 块注释 /* */
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2; // 跳过结束符 */
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * 解析 JSONC（先剥离注释再 JSON.parse）。
 * @param {string} text 原始文本
 * @param {string} [label] 报错时的文件名提示
 * @returns {any} 解析结果
 */
export function parseJsonc(text, label = '配置') {
  const cleaned = stripComments(text);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`${label}解析失败: ${e.message}（已剥离注释后再解析；若报错位置与原文不符，注意注释会改变行号）`);
  }
}

// 直接运行：读文件并打印解析结果，便于排查配置
// 仅 CLI 自跑时执行（被 import 时此分支不会进入），故不走 logger
if (process.argv[1] && process.argv[1].endsWith('parse-jsonc.mjs') && process.argv[2]) {
  const fs = await import('node:fs');
  const cfg = parseJsonc(fs.readFileSync(process.argv[2], 'utf8'), process.argv[2]);
  console.log(JSON.stringify(cfg, null, 2));
}
