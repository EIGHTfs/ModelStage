// panel/background-list.js —— 右栏「主题背景 · 自定义图片」列表
//
// 一个列表做四件事：展示（缩略图 + 名称 + 大小）、设为背景、重命名（内联编辑）、删除（二次确认），
//   外加顶部的「上传图片」。数据全部来自服务端（app/backgrounds.js），刷新后仍在。
//
// 为什么失败提示要贴出具体文案：上传超限、类型不符、磁盘失败是三种不同的用户动作错误，
//   笼统一句"上传失败"用户不知道该改什么；后端给了 reason + 具体数值，这里原样透出。

import { el } from './dom.js';
import { stageLog, stageStatus } from '../app/status.js';
import { applyBackground, readViewSettings, setBackgroundColor, setCustomBackground } from '../app/view-settings.js';
import {
  addSolid, listSolids, removeSolid, renameSolid, resetSolids,
} from '../app/background-solids.js';
import { openColorPicker } from './color-picker.js';
import {
  listBackgrounds, pickFile, removeBackground, renameBackground, uploadBackground,
} from '../app/backgrounds.js';

/** 容器的唯一选择器（现查，不闭包持有——面板会重建） */
const BOX_SEL = '#right-panel [data-ctl="ctl-bg-list"]';

/** 当前列表数据（重命名/删除后就地更新，避免整表重取时闪一下） */
let items = [];

/** 二次确认的自动解除时间：误点了 8 秒内不动就恢复成「删除」 */
const DISARM_MS = 8000;

/**
 * 在容器里显示一条状态文案（成功/失败都走这里，断言读 data-bg-msg）。
 * @param {HTMLElement} box 容器
 * @param {string} text 文案
 * @param {'ok'|'error'} [kind] 类型
 */
function say(box, text, kind = 'ok') {
  const hint = box.querySelector('.bg-hint');
  if (!hint) return;
  hint.textContent = text;
  hint.dataset.kind = kind;
  box.dataset.bgMsg = text;
  if (kind === 'error') stageLog('error', text, { source: 'background-list' }); else stageStatus(text, 'info', { show: true });
}

/**
 * 把字节数格式化成人话。
 * @param {number} n 字节
 */
function humanSize(n) {
  const v = Number(n) || 0;
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

/**
 * 设为舞台背景（服务端 url 直接当 background-image）。
 * @param {object} item 列表项
 */
function applyItem(item) {
  const okSet = setCustomBackground(item.url);
  const box = document.querySelector(BOX_SEL);
  if (box) say(box, okSet ? `已设为背景：${item.name}` : '设置背景失败（舞台未就绪）', okSet ? 'ok' : 'error');
  // 通知面板把「背景模式」档位同步到「自定义」（视觉一致）
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('panel:bg-applied', { detail: { mode: 'custom' } }));
  }
}

/**
 * 造一行：缩略图 + 名称/大小 + 改名 + 删除。
 * @param {object} item 列表项
 * @param {HTMLElement} box 容器（用于状态提示）
 * @returns {HTMLElement} 行元素
 */
function buildRow(item, box) {
  const row = el('div', 'bg-item');
  row.dataset.bgId = item.id;

  const thumb = el('button', 'bg-thumb');
  thumb.type = 'button';
  thumb.title = '设为背景';
  const img = el('img');
  img.src = item.url;
  img.alt = item.name || '背景图';
  img.loading = 'lazy';
  thumb.append(img);
  thumb.addEventListener('click', () => applyItem(item));

  const meta = el('div', 'bg-meta');
  const nameEl = el('span', 'bg-name', item.name || '未命名');
  meta.append(nameEl, el('span', 'bg-size', humanSize(item.bytes)));

  const renameBtn = el('button', 'bg-btn', '改名');
  renameBtn.type = 'button';
  renameBtn.title = '重命名这张图（只改显示名）';
  renameBtn.addEventListener('click', () => startRename(row, item, box));

  const delBtn = el('button', 'bg-btn bg-btn-danger', '删除');
  delBtn.type = 'button';
  delBtn.title = '删除这张图（移入回收目录，可恢复）';
  delBtn.addEventListener('click', () => confirmDelete(delBtn, item, box));

  row.append(thumb, meta, renameBtn, delBtn);
  return row;
}

/**
 * 内联重命名：名称处变成输入框，Enter/确定提交，Esc/取消放弃。
 * @param {HTMLElement} row 行
 * @param {object} item 列表项
 * @param {HTMLElement} box 容器
 */
