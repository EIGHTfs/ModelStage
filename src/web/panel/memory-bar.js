// panel/memory-bar.js —— 内存三色条（总 / 可用 / 服务端已占用），两处复用同一实现
//
// 数据只有一个来源：GET /api/unpack/capacity（不带 sourceMb）
//   memTotalMb     物理总内存
//   memAvailableMb MemAvailable（含可回收 buff/cache）
//   rssMb          服务端进程已占用
// 这里**不显示 peakEstMb**（那是"某个包解包要多少"的预估，与"当前机器内存状况"是两件事）。
//
// 为什么不做定时刷新：项目契约要求事件驱动。数字停在拉取那一刻是预期行为 ——
//   用户要新数字，重新加载模型或重开设置面板即可。
//
// 无障碍：整条 role="img" + aria-label 写全三个数值；文字行**始终可见**（触摸端没有 hover）。
//
// 失败态（与"主动隐藏"是两件事，别混）：
//   · 拉取失败 / 数据不完整 ⇒ **保留占位**，条上写「内存：不可用（原因）」，
//     原因至少能分出 超时 / HTTP xxx / 数据不完整 三种（用户不必猜是接口挂了还是自己被关了保护）。
//   · 开关关掉（"显示状态信息" / 内存保护关）⇒ 走 hide()，整块不占位 —— 这是主动隐藏，维持原语义。
//   · 下次轮询/刷新拿到数据 ⇒ 自动恢复正常条（清掉 unavailable 标记）。

import { el } from './dom.js';
import { stageLog } from '../app/status.js';

/**
 * 把三个内存量拆成三段百分比，并保证**恰好合 100%**。
 *
 * 为什么需要专门修正：三段各自四舍五入后相加常是 99.99 或 100.01，
 *   条子末尾会露一条缝（或溢出）—— 视觉上像渲染错误。所以余数补给最大的一段。
 *
 * @param {{total:number, server:number, avail:number}} m 三个量（MB）
 * @returns {{server:number, other:number, avail:number}} 三段百分比（2 位小数，和恰为 100）
 */
export function splitPercents(m) {
  const total = Number(m && m.total) > 0 ? Number(m.total) : 0;
  if (!total) return { server: 0, other: 100, avail: 0 };
  const clamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));
  const round2 = (v) => Math.round(v * 100) / 100;
  let server = clamp((Number(m.server) || 0) / total * 100);
  let avail = clamp((Number(m.avail) || 0) / total * 100);
  // 两者之和可能超过 100（rss 与 MemAvailable 口径不同，极端情况下会重叠）⇒ 按比例压回
  if (server + avail > 100) {
    const k = 100 / (server + avail);
    server *= k;
    avail *= k;
  }
  server = round2(server);
  avail = round2(avail);
  let other = round2(100 - server - avail);
  // 余数修正：把 0.01 级别的误差补给**最大的一段**，避免条子末尾露缝
  const drift = round2(100 - (server + other + avail));
  if (drift !== 0) {
    const biggest = Math.max(server, other, avail);
    if (biggest === server) server = round2(server + drift);
    else if (biggest === avail) avail = round2(avail + drift);
    else other = round2(other + drift);
  }
  return { server, other, avail };
}

/** 建一条三色条的 DOM（不含数据）：轨道 + 三段 + 文字行 */
function buildBar() {
  const root = el('div', 'mem-bar');
  root.setAttribute('role', 'img');
  const track = el('div', 'mem-bar-track');
  const segServer = el('span', 'mem-bar-seg mem-bar-seg--server');
  const segOther = el('span', 'mem-bar-seg mem-bar-seg--other');
  const segAvail = el('span', 'mem-bar-seg mem-bar-seg--avail');
  track.append(segServer, segOther, segAvail);
  const text = el('p', 'mem-bar-text', '');
  root.append(track, text);
  return { root, segServer, segOther, segAvail, text };
}

/**
 * 挂一条内存条到容器里（容器由调用方提供；面板重建会换容器，所以刷新时现查）。
 * @param {string} selector 容器选择器
 * @returns {{refresh: () => Promise<boolean>, hide: () => void, root: () => HTMLElement|null}}
 */
