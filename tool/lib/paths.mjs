// tool/lib/paths.mjs —— 脚本里反复用到的"本文件位置"计算
//
// 为什么单独成一个模块：`path.dirname(fileURLToPath(import.meta.url))` 这一行在 6 个脚本里
//   各写了一遍（bin/modelstage.mjs 与 tool/ 下的 5 个）。它是纯机械代码，复制越多越容易出错 ——
//   常见的错法是漏掉 fileURLToPath，于是 HERE 变成 "file:///…" 字符串，
//   后面所有 path.join 都会拼出怪路径，而报错要等到读文件时才出现。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 取「本文件所在目录」的绝对路径（ESM 没有 __dirname）。
 *
 * 注意它返回的是**调用方自己**的目录：bin/ 下调用得到 <root>/bin，tool/ 下得到 <root>/tool。
 *   所以只统一写法，不统一返回值 —— 想把两者换算成项目根，各调用点自己 path.resolve(HERE, '..')。
 * @param {string} metaUrl 调用方传 `import.meta.url`
 * @returns {string} 目录绝对路径
 */
export function here(metaUrl) {
  return path.dirname(fileURLToPath(metaUrl));
}