function startRename(row, item, box) {
  const meta = row.querySelector('.bg-meta');
  const nameEl = meta.querySelector('.bg-name');
  if (!nameEl || meta.querySelector('.bg-name-input')) return;
  const input = el('input', 'bg-name-input');
  input.type = 'text';
  input.value = item.name || '';
  input.maxLength = 60;
  const okBtn = el('button', 'bg-btn', '确定');
  okBtn.type = 'button';
  const cancelBtn = el('button', 'bg-btn', '取消');
  cancelBtn.type = 'button';
  meta.replaceChildren(input, okBtn, cancelBtn);
  // 编辑态：把行内的「改名/删除」藏起来——它们和 确定/取消 在同一行，窄面板下会重叠，
  //   实测会拦住指针事件（点「确定」被判成点到「改名」）。编辑时这两个动作也没有意义。
  row.classList.add('is-editing');
  input.focus();
  input.select();
  /** 收尾：无论成功失败都把界面还原成文本 */
  const restore = () => {
    row.classList.remove('is-editing');
    meta.replaceChildren(el('span', 'bg-name', item.name || '未命名'),
      el('span', 'bg-size', humanSize(item.bytes)));
  };
  const submit = async () => {
    const next = input.value.trim();
    if (!next) { say(box, '名称不能为空', 'error'); return; }
    const r = await renameBackground(item.id, next);
    if (!r.ok) { say(box, r.message, 'error'); restore(); return; }
    item.name = r.item.name;
    if (r.adjusted) say(box, `同名已存在，改成了「${r.item.name}」`, 'ok');
    else say(box, `已重命名：${r.item.name}`, 'ok');
    await refreshBackgrounds();
  };
  okBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', restore);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
    if (ev.key === 'Escape') { ev.preventDefault(); restore(); }
  });
}

/**
 * 删除要二次确认：第一次点变成「确认删除」并自动解除，避免误删。
 * @param {HTMLButtonElement} btn 删除按钮
 * @param {object} item 列表项
 * @param {HTMLElement} box 容器
 */
function confirmDelete(btn, item, box) {
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = '确认删除';
    btn.classList.add('is-armed');
    setTimeout(() => {
      if (btn.dataset.armed !== '1') return;
      btn.dataset.armed = '0';
      btn.textContent = '删除';
      btn.classList.remove('is-armed');
    }, DISARM_MS);
    return;
  }
  btn.dataset.armed = '0';
  removeBackground(item.id).then((r) => {
    if (!r.ok) { say(box, r.message, 'error'); return null; }
    // 删掉的正好是当前背景图 ⇒ 舞台不能继续指向一个已 404 的地址，回落到棋盘格
    const using = ((readViewSettings().background || {}).imageUrl || '') === item.url;
    if (using) {
      applyBackground('checkerboard');
      document.dispatchEvent(new CustomEvent('panel:bg-applied', { detail: { mode: 'checkerboard' } }));
    }
    say(box, `已删除：${item.name}${using ? '（当前背景已回落到棋盘格）' : ''}`, 'ok');
    return refreshBackgrounds();
  });
}

/**
 * 渲染整张列表（含顶部上传按钮与状态行）。
 * @param {HTMLElement} box 容器
 */
function renderList(box) {
  const list = el('div', 'bg-items');
  for (const item of items) list.append(buildRow(item, box));
  if (!items.length) list.append(el('p', 'ctl-list-empty', '还没有上传图片'));
  const hint = el('p', 'bg-hint', '');
  box.dataset.bgCount = String(items.length);
  box.replaceChildren(hint, list);
}

/**
 * 上传：选文件 → POST → 刷新列表。
 * @param {HTMLElement} box 容器
 */
async function startUpload(box) {
  const file = await pickFile();
  if (!file) return;
  say(box, `正在上传：${file.name}…`, 'ok');
  const r = await uploadBackground(file);
  if (!r.ok) { say(box, r.message, 'error'); return; }
  say(box, `已上传：${r.item.name}`, 'ok');
  await refreshBackgrounds();
}

/**
 * 刷新列表（面板重建、上传/改名/删除之后都调它）。
 * 每次现查容器：面板重建会换掉旧 DOM，闭包持有旧节点会"刷了看不见"。
 * @returns {Promise<number>} 列表条数（容器不存在时返回 -1）
 */
