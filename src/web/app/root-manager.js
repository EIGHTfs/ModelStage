// app/root-manager.js —— 资源根管理（左栏）：新增 / 改名 / 启停 / 删除
//
// 为什么是"输入服务端绝对路径"而不是目录选择器：
//   模型是**服务端**扫描自己文件系统加载的，浏览器 File System Access API 拿到的是客户端
//   FileSystemDirectoryHandle（浏览器沙箱内的句柄），根本无法变成服务端可读的路径 —— 传过去
//   毫无意义。项目也没有"服务端目录浏览"接口（那属于 M5 插件接口范畴），所以这里用文本框收
//   绝对路径 + 用已有根做 datalist 提示 + 把后端校验错误原样显示给用户（400/409/404 都有文案）。
//
// 每个动作结束后都用后端返回的 rootsAll 重建列表（含停用项），再回调 onChanged 让名册树刷新。

/** 后端错误文案优先，其次状态码，最后兜底 —— 一律原样呈现，不吞不猜 */
function describeError(status, payload, formatError) {
  const text = payload && typeof payload.error === 'string' && payload.error
    ? payload.error
    : (typeof formatError === 'function' ? formatError({ status }) : `HTTP ${status}`);
  return `${text}（HTTP ${status}）`;
}

/**
 * 创建资源根管理器。
 * @param {{els: object, onChanged?: Function, formatError?: Function}} deps
 *   els 需要：list（根条目容器）、form/pathInput/nameInput（新增表单）、msg（提示区）、
 *            count（数量文案）、toggleBtn/body（管理区展开/收起）
 */
