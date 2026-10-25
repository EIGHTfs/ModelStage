// panel/dialog.js —— 自绘弹窗（文本输入 / 危险确认），零依赖、纯逻辑
//
// 为什么要自绘而不是浏览器原生弹窗（输入框 / 确认框）：
//   ① 原生弹窗是**同步阻塞**的，会把整个 JS 线程停住 —— 阻塞期间渲染循环停摆、
//      就绪信号不推进、日志不落盘，与项目契约《事件驱动优先》直接冲突；
//   ② 原生 chrome 的字体/配色/按钮文案全由浏览器决定（英文环境下会变成 Cancel/OK），
//      深色面板弹出一个系统白底窗口，视觉断层，手机上还可能被虚拟键盘顶飞；
//   ③ DOM 级弹窗可以直接查元素断言，不需要 stub 全局函数 —— 自动化更稳。
//
// 两条硬纪律（踩过就会懂）：
//   · **任何**关闭路径（确定/取消/Esc/点遮罩/被新弹窗顶掉）都必须 resolve，
//     否则调用方的 await 永远挂住，表现为"点了没反应"；
//   · 同一时刻只允许一个弹窗：重复调用先把前一个 resolve 掉再开新的。

import { el } from './dom.js';

/** 样式表只注入一次（面板会重建，重复插 <link> 浪费） */
const CSS_HREF = 'panel/dialog.css';
const CSS_ATTR = 'data-dialog-css';

/** 当前打开的弹窗句柄（单例约束） */
let current = null;

/** 注入样式表（幂等；失败不阻塞弹窗可用） */
function ensureStylesheet(doc) {
  if (doc.querySelector(`link[${CSS_ATTR}]`)) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_HREF;
  link.setAttribute(CSS_ATTR, '1');
  (doc.head || doc.documentElement).append(link);
}

/**
 * 打开一个弹窗并在关闭时 resolve。
 * @param {object} spec
 * @param {string} spec.title 标题
 * @param {string} [spec.message] 说明文字
 * @param {boolean} [spec.withInput] 是否带输入框
 * @param {string} [spec.value] 输入框初始值
 * @param {string} [spec.placeholder] 占位提示
 * @param {number} [spec.maxlength] 最大长度（带实时字数反馈）
 * @param {boolean} [spec.danger] 危险操作（确定键用危险色 + 默认焦点给取消）
 * @param {string} [spec.confirmText] 确定键文案
 * @param {string} [spec.cancelText] 取消键文案
 * @returns {Promise<any>} 带输入 ⇒ 字符串或 null；确认 ⇒ boolean
 */
function openDialog(spec) {
  // 单例：先把上一个按"取消"收掉，避免两个遮罩叠放且其 Promise 悬空
  if (current) current.close(spec.withInput ? null : false);

  const doc = document;
  ensureStylesheet(doc);

  const mask = el('div', 'dlg-mask');
  const panel = el('div', 'dlg-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');

  const titleEl = el('p', 'dlg-title', spec.title || '');
  panel.append(titleEl);
  if (spec.message) panel.append(el('p', 'dlg-message', spec.message));

  let input = null;
  let counter = null;
  if (spec.withInput) {
    const row = el('div', 'dlg-input-row');
    input = el('input', 'dlg-input');
    input.type = 'text';
    input.value = spec.value || '';
    input.placeholder = spec.placeholder || '';
    if (spec.maxlength) input.maxLength = spec.maxlength;
    input.setAttribute('aria-label', spec.title || '输入');
    row.append(input);
    if (spec.maxlength) {
      // 实时字数：没有反馈用户不知道为什么打不进去
      counter = el('span', 'dlg-counter', `${input.value.length}/${spec.maxlength}`);
      row.append(counter);
    }
    panel.append(row);
  }

  const actions = el('div', 'dlg-actions');
  const btnCancel = el('button', 'dlg-btn dlg-btn--cancel', spec.cancelText || '取消');
  btnCancel.type = 'button';
  const btnOk = el('button', `dlg-btn dlg-btn--primary${spec.danger ? ' dlg-btn--danger' : ''}`, spec.confirmText || '确定');
  btnOk.type = 'button';
  actions.append(btnCancel, btnOk);
  panel.append(actions);
  mask.append(panel);
  doc.body.append(mask);

  let closed = false;
  return new Promise((resolve) => {
    /** 统一的关闭出口：保证只 resolve 一次，并摘掉全局监听 */
    const finish = (ok) => {
      if (closed) return;
      closed = true;
      doc.removeEventListener('keydown', onKey, true);
      try { mask.remove(); } catch { /* 已被移除 */ }
      if (current === handle) current = null;
      if (spec.withInput) resolve(ok ? String(input.value || '').trim() : null);
      else resolve(!!ok);
    };

    /** Enter 提交 / Esc 取消（捕获阶段，避免被页面其它快捷键抢先） */
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); return; }
      if (ev.key === 'Enter' && spec.withInput && ev.target === input) {
        ev.preventDefault();
        ev.stopPropagation();
        finish(true);   // 输入框里按 Enter = 确定
      }
    }
    doc.addEventListener('keydown', onKey, true);

    btnCancel.addEventListener('click', () => finish(false));
    btnOk.addEventListener('click', () => finish(true));
    mask.addEventListener('click', (ev) => { if (ev.target === mask) finish(false); });

    if (input) {
      input.addEventListener('input', () => {
        // 粘贴/程序化赋值可能绕过 maxlength ⇒ 这里再夹一次并同步字数，避免出现 "40/30"
        if (spec.maxlength && input.value.length > spec.maxlength) {
          input.value = input.value.slice(0, spec.maxlength);
        }
        if (counter && spec.maxlength) counter.textContent = `${input.value.length}/${spec.maxlength}`;
      });
      // 打开即聚焦并**全选原值**：改名时用户能直接打字覆盖
      try {
        input.focus();
        input.select();
      } catch { /* 忽略 */ }
    }

    const handle = { close: (ok) => finish(ok) };
    current = handle;

    // danger 时默认焦点给「取消」：防误触把图片删掉
    try {
      if (spec.danger) btnCancel.focus();
      else if (!spec.withInput) btnOk.focus();
    } catch { /* 忽略 */ }
  });
}

/**
 * 文本输入弹窗。
 * @param {object} opts 见 openDialog
 * @returns {Promise<string|null>} 确定 ⇒ 去空白后的文本；取消/关闭 ⇒ null
 */
export function askText(opts = {}) {
  return openDialog({
    ...opts,
    withInput: true,
    value: opts.value || '',
    placeholder: opts.placeholder || '',
    maxlength: opts.maxlength === undefined ? 30 : opts.maxlength,
  });
}

/**
 * 确认弹窗。
 * @param {object} opts { title, message, danger, confirmText, cancelText }
 * @returns {Promise<boolean>} 确定 ⇒ true；取消/关闭 ⇒ false
 */
export function askConfirm(opts = {}) {
  return openDialog({
    ...opts,
    withInput: false,
    danger: !!opts.danger,
  });
}
