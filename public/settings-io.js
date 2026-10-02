// settings-io.js —— 配置导出 / 导入（改造原作者设置面板底部那两个按钮）
//
// 需求：原版的「导出设置 / 导入设置」只搬 20 项 UI 偏好（存 localStorage），
//   不含本项目的配置（资源根 + 角色名表）——换台机器或清浏览器就全丢。
//   改造为「一个文件同时带走：项目配置 + 原版偏好」。
//
// 做什么：
//   拦截右栏设置面板底部那两个按钮的点击，改为：
//     导出 → { _meta, project: <服务端配置原文>, viewer: <原版 20 项偏好> }
//     导入 → 项目配置走 POST /api/config/import，偏好走 store.importSettings()
//
// 为什么用「捕获阶段拦截」而不是替换按钮：
//   按钮由 React 渲染，无法从外部改它的 onClick；但在 document 上以捕获阶段先拿到点击，
//   stopPropagation 后事件到不了 React 挂在根容器的委托监听，等于替换了行为。
//
// 兼容性：导入时若文件顶层直接就是那 20 项偏好（原版导出的旧文件），按「仅偏好」处理。

(function () {
  'use strict';

  const BTN_EXPORT = '导出设置';
  const BTN_IMPORT = '导入设置';
  const FILE_NAME = 'spine-viewer-config.json';
  const TOAST_ID = 'settings-io-toast';

  // 简易提示条。
  // 需求：导入/导出要给用户明确反馈（成功写了几个文件、备份在哪、失败原因）。
  // 思路：自建一个固定定位的小条，不依赖原版的 sonner 提示库（不易从外部调用）。
  let toastTimer = null;
  function toast(msg, ok) {
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = TOAST_ID;
      el.style.cssText = [
        'position:fixed', 'left:50%', 'transform:translateX(-50%)', 'bottom:5rem',
        'z-index:9999', 'max-width:min(680px,92vw)', 'padding:9px 14px',
        'border-radius:8px', 'font-size:12px', 'line-height:1.5',
        'box-shadow:0 6px 20px rgba(0,0,0,.45)', 'white-space:pre-wrap', 'word-break:break-all',
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.background = ok === false ? '#7f1d1d' : '#1f3d2b';
    el.style.color = '#e8f5e9';
    el.style.border = `1px solid ${ok === false ? '#b91c1c' : '#2f6f4a'}`;
    el.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    // 失败信息多留一会儿，便于看清原因
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, ok === false ? 12000 : 6000);
  }

  // 统一的 JSON 请求（失败时把服务端返回的 error 抛出来，便于提示到界面）
  function api(path, opts) {
    return fetch(path, opts).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail = Array.isArray(j.details) ? `：${j.details.join('；')}` : '';
        throw new Error((j.error || `HTTP ${r.status}`) + detail);
      }
      return j;
    });
  }

  function store() {
    return window.__SPINE_STORE__ || null;
  }

  // 导出：项目配置（服务端原文）+ 原版 UI 偏好，合成一个文件下载。
  // 思路：项目配置直接搬服务端文件的原始文本（保留 JSONC 注释），
  //   偏好取 store 的 exportSettings()（与原版导出的字段完全一致）。
  async function doExport() {
    const cfg = await api('/api/config/export');
    const s = store();
    const viewer = (s && typeof s.getState === 'function' && s.getState().exportSettings)
      ? s.getState().exportSettings() : null;

    const payload = {
      _meta: {
        app: 'spine-multi-viewer',
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        note: 'project=本项目服务端配置（资源根 + 名表的文件原文）；viewer=原版 UI 偏好',
      },
      project: { files: cfg.files },
      viewer,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = FILE_NAME;
    a.click();
    URL.revokeObjectURL(url);

    toast(`已导出 ${FILE_NAME}\n`
      + `项目配置：${Object.keys(cfg.files).length} 个文件（${Object.keys(cfg.files).join('、')}）\n`
      + `UI 偏好：${viewer ? Object.keys(viewer).length : 0} 项`);
  }

  // 选文件（自建 input，不复用原版那个隐藏 input，避免互相干扰）
  function pickFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => {
        applyImport(String(fr.result)).catch((e) => toast(`导入失败：${e.message}`, false));
      };
      fr.onerror = () => toast('读取文件失败', false);
      fr.readAsText(f);
    };
    input.click();
  }

  // 应用导入内容。
  // 需求：一个文件里可能同时含「项目配置」与「UI 偏好」，需分别落到对应位置；
  //   还要能读原版导出的旧文件（顶层直接是 20 项偏好）。
  // 思路：有 project/viewer 结构按新格式处理；否则整个对象当偏好处理。
  //   项目配置变了（资源根可能增减）→ 提示后刷新页面重新加载模型。
  async function applyImport(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('不是合法的 JSON 文件');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('文件内容不是对象');
    }

    const isNewFormat = !!data.project || !!data.viewer;
    const project = isNewFormat ? data.project : null;
    const viewer = isNewFormat ? data.viewer : data;

    const applied = [];

    if (project && project.files && Object.keys(project.files).length) {
      const r = await api('/api/config/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: project.files }),
      });
      applied.push(`项目配置 ${r.written.length} 个文件（${r.written.join('、')}）`);
      applied.push(`原配置已备份到 ${r.backupDir}`);
    }

    // 注意：必须要求 viewer **有字段**才应用。
    //   原版 importSettings 内部是 `{...默认值, ...传入值}`，传入空对象等于把偏好**重置为默认**——
    //   若把「空对象」也当成功，用户导入一个空文件就会静默清掉自己的偏好（自检抓到过这个问题）。
    if (viewer && typeof viewer === 'object' && Object.keys(viewer).length) {
      const s = store();
      if (s && typeof s.getState === 'function' && s.getState().importSettings) {
        s.getState().importSettings(viewer);
        applied.push(`UI 偏好 ${Object.keys(viewer).length} 项`);
      }
    }

    if (!applied.length) throw new Error('文件里没有可导入的内容');

    toast(`导入成功：\n${applied.join('\n')}`
      + (project ? '\n资源根可能已变化，即将刷新页面…' : ''));

    if (project) setTimeout(() => location.reload(), 1800);
  }

  // 在捕获阶段拦截原版那两个按钮的点击。
  // 只按**精确文本**匹配，避免误伤其它按钮。
  function intercept() {
    document.addEventListener('click', (e) => {
      const t = e.target;
      const btn = t && t.closest ? t.closest('button') : null;
      if (!btn) return;
      const label = (btn.textContent || '').trim();
      if (label !== BTN_EXPORT && label !== BTN_IMPORT) return;

      // 捕获阶段拦下：React 挂在根容器的委托监听收不到这次点击，
      // 原版的「仅偏好」导出/导入行为即被替换。
      e.stopPropagation();
      e.preventDefault();

      if (label === BTN_EXPORT) {
        doExport().catch((err) => toast(`导出失败：${err.message}`, false));
      } else {
        pickFile();
      }
    }, true);

    console.info('[settings-io] 已接管「导出设置 / 导入设置」按钮（项目配置 + UI 偏好）');
  }

  intercept();

  // 暴露接口：便于自动化自检，也便于其它脚本以编程方式导入配置。
  window.__SETTINGS_IO__ = { export: doExport, importText: applyImport, pickFile };

  // 自检钩子（默认不触发）：?selftest=import
  //   只测**无副作用**的路径：旧格式（仅偏好）能否应用、非法内容能否被拒绝。
  //   刻意不测「带 project 的新格式」——那会真的覆盖服务端配置。
  //   测试前后会保存/还原当前偏好，避免污染真实配置（importSettings 会写入 localStorage）。
  if (new URLSearchParams(location.search).get('selftest') === 'import') {
    setTimeout(async () => {
      const s = store();
      const before = (s && s.getState().exportSettings) ? s.getState().exportSettings() : null;
      try {
        // ① 旧格式（顶层直接是偏好）：应只应用偏好
        await applyImport(JSON.stringify({ playbackSpeed: 1.5, fpsLimit: 30 }));
        console.info('[selftest] 导入: 旧格式(仅偏好) 应用成功 ✅');
        // ② 非法 JSON：应被拒绝
        try {
          await applyImport('{ 坏 json');
          console.info('[selftest] 导入: 非法 JSON 竟然通过 ❌');
        } catch (e) {
          console.info(`[selftest] 导入: 非法 JSON 已拒绝 ✅ (${e.message})`);
        }
        // ③ 空对象：应被拒绝
        try {
          await applyImport('{}');
          console.info('[selftest] 导入: 空对象竟然通过 ❌');
        } catch (e) {
          console.info(`[selftest] 导入: 空对象已拒绝 ✅ (${e.message})`);
        }
      } finally {
        // 还原测试前的偏好
        if (before && s && s.getState().importSettings) {
          s.getState().importSettings(before);
          console.info('[selftest] 导入: 已还原测试前的偏好');
        }
      }
    }, 3500);
  }

  // 自检钩子（默认不触发）：?selftest=export
  //   先点顶部工具栏「菜单」打开右栏（导出/导入按钮在右栏设置面板底部），
  //   再点「导出设置」，最后检查是否出现**我们自建的提示条**——
  //   出现即说明点击已被本脚本接管（原版行为只会静默下载一个偏好文件、不会有提示条）。
  if (new URLSearchParams(location.search).get('selftest') === 'export') {
    setTimeout(() => {
      const menuBtn = [...document.querySelectorAll('button')].find((b) => b.title === '菜单');
      console.info(`[selftest] 导出: 顶部「菜单」按钮=${!!menuBtn}`);
      if (menuBtn) menuBtn.click();
      setTimeout(() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => (b.textContent || '').trim() === BTN_EXPORT);
        console.info(`[selftest] 导出: 「${BTN_EXPORT}」按钮存在=${!!btn}`);
        if (btn) btn.click();
        setTimeout(() => {
          const t = document.getElementById(TOAST_ID);
          const shown = !!t && t.style.display !== 'none';
          console.info(`[selftest] 导出: 已接管(提示条出现)=${shown}`);
          if (shown) console.info(`[selftest] 导出: 提示内容=${(t.textContent || '').replace(/\n/g, ' | ')}`);
        }, 2000);
      }, 1200);
    }, 3500);
  }
})();
