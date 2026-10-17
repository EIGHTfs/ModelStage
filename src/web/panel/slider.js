// panel/slider.js —— 滑块控件的渲染与"位置↔数值"映射（从 view.js 抽出来）
//
// 为什么单独一个文件：滑块是唯一带**非线性映射**的控件（双段比例 + 吸附 + 刻度），
//   逻辑量比其它控件大；留在 view.js 里会把那个文件继续推长（超长文件审计不过）。
//
// 契约《禁止内联 CSS 与 JS》：
//   · 颜色/尺寸/圆角/字体全部在 panel/panel.css（类名 + CSS 变量），这里**不写 element.style**；
//   · 轨道与手柄用原生 `accent-color: var(--color-primary)` 跟随五套主题；
//   · 中线刻度是伪元素，颜色由 CSS 侧的 var(--color-muted-foreground) 指定（accent-color 不影响伪元素）。

/** 允许的空值语义：0 值有专门文案时优先显示它（混合时长 0 秒 = "关"） */

/**
 * 滑块的"位置 ↔ 数值"映射表（非线性滑块的唯一权威）。
 *
 * 为什么速度要非线性：原生 range 是线性的，若 0.1~3 平铺，1.0 只落在 31% 处，
 *   慢速段（0.1~1.0）被压成一小段，想细看慢动作很难拖准。
 *   改成**双段比例**：左半 0~50 格 → 0.1~1.0（细调），右半 50~100 格 → 1.0~3.0（粗调），
 *   1.0 恰好在正中间 —— 视觉上天然是"基准点"，也更符合人对倍率的感知（不是线性的）。
 */
/** 速度滑块的取值域与双段划分（数值含义集中在常量里，映射函数只引用它们） */
export const SPEED_MIN = 0.1;        // 最慢
export const SPEED_MID = 1;          // 基准值：落在滑块正中
export const SPEED_MAX = 3;          // 最快
export const SPEED_STEP = 0.1;       // 对外声明的步进（读数是两位小数，实际由量化决定）
export const SPEED_DEFAULT = 1;      // 默认倍率
export const MIX_MIN = 0;            // 混合时长：0 = 不混合
export const MIX_MAX = 1;            // 最长 1 秒
export const MIX_STEP = 0.05;        // 混合时长步进
export const MIX_DEFAULT = 0.2;      // 默认 0.2 秒（引擎默认过渡）

const POS_MIN = 0;                   // 滑块格位下界
const POS_MID = 50;                  // 正中 = SPEED_MID
const POS_MAX = 100;                 // 格位上界
const SNAP_RANGE = 3;                // 正中 ±3 格内吸附到基准值
const QUANTIZE_STEPS = 20;           // 按 1/20 = 0.05 归整

export const SLIDER_CURVES = {
  speed: {
    /** 位置(0~100 整数) → 数值 */
    toValue: (p) => (p <= POS_MID
      ? SPEED_MIN + (p / POS_MID) * (SPEED_MID - SPEED_MIN)
      : SPEED_MID + ((p - POS_MID) / (POS_MAX - POS_MID)) * (SPEED_MAX - SPEED_MID)),
    /** 数值 → 位置(0~100 浮点，写入时取整) */
    toPos: (v) => (v <= SPEED_MID
      ? ((v - SPEED_MIN) / (SPEED_MID - SPEED_MIN)) * POS_MID
      : POS_MID + ((v - SPEED_MID) / (SPEED_MAX - SPEED_MID)) * (POS_MAX - POS_MID)),
    /** 靠近正中（基准倍率）就吸附过去，避免"想回 1x 却总停在 0.97x" */
    snap: { at: POS_MID, range: SNAP_RANGE },
    // 按 0.05 归整：慢速段每格 ≈0.018，若按 0.1 归整会把 25% 处的 0.55 变成 0.6（与双段比例对不上）；
    //   0.05 既贴合映射、又保证下发/持久化里不会出现 1.2999999 这类长小数。
    quantize: (v) => Math.round(v * QUANTIZE_STEPS) / QUANTIZE_STEPS,
    precision: 1,
    posMin: POS_MIN,
    posMax: POS_MAX,
  },
};

/**
 * 取控件用的映射（无 curve 声明 ⇒ 线性，直接读 input 的 min/max/step）。
 * @param {object} ctl schema 控件声明
 */
export function curveOf(ctl) {
  return (ctl && ctl.curve && SLIDER_CURVES[ctl.curve]) || null;
}

/**
 * 数值 → 滑块位置（线性控件原样返回）。
 * @param {object} ctl
 * @param {number} value 真实数值
 * @returns {number} 位置（非线性时 0~100，线性时 min..max）
 */
export function posOf(ctl, value) {
  const cv = curveOf(ctl);
  return cv ? cv.toPos(Number(value)) : Number(value);
}

/**
 * 位置 → 真实数值（非线性时做量化）。
 * @param {object} ctl
 * @param {number} pos 滑块位置
 * @returns {number} 真实数值
 */
export function valueOfPos(ctl, pos) {
  const cv = curveOf(ctl);
  const raw = cv ? cv.toValue(Number(pos)) : Number(pos);
  return cv ? cv.quantize(raw) : raw;
}

/**
 * 读数格式化（按 schema 的 `format` 声明，不在这里猜单位）。
 *   format: 'x' → 1.5x（播速）；'s' → 0.85s（时长）；0 且声明了 zeroText → 显示该文案（"关"）
 * @param {object} ctl
 * @param {number} v
 * @returns {string}
 */
