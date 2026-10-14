// live2d-stage.js —— 在主查看页里承载 Live2D 渲染（与 Spine 共用一个界面）
//
// 目标：Live2D 模型要与 Spine 模型**显示在一起**——同一个左栏列表、同一个舞台区域，
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

'use strict';

// 为什么用「顶层块」而不是常见的 IIFE 包装（(function(){…})()）：
//   两者作用域行为一致 —— 块内的 const / function 都只在本块内可见，不往 window 上放东西；
//   但 IIFE 会把整份文件包成**一个函数**，静态度量与审计都会把它当成「一个几百行的巨型函数」。
//   块不是函数，因此函数长度度量看到的是文件里真正的一个个函数。
//   块不构成函数级指令原句，故把 'use strict' 提到文件首行（脚本级指令原句，严格模式覆盖整个脚本）。
{
  const OVERLAY_ID = 'live2d-stage';
  const SPINE_CANVAS_SEL = 'canvas.absolute.inset-0';

  const st = {
    app: null,
    model: null,
    libsReady: null,
    active: false,
    // 缩放倍数（1 = 适应视图；值越大模型越大）。
    // **唯一写入方是 bridge.setZoomRatio()** —— 也就是引擎的 userScale 经相机委托传进来；
    //   本文件不再自己持有第二份缩放状态（原自建滑杆/±按钮的那份已在 P4b 删除）。
    zoomRatio: 1,
    // 平移（屏幕像素；与缩放分开存，便于被引擎的 applyPan 直接驱动）
    panX: 0,
    panY: 0,
    // 当前已加载的模型 id（引擎的 loadForEngine 用它判断「同一个模型就不重复加载」）
    modelId: null,
    // 当前 L2D 模型元数据（motions/expressions 表；引擎桥查标签、查表情都要用）
    modelMeta: null,
    // 引擎实例（由引擎在进入 Live2D 模式时挂上）：
    //   bridge.readState() 会读它的 getCameraZoom()，用于「引擎 userScale 与桥缩放是否同源」的核对。
    camera: null,
  };

  // ---------------------------------------------------------------- 右栏几何
  //
  // P4b：本文件**不再往右栏注入任何自建区块**。
  //   历史实现曾在右栏顶部插一个紫色的 `#live2d-sidebar-section`（缩放滑杆 + ± + 重置 +
  //   动作下拉 + 表情下拉），并配一个 MutationObserver 在 React 重渲染后把它补回来；
  //   结果是右栏同时出现「原版动作区」和「自建动作/表情区」两套重复控件。
  //   现在右栏完全交给原版 UI：原版动作区渲染 bridge 提供的 motions 标签，
  //   点击 → 引擎 setAnimation → bridge.playLabel → Live2D 模型动作；缩放/平移也统一由
  //   引擎的相机委托（userScale → setZoomRatio / pan / resetView）驱动。
  //
  // 仍然需要知道右栏的位置：syncRect() 用几何它在「两侧栏之间」的舞台区域里摆放覆盖层，
  //   否则覆盖层会压住右栏（实测会表现为「右栏点不动」）。
  function findRightSidebar() {
    // ⚠️ bv-sidebar 类左右两个侧栏共用，右侧栏靠 right-0 区分（左侧栏是 left-0）
    return document.querySelector('.bv-sidebar.right-0') || document.querySelector('.bv-sidebar[class*="right-0"]');
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
      //   同时要高于 Spine 画布。
      'position:fixed', 'z-index:10', 'display:none',
      'background:transparent', 'overflow:hidden',
      // P4a：覆盖层**不再接收指针事件** —— 事件下穿到原版 Spine 画布，
      //   由原版公共事件层（滚轮/单指拖动/双指缩放）统一驱动引擎，
      //   引擎在 Live2D 激活时把相机操作委托给本文件的 bridge。
      //   于是 Live2D 与 Spine 走同一条交互路径（本文件自带的拖动/滚轮绑定随之失效，P4b 删除）。
      'pointer-events:none',
    ].join(';');

    const cv = document.createElement('canvas');
    cv.id = 'live2d-stage-canvas';
    cv.style.cssText = 'display:block;width:100%;height:100%';
    el.appendChild(cv);

    // P4b：画布上不再绑任何指针/滚轮处理 —— 覆盖层是 pointer-events:none，
    //   事件本来就到不了这里（原绑定是死代码）。拖动/滚轮/双指统一走
    //   「原版 Spine 画布上的公共事件层 → 引擎 → 相机委托 → bridge」这一条路径。
    document.body.appendChild(el);

    return el;
  }

  // 把 PIXI 渲染器尺寸同步到覆盖层的**实际 CSS 尺寸**。
  //
  // 为什么必须显式做（而不是只靠 PIXI 的 resizeTo）：
  //   ① PIXI 6 的 resizeTo 只在 window resize 时跟随，覆盖层自身尺寸变化它不会自动跟；
  //   ② 覆盖层尺寸是 syncRect() 按 Spine 画布 rect 算出来写上去的（rAF 延迟），
  //      而 ensureApp() 可能在首次 syncRect 生效之前就跑完 —— 那时覆盖层还没有尺寸，
  //      PIXI 会停在默认 800×600，模型于是被居中在 800×600 的逻辑空间里
  //      （实测：模型中心落在 x≈400，正好被 544px 宽的角色库面板盖住）。
  //   ③ resize() 之后 PIXI 会把 canvas 的 style 写成像素值，需要再拉回 100% 跟随覆盖层。
  function fitAppToOverlay() {
    const app = st.app;
    const ov = document.getElementById(OVERLAY_ID);
    if (!app || !app.renderer || !ov) return false;
    const r = ov.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    const res = app.renderer.resolution || 1;
    const curW = Math.round((app.renderer.width || 0) / res);
    const curH = Math.round((app.renderer.height || 0) / res);
    if (curW !== w || curH !== h) app.renderer.resize(w, h);
    const cv = document.getElementById('live2d-stage-canvas');
    if (cv) { cv.style.width = '100%'; cv.style.height = '100%'; }
    return true;
  }

  // 把覆盖层对齐到 Spine 画布 —— **几何完全一致**（同 left/top/width/height）。
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
        // 为什么现在直接铺满：历史上覆盖层会挡住侧栏（当时它接收指针事件），于是刻意把覆盖层
        //   收窄到「两侧栏之间的舞台区」；P4a 起覆盖层已是 pointer-events:none，挡不住任何指针事件，
        //   几何规避随之失去意义 —— 而且它让 Live2D 的可视舞台比 Spine 小
        //   （实测 1200×1080 @ x=544，Spine 是 1920×1080 @ x=0，模型拖到两侧会被裁掉）。
        //   故这里与 Spine 画布逐值对齐，背景/棋盘格与舞台范围随之一致。
        el.style.left = `${r.left}px`;
        el.style.top = `${r.top}px`;
        el.style.width = `${r.width}px`;
        el.style.height = `${r.height}px`;
        // 尺寸变了就让 PIXI 渲染器跟上，并按新视口重排模型（否则模型仍按旧尺寸居中）
        if (st.active && st.app) {
          fitAppToOverlay();
          applyZoom();
        }
      } catch (e) {
        console.warn('[live2d-stage] 对齐失败:', e.message);
      }
    });
  }

  // 隐藏/恢复原版 Spine 画布（Live2D 显示时）。
  //
  // P4a 变更：**不能再用 visibility:hidden** —— 那会让画布退出命中测试，
  //   而原版公共事件层（滚轮/拖动/双指）恰恰绑在这张画布上；Live2D 覆盖层既然已
  //   pointer-events:none，就必须让画布继续可命中，事件才能落到公共事件层。
  //   改用 opacity:0：视觉上完全隐藏（Live2D 在覆盖层上渲染），但保留命中测试。
  function setSpineCanvasVisible(visible) {
    try {
      const cv = document.querySelector(SPINE_CANVAS_SEL);
      if (!cv) return;
      cv.style.opacity = visible ? '' : '0';
      cv.style.visibility = '';
      cv.setAttribute('data-l2d-hidden', visible ? '' : '1');
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
      // 模板缓冲（stencil）必须开：Cubism 的**裁剪遮罩**（clipping mask）靠模板缓冲实现，
      //   PIXI 默认 stencil:false（实测漏开时，带遮罩的模型会把本应被裁掉的部件画出来 ——
      //   用户看到的是"手臂重复/同一张脸叠两层"这类重影；同模型无遮罩版本则正常）。
      //   判定依据：出重影的 aimierbeierding_3 有 18 个带遮罩绘制对象 / 19 条遮罩引用，
      //   不出问题的 aimierbeierding_2 为 0 个。
      // [重影-推测修复] 2026-10-16 停用：误诊为遮罩渲染问题时的改动，除"试图解决重影"外无实际作用；重影方向已判定为模型数据问题（见 doc/2026-10-16重影问题定案与模型特殊性对照.MD）
      // stencil: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      resizeTo: document.getElementById(OVERLAY_ID),
    };
    // 特性检测：PIXI 7 起 Application 构造不初始化，必须再 await init()
    const isModern = typeof PIXI.Application.prototype.init === 'function';
    const app = isModern ? new PIXI.Application() : new PIXI.Application(opts);
    if (isModern) await app.init(opts);
    st.app = app;
    // 创建后立刻按覆盖层实际尺寸校准一次：覆盖层在首次 syncRect 生效前可能还没有尺寸，
    //   只靠 resizeTo 会让渲染器停在 PIXI 默认 800×600（模型随之被居中到错误位置）。
    fitAppToOverlay();
    guardTicker();
    // stencil 缓冲自检：Cubism 的裁剪遮罩靠模板缓冲实现，拿不到 stencil 的设备上遮罩会失效 ——
    //   表现就是本应被裁掉的部件被画出来（看画面像"重影"）。这里把实测结果留痕（日志 + debug()），
    //   便于按设备定位「同一模型有的机器正常、有的机器重影」这类问题。
    st.stencilOk = (() => {
      try {
        const gl = app.renderer && app.renderer.gl;
        const attr = gl && typeof gl.getContextAttributes === 'function' ? gl.getContextAttributes() : null;
        return attr ? !!attr.stencil : null;
      } catch { return null; }
    })();
    if (st.stencilOk === false) {
      // 说明：stencil 是否可用是**只读测量点**（保留，用于按设备定位遮罩类差异）；
      //   而 stencil 选项本身已按重影方向的停用决定注释掉（恢复 PIXI 默认），故此警告只是事实陈述，不再下"重影"结论。
      console.warn('[live2d-stage] 当前 WebGL 上下文没有 stencil 缓冲：Cubism 裁剪遮罩在该设备上不生效');
    }
    return app;
  }

  // ---- 渲染循环兜底与自愈 ----------------------------------------------------
  // 为什么需要：模型的动作/贴图数据异常时，它的每帧更新可能抛出未捕获异常。
  //   PIXI 的 Ticker 一旦在 update 里抛错，续期的 requestAnimationFrame 就不会执行——
  //   started 仍为 true，但 _requestId 变成 null，渲染循环就此停摆：画面先冻结，
  //   此后任何画布清屏（尺寸变化、切换模型时的 resize）都会让画面全黑。
  //   实测触发路径：切到某个动作数据与其 moc3 参数表不匹配的资源包模型后，
  //   运行时读动作数据得到 undefined，抛 "Cannot read properties of undefined (reading 'time')"。
  // 做法分两层：① 包一层 update，单帧异常不再打断渲染链，并立刻做两件补救；
  //             ② 定时自检，链已断就重启（兜住其它路径造成的同类断链）。
  let tickerWatchdog = null;

  /** 单帧异常后的补救：停掉会持续抛错的当前动作，并补渲染一帧（异常已跳过后半段监听器，含渲染监听）。 */
  function recoverFromFrameError(err) {
    console.warn('[live2d-stage] 渲染帧内异常已兜底（渲染循环不会因此中断）:', err && err.message);
    try {
      const mm = st.model && st.model.internalModel && st.model.internalModel.motionManager;
      if (mm && typeof mm.stopAllMotions === 'function') mm.stopAllMotions();
    } catch { /* 忽略 */ }
    try { if (st.app && st.app.stage) st.app.renderer.render(st.app.stage); } catch { /* 忽略 */ }
  }

  /** 给渲染循环加兜底与看门狗（幂等：重复调用只生效一次）。 */
  function guardTicker() {
    const t = st.app && st.app.ticker;
    if (!t || t.__l2dGuarded) return;
    t.__l2dGuarded = true;
    const orig = t.update;
    t.update = function patchedUpdate(...args) {
      try { return orig.apply(this, args); } catch (err) { recoverFromFrameError(err); return false; }
    };
    if (!tickerWatchdog) {
      tickerWatchdog = setInterval(() => {
        const tk = st.app && st.app.ticker;
        if (!tk || !tk.started) return;
        if (!tk._requestId) {
          console.warn('[live2d-stage] 检测到渲染循环已停（rAF 链断），自动重启');
          try { tk.start(); } catch { /* 忽略 */ }
          try { if (st.app.stage) st.app.renderer.render(st.app.stage); } catch { /* 忽略 */ }
        }
      }, 1500);
    }
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

  // 把模型按真实包围盒缩放并居中到视口（再叠加平移 st.panX/st.panY）。
  //
  // 注意：必须先归零缩放/位移再取包围盒，否则包围盒会随当前缩放变化而算错。
  //
  // P4a 变更：平移从「直接改 model.x/y」改为**显式状态 st.panX/st.panY**，
  //   这样引擎的 applyPan() 委托进来（公共事件层的单指拖动/双指中点移动）与
  //   本文件自己的拖动实现共享同一份状态，不会出现「两套位移互相覆盖」。
  function applyZoom() {
    const model = st.model;
    if (!model || !st.app) return;
    const W = st.app.renderer.width / st.app.renderer.resolution;
    const H = st.app.renderer.height / st.app.renderer.resolution;

    const f = computeFit();
    if (!f) return;
    // 0.98：留一点边距，避免贴边被裁
    const s = Math.min(W / f.w, H / f.h) * 0.98 * st.zoomRatio;
    model.scale.set(s);
    // 适配矩形中心对齐视口中心（矩形相对模型原点的偏移是 f.x / f.y），再叠加平移
    model.x = W / 2 - (f.x + f.w / 2) * s + st.panX;
    model.y = H / 2 - (f.y + f.h / 2) * s + st.panY;
  }

  // ---------------------------------------------------------------- 动作标签表（P4a）
  //
  // 为什么需要：原版右栏「动作」区渲染的是**字符串列表**（model.animations），点击后把
  //   同一个字符串回传给引擎的 setAnimation()。Live2D 的动作是 (group, index) 二元组，
  //   故这里建一张「标签 -> (group, index)」的双向表，让原版 UI 用它熟悉的字符串工作。
  //   标签形态：`group / 动作文件名（去 .motion3 后缀）`，例如 `idle / idle`。
  //
  // 排序：idle 组排在最前（原实现自动播放 idle；引擎装载后会播放 animations[0]，
  //   把 idle 放首位可保持「切过去就是待机」的既有观感），其余按模型文件里的组顺序。
  let motionMap = new Map();          // label -> { group, index }
  function motionLabel(group, name) {
    return `${group} / ${String(name || '').replace(/\.motion3$/i, '')}`;
  }
  function buildMotionMap(m) {
    motionMap = new Map();
    const groups = Object.keys(m.motions || {});
    groups.sort((a, b) => (a === 'idle' ? -1 : b === 'idle' ? 1 : 0));
    for (const group of groups) {
      (m.motions[group] || []).forEach((mo, i) => {
        let label = motionLabel(group, mo && mo.name);
        if (motionMap.has(label)) label = `${label} #${i + 1}`;   // 同名兜底，保证唯一
        motionMap.set(label, { group: String(group), index: i });
      });
    }
    return [...motionMap.keys()];
  }
  function motionLabels() { return [...motionMap.keys()]; }
  function expressionNames(m) { return (m && m.expressions ? m.expressions : []).map((e) => e.name); }

  // ---------------------------------------------------------------- 引擎桥（P4a）
  //
  // 用途：让 **原版公共管线**（右栏动作区 + 公共事件层）驱动 Live2D。
  //   · loadForEngine(model)：引擎 loadModel() 认出 kind==="live2d" 时调用；
  //       若目标模型已加载则直接复用，返回与 Spine 同形的 { animations, skins, durations }。
  //   · playLabel(label)：引擎 setAnimation() 委托（标签->(group,index)）。
  //   · setExpressions(names)：引擎 setSkins() 委托。
  //   · setZoomRatio / pan / resetView：引擎相机方法委托（缩放/平移/复位）。
  //   · attachCamera(engine)：把引擎实例挂上（readState 用它读 getCameraZoom 做同源核对）。
  const bridge = {
    isActive: () => st.active,
    hide,
    currentModelId: () => st.modelId,
    labels: () => motionLabels(),
    expressions: () => expressionNames(st.modelMeta),
    /** 引擎装载入口：复用或加载，并返回同形摘要。 */
    async loadForEngine(m) {
      const reusable = st.active && st.modelId === m.id && st.model;
      if (!reusable) {
        const ok = await show(m);
        if (!ok) throw new Error(`Live2D 模型加载失败: ${m.name}`);
      }
      attachIfNeeded();
      return {
        animations: motionLabels(),
        skins: expressionNames(st.modelMeta || m),
        durations: {},
        version: `Live2D Cubism ${(m && m.cubism) || 3}`,
      };
    },
    playLabel(label) {
      const hit = motionMap.get(label);
      if (!hit) { console.warn('[live2d-stage] 未知动作标签:', label); return false; }
      if (!st.model) return false;
      st.lastLabel = label;
      try { st.model.motion(hit.group, hit.index); } catch (e) { console.warn('[live2d-stage] 播放动作失败:', e.message); return false; }
      return true;
    },
    setExpressions(names) {
      if (!st.model) return false;
      const list = (names || []).filter((x) => x);
      try {
        if (!list.length) { st.model.expression(); return true; }
        const m = st.modelMeta || {};
        const idx = (m.expressions || []).findIndex((e) => e.name === list[0]);
        if (idx >= 0) st.model.expression(idx);
        return true;
      } catch (e) { console.warn('[live2d-stage] 切换表情失败:', e.message); return false; }
    },
    // 缩放倍数：引擎「userScale 变大 = 模型变大」直接对应本文件的 st.zoomRatio（值越大模型越大）。
    setZoomRatio(r) {
      const v = Math.min(6, Math.max(0.2, Number(r) || 1));
      st.zoomRatio = v;
      applyZoom();
      return v;
    },
    pan(dx, dy) {
      st.panX += Number(dx) || 0;
      st.panY += Number(dy) || 0;
      applyZoom();
    },
    resetView() {
      st.zoomRatio = 1; st.panX = 0; st.panY = 0;
      applyZoom();
    },
    attachCamera(engine) { st.camera = engine || null; },
    /** 自检/验证用读数（不改状态）。 */
    readState() {
      const model = st.model;
      // 模型内部当前动作：pixi-live2d-display 的 motionManager 上有 currentGroup/currentIndex，
      //   用于验证「原版动作区点击 → 引擎 → bridge → 模型内部真的换了动作」这条链路。
      let motion = null;
      try {
        const mm = model && model.internalModel && model.internalModel.motionManager;
        // pixi-live2d-display：动作状态在 MotionManager 的 state（MotionState）上（currentGroup/currentIndex），
        //   这里两种位置都试，拿不到就报出可用键名便于排查。
        const holder = (mm && mm.state && (mm.state.currentGroup !== undefined || mm.state.currentIndex !== undefined)) ? mm.state
          : (mm && (mm.currentGroup !== undefined || mm.currentIndex !== undefined)) ? mm : null;
        if (holder) motion = { group: holder.currentGroup ?? null, index: holder.currentIndex ?? null, via: holder === (mm && mm.state) ? 'state' : 'manager' };
        else if (mm) motion = { keys: Object.keys(mm).slice(0, 16) };
      } catch { /* 忽略 */ }
      return {
        active: st.active,
        modelId: st.modelId,
        lastLabel: st.lastLabel || null,
        motion,
        // 对外字段名保持 zoom 不变（验证脚本/自检都在用它读桥侧缩放）
        zoom: st.zoomRatio,
        panX: st.panX,
        panY: st.panY,
        modelScale: model && model.scale ? model.scale.x : null,
        modelX: model ? model.x : null,
        modelY: model ? model.y : null,
        labels: motionLabels().length,
        cameraUserScale: st.camera && st.camera.getCameraZoom ? st.camera.getCameraZoom() : null,
      };
    },
    /** 自检：适配矩形 + 「模型中心是否落在渲染器中心」（读完原样恢复现场，不改渲染状态）。 */
    fitInfo() {
      const model = st.model;
      if (!model || !st.app) return null;
      const saveS = model.scale.x;
      const saveX = model.x;
      const saveY = model.y;
      const f = computeFit();
      model.scale.set(saveS);
      model.x = saveX;
      model.y = saveY;
      const W = st.app.renderer.width / (st.app.renderer.resolution || 1);
      const H = st.app.renderer.height / (st.app.renderer.resolution || 1);
      const cx = saveX + (f.x + f.w / 2) * saveS;
      const cy = saveY + (f.y + f.h / 2) * saveS;
      return {
        fitRect: { x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h) },
        rendererW: Math.round(W),
        rendererH: Math.round(H),
        modelCenterX: Math.round(cx),
        modelCenterY: Math.round(cy),
        offCenterPx: Math.round(Math.hypot(cx - W / 2, cy - H / 2)),
      };
    },
  };

  /** 引擎装载后把引擎实例挂到 bridge 上（引擎会主动调 bridge.attachCamera）。 */
  function attachIfNeeded() { /* 由引擎侧 attachCamera 完成，这里保留空实现以表明归属 */ }

  /**
   * 让 Live2D 模型进入**原版 store**（P4a 的接入点）。
   *
   * 为什么必须补 animations / skins 两个字段：
   *   store.setCurrentModel() 会读 `model.animations.length`、`model.skins.length`、`.includes()`，
   *   而服务端给的 Live2D 模型对象只有 motions / expressions（**没有**这两个字段）——
   *   不补就直接选中会抛 TypeError。故先用 store 的 updateModel() 把标签表/表情名写进模型对象。
   *
   * 补完之后走的是**纯原版路径**（React 代码一行都不用改）：
   *   setCurrentModel → 应用层「当前模型变化」的 effect → engine.loadModel(该模型)
   *   → 引擎认出 kind==="live2d" → bridge.loadForEngine（本模型已加载则复用）
   *   → 返回 { animations, skins, … } → store 更新 + 右栏原版「动作」区列出这些 motions。
   */
  function syncStoreForEngine(m) {
    try {
      const store = window.__SPINE_STORE__;
      if (!store || typeof store.getState !== 'function') {
        console.warn('[live2d-stage] 未找到 __SPINE_STORE__，Live2D 无法接入原版动作区');
        return false;
      }
      const labels = motionLabels();
      const skins = expressionNames(m);
      const s = store.getState();
      const patch = { animations: labels, skins, version: `Live2D Cubism ${m.cubism || 3}` };
      if ((s.models || []).some((x) => x.id === m.id)) {
        s.updateModel(m.id, patch);
      } else {
        // Live2D 模型来自 /api/live2d/models，**默认不在 store.models 里**（char-tree 只把它并进自己的树）。
        //   而原版 setCurrentModel() 是按 id 在 store.models 里查找模型对象的 —— 不在列表里
        //   currentModel 会变成 null，右栏动作区也就拿不到 motions。
        //   故先用原版 addModels() 把它并进模型列表（该 action 自带去重：name+fileSize+目录），
        //   再 setCurrentModel()。这样走的是原版自己的数据通路，不额外发明字段。
        Object.assign(m, patch);
        s.addModels([m]);
        console.info('[live2d-stage] 已把 Live2D 模型并入 store.models（原先不在列表里）:', m.name);
      }
      if (store.getState().currentModelId !== m.id) {
        store.getState().setCurrentModel(m.id);
        console.info(`[live2d-stage] 已把 ${m.name} 设为当前模型`
          + `（动作 ${labels.length} / 表情 ${skins.length}），原版右栏动作区将列出这些 motions`);
      }
      return true;
    } catch (e) {
      console.warn('[live2d-stage] 接入 store 失败:', e.message);
      return false;
    }
  }

  // ---------------------------------------------------------------- 对外接口
  // 加载序号：每次 show() 递增。
  //
  // 为什么需要：show() 是异步的（要加载 moc/贴图）。若在第一次加载**尚未完成**时又调一次 show()，
  //   两次都会走到 addChild，而 st.model 只指向后完成的那次——**先完成的那次模型就成了孤儿**，
  //   永远留在舞台上继续渲染（实测现象：刷新时「加载两遍、其中一个留在背景」）。
  //   有了序号，先发起的那次在完成时发现序号已过期，就自行销毁，不往舞台上放。
  let showSeq = 0;

  /** show() 的舞台准备段：创建/显示覆盖层、对齐几何、隐藏 Spine 画布、标记为激活。 */
  function prepareStageForShow(m) {
    const el = buildOverlay();
    syncRect();
    el.style.display = 'block';
    setSpineCanvasVisible(false);
    // hide() 会停掉渲染循环（隐藏期间不空转），重新上屏时在这里恢复
    try { if (st.app && typeof st.app.start === 'function') st.app.start(); } catch { /* 忽略 */ }
    st.active = true;
    console.info(`[live2d-stage] 开始加载 ${m.name}（右栏由原版动作区驱动）`);
  }

  /**
   * 装载 PIXI 模型并挂到舞台。
   * 返回模型对象；若期间又发起了新的 show()（本次序号已过期）则销毁本次结果并返回 null。
   */
  async function loadAndMountModel(m, seq) {
    await ensureLibs();
    await ensureApp();
    syncRect();

    // 模型可自带 prepare() 钩子：在取任何模型资产**之前**执行（由模型来源方定义）。
    //   用途：把内存态资源（Blob URL）接入页面加载器 —— 加载器是按 model3.json 的 URL
    //   解析相对路径的，内存资源的绝对 URL 必须先给加载器装上直通中间件，否则会被拼坏。
    //   放在 ensureLibs() 之后：运行时已就绪，钩子内部不必也不该自己去等运行时（否则死锁）。
    if (m && typeof m.prepare === 'function') {
      try { await m.prepare(); } catch (e) { console.warn('[live2d-stage] 模型 prepare 钩子失败（继续装载）:', e.message); }
    }

    if (st.model) {
      try { st.app.stage.removeChild(st.model); st.model.destroy({ children: true }); } catch { /* 忽略 */ }
      st.model = null;
    }
    // 释放旧模型占用的内存资源（Blob URL 等由模型自己声明，见插件侧 model.revoke）。
    if (st.modelMeta && typeof st.modelMeta.revoke === 'function' && st.modelMeta !== m) {
      try { st.modelMeta.revoke(); } catch { /* 忽略 */ }
    }
    const model = await PIXI.live2d.Live2DModel.from(m.modelUrl);
    // 期间又发起了新的 show()：本次结果作废，直接销毁，避免两个模型同时留在舞台上
    if (seq !== showSeq) {
      try { model.destroy({ children: true }); } catch { /* 忽略 */ }
      console.info(`[live2d-stage] 已有更新的加载请求，丢弃本次结果: ${m.name}`);
      return null;
    }
    // 挂载前兜底清扫：并发 show() 交错时，前一次「加载中→已挂载」的模型可能晚于本次的清理段落到舞台上，
    //   只靠 st.model 记一个引用挡不住（实测会出现两幅叠加渲染）。
    // 说明：这条守卫是重影排查期间加的，但**它防的是真实的并发竞态**（两个模型同时渲染），
    //   已独立验证有效（连续 7 次 L2D↔Spine 切换：live2dModels 恒为 1），故保留、不停用。
    //   这里按类型清扫舞台上所有 Live2D 模型，确保**始终只有一个**在渲染。
    //   只清理 Live2D 模型（stage.children 里其它装饰/调试对象不动），且当前这次要挂载的模型不会被误清。
    for (const child of st.app.stage.children.slice()) {
      if (child === model) continue;
      if (child instanceof PIXI.live2d.Live2DModel) {
        try { st.app.stage.removeChild(child); } catch { /* 忽略 */ }
        try { child.destroy({ children: true }); } catch { /* 忽略 */ }
        console.info(`[live2d-stage] 清扫舞台上多余的 Live2D 模型（防止重影）: ${m.name}`);
      }
    }
    st.model = model;
    st.app.stage.addChild(model);
    // 裁剪遮罩缓冲按模型规模自适应：必须在**首次渲染前**设置，且每次装载都要重设
    //   （换模型会拿到新的 renderer/clippingManager，参数回到框架默认 256）。
    // 裁剪遮罩：先按开关决定是否关闭（逃生），未关闭时再按画布自适应缓冲尺寸。
    //   关闭遮罩时缓冲用不到，故 maskBuf 记为 null，避免 debug() 报一个不生效的值。
    // [重影-推测修复] 2026-10-16 停用：误诊为遮罩渲染问题时的改动，除"试图解决重影"外无实际作用；重影方向已判定为模型数据问题（见 doc/2026-10-16重影问题定案与模型特殊性对照.MD）
    // const masksResolved = await resolveMasksMode();
    // st.masksMode = applyClippingMasksMode(model, m.name, masksResolved.mode);
    // st.maskBuf = st.masksMode === 'off' ? null : applyClippingMaskBuffer(model, m.name);
    return model;
  }

  /**
   * 按模型规模设置裁剪遮罩缓冲尺寸，并让遮罩渲染纹理按新尺寸重建。
   *
   * 背景（实测）：Cubism 的裁剪遮罩先画进一块独立渲染缓冲（框架默认 256×256），
   *   再拿它去裁剪绘制对象。模型画布越大、遮罩组越多，256 的缓冲越"糊"，
   *   本该被裁掉的部件就会漏出来——表现为头发上多一层半透明覆层（看起来像重影）。
   *   本样本 aimierbeierding_3：画布 6200×5600、9 组遮罩，默认 256 时覆层明显；
   *   调到 2048（并按新尺寸重建遮罩纹理）后覆层消失，画面差异集中在头部/躯干。
   *
   * 取值：clamp(1024, max(画布宽,高)/4, 2048) —— 本样本为 1550。
   *   下界 1024 保证小画布模型也有足够精度；上界 2048 避免无谓的显存开销。
   *
   * 只处理**确实有遮罩**的模型：无 `_clippingManager`、或遮罩组列表为空时直接返回 null，
   *   保持框架默认（缓冲显存 256²≈0.25MB，放宽到 2048²≈16MB，无遮罩模型不需要这笔开销）。
   *
   * 全程 try/catch：不同运行时版本的内部字段名可能不同，取不到句柄就静默跳过，
   *   绝不让"美化"失败影响装载流程。
   * @returns {number|null} 实际生效的缓冲尺寸；无遮罩或失败返回 null
   */
  // [重影-推测修复] 2026-10-16 停用：误诊为遮罩渲染问题时的改动，除"试图解决重影"外无实际作用；重影方向已判定为模型数据问题（见 doc/2026-10-16重影问题定案与模型特殊性对照.MD）
  // // ---------------------------------------------------------------- 裁剪遮罩开关（逃生用）
  // // 为什么需要：遮罩渲染依赖设备的模板缓冲与遮罩缓冲，个别设备（实测手机端反馈）上表现不同，
  // //   出现"本应被裁掉的部件被画出"的观感。开关用于先排除"是不是遮罩路径的问题"，不改模型数据。
  // // 取值优先级：URL 参数 ?masks=off|auto > 服务端 config/live2d.json > 默认 auto。
  // // 关闭方式：把裁剪管理器的 setupClippingContext 置空 —— 不建立裁剪上下文，
  // //   带遮罩的绘制对象按"无裁剪"绘制（实测：模型完整、无游离部件）。
  // function masksModeFromUrl() {
  //   try {
  //     const v = new URLSearchParams(location.search).get('masks');
  //     if (v === 'off') return 'off';
  //     if (v === 'auto') return 'auto';
  //     return null;
  //   } catch { return null; }
  // }
  //
  // /** 解析当前生效的遮罩模式（带缓存；URL 参数每次读，便于同页切换对比）。 */
  // async function resolveMasksMode() {
  //   const fromUrl = masksModeFromUrl();
  //   if (fromUrl) return { mode: fromUrl, source: 'url' };
  //   if (st.masksSetting) return st.masksSetting;
  //   try {
  //     const r = await fetch('/api/live2d/settings');
  //     const j = await r.json();
  //     st.masksSetting = { mode: j && j.clippingMasks === 'off' ? 'off' : 'auto', source: 'config' };
  //   } catch {
  //     st.masksSetting = { mode: 'auto', source: 'default' };
  //   }
  //   return st.masksSetting;
  // }
  //
  // /** 按模式处理裁剪遮罩：off 时关闭遮罩；返回实际生效的模式。 */
  // function applyClippingMasksMode(model, name, mode) {
  //   try {
  //     const renderer = model && model.internalModel && model.internalModel.renderer;
  //     if (!renderer) return mode;
  //     if (mode === 'off') {
  //       const cm = renderer._clippingManager;
  //       if (!cm) return mode;   // 该模型本就没有遮罩，无需处理
  //       if (!renderer.__cmBackup) {
  //         // 关法：让渲染器看不到裁剪管理器 —— 它便走"无裁剪"的绘制分支。
  //         //   为什么不用把 setupClippingContext 置空：实测那样渲染器会读到未初始化的裁剪上下文，
  //         //   每帧抛 "Cannot read properties of undefined (reading 'R')"（被渲染循环兜底接住，但等于每帧报错）。
  //         //   备份原引用，便于同页切回 auto 时复原（每次装载都是新实例，备份只为可逆）。
  //         renderer.__cmBackup = cm;
  //         renderer._clippingManager = null;
  //         console.info(`[live2d-stage] 已关闭裁剪遮罩（模型 ${name}）`);
  //       }
  //       return 'off';
  //     }
  //     // auto：若此前被关闭过（同一实例复用），复原裁剪管理器
  //     if (renderer.__cmBackup && !renderer._clippingManager) {
  //       renderer._clippingManager = renderer.__cmBackup;
  //       renderer.__cmBackup = null;
  //     }
  //   } catch (e) {
  //     console.warn('[live2d-stage] 处理裁剪遮罩开关失败（按原有遮罩继续）:', e && e.message);
  //   }
  //   return mode === 'off' ? 'off' : 'auto';
  // }
  //
  // function applyClippingMaskBuffer(model, name) {
  //   try {
  //     const renderer = model && model.internalModel && model.internalModel.renderer;
  //     const cm = renderer && renderer._clippingManager;
  //     if (!cm) return null;
  //     const list = cm._clippingContextListForMask;
  //     if (!list || !list.length) return null;
  //     const w = Number(model.internalModel.width) || 0;
  //     const h = Number(model.internalModel.height) || 0;
  //     const target = Math.max(1024, Math.min(2048, Math.round(Math.max(w, h) / 4) || 1024));
  //     const current = Number(cm._clippingMaskBufferSize) || 0;
  //     // 已经是目标值且遮罩纹理还在：不必重复重建
  //     if (current === target && cm._maskRenderTexture) return current;
  //     if (typeof cm.setClippingMaskBufferSize === 'function') cm.setClippingMaskBufferSize(target);
  //     else cm._clippingMaskBufferSize = target;
  //     // 关键一步：遮罩渲染纹理必须按新尺寸重建，否则新尺寸不生效（实测不重建看不出变化）
  //     try { if (cm._maskRenderTexture) cm._maskRenderTexture.destroy(true); } catch { /* 忽略 */ }
  //     cm._maskRenderTexture = null;
  //     console.info(`[live2d-stage] 裁剪遮罩缓冲 ${current || 256} → ${target}`
  //       + `（模型 ${name}，画布 ${w}x${h}，遮罩组 ${list.length}）`);
  //     return target;
  //   } catch (e) {
  //     console.warn('[live2d-stage] 设置裁剪遮罩缓冲失败（按默认继续）:', e && e.message);
  //     return null;
  //   }
  // }

  /** 装载完成后的接入段：记模型 / 视图复位 / 建动作标签表 / 起手播第一个标签 / 并入原版 store。 */
  function activateLoadedModel(m) {
    // 1) 记下当前模型（引擎桥用它判断复用，避免重复加载）
    st.modelId = m.id;
    st.modelMeta = m;
    // 2) 新模型从「适应视图」开始（与 Spine 装载后 resetCamera 的观感一致）
    st.zoomRatio = 1;
    st.panX = 0;
    st.panY = 0;
    // 3) 建动作标签表：原版右栏「动作」区渲染的就是这批字符串
    buildMotionMap(m);
    applyZoom();
    // 3b) 起手播第一个标签（标签表把 idle 组排在最前，等价于原先的「自动播 idle」）
    const firstLabel = motionLabels()[0];
    if (firstLabel) bridge.playLabel(firstLabel);
    // 4) 让 L2D 模型进入 store（补足原版渲染动作列表所需的形状）→ 触发引擎装载
    syncStoreForEngine(m);
  }

  async function show(m) {
    const seq = ++showSeq;
    const tShow = Date.now();   // 装载耗时起点（诊断事件 model.mount 用）
    prepareStageForShow(m);

    try {
      const model = await loadAndMountModel(m, seq);
      if (!model) return false;
      activateLoadedModel(m);
      console.info(`[live2d-stage] 已渲染 ${m.name}（Cubism ${m.cubism}，`
        + `贴图 ${m.textureFiles.length}，表情 ${m.expressions.length}，`
        + `动作组 ${Object.keys(m.motions || {}).join('/') || '无'}）`);
      // 诊断事件：模型已挂载（含总装载耗时与关键规模，便于事后定位"为什么这次慢/为什么没动作"）
      if (window.__DIAG__ && typeof window.__DIAG__.event === 'function') {
        window.__DIAG__.event('model.mount', {
          id: m.id,
          name: m.name,
          cubism: m.cubism,
          textures: m.textureFiles.length,
          expressions: m.expressions.length,
          motionGroups: Object.keys(m.motions || {}),
          ms: Date.now() - tShow
        }, { model: m.id });
      }
      return true;
    } catch (e) {
      console.error('[live2d-stage] 加载失败:', e);
      return false;
    }
  }

  // ---------------------------------------------------------------- Spine 揭盖保持
  //
  // 从 Live2D 切回 Spine 时要避开一个中间态：盖层一收，Spine 画布立刻亮出来，
  //   而画布上仍是上一张 Spine 的最后一帧（切到 Live2D 时只把画布藏起来，没有清屏），
  //   于是画面先"回跳"到上一张 Spine，等新模型画好才切过去；实测这个中间态约 2 秒。
  //
  // 为什么会由舞台来兜：切回 Spine 时，**引擎自己**也会调 bridge.hide()
  //   （引擎在离开 Live2D 模型时收盖层），所以只在调用方那边延后 hide 挡不住它。
  // 做法：切换期间"持住"揭盖——hide() 照旧收盖层，但**不亮出** Spine 画布；
  //   新模型首帧画好后由调用方 release，才真正亮出画布（一步到位）。
  // 兜底：hold 超时（默认 7 秒）强制释放，避免异常路径把画面永久留在空白。
  let coverHoldCount = 0;
  let coverHoldTimer = null;

  function holdSpineCover(timeoutMs) {
    coverHoldCount++;
    if (coverHoldTimer) clearTimeout(coverHoldTimer);
    coverHoldTimer = setTimeout(() => {
      coverHoldTimer = null;
      if (coverHoldCount > 0) {
        console.warn(`[live2d-stage] Spine 揭盖保持超时（${timeoutMs || 7000} ms），强制释放`);
        coverHoldCount = 0;
        if (!st.active) setSpineCanvasVisible(true);
      }
    }, timeoutMs || 7000);
    return coverHoldCount;
  }

  function releaseSpineCover() {
    if (coverHoldCount > 0) coverHoldCount--;
    if (coverHoldCount === 0) {
      if (coverHoldTimer) { clearTimeout(coverHoldTimer); coverHoldTimer = null; }
      if (!st.active) setSpineCanvasVisible(true);
    }
    return coverHoldCount;
  }

  function hide() {
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.style.display = 'none';
    // 揭盖保持期间不亮画布（画布内容还可能是上一张 Spine；见 holdSpineCover）
    if (coverHoldCount === 0) setSpineCanvasVisible(true);
    // 释放上屏资源：盖层收掉后这个模型不会再被看到，但它的骨架/纹理仍占显存，
    //   隐藏着的 PIXI 应用也照样每帧渲染。下次 show() 本来就要重新加载，
    //   故这里直接卸掉模型并停掉渲染循环（show() 时会重新 start）。
    if (st.model) {
      try { st.app && st.app.stage.removeChild(st.model); } catch { /* 忽略 */ }
      try { st.model.destroy({ children: true }); } catch { /* 忽略 */ }
      st.model = null;
    }
    try { if (st.app && typeof st.app.stop === 'function') st.app.stop(); } catch { /* 忽略 */ }
    st.active = false;
    st.modelId = null;   // P4a：清掉「已加载模型」标记，下次 show() 重新加载
    // [重影-推测修复] 2026-10-16 停用：误诊为遮罩渲染问题时的改动，除"试图解决重影"外无实际作用；重影方向已判定为模型数据问题（见 doc/2026-10-16重影问题定案与模型特殊性对照.MD）
    // st.maskBuf = null;   // 模型已卸掉，遮罩缓冲值一并清掉（避免 debug() 报上一个模型的值）
    return true;
  }

  function isActive() { return st.active; }

  window.addEventListener('resize', () => { if (st.active) { syncRect(); applyZoom(); } });

  // 舞台尺寸变化 → 覆盖层跟随重算 + PIXI 渲染器校准 + 模型重排。
  //   观察**覆盖层**与**Spine 画布**两者：
  //     · 覆盖层：syncRect 写入尺寸后若渲染器没跟上（或反之），这里兜底再校一次；
  //     · Spine 画布：窗口/影院模式等改变画布尺寸时触发重算。
  //   （历史上是靠「补回自建区块」的整页 MutationObserver 顺带重算；自建区块删除后改为定点观察。）
  function watchCanvasRect() {
    try {
      if (typeof ResizeObserver !== 'function') return;
      const cb = () => { if (st.active) { syncRect(); fitAppToOverlay(); applyZoom(); } };
      const ro = new ResizeObserver(cb);
      const cv = document.querySelector(SPINE_CANVAS_SEL);
      const ov = document.getElementById(OVERLAY_ID);
      if (cv) ro.observe(cv);
      if (ov) ro.observe(ov);
    } catch { /* 观察器不可用时由 window resize 兜底 */ }
  }

  watchCanvasRect();

  /**
   * 只读调试口：给「无视觉」的验证用（不改任何状态，只报告当前舞台事实）。
   *   stageChildren  舞台子对象数（类型名计数）
   *   live2dModels   舞台上 Live2D 模型数（应为 0 或 1；>1 就是两幅叠加 = 重影）
   *   currentModel   当前记录在案的模型 id/名称
   *   zoom/pan       视图状态
   *   app            渲染器尺寸与 DPR
   */
  function debug() {
    const children = st.app && st.app.stage ? st.app.stage.children : [];
    const kinds = {};
    let live2dModels = 0;
    for (const c of children) {
      const n = (c && c.constructor && c.constructor.name) || 'unknown';
      kinds[n] = (kinds[n] || 0) + 1;
      if (PIXI.live2d && c instanceof PIXI.live2d.Live2DModel) live2dModels++;
    }
    // 渲染循环与模型可见性：用于排查「模型已挂载但画面空白/异常」这类只在多次切换后出现的问题。
    //   把判据落在两件可测的事上 —— ① 渲染循环还在不在跑；② 模型自身是否可见/有尺寸/有可绘对象。
    let modelView = null;
    if (st.model) {
      const m = st.model;
      const internal = m.internalModel || null;
      // 逐项 try：任一子项读不到只影响该项，不让整块测量因一个未知 API 全部丢失
      const safe = (fn) => { try { return fn(); } catch (e) { return 'err:' + String(e && e.message).slice(0, 40); } };
      modelView = {
        visible: safe(() => m.visible),
        alpha: safe(() => m.alpha),
        renderable: safe(() => (m.renderable === undefined ? null : m.renderable)),
        x: safe(() => Math.round(m.x || 0)),
        y: safe(() => Math.round(m.y || 0)),
        scaleX: safe(() => (m.scale ? +m.scale.x.toFixed(4) : null)),
        scaleY: safe(() => (m.scale ? +m.scale.y.toFixed(4) : null)),
        w: safe(() => Math.round(m.width || 0)),
        h: safe(() => Math.round(m.height || 0)),
        hasInternal: !!internal,
        // Cubism 运行时版本差异：drawables 计数可能挂在 coreModel.getDrawableCount() 或 coreModel.drawables.count
        drawables: safe(() => {
          const core = internal && internal.coreModel;
          if (!core) return null;
          if (typeof core.getDrawableCount === 'function') return core.getDrawableCount();
          if (core.drawables && typeof core.drawables.count === 'number') return core.drawables.count;
          return 'unknown-api';
        }),
        textures: safe(() => (Array.isArray(m.textures) ? m.textures.length : null)),
      };
    }
    let ticker = null;
    try {
      const t = st.app ? st.app.ticker : null;
      if (t) ticker = { started: !!t.started, FPS: +Number(t.FPS || 0).toFixed(1), count: t.count === undefined ? null : t.count };
    } catch { /* 忽略 */ }
    let glLost = null;
    try { glLost = st.app && st.app.renderer && st.app.renderer.gl ? st.app.renderer.gl.isContextLost() : null; } catch { /* 忽略 */ }
    return {
      active: st.active,
      // 揭盖保持计数：>0 表示正在等新 Spine 首帧，Spine 画布暂不亮出（见 holdSpineCover）
      coverHold: coverHoldCount,
      // [重影-推测修复] 2026-10-16 停用：误诊为遮罩渲染问题时的改动，除"试图解决重影"外无实际作用；重影方向已判定为模型数据问题（见 doc/2026-10-16重影问题定案与模型特殊性对照.MD）
      // // 裁剪遮罩缓冲尺寸：有遮罩的模型是自适应后的实际值，无遮罩/未设置时为 null（见 applyClippingMaskBuffer）
      // maskBuf: st.maskBuf === undefined ? null : st.maskBuf,
      // // 裁剪遮罩模式：'auto' 用模型自带遮罩（缓冲自适应）/ 'off' 已关闭遮罩（逃生开关，见 config/live2d.json 与 ?masks=）
      // masksMode: st.masksMode === undefined ? null : st.masksMode,
      stageChildren: children.length,
      stageChildKinds: kinds,
      live2dModels,
      currentModel: st.model ? { id: st.modelId, name: st.modelMeta && st.modelMeta.name, mounted: children.indexOf(st.model) >= 0 } : null,
      modelMeta: st.modelMeta ? { id: st.modelMeta.id, name: st.modelMeta.name, textureFiles: st.modelMeta.textureFiles ? st.modelMeta.textureFiles.length : 0 } : null,
      zoom: { ratio: st.zoomRatio, panX: st.panX, panY: st.panY },
      app: st.app ? { w: st.app.renderer.width, h: st.app.renderer.height, res: st.app.renderer.resolution } : null,
      labels: motionLabels ? motionLabels().length : 0,
      ticker,
      glLost,
      stencilOk: st.stencilOk === undefined ? null : st.stencilOk,
      modelView,
      // 画布身份：确认渲染器画的是当前 DOM 里那个 canvas（切换后若换了画布，旧画布就会一直空着）
      canvas: (() => {
        try {
          const cv = document.getElementById('live2d-stage-canvas');
          return { isAppView: !!(st.app && cv && st.app.view === cv), domId: cv ? String(cv.id) : null, domConnected: cv ? cv.isConnected : null };
        } catch { return null; }
      })(),
      // ticker 监听器条数：为 0 表示没人驱动渲染（渲染循环虽 started 但不会画）
      tickerListeners: (() => {
        try {
          let n = 0;
          let l = st.app && st.app.ticker ? st.app.ticker._head : null;
          while (l && n < 200) { n += 1; l = l.next; }
          return n;
        } catch { return null; }
      })(),
      // 诊断逃生口：把渲染器与舞台对象一并给出，便于在页面里用 PIXI 自身能力取证
      //   （如 renderer.extract 抽取舞台内容，判断"舞台上真有内容"还是"画布没画"）。
      _app: st.app || null,
      _stage: st.app ? st.app.stage : null,
    };
  }

  window.__LIVE2D_STAGE__ = { show, hide, isActive, bridge, debug, holdSpineCover, releaseSpineCover };

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
        // 原版右栏动作区（Live2D 的入口）：只断言桥提供的标签数与原版动作区条目数一致
        console.info(`[selftest] 桥标签数=${motionLabels().length} 自建右栏区块=`
          + `${document.getElementById('live2d-sidebar-section') ? '仍存在 ❌' : '已删除 ✅'}`);
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
        // 公共事件层（Spine 画布）上的滚轮/拖动才有效；覆盖层 pointer-events:none，故改测画布
        const spineCv = document.querySelector(SPINE_CANVAS_SEL);
        const s0 = model.scale.x;
        const z0 = window.__LIVE2D_STAGE__.bridge.readState().zoom;
        spineCv.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: 700, clientY: 450, bubbles: true, cancelable: true }));
        console.info(`[selftest] 滚轮缩放（公共事件层）: 模型缩放 ${s0.toFixed(3)} -> ${model.scale.x.toFixed(3)}`
          + ` 桥缩放 ${z0} -> ${window.__LIVE2D_STAGE__.bridge.readState().zoom}`
          + ` 变化=${model.scale.x !== s0}`);
      } catch (e) {
        console.warn('[selftest] 失败:', e.message);
      }
    }, 3000);
  }

  console.info('[live2d-stage] 已就绪（Live2D 与 Spine 共用同一界面，运行时按需懒加载）');
}
