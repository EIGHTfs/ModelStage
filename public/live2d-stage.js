// live2d-stage.js —— 在主查看页里承载 Live2D 渲染（与 Spine 共用一个界面）
//
// 需求：Live2D 模型要与 Spine 模型**显示在一起**——同一个左栏列表、同一个舞台区域，
//   选中 Live2D 项就在舞台上渲染它，选中 Spine 项就切回 Spine 渲染。
//
// 思路：
//   - 不新建页面，而是在 Spine 画布上方覆盖一层 Live2D 画布（定位与 Spine 画布一致）
//   - 显示 Live2D 时用 CSS 隐藏 Spine 画布；切回 Spine 时反向操作
//   - 运行时库（PIXI / Cubism 核心 / pixi-live2d-display，合计约 1.4MB）**按需懒加载**：
//     只有第一次选中 Live2D 模型时才注入 <script>，不拖慢 Spine 首屏
//   - 动作/表情/缩放控件做成覆盖层底部的自包含小工具条，只在 Live2D 激活时出现
//
// 对外接口（char-tree.js 调用）：
//   window.__LIVE2D_STAGE__.show(live2dModel)   显示并加载某个 Live2D 模型
//   window.__LIVE2D_STAGE__.hide()              隐藏，切回 Spine 渲染
//   window.__LIVE2D_STAGE__.isActive()          当前是否在显示 Live2D