export function formatSliderValue(ctl, v) {
  const n = Number(v);
  if (ctl.zeroText && Number.isFinite(n) && n === 0) return ctl.zeroText;
  const cv = curveOf(ctl);
  const digits = cv && cv.precision !== undefined ? cv.precision : 2;
  if (ctl.format === 's') return `${(Number.isFinite(n) ? n : 0).toFixed(2)}s`;
  if (ctl.format === 'x') {
    // 速度读数两位、裁掉末尾的 0，但**保留一位**（1.0x 不写成 1x、0.55x 不写成 0.6x）：
    //   读数是"真实生效值"的唯一可见出口，必须与内部值一致（0.05 归整后会出现 0.55 这类两位值）
    const t = (Number.isFinite(n) ? n : 1).toFixed(2);          // 1.50 / 0.55 / 1.00
    return `${t.endsWith('0') ? t.slice(0, -1) : t}x`;           // 1.5x / 0.55x / 1.0x
  }
  return Number.isFinite(n) ? n.toFixed(digits) : '';
}

/**
 * 渲染一个滑块控件。
 *
 * 结构**标签在左、当前值在右（等宽），滑块单独一行占满宽度**，正中一条基准刻度：
 *   ┌ 速度            1.5x ┐
 *   └ ─────●──┊───────────┘
 *
 * @param {object} ctl schema 控件声明（kind: 'slider'）
 * @param {object} ctx 面板上下文：{ isWired(id), onSetting(id, value) }
 * @param {(tag: string, cls?: string, text?: string) => HTMLElement} el DOM 构造小工具（由 view.js 注入）
 * @param {(node: HTMLElement, ctl: object, ctx: object) => void} markDisabled 置灰工具
 * @returns {HTMLElement}
 */
/**
 * 建滑块的原生 input（非线性曲线统一用 0~100 格；线性控件直接用 min/max/step）。
 * @returns {HTMLInputElement}
 */
function buildRangeInput(ctl, cv, el) {
  const input = el('input', 'ctl-slider-input');
  input.id = ctl.id || '';
  input.type = 'range';
  if (cv) {
    input.min = String(cv.posMin);
    input.max = String(cv.posMax);
    input.step = '1';
    input.value = String(Math.round(posOf(ctl, ctl.defaultValue !== undefined ? ctl.defaultValue : SPEED_MID)));
  } else {
    input.min = String(ctl.min !== undefined ? ctl.min : 0);
    input.max = String(ctl.max !== undefined ? ctl.max : 100);
    input.step = String(ctl.step !== undefined ? ctl.step : 1);
    input.value = String(ctl.defaultValue !== undefined ? ctl.defaultValue : input.min);
  }
  input.setAttribute('aria-label', ctl.label);
  return input;
}

/**
 * 渲染一个滑块控件（结构见文件头注释）。
 * @param {object} ctl schema 控件声明（kind: 'slider'）
 * @param {object} ctx 面板上下文：{ isWired(id), onSetting(id, value) }
 * @param {Function} el DOM 构造小工具（由 view.js 注入）
 * @param {Function} markDisabled 置灰工具（由 view.js 注入）
 * @returns {HTMLElement}
 */
export function renderSlider(ctl, ctx, el, markDisabled) {
  const wired = ctx.isWired(ctl.id) && ctl.disabled !== true;
  const cv = curveOf(ctl);
  const box = el('div', 'ctl-slider');
  box.dataset.ctl = ctl.id || '';

  const head = el('div', 'ctl-slider-head');
  head.append(el('span', 'ctl-slider-label', ctl.label));
  // 契约 R2：首次渲染就用工厂里的当前值（有则覆盖 schema 默认），避免"先默认后跳"
  const ivSlider = ctx && typeof ctx.initialValue === 'function' ? ctx.initialValue(ctl.id) : undefined;
  const seed = ivSlider === undefined ? ctl.defaultValue : ivSlider;
  const readout = el('span', 'ctl-slider-value', formatSliderValue(ctl, seed));
  readout.dataset.readout = ctl.id || '';
  readout.setAttribute('aria-live', 'polite');
  head.append(readout);

  const track = el('div', 'ctl-slider-track');
  const input = buildRangeInput(ctl, cv, el);
  // 滑块 input.value 存的是**格位**（非线性滑块要换算），所以按 posOf 定位而不是直接写数值
  if (ivSlider !== undefined) {
    try { input.value = String(Math.round(posOf(ctl, ivSlider))); } catch { /* 换算失败就用默认位置 */ }
  }
  track.append(input);
  box.append(head, track);

  if (!wired) {
    markDisabled(input, ctl, ctx);
    return box;
  }
  input.title = ctl.title || ctl.label;
  readout.title = cv && cv.snap ? '双击回到基准值' : '双击复位到默认值';

  /** 读当前格位 → 吸附 → 回写滑块 → 返回真实数值 */
  const readSnapped = () => {
    let pos = Number(input.value);
    if (cv && cv.snap && Math.abs(pos - cv.snap.at) <= cv.snap.range) {
      pos = cv.snap.at;
      input.value = String(pos);
    }
    return valueOfPos(ctl, pos);
  };
  const commit = (v) => {
    readout.textContent = formatSliderValue(ctl, v);
    try { ctx.onSetting(ctl.id, v); } catch { /* 接线失败不影响面板自身显示 */ }
  };

  input.addEventListener('input', () => commit(readSnapped()));
  // 双击读数复位：不额外占一行按钮
  readout.addEventListener('dblclick', () => {
    const back = ctl.defaultValue !== undefined ? ctl.defaultValue : valueOfPos(ctl, input.min);
    input.value = String(Math.round(posOf(ctl, back)));
    commit(back);
  });
  return box;
}