export function createRootManager({ els, onChanged, formatError } = {}) {
  const state = {
    /** 最近一次拿到的完整根列表（含停用项）：GET 只给启用的，所以以 POST 返回的 rootsAll 为准 */
    roots: [],
    /** 正在内联编辑改名的根 id */
    editingId: null,
    /** 正在二次确认删除的根 id */
    confirmingId: null,
    /** 最近一次动作结果（断言用） */
    last: null,
  };

  /** 统一的提示：文案 + 级别（ok/err），同时写进 dataset 供断言读 */
  function notify(text, level = 'info') {
    if (els.msg) {
      els.msg.textContent = text || '';
      els.msg.dataset.level = level;
    }
    document.documentElement.dataset.rootMsg = `${level}|${text || ''}`;
    return text;
  }

  /** 发一次写请求：返回 {ok, status, data}；HTTP 非 2xx 不抛，交给调用方决定怎么提示 */
  async function post(body) {
    const res = await fetch('/api/roots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // 写操作：**不加去重、不自动重试**（重复写会建两个根），只补超时信号防"永久转圈"。
      //   8s 依据：服务端只改一份 resources.json + 落盘备份（backupConfigFile），正常 <1s，
      //   留 8 倍余量覆盖 CIFS 落盘抖动。不用 api.js：它的默认重试会重发写请求。
      signal: AbortSignal.timeout(8000),
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    state.last = { action: body && body.action, status: res.status, data };
    return { ok: res.ok, status: res.status, data };
  }

  /** 用一份完整根列表重建 UI（后端给的 rootsAll 优先；没有就退回 GET 的 roots） */
  function render(roots) {
    if (Array.isArray(roots)) state.roots = roots;
    const list = state.roots;
    if (els.count) els.count.textContent = String(list.length);
    if (!els.list) return list;
    els.list.replaceChildren();
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'muted-hint';
      empty.textContent = '还没有资源根';
      els.list.append(empty);
      return list;
    }
    for (const root of list) els.list.append(renderRow(root));
    return list;
  }

  /** 单条根：名字 / id / 路径 / 启停状态 + 三个操作（改名为内联编辑，删除二次确认） */
  function renderRow(root) {
    const row = document.createElement('div');
    row.className = 'root-row';
    row.dataset.rootId = root.id;
    row.dataset.enabled = String(root.enabled !== false);

    const title = document.createElement('span');
    title.dataset.role = 'name';
    title.className = 'root-name';
    title.textContent = `${root.name || root.id}${root.enabled === false ? '（已停用）' : ''}`;
    row.append(title);

    const pathEl = document.createElement('span');
    pathEl.dataset.role = 'path';
    pathEl.className = 'muted-hint root-path';
    pathEl.textContent = root.path || '';
    row.append(pathEl);

    if (state.editingId === root.id) {
      const input = document.createElement('input');
      input.type = 'text';
      input.dataset.role = 'rename-input';
      input.className = 'root-rename-input';
      input.value = root.name || root.id;
      row.append(input);
      row.append(miniBtn('保存', 'rename-save', () => submitRename(root.id, input.value)));
      row.append(miniBtn('取消', 'rename-cancel', () => { state.editingId = null; render(); }));
      return row;
    }

    row.append(miniBtn('改名', 'rename', () => { state.editingId = root.id; render(); }));
    row.append(miniBtn(root.enabled === false ? '启用' : '停用', 'toggle',
      () => submitToggle(root.id, root.enabled === false)));

    if (state.confirmingId === root.id) {
      const ask = document.createElement('span');
      ask.dataset.role = 'confirm';
      ask.className = 'root-confirm-ask';
    ask.textContent = '确认删除？';
      row.append(ask);
      row.append(miniBtn('确认删除', 'remove-confirm', () => submitRemove(root.id)));
      row.append(miniBtn('取消', 'remove-cancel', () => { state.confirmingId = null; render(); }));
    } else {
      row.append(miniBtn('删除', 'remove', () => { state.confirmingId = root.id; render(); }));
    }
    return row;
  }

  /** 小按钮工厂：统一 class 与 dataset，便于断言按 data-role 定位 */
  function miniBtn(text, role, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini-btn';
    btn.textContent = text;
    btn.dataset.role = role;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /** 用后端最新列表刷新（后端成功响应都带 rootsAll: 含停用项） */
  function applyResult(data) {
    const next = data && (data.rootsAll || data.roots);
    if (Array.isArray(next)) render(next);
    if (typeof onChanged === 'function') {
      try { onChanged(data); } catch { /* 名册刷新失败不影响管理列表 */ }
    }
    return Array.isArray(next) ? next : state.roots;
  }

  /** 最近一次"添加资源根"的失败原因（空 = 上次成功或还没试过） */
  let lastAddError = '';

  // ------------------------------------------------------------------ 四个动作

  /** 新增：path 必填（服务端绝对路径）；name 可空（空则用目录名） */
  async function submitAdd(pathValue, nameValue) {
    const path = String(pathValue || '').trim();
    const name = String(nameValue || '').trim();
    // 失败原因要能被目录选择对话框取到：它弹在屏幕中央，左栏那行提示在用户背后（实测用户看不到）。
    //   返回值仍是布尔（既有调用方与测试都按布尔断言），文案另存一份。
    const fail = (msg) => { lastAddError = msg; notify(msg, 'err'); return false; };
    lastAddError = '';
    if (!path) return fail('请填写要添加的目录（服务端绝对路径）');
    const body = { action: 'add', path };
    if (name) body.name = name;
    const res = await post(body);
    if (!res.ok) return fail(describeError(res.status, res.data, formatError));
    const merged = !!(res.data && res.data.changed && res.data.changed.merged);
    const root = (res.data && res.data.changed && res.data.changed.root) || {};
    applyResult(res.data);
    notify(merged
      ? `已合并到同名根：${root.name || name || root.id}`
      : `已添加资源根：${root.name || name || root.id}（${root.path || path}）`, 'ok');
    return true;
  }

  /** 改名：命中已有名字时后端返回 merged:true —— 必须如实提示"已合并"，不能显示成改名成功 */
  async function submitRename(id, nameValue, apiOnly = false) {
    const name = String(nameValue || '').trim();
    if (!apiOnly && !name) { notify('新名字不能为空', 'err'); return false; }
    const res = await post({ action: 'rename', id, name });
    if (!res.ok) { notify(describeError(res.status, res.data, formatError), 'err'); return false; }
    const changed = (res.data && res.data.changed) || {};
    state.editingId = null;
    applyResult(res.data);
    if (changed.merged) {
      notify(`已合并到同名根「${changed.to}」（条目由 ${changedFrom(res)} 变为 ${(res.data.roots || []).length} 个）`, 'warn');
    } else {
      notify(`已改名为「${changed.to || name}」`, 'ok');
    }
    return true;
  }

  /** toggle 必须传真布尔，否则后端 400（字符串 "false" 会被拒） */
  async function submitToggle(id, enabled) {
    const res = await post({ action: 'toggle', id, enabled: enabled === true });
    if (!res.ok) { notify(describeError(res.status, res.data, formatError), 'err'); return false; }
    applyResult(res.data);
    notify(`已${enabled === true ? '启用' : '停用'}：${id}`, 'ok');
    return true;
  }

  /** 删除：界面上先二次确认，再发请求 */
  async function submitRemove(id) {
    const res = await post({ action: 'remove', id });
    if (!res.ok) { notify(describeError(res.status, res.data, formatError), 'err'); return false; }
    state.confirmingId = null;
    applyResult(res.data);
    notify(`已删除资源根：${id}`, 'ok');
    return true;
  }

  /** 合并提示里需要"合并前后条目数"：后端不给 before，这里用 roots 数量差反推 */
  function changedFrom(res) {
    const after = (res.data && res.data.roots) || [];
    return String(after.length + 1);
  }

  /** 目录浏览器的默认起点（上次添加的目录的父目录）；空则从 / 开始 */
  let pickerStart = '';

  // 「选择目录」：打开服务端目录浏览器，选完目录直接添加，面板里不填路径
  if (els.triggerBtn) {
    els.triggerBtn.addEventListener('click', () => {
      if (!els.picker) { notify('目录浏览器未就绪', 'err'); return; }
      els.picker.open(pickerStart);
    });
  }

  // 管理区展开/收起
  if (els.toggleBtn && els.body) {
    els.toggleBtn.addEventListener('click', () => {
      const open = els.body.hidden;
      els.body.hidden = !open;
      els.toggleBtn.setAttribute('aria-expanded', String(open));
      els.toggleBtn.textContent = open ? '收起' : '管理';
    });
  }

  return {
    render, post, notify,
    /** 目录浏览器实例（测试/排障用：open/goto/state） */
    get picker() { return els.picker || null; },
    /** 设置目录浏览器的默认起点（由装配方按现有根推算） */
    setPickerStart(path) { pickerStart = String(path || ''); },
    submitAdd, submitRename, submitToggle, submitRemove,
    /** 最近一次添加失败的原因（对话框用它把错误显示在自己身上） */
    getLastAddError: () => lastAddError,
    get roots() { return state.roots; },
    get last() { return state.last; },
  };
}