(function () {
  'use strict';

  const OVERLAY_ID = 'live2d-stage';
  const SPINE_CANVAS_SEL = 'canvas.absolute.inset-0';

  const st = {
    app: null,
    model: null,
    libsReady: null,
    active: false,
    zoom: 1,
  };

  // ---------------------------------------------------------------- 侧栏区块
  //
  // 需求：右栏（菜单面板）原本只针对 Spine，Live2D 用不上；要给 Live2D 加上与 Spine
  //   同款的「初始缩放」等控件，并放进右栏。
  // 思路：在右栏顶部注入一个 Live2D 专属区块（只在 Live2D 激活时显示）。
  //   区块是 React 之外的自有节点，React 重渲染可能把它移除，故用 MutationObserver 补回。
  const SECTION_ID = 'live2d-sidebar-section';

  function findRightSidebar() {
    // ⚠️ bv-sidebar 类左右两个侧栏共用，右侧栏靠 right-0 区分（左侧栏是 left-0）
    return document.querySelector('.bv-sidebar.right-0') || document.querySelector('.bv-sidebar[class*="right-0"]');
  }

  function buildSection() {
    const el = document.createElement('div');
    el.id = SECTION_ID;
    el.style.cssText = 'padding:10px;border-bottom:1px solid #3a3a3a;background:rgba(109,40,217,.10)';

    const btn = (id, text, extra) => `<button id="${id}" style="background:#333;color:#ddd;border:1px solid #555;`
      + `border-radius:5px;padding:3px 8px;cursor:pointer;font-size:11px;${extra || ''}">${text}</button>`;
    const modeBtn = (id, text, title) => `<button id="${id}" title="${title}" `
      + `style="background:#333;color:#ddd;border:1px solid #555;border-radius:5px;padding:3px 0;`
      + `cursor:pointer;font-size:10px;width:100%">${text}</button>`;

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
        <span style="font-size:13px;font-weight:600">Live2D</span>
        <span id="l2d-name" style="color:#9aa;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
      </div>

      <div style="margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
          <span style="color:#9aa;font-size:11px">缩放</span>
          <span id="l2d-zoom-val" style="color:#c4b5fd;font-size:11px"></span>
        </div>
        <input id="l2d-zoom" type="range" min="20" max="600" value="100"
          style="width:100%;accent-color:#6d28d9">
      </div>

      <div style="display:flex;gap:6px;margin-bottom:8px">
        ${btn('l2d-reset', '重置视图')}
        ${btn('l2d-zout', '－')}
        ${btn('l2d-zin', '＋')}
      </div>

      <div style="margin-bottom:8px">
        <div style="color:#9aa;font-size:11px;margin-bottom:4px">动作</div>
        <select id="l2d-motion" style="width:100%;background:#2a2d30;color:#eee;border:1px solid #555;border-radius:5px;padding:3px 4px;font-size:11px"></select>
      </div>

      <div>
        <div style="color:#9aa;font-size:11px;margin-bottom:4px">表情</div>
        <select id="l2d-expr" style="width:100%;background:#2a2d30;color:#eee;border:1px solid #555;border-radius:5px;padding:3px 4px;font-size:11px"></select>
      </div>`;

    // 事件
    const $ = (id) => el.querySelector(`#${id}`);
    // 缩放滑杆：值即百分比，直接映射到 st.zoom（1.0 = 适应视图）
    const syncZoomUI = () => {
      const r = $('l2d-zoom');
      const v = $('l2d-zoom-val');
      if (r) r.value = String(Math.round(st.zoom * 100));
      if (v) v.textContent = `${Math.round(st.zoom * 100)}%`;
    };
    $('l2d-zoom').oninput = (e) => { st.zoom = Number(e.target.value) / 100; applyZoom(); syncZoomUI(); };
    $('l2d-reset').onclick = () => { st.zoom = 1; applyZoom(); syncZoomUI(); };
    $('l2d-zin').onclick = () => { st.zoom = Math.min(6, st.zoom * 1.2); applyZoom(); syncZoomUI(); };
    $('l2d-zout').onclick = () => { st.zoom = Math.max(0.2, st.zoom / 1.2); applyZoom(); syncZoomUI(); };
    el._syncZoomUI = syncZoomUI;
    $('l2d-motion').onchange = playMotion;
    $('l2d-expr').onchange = () => {
      if (!st.model) return;
      const v = $('l2d-expr').value;
      try { if (v === '') st.model.expression(); else st.model.expression(Number(v)); }
      catch (e) { console.warn('[live2d-stage] 切换表情失败:', e.message); }
    };
    return el;
  }

  // 同步右栏的缩放显示（滑杆值 + 百分比文案）。
  function markFitMode() {
    const el = document.getElementById(SECTION_ID);
    if (el && typeof el._syncZoomUI === 'function') el._syncZoomUI();
  }

  function injectSection() {
    const aside = findRightSidebar();
    if (!aside) return false;
    let el = document.getElementById(SECTION_ID);
    if (!el) {
      el = buildSection();
      // 插到侧栏内容区顶部（跳过可能的标题行）
      const host = aside.querySelector('.overflow-y-auto') || aside;
      host.insertBefore(el, host.firstChild);
      const cls = String(aside.className);
      console.info(`[live2d-stage] 已注入控制区块: 是右栏=${cls.includes('right-0')} 是左栏=${cls.includes('left-0')}`
        + ` 宿主=${String(host.className).slice(0, 40)}`);
    }
    el.style.display = '';
    markFitMode();
    return true;
  }

  function hideSection() {
    const el = document.getElementById(SECTION_ID);
    if (el) el.style.display = 'none';
  }

  // React 重渲染右栏时可能把我们的区块移除，用 MutationObserver 补回。
  //   rAF 节流（避免频繁回调）；只在 Live2D 激活时补，Spine 时不打扰。
  function watchSection() {
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        if (!st.active) return;
        if (!document.getElementById(SECTION_ID)) injectSection();
        else markFitMode();
        if (st.active) syncRect();   // 侧栏开合是动画，会产生大量 DOM 变更，跟着重算舞台区域
      });
    };
    try {
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    } catch { /* 观察器不可用时至少首次注入生效 */ }
  }

  // ---------------------------------------------------------------- 懒加载运行时
  // 顺序不可颠倒：live2dcubismcore 必须最先（pixi-live2d-display 初始化时会检查它，
  // 缺失直接抛「Could not find Cubism runtime」，导致 PIXI.live2d 不存在）。
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`脚本加载失败: ${src}`));
      document.head.appendChild(s);
    });
  }

  function ensureLibs() {
    if (!st.libsReady) {
      st.libsReady = (async () => {
        console.info('[live2d-stage] 首次使用，按需加载 Live2D 运行时…');
        await loadScript('/live2d-lib/live2dcubismcore.min.js');
        await loadScript('/live2d-lib/live2d.min.js');
        await loadScript('/live2d-lib/pixi.min.js');
        await loadScript('/live2d-lib/index.min.js');
        console.info(`[live2d-stage] 运行时就绪（PIXI ${PIXI.VERSION || '?'}）`);
      })();
    }
    return st.libsReady;
  }

  // ---------------------------------------------------------------- 覆盖层
  function buildOverlay() {
    let el = document.getElementById(OVERLAY_ID);
    if (el) return el;

    el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.style.cssText = [
      // z-index 必须**低于左右侧栏**（右栏 z-30、本项目左栏 z-60），否则会盖住侧栏
      //   导致「右栏点不动、滑杆拖不了」（实测命中测试发现覆盖层是整窗且层级过高）。
      //   同时要高于 Spine 画布，才能接收滚轮/拖动事件。
      'position:fixed', 'z-index:10', 'display:none',
      'background:transparent', 'overflow:hidden',
    ].join(';');

    const cv = document.createElement('canvas');
    cv.id = 'live2d-stage-canvas';
    cv.style.cssText = 'display:block;width:100%;height:100%';
    el.appendChild(cv);
    bindPanZoom(cv);   // 拖动平移 + 滚轮缩放

    // 控件已移到右栏的 Live2D 区块（见 injectSection）；画布上保留拖动与滚轮缩放。
    document.body.appendChild(el);

    // 底部控件条已移除，其事件绑定随之删除；控件改绑在右栏区块（见 buildSection）。

    return el;
  }

  // 把覆盖层对齐到 Spine 画布的位置。
  // 防御性写法：几何读取放 rAF + try/catch —— 布局读取一旦抛错不应影响整页；
  //   （历史上曾因「改侧栏宽度后立刻读几何」触发强制同步重排打崩渲染进程，
  //    这里只读不改任何 React 管理的样式，风险可控。）
  let syncPending = false;
  function syncRect() {
    if (syncPending) return;
    syncPending = true;
    requestAnimationFrame(() => {
      syncPending = false;
      try {
        const el = document.getElementById(OVERLAY_ID);
        const spineCv = document.querySelector(SPINE_CANVAS_SEL);
        if (!el || !spineCv) return;
        const r = spineCv.getBoundingClientRect();
        // 覆盖层限制在**两侧栏之间的可视舞台区域**，而不是整窗铺满。
        // 为什么：侧栏浮在画布之上；覆盖层若整窗铺满会挡住侧栏，导致
        //   「右栏点不动、滑杆拖不了」。单纯调 z-index 不可靠——实测覆盖层 z=10
        //   仍压过 z=30 的右栏，因为右栏所在父级创建了更低的堆叠上下文。
        //   从几何上避开侧栏，是与层级无关的稳妥做法。
        let left = r.left;
        let right = r.left + r.width;
        const leftPanel = document.getElementById('char-tree-panel');
        if (leftPanel) {
          const lr = leftPanel.getBoundingClientRect();
          if (lr.width > 0) left = Math.max(left, lr.right);
        }
        const rightAside = findRightSidebar();
        if (rightAside) {
          const rr = rightAside.getBoundingClientRect();
          if (rr.width > 0) right = Math.min(right, rr.left);
        }
        el.style.left = `${left}px`;
        el.style.top = `${r.top}px`;
        el.style.width = `${Math.max(0, right - left)}px`;
        el.style.height = `${r.height}px`;
      } catch (e) {
        console.warn('[live2d-stage] 对齐失败:', e.message);
      }
    });
  }

  function setSpineCanvasVisible(visible) {
    try {
      const cv = document.querySelector(SPINE_CANVAS_SEL);
      if (cv) cv.style.visibility = visible ? '' : 'hidden';
    } catch { /* 忽略 */ }
  }

  // ---------------------------------------------------------------- PIXI 应用
  async function ensureApp() {
    if (st.app) return st.app;
    const canvas = document.getElementById('live2d-stage-canvas');
    const opts = {
      view: canvas,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      resizeTo: document.getElementById(OVERLAY_ID),
    };
    // 特性检测：PIXI 7 起 Application 构造不初始化，必须再 await init()
    const isModern = typeof PIXI.Application.prototype.init === 'function';
    const app = isModern ? new PIXI.Application() : new PIXI.Application(opts);
    if (isModern) await app.init(opts);
    st.app = app;
    return app;
  }

  // 适应视图（把模型按**真实包围盒**缩放并居中）。
  //
  // 为什么不用 model.width/height：那是 Live2D 的**画布尺寸**（internalModel.width/height），
  //   角色往往只占画布中的一部分，拿它算缩放会出现「偏小 + 不居中」（实测反馈）。
  //   改用 getBounds() 拿真实绘制包围盒，再按包围盒居中。
  //
  // 注意：必须先归零缩放/位移再取包围盒，否则包围盒会随当前缩放变化而算错。
  // 算出用于适配的矩形（宽高 + 相对模型原点的偏移）。
  //
  // 说明：Spine 右栏的「初始缩放」有主体优先/全部部件/动画全程三档，但 Live2D **没有对应物**——
  //   实测 internalModel.width/height、originalWidth/Height 与真实包围盒（getBounds）完全一致
  //   （都是 960x1600），三档结果必然相同，做成三档只会误导。故 Live2D 只按真实包围盒适配，
  //   缩放交由右栏的缩放滑杆与画布滚轮控制。
  function computeFit() {
    const model = st.model;
    if (!model) return null;
    model.scale.set(1);
    model.position.set(0, 0);
    const b = model.getBounds();
    return {
      x: (b && b.x) || 0,
      y: (b && b.y) || 0,
      w: (b && b.width) || model.width || 1,
      h: (b && b.height) || model.height || 1,
    };
  }

  // 把模型按真实包围盒缩放并居中到视口。
  //
  // 注意：必须先归零缩放/位移再取包围盒，否则包围盒会随当前缩放变化而算错。
  function applyZoom() {
    const model = st.model;
    if (!model || !st.app) return;
    const W = st.app.renderer.width / st.app.renderer.resolution;
    const H = st.app.renderer.height / st.app.renderer.resolution;

    const f = computeFit();
    if (!f) return;
    // 0.98：留一点边距，避免贴边被裁
    const s = Math.min(W / f.w, H / f.h) * 0.98 * st.zoom;
    model.scale.set(s);
    // 适配矩形中心对齐视口中心（矩形相对模型原点的偏移是 f.x / f.y）
    model.x = W / 2 - (f.x + f.w / 2) * s;
    model.y = H / 2 - (f.y + f.h / 2) * s;
  }

  // ---------------------------------------------------------------- 拖动平移 / 滚轮缩放
  //
  // 需求：模型能拖动查看细节、能缩放（此前只能靠底部按钮，且无法平移）。
  // 思路：直接在画布上做指针事件平移；滚轮以**光标位置为锚点**缩放（更符合直觉）。
  //   按钮的「适应」调 applyZoom() 复位；± 按钮调 st.zoom 后同样走 applyZoom()。
  function bindPanZoom(canvas) {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', (e) => {
      if (!st.model) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.style.cursor = 'grabbing';
      try { canvas.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging || !st.model) return;
      st.model.x += e.clientX - lastX;
      st.model.y += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    const endDrag = (e) => {
      dragging = false;
      canvas.style.cursor = 'grab';
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener('wheel', (e) => {
      if (!st.model) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const oldS = st.model.scale.x || 1;
      const nextS = Math.min(8, Math.max(0.05, oldS * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      const k = nextS / oldS;
      // 以光标为锚点缩放：光标下的模型点保持不动
      st.model.x = px - (px - st.model.x) * k;
      st.model.y = py - (py - st.model.y) * k;
      st.model.scale.set(nextS);
    }, { passive: false });
  }

  // 把动作/表情选项填进**右栏区块**的下拉框（控件已从画布底部移到右栏）。
  function buildOptions(m) {
    const sec = document.getElementById(SECTION_ID);
    if (!sec) return;
    const msel = sec.querySelector('#l2d-motion');
    const esel = sec.querySelector('#l2d-expr');
    if (!msel || !esel) return;
    msel.innerHTML = '';
    for (const [group, list] of Object.entries(m.motions || {})) {
      (list || []).forEach((mo, i) => {
        const o = document.createElement('option');
        o.value = `${group}|${i}`;
        o.textContent = `${group} / ${mo.name}`;
        msel.appendChild(o);
      });
    }
    if (!msel.options.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '（无动作）';
      msel.appendChild(o);
    }
    esel.innerHTML = '<option value="">（默认）</option>';
    (m.expressions || []).forEach((e, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = e.name;
      esel.appendChild(o);
    });
  }

  function playMotion() {
    const sel = document.getElementById(SECTION_ID);
    const v = sel && sel.querySelector('#l2d-motion').value;
    if (!v || !st.model) return;
    const [group, idx] = v.split('|');
    try { st.model.motion(String(group), Number(idx)); }
    catch (e) { console.warn('[live2d-stage] 播放动作失败:', e.message); }
  }

  // ---------------------------------------------------------------- 对外接口
  // 加载序号：每次 show() 递增。
  //
  // 为什么需要：show() 是异步的（要加载 moc/贴图）。若在第一次加载**尚未完成**时又调一次 show()，
  //   两次都会走到 addChild，而 st.model 只指向后完成的那次——**先完成的那次模型就成了孤儿**，
  //   永远留在舞台上继续渲染（实测现象：刷新时「加载两遍、其中一个留在背景」）。
  //   有了序号，先发起的那次在完成时发现序号已过期，就自行销毁，不往舞台上放。
  let showSeq = 0;

  async function show(m) {
    const seq = ++showSeq;
    const el = buildOverlay();
    injectSection();   // 右栏显示 Live2D 控制区块
    syncRect();
    el.style.display = 'block';
    setSpineCanvasVisible(false);
    st.active = true;
    // 状态写到右栏区块的角色名位置（底部控件条已移除）
    const status = () => document.getElementById('l2d-name');
    if (status()) status().textContent = '加载中…';

    try {
      await ensureLibs();
      await ensureApp();
      syncRect();

      if (st.model) {
        try { st.app.stage.removeChild(st.model); st.model.destroy({ children: true }); } catch { /* 忽略 */ }
        st.model = null;
      }
      const model = await PIXI.live2d.Live2DModel.from(m.modelUrl);
      // 期间又发起了新的 show()：本次结果作废，直接销毁，避免两个模型同时留在舞台上
      if (seq !== showSeq) {
        try { model.destroy({ children: true }); } catch { /* 忽略 */ }
        console.info(`[live2d-stage] 已有更新的加载请求，丢弃本次结果: ${m.name}`);
        return false;
      }
      st.model = model;
      st.app.stage.addChild(model);
      applyZoom();
      buildOptions(m);

      const msel = document.getElementById(SECTION_ID) && document.getElementById(SECTION_ID).querySelector('#l2d-motion');
      const idleIdx = msel ? [...msel.options].findIndex((o) => o.value.startsWith('idle|')) : -1;
      if (idleIdx >= 0) { msel.selectedIndex = idleIdx; playMotion(); }
      if (status()) {
        status().textContent = `${m.name} · Cubism ${m.cubism} · `
          + `${m.textureFiles.length} 贴图 / ${m.expressions.length} 表情`;
      }
      console.info(`[live2d-stage] 已渲染 ${m.name}（Cubism ${m.cubism}，`
        + `贴图 ${m.textureFiles.length}，表情 ${m.expressions.length}，`
        + `动作组 ${Object.keys(m.motions || {}).join('/') || '无'}）`);
      return true;
    } catch (e) {
      if (status()) status().textContent = `加载失败：${e.message}`;
      console.error('[live2d-stage] 加载失败:', e);
      return false;
    }
  }

  function hide() {
    hideSection();   // 收起右栏的 Live2D 区块（回到 Spine）
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.style.display = 'none';
    setSpineCanvasVisible(true);
    st.active = false;
  }

  function isActive() { return st.active; }

  window.addEventListener('resize', () => { if (st.active) { syncRect(); applyZoom(); } });

  watchSection();

  window.__LIVE2D_STAGE__ = { show, hide, isActive };

  // 自检（默认不触发）：?selftest=live2dstage
  //   自动取第一个 Live2D 模型渲染，并报告真实包围盒 / 缩放 / 居中偏差 / 填充率，
  //   用于无人值守验证「是否居中、大小是否合适」（不需要看图）。
  if (new URLSearchParams(location.search).get('selftest') === 'live2dstage') {
    setTimeout(async () => {
      try {
        // 可指定资源根：?selftest=live2dstage&root=azurlane（默认天命之子）
        const rootId = new URLSearchParams(location.search).get('root') || 'live2d';
        console.info(`[selftest] 开始: root=${rootId}`);
        const r = await fetch(`/api/live2d/models?root=${encodeURIComponent(rootId)}`).then((x) => x.json());
        console.info(`[selftest] 列表: ${(r.models || []).length} 个，第一个=${(r.models || [])[0] ? r.models[0].name : '-'}`);
        const m = (r.models || [])[0];
        if (!m) { console.warn('[selftest] 没有可用的 Live2D 模型'); return; }
        console.info(`[selftest] 开始加载: ${m.modelUrl}`);
        const okShow = await show(m);
        console.info(`[selftest] show 返回=${okShow}`);
        const model = st.model;
        if (!model) { console.warn('[selftest] 模型未挂载'); return; }
        const b = model.getBounds();
        const W = st.app.renderer.width / st.app.renderer.resolution;
        const H = st.app.renderer.height / st.app.renderer.resolution;
        const s = model.scale.x;
        // 注意：getBounds() 返回的是**世界坐标**（已包含位置与缩放），
        //   不能再乘一次缩放——曾因此算出「偏差 234px」的假象（实际完全居中）。
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        console.info(`[selftest] Live2D 舞台: 视口=${Math.round(W)}x${Math.round(H)}`
          + ` 世界包围盒=${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`
          + ` 缩放=${s.toFixed(3)} 位置=${Math.round(model.x)},${Math.round(model.y)}`);
        console.info(`[selftest] 居中检查: 包围盒中心=(${Math.round(cx)},${Math.round(cy)})`
          + ` 视口中心=(${Math.round(W / 2)},${Math.round(H / 2)})`
          + ` 偏差=${Math.round(Math.hypot(cx - W / 2, cy - H / 2))}px`);
        console.info(`[selftest] 填充率: 宽占 ${(b.width / W * 100).toFixed(0)}%`
          + ` 高占 ${(b.height / H * 100).toFixed(0)}%`);
        // 右栏区块与三档缩放
        const sec = document.getElementById(SECTION_ID);
        console.info(`[selftest] 右栏区块: 存在=${!!sec} 可见=${sec ? sec.style.display !== 'none' : false}`
          + ` 动作选项=${sec ? sec.querySelector('#l2d-motion').options.length : 0}`
          + ` 表情选项=${sec ? sec.querySelector('#l2d-expr').options.length : 0}`);
        // 命中测试：真实鼠标事件会落到哪个元素（程序化派发测不出遮挡问题）
        const ov = document.getElementById(OVERLAY_ID);
        const r0 = ov.getBoundingClientRect();
        const cx0 = Math.round(r0.left + r0.width / 2);
        const cy0 = Math.round(r0.top + r0.height / 2);
        const hit = document.elementFromPoint(cx0, cy0);
        console.info(`[selftest] 命中测试: 视口中心(${cx0},${cy0}) 最上层=`
          + `${hit ? hit.tagName + '#' + (hit.id || '') + '.' + String(hit.className || '').slice(0, 50) : '无'}`);
        console.info(`[selftest] 覆盖层: rect=${Math.round(r0.left)},${Math.round(r0.top)} ${Math.round(r0.width)}x${Math.round(r0.height)}`
          + ` 我的画布=${hit && hit.id === 'live2d-stage-canvas' ? '在最上层 ✅' : '被遮挡 ❌'}`);
        // 右栏是否可点（不能被覆盖层挡住）
        const asideEl = findRightSidebar();
        if (asideEl) {
          const ra = asideEl.getBoundingClientRect();
          const hx = Math.round(ra.left + ra.width / 2);
          const hy = Math.round(ra.top + 40);
          const hitAside = document.elementFromPoint(hx, hy);

          const inside = hitAside && asideEl.contains(hitAside);
          console.info(`[selftest] 右栏命中测试: (${hx},${hy}) 命中=${hitAside ? hitAside.tagName : '无'}`
            + ` 在右栏内=${inside ? '✅ 可交互' : '❌ 被遮挡'}`);
        }
        // 滚轮缩放（画布上）是否生效
        const cvEl = document.getElementById('live2d-stage-canvas');
        const s0 = model.scale.x;
        cvEl.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: 700, clientY: 450, bubbles: true, cancelable: true }));
        console.info(`[selftest] 滚轮缩放: ${s0.toFixed(3)} -> ${model.scale.x.toFixed(3)} 变化=${(model.scale.x !== s0)}`);
        // 拖动平移（指针事件）是否生效
        const x0 = model.x;
        cvEl.dispatchEvent(new PointerEvent('pointerdown', { clientX: 700, clientY: 450, bubbles: true, pointerId: 1 }));
        cvEl.dispatchEvent(new PointerEvent('pointermove', { clientX: 760, clientY: 450, bubbles: true, pointerId: 1 }));
        cvEl.dispatchEvent(new PointerEvent('pointerup', { clientX: 760, clientY: 450, bubbles: true, pointerId: 1 }));
        console.info(`[selftest] 拖动平移: x ${Math.round(x0)} -> ${Math.round(model.x)} 变化=${(model.x !== x0)}`);
        // 缩放滑杆
        const sec2 = document.getElementById(SECTION_ID);
        const zr = sec2 && sec2.querySelector('#l2d-zoom');
        console.info(`[selftest] 右栏缩放滑杆: 存在=${!!zr} 值=${zr ? zr.value : '-'}`);
        if (zr) { zr.value = '200'; zr.dispatchEvent(new Event('input')); }
        console.info(`[selftest] 设为 200% 后: 缩放=${model.scale.x.toFixed(3)} 偏差=${Math.round(Math.hypot((model.getBounds().x + model.getBounds().width/2) - W/2, (model.getBounds().y + model.getBounds().height/2) - H/2))}px`);
        if (zr) { zr.value = '100'; zr.dispatchEvent(new Event('input')); }
      } catch (e) {
        console.warn('[selftest] 失败:', e.message);
      }
    }, 3000);
  }

  console.info('[live2d-stage] 已就绪（Live2D 与 Spine 共用同一界面，运行时按需懒加载）');
})();