export function mountMemoryBar(selector) {
  const getHost = () => document.querySelector(selector);

  /** 现查（或首次创建）本容器的条子 */
  const ensure = () => {
    const host = getHost();
    if (!host) return null;
    let bar = host.querySelector('.mem-bar');
    if (!bar) {
      const built = buildBar();
      host.replaceChildren(built.root);
      bar = built.root;
    }
    return bar;
  };

  const hide = () => {
    const host = getHost();
    if (!host) return;
    host.replaceChildren();   // 不留空壳：没数据就整块不占位
    host.hidden = true;
  };

  /**
   * 拉取失败时：**保留占位、把原因写在条上**，而不是整块消失。
   *
   * 为什么要这个（不再一律 hide）：条子突然消失，用户分不清是哪一种情况 ——
   *   ① 接口挂了/超时 ② 服务端没数据 ③ 内存保护被关。三者在界面上曾长得一模一样。
   * 与 `hide()` 的分工：hide() 只服务"开关关掉、本来就不该显示"这种**主动隐藏**；
   *   拉取失败属于**该显示但显示不出**，要留着位置说明白。
   *
   * 硬约束：**绝不用 0 或上一次的旧值冒充当前值** —— 三段宽度归零、dataset 数值清空，
   *   文字只写原因。宁可空轨道 + 一句原因，也不给假数字。
   * @param {string} reason 已归类的可读原因（超时 / HTTP xxx / 数据不完整）
   */
  const showUnavailable = (reason) => {
    const bar = ensure();
    if (!bar) return false;
    const host = getHost();
    host.hidden = false;                 // 保留占位
    bar.dataset.unavailable = '1';       // 供断言与排障：这是"不可用态"，不是正常条
    // 清掉上一次的数值痕迹，避免任何消费方（含断言快照）把旧数字当成当前值
    delete bar.dataset.pctServer;
    delete bar.dataset.pctOther;
    delete bar.dataset.pctAvail;
    for (const cls of ['--server', '--other', '--avail']) {
      const seg = bar.querySelector(`.mem-bar-seg${cls}`);
      if (seg) seg.style.setProperty('--seg-w', '0%');
    }
    const label = `内存：不可用（${reason}）`;
    bar.setAttribute('aria-label', label);
    const text = bar.querySelector('.mem-bar-text');
    if (text) text.textContent = label;
    return false;
  };

  /** 把 fetch 异常归类成用户看得懂的原因（三种失败要能区分开） */
  const reasonOfFetchError = (err) => {
    const msg = String((err && err.message) || err || '');
    // AbortSignal.timeout() 超时抛的是 name='TimeoutError' 的 DOMException
    if ((err && err.name === 'TimeoutError') || /abort|timeout/i.test(msg)) return '查询超时';
    const m = msg.match(/^HTTP (\d{3})$/);
    if (m) return `HTTP ${m[1]}`;
    return msg || '接口不可达';
  };

  /**
   * 拉一次数据并刷新显示。
   * @returns {Promise<boolean>} 是否成功显示
   */
  const refresh = async () => {
    const host = getHost();
    if (!host) return false;
    let j = null;
    try {
      const res = await fetch('/api/unpack/capacity', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      j = await res.json();
    } catch (err) {
      // 失败：留占位 + 把原因写在条上（不静默、也不显示假数字）
      const reason = reasonOfFetchError(err);
      stageLog('warn', `内存条数据取不到：${reason}`, { where: 'memory-bar', err: String((err && err.message) || err) });
      return showUnavailable(reason);
    }
    const total = Number(j.memTotalMb);
    const avail = Number(j.memAvailableMb);
    const server = Number(j.rssMb);
    if (!(total > 0) || !Number.isFinite(avail) || !Number.isFinite(server)) {
      stageLog('warn', '内存条数据不完整（字段缺失或非法）', { total, avail, server });
      return showUnavailable('数据不完整');
    }

    const bar = ensure();
    if (!bar) return false;
    host.hidden = false;
    delete bar.dataset.unavailable;   // 恢复成正常条（下一轮拿到数据就切回来）
    const p = splitPercents({ total, server, avail });
    const segS = bar.querySelector('.mem-bar-seg--server');
    const segO = bar.querySelector('.mem-bar-seg--other');
    const segA = bar.querySelector('.mem-bar-seg--avail');
    // 宽度是"数据驱动的动态值" ⇒ 用 CSS 自定义属性下发，样式表里只用 var()
    segS.style.setProperty('--seg-w', `${p.server}%`);
    segO.style.setProperty('--seg-w', `${p.other}%`);
    segA.style.setProperty('--seg-w', `${p.avail}%`);
    bar.dataset.pctServer = String(p.server);
    bar.dataset.pctOther = String(p.other);
    bar.dataset.pctAvail = String(p.avail);
    bar.setAttribute('aria-label', `内存：总 ${total} MB，可用 ${avail} MB，服务端已占用 ${server} MB`);
    const text = bar.querySelector('.mem-bar-text');
    if (text) text.textContent = `总 ${total} MB · 可用 ${avail} MB · 服务端 ${server} MB`;
    return true;
  };

  return { refresh, hide, root: () => getHost() && getHost().querySelector('.mem-bar') };
}
