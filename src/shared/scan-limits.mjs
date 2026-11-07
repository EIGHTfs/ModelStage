// shared/scan-limits.mjs —— 扫描判死的阈值（**单一来源**）
//
// 为什么放 shared：前端要用它判"多久没进度就算疑似卡住"，将来服务端/插件也可能要读同一个数。
//   两处各写一份数字，调参时必然漂移（一处改了另一处没改，表现为"前端说卡住、服务端还在跑"）。
//
// 口径（设计 §7.3）：
//   · 这是**无进展**阈值，不是总时长阈值：大目录本来就慢，用总时长判死会误杀正常扫描。
//   · 每次收到任意一帧（start / progress / done / cached / error）都会重置计时。
//   · 触发后只改状态与文案，**不自动取消请求** —— 是否重试交给调用方决定。

/** 连续无帧多久 ⇒ 判"疑似卡住"（毫秒） */
export const SCAN_STALL_MS = 10000;

/**
 * 解析可覆盖值（来自 `/api/web-config` 的 scanStallMs 或测试注入）。
 * 非法/缺失一律回落默认：判死阈值必须始终有个可用数字，不能因为配置脏就变成 NaN。
 * @param {unknown} raw
 * @returns {number}
 */
export function resolveScanStallMs(raw) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : SCAN_STALL_MS;
}