export async function refreshBackgrounds() {
  const box = document.querySelector(BOX_SEL);
  if (!box) return -1;
  try {
  const r = await listBackgrounds();
  if (!r.ok) {
    items = [];
    box.dataset.bgCount = '0';
    const hint = el('p', 'bg-hint', r.message || '取列表失败');
    hint.dataset.kind = 'error';
    box.dataset.bgMsg = r.message || '取列表失败';
    box.replaceChildren(hint);
    return 0;
  }
  items = r.items || [];
  renderList(box);
  // 顶部操作区独立于列表重建，避免每次刷新都重挂监听
  const bar = el('div', 'bg-actions');
  const upBtn = el('button', 'bg-btn bg-btn-primary', '上传图片');
  upBtn.type = 'button';
  upBtn.title = '上传 png / jpeg / webp 图片（单张 ≤5MB），存到服务端 data/backgrounds/';
  upBtn.addEventListener('click', () => startUpload(box));
  bar.append(upBtn);
  box.prepend(bar);
  return items.length;
  } catch (e) {
    // 兜底：列表是面板的一小块，任何意外都不该让整块面板挂掉
    box.dataset.bgMsg = `列表渲染异常：${(e && e.message) || e}`;
    return -1;
  }
}


// ============================================================ 纯色预设（ctl-bg-solids）
//
// 与上面的自定义图片列表同一套交互习惯（列表 + 行内操作 + 二次确认 + 失败原样透出），
// 数据来自服务端 /api/backgrounds/solids（见 app/background-solids.js）。
// 职责划分：颜色挑选交给 panel/color-picker.js（纯 UI），这里只管"命名 + 增删改 + 应用"。

/** 纯色列表容器（现查，不闭包持有——面板会重建） */
const SOLID_BOX_SEL = '#right-panel [data-ctl="ctl-bg-solids"]';

/** 当前纯色列表数据 */
let solidItems = [];

/** 纯色列表的状态文案（断言读 data-bg-solid-msg） */
function solidSay(box, text, kind = 'ok') {
  box.dataset.bgSolidMsg = text;
  const hint = box.querySelector('.bg-solid-hint');
  if (!hint) return;
  hint.textContent = text;
  hint.dataset.kind = kind;
}

/** 问答式命名：新建与改名共用一个入口（便于自动化时 stub window.prompt） */
function askName(defaultValue) {
  try {
    const v = window.prompt('给这个颜色起个名字（≤30 字）', defaultValue || '');
    if (v === null) return null;
    const t = String(v).trim();
    return t || null;
  } catch {
    return null;
  }
}

/**
 * 应用某条预设（切到纯色模式并立即生效）。
 * @param {object} item 预设条目
 * @param {HTMLElement} box 容器
 */
function applySolid(item, box) {
  if (!item) return;
  setBackgroundColor(item.color);
  box.dataset.bgSolidApplied = item.color;
  solidSay(box, `已应用「${item.name}」 ${item.color}`, 'ok');
}

/**
 * 删除后的回落：删掉的正好是当前在用的颜色时，回落到第一条；列表空了就切回棋盘格。
 * 这条必须先定义清楚——否则会留下"舞台还显示着已删除的颜色"这种未定义行为。
 * @param {string} removedColor 被删掉的颜色值
 * @param {HTMLElement} box 容器
 */
function fallbackAfterRemove(removedColor, box) {
  const cur = (readViewSettings().background || {}).color || '';
  if (String(cur).toLowerCase() !== String(removedColor).toLowerCase()) return false;
  const next = solidItems[0];
  if (next) { applySolid(next, box); return false; }
  applyBackground('checkerboard');
  solidSay(box, '纯色预设已删空，已切回棋盘格', 'error');
  return true;   // 让调用方别再覆盖这条更重要的提示
}

/** 一行：色块（点击即应用）+ 名称 + 改名 + 删除 */
function buildSolidRow(item, box) {
  const row = el('div', 'bg-solid-row');
  row.dataset.solidId = item.id;
  const swatch = el('button', 'bg-solid-swatch');
  swatch.type = 'button';
  swatch.title = `应用 ${item.color}`;
  // 颜色是运行时数据 ⇒ 以 CSS 变量下发，不写 style.background 字面量
  swatch.style.setProperty('--swatch', item.color);
  swatch.addEventListener('click', () => applySolid(item, box));
  row.append(swatch, el('span', 'bg-solid-name', item.name));

  const rename = el('button', 'bg-btn', '改名');
  rename.type = 'button';
  rename.addEventListener('click', () => startRenameSolid(item, box));
  const del = el('button', 'bg-btn bg-btn-danger', '删');
  del.type = 'button';
  del.addEventListener('click', () => startRemoveSolid(del, item, box));
  row.append(rename, del);
  return row;
}

