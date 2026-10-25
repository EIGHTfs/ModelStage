// app/dir-picker.js —— 资源根「选择目录」的服务端目录浏览器
//
// 为什么必须有它：模型在**服务端**磁盘上，浏览器拿不到绝对路径（File System Access API 给的是
//   客户端沙箱句柄），只能让服务端列目录。旧端就是这么做的（legacy/patches/roots-ui.js，走 /api/browse）。
//
// 交互照旧端：
//   点「选择目录」→ 弹出面板
//   顶部：标题 + 关闭
//   中部：当前路径（含子目录数 / 含多少 .skel）、「↑ 上级目录」、「选择此目录」、📁 子目录列表
//   底部：显示名称（可空，同名会合并成一个游戏）+「添加」
//
// 面板关掉就销毁，不常驻 DOM（不留隐藏节点）。

/** 打开时的默认起点：上次用过的目录优先，否则从根开始让用户自己走 */
const LAST_DIR_KEY = 'modelstage.dirpicker.last';

/**
 * 创建目录选择器。
 * @param {{onPick: (payload: {path: string, name: string}) => Promise<boolean>|boolean, formatError?: Function}} deps
 *   onPick 返回 true 表示添加成功（面板会自行关闭）
 */
export function createDirPicker({ onPick, formatError } = {}) {
  let panel = null;      // 遮罩层（含面板）
  let currentPath = '';  // 当前浏览到的目录
  let pickedPath = '';   // 用户点过"选择此目录"的目录（空 = 还没选）
  let busy = false;

  const q = (sel) => (panel ? panel.querySelector(sel) : null);

  /** 读上次目录（浏览器存储不可用时回落空串） */
  function lastDir() {
    try { return localStorage.getItem(LAST_DIR_KEY) || ''; } catch { return ''; }
  }

  function rememberDir(path) {
    try { localStorage.setItem(LAST_DIR_KEY, path); } catch { /* 存不了就算了 */ }
  }

  function ensureShell() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'dir-picker';
    panel.className = 'dir-picker';
    panel.innerHTML = `
      <div class="dir-picker-box" role="dialog" aria-modal="true" aria-label="添加资源根">
        <div class="dir-picker-head">
          <strong>添加资源根</strong>
          <span class="dir-picker-spacer"></span>
          <button type="button" class="mini-btn" data-role="close">关闭</button>
        </div>
        <div class="dir-picker-body" data-role="body"></div>
        <div class="dir-picker-foot">
          <span class="muted-hint">显示名称（同名会合并成一个游戏，用于归类原版／Mod）</span>
          <input type="text" data-role="name" placeholder="如：棕色尘埃2" aria-label="资源根显示名称" />
          <button type="button" class="mini-btn is-primary" data-role="add">添加</button>
        </div>
      </div>`;
    document.body.append(panel);
    // 点遮罩关闭（点面板内部不关）
    panel.addEventListener('click', (e) => { if (e.target === panel) close(); });
    q('[data-role="close"]').addEventListener('click', close);
    q('[data-role="add"]').addEventListener('click', doAdd);
    return panel;
  }

  /** 渲染当前目录：路径信息 / 上级 / 选择此目录 / 子目录列表 */
  async function renderBody() {
    const body = q('[data-role="body"]');
    if (!body) return;
    body.replaceChildren();
    body.append(text('div', 'dir-picker-hint', '加载中…'));
    let data = null;
    try {
      const res = await fetch(`/api/browse?path=${encodeURIComponent(currentPath)}`);
      data = await res.json();
      if (!res.ok || !data || data.error) throw new Error((data && data.error) || `HTTP ${res.status}`);
    } catch (err) {
      body.replaceChildren(text('div', 'dir-picker-error',
        `读取失败：${typeof formatError === 'function' ? formatError(err) : (err && err.message) || err}`));
      return;
    }
    currentPath = data.path || currentPath;
    const hint = data.hint || {};
    const info = text('div', 'dir-picker-hint', '');
    info.append('当前：');
    const code = document.createElement('code');
    code.textContent = currentPath;
    info.append(code);
    info.append(`　子目录 ${hint.subDirCount || 0} 个${hint.skelHere ? `，含 ${hint.skelHere} 个 .skel` : ''}`);
    body.replaceChildren(info);

    // ↑ 上级目录
    if (data.parent) body.append(navBtn(`↑ 上级目录`, data.parent));

    // 选择此目录（已选过就变成"✓ 已选择"，再点仍是选中当前）
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = pickedPath === currentPath ? 'mini-btn is-primary' : 'mini-btn';
    pick.dataset.pick = currentPath;
    pick.textContent = pickedPath === currentPath ? '✓ 已选择此目录' : '选择此目录';
    pick.addEventListener('click', () => { pickedPath = currentPath; renderBody(); });
    const pickRow = text('div', 'dir-picker-pick', '');
    pickRow.append(pick);
    body.append(pickRow);

    // 子目录列表
    const dirs = Array.isArray(data.dirs) ? data.dirs : [];
    if (!dirs.length) {
      body.append(text('div', 'dir-picker-hint', '（无子目录）'));
      return;
    }
    const list = text('div', 'dir-picker-list', '');
    for (const d of dirs) {
      const btn = navBtn(`📁 ${d.name}`, d.path);
      btn.dataset.dirName = d.name;
      list.append(btn);
    }
    body.append(list);
  }

  function text(tag, className, content) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (content) n.textContent = content;
    return n;
  }

  function navBtn(label, target) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini-btn dir-picker-nav';
    btn.dataset.nav = target;
    btn.textContent = label;
    btn.addEventListener('click', () => { currentPath = target; renderBody(); });
    return btn;
  }

  /** 添加：用"已选择的目录"（没点过就用当前目录） */
  async function doAdd() {
    if (busy) return;
    const path = pickedPath || currentPath;
    const nameInput = q('[data-role="name"]');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!path) return;
    busy = true;
    try {
      const ok = await (typeof onPick === 'function' ? onPick({ path, name }) : false);
      if (ok) { rememberDir(path); close(); }
    } finally {
      busy = false;
    }
  }

  /** 打开面板（默认从上次目录或 / 开始） */
  function open(startPath) {
    ensureShell();
    panel.hidden = false;
    pickedPath = '';
    currentPath = startPath || lastDir() || '/';
    const nameInput = q('[data-role="name"]');
    if (nameInput) nameInput.value = '';
    renderBody();
    return panel;
  }

  /** 关闭并销毁（不留隐藏容器） */
  function close() {
    if (!panel) return;
    panel.remove();
    panel = null;
  }

  return {
    open, close,
    /** 只读：当前浏览路径 / 已选路径（断言用） */
    get state() { return { open: !!panel, currentPath, pickedPath }; },
    /** 断言用：直接设定路径后重绘（等价于用户一路点进来） */
    goto(path) { currentPath = path; return panel ? renderBody() : null; },
  };
}
