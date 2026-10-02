/*!
 * roots-ui.js —— 「添加资源根」界面（spine-multi-viewer 自有代码）
 *
 * 作用：在 原版 左栏顶部插入「＋资源根」按钮，点击后弹出本机目录浏览器，
 *      用户导航到资源目录、填写显示名称（= 归一 key）后添加，由服务端写入
 *      config/resources.json，实现「不手改 JSON、界面选择即自动生成」。
 *
 * 为什么需要目录浏览：浏览器 File System Access API 只能选用户自己电脑的文件，
 *      且拿不到绝对路径；资源在 NAS/部署设备上，必须由服务端 /api/browse 列目录。
 *
 * 依赖：
 *   - /api/browse   列本机目录
 *   - POST /api/roots  添加资源根（写 JSON），返回 merged 提示同名归一
 *   - local-roots.js 暴露的 window.__LOCAL_ROOTS__（用于添加后重新加载模型）
 */

(function () {
  'use strict';

  const START_PATH = '/volume1'; // 浏览起始点（NAS 数据卷；可按部署环境调整）

  // 说明：不再需要「等待某元素出现」的辅助函数——它此前只为等待原作者侧栏容器
  //   （.bv-sidebar > div）渲染完成以便注入按钮；现在改为暴露入口供面板调用，无需等待。

  function api(path, opts) {
    return fetch(path, opts || {}).then((r) => r.json().then((j) => {
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    }));
  }

  // ------------------------------------------------------------ 浮层面板
  let panel = null;
  let currentPath = START_PATH;
  let pickedPath = null;

  function closePanel() {
    if (panel) { panel.remove(); panel = null; }
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'roots-ui-panel';
    panel.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9999',
      'background:rgba(0,0,0,.55)', 'display:flex',
      'align-items:center', 'justify-content:center',
      'font-family:inherit',
    ].join(';');

    const box = document.createElement('div');
    box.style.cssText = [
      'background:#1f2224', 'color:#e6e6e6', 'border:1px solid #444',
      'border-radius:10px', 'width:min(720px,92vw)', 'max-height:82vh',
      'display:flex', 'flex-direction:column', 'overflow:hidden',
      'box-shadow:0 12px 40px rgba(0,0,0,.5)',
    ].join(';');

    const head = document.createElement('div');
    head.style.cssText = 'padding:12px 16px;border-bottom:1px solid #3a3a3a;display:flex;gap:8px;align-items:center';
    head.innerHTML = '<strong style="font-size:14px">添加资源根</strong>'
      + '<span style="flex:1"></span>'
      + '<button id="roots-ui-close" style="background:#333;color:#ddd;border:1px solid #555;border-radius:6px;padding:4px 10px;cursor:pointer">关闭</button>';

    const body = document.createElement('div');
    body.id = 'roots-ui-body';
    body.style.cssText = 'padding:12px 16px;overflow:auto;flex:1';

    const foot = document.createElement('div');
    foot.style.cssText = 'padding:12px 16px;border-top:1px solid #3a3a3a;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
    foot.innerHTML = ''
      + '<span style="font-size:12px;color:#aaa">显示名称（同名会合并为一个游戏，用于归类原版/Mod）</span>'
      + '<input id="roots-ui-name" placeholder="如：棕色尘埃2" style="flex:1;min-width:160px;background:#2a2d30;color:#eee;border:1px solid #555;border-radius:6px;padding:6px 8px">'
      + '<button id="roots-ui-add" style="background:#2b6cb0;color:#fff;border:none;border-radius:6px;padding:7px 14px;cursor:pointer">添加</button>';

    box.appendChild(head);
    box.appendChild(body);
    box.appendChild(foot);
    panel.appendChild(box);
    document.body.appendChild(panel);

    panel.querySelector('#roots-ui-close').onclick = closePanel;
    panel.addEventListener('click', (e) => { if (e.target === panel) closePanel(); });
    panel.querySelector('#roots-ui-add').onclick = doAdd;

    renderBody();
  }

  async function renderBody() {
    const body = panel && panel.querySelector('#roots-ui-body');
    if (!body) return;
    body.innerHTML = '<div style="color:#888;font-size:13px">加载中…</div>';

    let data;
    try {
      data = await api(`/api/browse?path=${encodeURIComponent(currentPath)}`);
    } catch (e) {
      body.innerHTML = `<div style="color:#e88">读取失败: ${e.message}</div>`;
      return;
    }

    const picked = data.path === pickedPath;
    const rows = [];

    rows.push(`<div style="font-size:12px;color:#9aa;margin-bottom:8px">当前：<code style="color:#7fd">${data.path}</code>`
      + `　子目录 ${data.hint.subDirCount} 个${data.hint.skelHere ? `，含 ${data.hint.skelHere} 个 .skel` : ''}</div>`);

    // 向上
    if (data.parent) {
      rows.push(`<div><button data-nav="${data.parent}" style="background:#333;color:#ddd;border:1px solid #555;border-radius:6px;padding:4px 10px;cursor:pointer;margin-bottom:8px">↑ 上级目录</button></div>`);
    }

    rows.push(`<div style="margin-bottom:8px"><button data-pick="${data.path}" style="background:${picked ? '#2f855a' : '#444'};color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer">${picked ? '✓ 已选择此目录' : '选择此目录'}</button></div>`);

    if (!data.dirs.length) {
      rows.push('<div style="color:#888;font-size:13px">（无子目录）</div>');
    } else {
      rows.push('<div style="display:flex;flex-direction:column;gap:4px">');
      for (const d of data.dirs) {
        rows.push(`<div><button data-nav="${d.path}" style="width:100%;text-align:left;background:#2a2d30;color:#ddd;border:1px solid #444;border-radius:6px;padding:6px 10px;cursor:pointer">📁 ${d.name}</button></div>`);
      }
      rows.push('</div>');
    }

    body.innerHTML = rows.join('');

    body.querySelectorAll('[data-nav]').forEach((b) => {
      b.onclick = () => { currentPath = b.getAttribute('data-nav'); renderBody(); };
    });
    body.querySelectorAll('[data-pick]').forEach((b) => {
      b.onclick = () => {
        pickedPath = b.getAttribute('data-pick');
        // 默认显示名取目录名，便于用户按需改成统一归一名称
        const nameInput = panel.querySelector('#roots-ui-name');
        if (nameInput && !nameInput.value) nameInput.value = pickedPath.split('/').filter(Boolean).pop() || '';
        renderBody();
      };
    });
  }

  async function doAdd() {
    const nameInput = panel.querySelector('#roots-ui-name');
    const name = (nameInput.value || '').trim();
    if (!pickedPath) { alert('请先选择一个目录'); return; }
    if (!name) { alert('请填写显示名称（同名资源根会在界面合并显示）'); return; }

    try {
      const r = await api('/api/roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path: pickedPath }),
      });
      const mergeTip = r.merged
        ? `\n注意：与已有「${name}」同名，界面将合并为一个游戏显示（原版/Mod 共存）。`
        : '';
      alert(`已添加：${name}\n路径：${pickedPath}\n检测到 ${r.detected.subDirCount} 个子目录${mergeTip}\n\n即将重新加载模型库。`);
      closePanel();
      // 重新加载：优先调用 local-roots.js 暴露的重载方法，否则刷新页面
      if (window.__LOCAL_ROOTS__ && typeof window.__LOCAL_ROOTS__.reload === 'function') {
        window.__LOCAL_ROOTS__.reload();
      } else {
        location.reload();
      }
    } catch (e) {
      alert('添加失败：' + e.message);
    }
  }

  // ------------------------------------------------------------ 注入按钮
  // 打开目录选择器。
  //
  // 变更说明（同功能重构）：此前这里把「＋资源根」按钮注入到原作者侧栏的标题行；
  //   该侧栏现已整体隐藏，界面改由本项目自己的面板承载（见 public/char-tree.js），
  //   故不再注入按钮，改为暴露入口供面板头部的「选择目录」按钮调用。
  //   同时去掉了配套的 waitEl 等待逻辑（它只为等待侧栏容器出现而存在，现已无用）。
  function openPicker() {
    currentPath = START_PATH;
    pickedPath = null;
    buildPanel();
  }

  // 暴露给同页的其他脚本（char-tree.js 的「选择目录」按钮）
  window.__ROOTS_UI__ = { open: openPicker };
  console.info('[roots-ui] 已就绪，目录选择器入口: window.__ROOTS_UI__.open()');
})();