/** 整表重绘（列表 + 底部按钮） */
function renderSolidList(box) {
  const list = el('div', 'bg-solids');
  for (const item of solidItems) list.append(buildSolidRow(item, box));
  if (!solidItems.length) list.append(el('p', 'ctl-list-empty', '还没有纯色预设'));

  const foot = el('div', 'bg-solid-foot');
  const add = el('button', 'bg-btn bg-btn-primary', '+ 添加颜色');
  add.type = 'button';
  add.addEventListener('click', () => startAddSolid(box));
  const reset = el('button', 'bg-btn bg-btn-danger', '恢复默认');
  reset.type = 'button';
  reset.addEventListener('click', () => startResetSolids(reset, box));
  foot.append(add, reset);

  const hint = el('p', 'bg-solid-hint', '');
  box.dataset.bgSolidCount = String(solidItems.length);
  box.replaceChildren(hint, list, foot);
}

/**
 * 刷新纯色列表（面板重建、增删改、恢复默认之后都调它）。
 * @returns {Promise<number>} 条数（容器不存在返回 -1）
 */
export async function refreshSolids() {
  const box = document.querySelector(SOLID_BOX_SEL);
  if (!box) return -1;
  const r = await listSolids();
  if (!r.ok) {
    solidItems = [];
    box.dataset.bgSolidCount = '0';
    solidSay(box, r.message || '取纯色预设失败', 'error');
    box.replaceChildren(box.querySelector('.bg-solid-hint') || el('p', 'bg-solid-hint', r.message || ''));
    return 0;
  }
  solidItems = r.items || [];
  renderSolidList(box);
  return solidItems.length;
}

/** 添加：调色盘取色 → 命名 → POST → 刷新 → **立即应用**（不然用户以为没成功） */
async function startAddSolid(box) {
  const picked = await new Promise((resolve) => {
    openColorPicker({
      initial: (readViewSettings().background || {}).color || '#2a2a2a',
      anchor: box,
      onConfirm: (color) => resolve(color),
      onCancel: () => resolve(null),
    });
  });
  if (!picked) return;
  const name = askName(`颜色 ${picked}`);
  if (!name) { solidSay(box, '已取消：没有命名', 'error'); return; }
  const r = await addSolid(name, picked);
  if (!r.ok) { solidSay(box, r.message || '添加失败', 'error'); return; }
  await refreshSolids();
  const item = r.item || solidItems.find((x) => x.color === picked);
  if (item) applySolid(item, box);
}

/** 改名：id 与 color 不变，只换名字 */
async function startRenameSolid(item, box) {
  const name = askName(item.name);
  if (!name || name === item.name) return;
  const r = await renameSolid(item.id, name);
  if (!r.ok) { solidSay(box, r.message || '改名失败', 'error'); return; }
  await refreshSolids();
  solidSay(box, `已改名：${name}`, 'ok');
}

/** 删除：两段式确认（防误点），删完按"是否正在用"决定回落 */
async function startRemoveSolid(btn, item, box) {
  if (!btn.classList.contains('is-armed')) {
    btn.classList.add('is-armed');
    btn.textContent = '确认删？';
    setTimeout(() => { btn.classList.remove('is-armed'); btn.textContent = '删'; }, DISARM_MS);
    return;
  }
  const r = await removeSolid(item.id);
  if (!r.ok) { solidSay(box, r.message || '删除失败', 'error'); return; }
  await refreshSolids();
  const switchedToCheckerboard = fallbackAfterRemove(item.color, box);
  if (!switchedToCheckerboard) solidSay(box, `已删除「${item.name}」`, 'ok');
}

/** 恢复默认：两段式确认（误点会把自定义全清掉，所以必须二次确认） */
async function startResetSolids(btn, box) {
  if (!btn.classList.contains('is-armed')) {
    btn.classList.add('is-armed');
    btn.textContent = '确认恢复？';
    setTimeout(() => { btn.classList.remove('is-armed'); btn.textContent = '恢复默认'; }, DISARM_MS);
    return;
  }
  const r = await resetSolids();
  if (!r.ok) { solidSay(box, r.message || '恢复默认失败', 'error'); return; }
  solidItems = r.items || [];
  renderSolidList(box);
  solidSay(box, `已恢复默认 ${solidItems.length} 条`, 'ok');
}
