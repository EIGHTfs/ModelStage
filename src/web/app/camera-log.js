// app/camera-log.js —— 相机操作日志的单一出口（控制台 / 断言缓冲 / 调试面板）
//
// 为什么独立成模块：main.js 有行数上限，且这段逻辑与"相机怎么动"无关，
//   只负责把相机侧发出的日志分发给三个消费者。

/**
 * 把相机日志接到三路输出。
 * @param {object|null} cameraEntry 当前渲染器的相机入口（含 setLogger）
 * @returns {boolean} 是否成功接上（相机入口缺失时返回 false）
 */
export function installCameraLogger(cameraEntry) {
  if (!cameraEntry || typeof cameraEntry.setLogger !== 'function') return false;
  cameraEntry.setLogger((line, data) => {
    const bag = (window.__WEB__ = window.__WEB__ || {});
    bag.cameraLog = bag.cameraLog || [];
    bag.cameraLog.push({ at: Date.now(), line, data });
    if (bag.cameraLog.length > 200) bag.cameraLog.shift(); // 只留最近 200 条供断言
    console.info('%c[CAMERA]', 'color:#1fc0c5', line);
    if (bag.debugLog) {
      try {
        const opts = { level: 'info', src: 'camera' };
        if (data !== undefined && data !== null) opts.data = data; // 结构化字段独立，不拼进正文
        bag.debugLog.log('CAMERA', line, opts);
      } catch { /* 日志失败不影响业务 */ }
    }
  });
  return true;
}
