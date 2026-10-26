// core/fs-portable.mjs —— 跨文件系统的可移植文件操作
//
// 为什么需要这一层：CIFS/SMB 挂载不允许改权限位，而 Node 的 fs.copyFileSync
//   在 libuv 层复制完字节后会 fchmod 把源权限位套到目标文件 —— 于是在 SMB 上
//   稳定报 EPERM。对照实验（2026-10-26）：
//     fs.copyFileSync(src, dst)              → EPERM
//     readFileSync + writeFileSync           → OK
//     openSync('w') + writeSync + close      → OK
//   所以不是目录不存在、也不是路径拼错，就是复制之后那次改权限。

import fs from 'node:fs';

/**
 * 复制文件，在不能改权限的文件系统上自动降级。
 *
 * 策略：普通盘先走内核复制（大文件明显更快）；只有 EPERM / ENOTSUP 这两种
 *   "这块文件系统不支持"的错误才降级成纯字节复制。其它错误一律往上抛 ——
 *   绝不把真问题（源不存在、磁盘满、路径越界）也吞成"复制成功或静默失败"。
 *
 * 为什么不是 async：调用点（配置备份、损坏文件留证）都在同步流程里，
 *   改成 Promise 会把整条写入管道染成异步，收益为零、风险变大。
 *
 * @param {string} src 源文件路径
 * @param {string} dst 目标文件路径（父目录必须已存在，与 fs.copyFileSync 一致）
 * @returns {void}
 */
export function copyFilePortable(src, dst) {
  try {
    fs.copyFileSync(src, dst);
  } catch (e) {
    // 只对"这块文件系统不支持改权限"的两种错误降级；其它照抛
    if (e.code !== 'EPERM' && e.code !== 'ENOTSUP') throw e;
    // 纯字节复制：读全量再写回，不碰权限位，实测在 CIFS/SMB 上可用。
    //   内存代价 = 文件大小（配置文件都是 KB 级；这里不做流式，避免再引入一条出错路径）
    fs.writeFileSync(dst, fs.readFileSync(src));
  }
}
