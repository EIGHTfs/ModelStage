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
import { askConfirm, askText } from './dialog.js';
import { listBgSources, renderSourceGroup, selectedSourceId } from './bg-source.js';
import * as uiState from '../app/ui-state.js';
import {
  listBackgrounds, pickFile, removeBackground, renameBackground, uploadBackground,
} from '../app/backgrounds.js';

/** 公共列表容器的选择器（现查，不闭包持有——面板会重建） */
const BOX_SEL = '#right-panel [data-ctl="ctl-bg-sources"]';

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
 * 删除要二次确认：第一次点变成「确认删除」并自动解除，避免误删。
 * @param {HTMLButtonElement} btn 删除按钮
 * @param {object} item 列表项
 * @param {HTMLElement} box 容器
 */
async function confirmDelete(btn, item, box) {
  // 自定义图删的是**服务端真实文件**（不可恢复）⇒ 必须明确确认；
  //   纯色预设不需要（有「恢复默认」能一键找回），所以那边直接删。
  const ok = await askConfirm({
    title: '删除这张背景图？',
    message: `「${item.name || item.id}」删除后不可恢复（图片文件会被一并删除）。`,
    danger: true,          // 确定键红色，且默认焦点落在「取消」防误触
    confirmText: '删除',
  });
  if (!ok) { say(box, '已取消删除', 'ok'); return; }
  removeBackground(realIdOf(item)).then((r) => {
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


// ============================================================ 纯色预设（ctl-bg-solids）
//
// 与上面的自定义图片列表同一套交互习惯（列表 + 行内操作 + 二次确认 + 失败原样透出），
// 数据来自服务端 /api/backgrounds/solids（见 app/background-solids.js）。
// 职责划分：颜色挑选交给 panel/color-picker.js（纯 UI），这里只管"命名 + 增删改 + 应用"。

/** 纯色列表容器（现查，不闭包持有——面板会重建） */
// 纯色预设与自定义图片**共用**同一个列表容器（schema 里那一个 kind:'dynamic-list' 的 ctl-bg-sources），
//   按当前背景模式决定往容器里渲染哪一种；所以这里必须与 BG_BOX_SEL 指向同一个容器。
//   写成一个不存在的 ctl-bg-solids 会让查询永远返回 null、纯色列表整块静默失效（本门禁 W2 抓到的）。
const SOLID_BOX_SEL = '#right-panel [data-ctl="ctl-bg-sources"]';

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

/**
 * 命名：新建与改名共用这一个入口，走自绘弹窗 panel/dialog.js（返回 Promise）。
 * 不用浏览器原生输入框：它同步阻塞主线程、样式不受主题控制。
 * @param {string} defaultValue 原名（改名时预填，打开即全选，可直接覆盖）
 * @returns {Promise<string|null>} 取消 ⇒ null
 */
async function askName(defaultValue) {
  const v = await askText({
    title: '给这个颜色起个名字',
    message: '最多 30 个字；同名会被服务端拒绝，换个名字即可。',
    value: defaultValue || '',
    maxlength: 30,
    confirmText: '确定',
  });
  const t = (v || '').trim();
  return t || null;
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



/**
 * 刷新纯色列表（面板重建、增删改、恢复默认之后都调它）。
 * @returns {Promise<number>} 条数（容器不存在返回 -1）
 */

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
  const name = await askName(`颜色 ${picked}`);
  if (!name) { solidSay(box, '已取消：没有命名', 'error'); return; }
  const r = await addSolid(name, picked);
  if (!r.ok) { solidSay(box, r.message || '添加失败', 'error'); return; }
  await refreshSolids();
  const item = r.item || solidItems.find((x) => x.color === picked);
  if (item) applySolid(item, box);
}

/** 改名：id 与 color 不变，只换名字 */
async function startRenameSolid(item, box) {
  const name = await askName(item.name);
  if (!name || name === item.name) return;
  const r = await renameSolid(realIdOf(item), name);
  if (!r.ok) { solidSay(box, r.message || '改名失败', 'error'); return; }
  await refreshSolids();
  solidSay(box, `已改名：${name}`, 'ok');
}

/** 删除：两段式确认（防误点），删完按"是否正在用"决定回落 */
async function startRemoveSolid(btn, item, box) {
  // 纯色直接删：有「恢复默认」能一键找回，二次确认反而碍事（自定义图那边才必须确认）
  const r = await removeSolid(realIdOf(item));
  if (!r.ok) { solidSay(box, r.message || '删除失败', 'error'); return; }
  await refreshBgSources();
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


// ============================================================ 统一来源列表（右栏二级）
//
// 右栏现在是「四个平级按钮 + 按下展开对应列表」：
//   棋盘格 / 纯色▾ / 透明 / 自定义▾  —— 顶部的四个档位仍由 ctl-bg-mode 控件渲染，
//   这里只负责：① 两组列表的内容（调 bg-source.renderSourceGroup）
//              ② 展开哪一组（openGroup）
//              ③ 打开时把「当前项」勾出来

/**
 * 当前展开的组：null = 都收起，'solid' / 'custom' = 展开对应列表。
 * **状态存在 UI 状态工厂里**（不只是内存变量）：刷新后能恢复"上次展开的是哪一组"，
 * 否则会出现"按钮回填了、列表却收起"的半截状态。
 */
let openGroup = uiState.getBgOpen() || null;

/**
 * 公共列表容器（现查：面板重建会换 DOM）。
 * 纯色预设与自定义图片**共用这一个位置**：切换组时只换内容，按钮行不位移、视线不用上下找。
 */
const SRC_SEL = BOX_SEL;

/** 按 openGroup 控制两组列表的可见性（列表内容常驻，切的是显隐） */
function applyGroupVisibility() {
  const box = document.querySelector(SRC_SEL);
  if (!box) return;
  // 收起时**整块不占位**：清内容 + hidden（style.css 有全局 [hidden]{display:none!important} 兜底）
  if (!openGroup) { box.replaceChildren(); box.hidden = true; }
  else box.hidden = false;
  const rp = document.getElementById('right-panel');
  if (rp) rp.dataset.bgOpen = openGroup || '';
}

/**
 * 取条目的**真实服务端 id**。
 *
 * 为什么需要：统一渲染层（bg-source）给的 `item.id` 是"带组前缀的渲染 id"
 *   （`solid:<真id>` / `custom:<url>`），用于唯一标识一行；而改名/删除接口要的是原始 id。
 *   原始记录一直挂在 `item.raw` 上。
 * @param {{id?:string, raw?:{id?:string}}} item
 * @returns {string}
 */
function realIdOf(item) {
  return String((item && item.raw && item.raw.id) || (item && item.id) || '');
}

/** 图片改名：与纯色走同一套问答式命名（不再做行内输入框，两边口径一致） */
async function startRenameImage(item, box) {
  const name = await askName(item.name);
  if (!name || name === item.name) return;
  const r = await renameBackground(realIdOf(item), name);
  if (!r || !r.ok) { say(box, (r && r.message) || '改名失败', 'error'); return; }
  await refreshBgSources();
  say(box, `已改名：${name}`, 'ok');
}

/**
 * 统一刷新两个列表（一次取数，两组都画，勾选态由 bg-source 决定）。
 *
 * 勾选口径：纯色按 color、自定义按 url；同色多条只认第一条；
 *   当前 color 不在任何预设里 ⇒ 列表无勾，但「纯色」档位仍高亮（档位由 ctl-bg-mode 负责）。
 * @returns {Promise<number>} 两条列表合计条数
 */
export async function refreshBgSources() {
  const box = document.querySelector(SRC_SEL);
  if (!box) return -1;
  const sources = await listBgSources();
  const sel = selectedSourceId(readViewSettings().background || {}, sources);
  const selId = sel.itemId || null;

  if (sources.errors && sources.errors.length) box.dataset.bgSrcErrors = sources.errors.join(' / ');
  else delete box.dataset.bgSrcErrors;

  if (!openGroup) { applyGroupVisibility(); return 0; }
  box.hidden = false;

  if (openGroup === 'solid') {
    renderSourceGroup(box, 'solid', sources.solid, {
      selectedItemId: selId,
      onApply: (item) => applySolid(item, box),
      onRename: (item) => startRenameSolid(item, box),
      onRemove: (btn, item) => startRemoveSolid(btn, item, box),
      onAdd: () => startAddSolid(box),
      onReset: (btn) => startResetSolids(btn, box),
    });
    return sources.solid.length;
  }
  renderSourceGroup(box, 'custom', sources.custom, {
    selectedItemId: selId,
    onApply: (item) => applyItem(item),
    onRename: (item) => startRenameImage(item, box),
    onRemove: (btn, item) => confirmDelete(btn, item, box),
    onUpload: () => startUpload(box),
  });
  return sources.custom.length;
}

/** 兼容旧入口：两处都转发到统一实现（panel-settings 的调用点不用改） */
export async function refreshBackgrounds() { return refreshBgSources(); }
export async function refreshSolids() { return refreshBgSources(); }

/**
 * 点「纯色▾」/「自定义▾」的语义：既是切到该模式，也是展开/收起它的列表。
 * 已经是该组展开态时再点一次 = 收起（不重复应用同一个颜色）。
 * 点「棋盘格」「透明」⇒ 两组都收起。
 */
let toggleBound = false;
export function bindBgGroupToggle() {
  if (toggleBound) return false;
  toggleBound = true;
  document.addEventListener('click', (ev) => {
    const btn = ev.target && typeof ev.target.closest === 'function'
      ? ev.target.closest('#right-panel [data-ctl="ctl-bg-mode"] [data-value]')
      : null;
    if (!btn) return;
    const v = btn.dataset.value;
    openGroup = (v === 'solid' || v === 'custom') ? (openGroup === v ? null : v) : null;
    uiState.setBgOpen(openGroup || '');   // 记进工厂：刷新后按这个值恢复展开态
    // 模式切换由 segmented 自身继续走（它会在下一拍更新档位与背景）
    setTimeout(() => { refreshBgSources().catch(() => { /* 刷新失败保留现状 */ }); }, 0);
  }, true);
  // 其它来源（底栏/快捷键/自动恢复）改了背景 ⇒ 只更新勾选，不擅自展开/收起
  document.addEventListener('panel:bg-applied', () => {
    refreshBgSources().catch(() => { /* 忽略 */ });
  });
  return true;
}
