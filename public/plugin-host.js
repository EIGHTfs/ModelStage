// ============================================================================
// plugin-host.js —— 展示类型插件的宿主（本项目自有补丁脚本，不属于 dist 产物）
//
// 目标：**往项目根 plugins/ 放 js，网页就获得读/渲染这种文件的能力**。
//   本文件负责：① 问服务端要插件清单（GET /api/plugins）
//              ② 按清单顺序动态注入 <script>（/plugins/<相对路径>）
//              ③ 暴露 window.SpineViewerPlugins（register/list/host）给插件用
//
// 三条纪律（决定这套机制是否"可插拔"）：
//   ① 失败隔离：任何插件加载失败/抛错都不得影响页面与其它插件 → 每个 script 独立 onerror，
//      并用 window 的 error 事件只给「来源属于 /plugins/ 的错误」打归属日志。
//   ② 插件只能通过 host 触碰页面（拿 store/stage、读资源根文件、登记模型、发提示），
//      不允许直接改 dist 核心产物 —— 宿主是白名单闸门。
//   ③ 能力可增删：清单来自服务端实时扫描，删掉 plugins/<id>/ 后刷新页面即消失。
//
// 加载顺序：本文件在 server.mjs 注入的 5 个补丁脚本之后加载（见 server.mjs 的 SCRIPT_TAGS），
//   这样插件注册时 store/stage 已经存在；注入的插件脚本默认按清单顺序串行加载。
// ============================================================================

'use strict';

{
  // 插件注册表：id -> 插件对象。重复 id 拒绝并告警（避免两个插件抢同一个文件类型）。
  const registry = new Map();
  // 插件产出并登记的模型（M6 之前用于自检与后续渲染接线；宿主不擅自塞进 store）。
  const hostModels = [];
  // 每个插件的加载状态：id -> { loaded:boolean, error:string|null }
  const loadState = new Map();
  // 服务端扫到的插件清单（含清单文件里的 label/assets，供注册时兜底与调试查看）
  const discovered = [];
  // 「插件发现+注入」完成的信号：页面其它部分（如角色库要按插件声明的标签显示）
  //   需要等它，否则会先按"没有插件"的兜底渲染一次（实测踩过：标签短暂显示成兜底值）。
  let resolveReady;
  const readyPromise = new Promise((r) => { resolveReady = r; });

  const log = (kind, msg) => {
    const line = `[plugin-host] ${msg}`;
    if (kind === 'error') console.error(line); else if (kind === 'warn') console.warn(line); else console.info(line);
  };

  /**
   * 宿主能力：插件触碰页面的唯一入口（白名单）。
   * 所有取值都是**惰性**的 —— 插件可能在 store/stage 就绪之前注册，调用时再取。
   */
  const host = {
    /** 现有 zustand store（server.mjs 注入的 window.__SPINE_STORE__；未就绪返回 null） */
    getStore() { return window.__SPINE_STORE__ || null; },
    /** Live2D 舞台（public/live2d-stage.js 暴露；未就绪返回 null） */
    getStage() { return window.__LIVE2D_STAGE__ || null; },

    /**
     * 读资源根里的文件字节。
     * @param {string} rootId 资源根 id（config/resources.json 的 id）
     * @param {string} rel 相对该根的路径（POSIX 分隔）
     * @returns {Promise<{bytes:ArrayBuffer,size:number,url:string}>}
     */
    async fetchFile(rootId, rel) {
      const url = `/api/file?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(rel)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`读文件失败 HTTP ${r.status}: ${rel}`);
      const bytes = await r.arrayBuffer();
      return { bytes, size: bytes.byteLength, url };
    },

    /**
     * 提示通道：控制台 + 自定义事件（页面其它部分可监听 'spineviewer:notify'）。
     * 插件不直接操作 DOM 提示元素，避免与现有 UI 抢口径。
     */
    notify(kind, msg) {
      log(kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'info', msg);
      try {
        window.dispatchEvent(new CustomEvent('spineviewer:notify', { detail: { kind, msg } }));
      } catch { /* 忽略 */ }
    },

    /**
     * 把插件产出的模型登记进宿主列表（供后续渲染接线/自检读取）。
     * 登记是**纯记录**：不自动改 store、不自动切换当前模型 —— 插件若需要，通过 getStore() 自己做。
     * @param {object} model 至少含 { id, name, kind }；其余字段（url/motions/…）由插件自定义
     */
    registerModel(model) {
      if (!model || !model.id) { log('warn', 'registerModel 收到无效模型（缺 id），已忽略'); return null; }
      const rec = Object.assign({}, model, { registeredAt: Date.now() });
      hostModels.push(rec);
      log('info', `已登记模型 ${rec.id}（来源插件产出，kind=${rec.kind || '(未标注)'}）`);
      return rec;
    },
  };

  const api = {
    version: 1,

    /**
     * 插件注册（每个插件文件末尾调用一次）。
     * @param {object} plugin { id, name, version, fileKinds?, probe?, open? }
     * @returns {boolean} 是否注册成功
     */
    register(plugin) {
      if (!plugin || typeof plugin !== 'object') { log('warn', 'register 收到非对象，已忽略'); return false; }
      const id = String(plugin.id || '').trim();
      if (!id) { log('warn', 'register 缺少 id，已忽略'); return false; }
      if (registry.has(id)) {
        log('warn', `插件 id 重复，拒绝注册：${id}（已存在：${registry.get(id).name || id}）`);
        return false;
      }
      if (typeof plugin.probe !== 'function' && typeof plugin.open !== 'function') {
        log('warn', `插件 ${id} 既没有 probe 也没有 open，拒绝注册`);
        return false;
      }
      const rec = Object.assign({}, plugin, { id });
      // label 优先用插件 register 声明的；没声明时退回它清单文件里的 label
      if (!rec.label) {
        const fromManifest = discovered.find((d) => d.id === id);
        if (fromManifest && fromManifest.label) rec.label = fromManifest.label;
      }
      registry.set(id, rec);
      const st = loadState.get(id);
      if (st) st.loaded = true;
      log('info', `已注册插件 ${id}（${rec.name || id}）v${rec.version || '?'}`
        + ` 可读种类=${Array.isArray(rec.fileKinds) ? rec.fileKinds.join('/') || '(未声明)' : '(未声明)'}`);
      try { window.dispatchEvent(new CustomEvent('spineviewer:plugin-registered', { detail: { id } })); } catch { /* 忽略 */ }
      return true;
    },

    /** 已注册插件列表（调试/自检用）。 */
    list() {
      return [...registry.values()].map((p) => ({
        id: p.id,
        name: p.name || p.id,
        label: p.label || null,
        version: p.version || null,
        fileKinds: Array.isArray(p.fileKinds) ? p.fileKinds.slice() : [],
        hasProbe: typeof p.probe === 'function',
        hasOpen: typeof p.open === 'function',
      }));
    },

    /**
     * 取某个文件种类在角色库里的**变体标签文字**（由插件在 register 时声明）。
     * 角色库用它显示标签，配色仍由角色库按类型统一决定（插件不自创配色）。
     * @param {string} fileKind 如 'bundle'
     * @param {string} [fallback] 没有任何插件声明该种类时的兜底文字
     */
    labelFor(fileKind, fallback) {
      for (const p of registry.values()) {
        if (p.label && Array.isArray(p.fileKinds) && p.fileKinds.includes(fileKind)) return p.label;
      }
      return fallback || null;
    },

    /** 按文件种类找可读该种类的插件（返回置信度最高的那个；没有则 null） */
    pickFor(fileKind) {
      let best = null;
      for (const p of registry.values()) {
        if (!Array.isArray(p.fileKinds) || !p.fileKinds.includes(fileKind)) continue;
        if (typeof p.open !== 'function') continue;
        if (!best || (p.probe && !best.probe)) best = p;
      }
      return best;
    },

    /** 已发现的插件清单（原始记录，含 label/assets） */
    discovered() { return discovered.map((p) => Object.assign({}, p)); },

    /**
     * 等「插件发现 + 注入」结束（无论成功失败都会 resolve，绝不reject）。
     * 用途：需要按插件声明来渲染的地方（角色库标签等）先 await 它，避免先按兜底值渲染。
     * @param {{timeoutMs?:number}} [opts] 超时上限，默认 3000ms
     */
    ready(opts) {
      const ms = (opts && opts.timeoutMs) || 3000;
      return Promise.race([
        readyPromise,
        new Promise((r) => setTimeout(() => r('timeout'), ms)),
      ]);
    },

    /** 宿主登记的模型（插件产出）。 */
    models() { return hostModels.slice(); },

    /** 插件加载状态（含失败原因，便于定位"某个插件为什么没生效"）。 */
    loadReport() {
      return [...loadState.entries()].map(([id, s]) => ({ id, loaded: s.loaded, error: s.error }));
    },

    host,
  };

  window.SpineViewerPlugins = api;

  // 只给「来源属于 /plugins/ 的错误」打归属日志：
  //   不拦截、不吞掉任何异常（尊重页面既有错误处理），只是让插件错误能被一眼认出。
  window.addEventListener('error', (e) => {
    const src = String(e && e.filename || '');
    if (src.includes('/plugins/')) {
      log('error', `插件脚本运行出错: ${src.split('/plugins/')[1] || src} :: ${e.message || '(无消息)'}`);
    }
  }, true);

  /** 注入一个 <script> 并等待其加载结束（成功/失败都 resolve，失败写 loadState）。 */
  function injectScript(src) {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = () => resolve(true);
      s.onerror = () => { log('error', `插件脚本加载失败: ${src}`); resolve(false); };
      document.head.appendChild(s);
    });
  }

  /** 按服务端清单串行注入所有插件的 js（串行是为了让清单里的顺序真正生效）。 */
  async function loadPlugins() {
    try {
      await loadPluginsInner();
    } finally {
      // 无论如何都放行「就绪」信号：插件加载失败不应让等待者一直悬着
      if (resolveReady) { resolveReady('done'); resolveReady = null; }
    }
  }

  async function loadPluginsInner() {
    let data = null;
    try {
      const r = await fetch('/api/plugins', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = await r.json();
    } catch (e) {
      log('warn', `插件清单获取失败（页面其余功能不受影响）: ${e.message}`);
      return;
    }
    const plugins = (data && data.plugins) || [];
    discovered.length = 0;
    for (const pl of plugins) discovered.push(pl);
    if (!plugins.length) {
      log('info', 'plugins/ 下没有插件（放 js 进该目录即可获得对应能力）');
      return;
    }
    log('info', `发现 ${plugins.length} 个插件: ${plugins.map((x) => x.id).join(', ')}`);
    for (const pl of plugins) {
      const t0 = Date.now();
      loadState.set(pl.id, { loaded: false, error: null });
      for (const f of (pl.files || [])) {
        const ok = await injectScript(`/plugins/${f}`);
        if (!ok) {
          const st = loadState.get(pl.id);
          if (st) st.error = `脚本加载失败: ${f}`;
        }
      }
      const st = loadState.get(pl.id);
      if (st && !st.loaded && !st.error) st.error = '脚本已加载但没有调用 register()';
      if (st && st.error) log('warn', `插件 ${pl.id} 未生效：${st.error}`);
      // 诊断事件：插件装载结果（id / 脚本数 / 成败 / 耗时 / 装载后的注册表快照）
      //   走 __DIAG__ 统一出口：出问题时 AI 可直接读 data/diag.jsonl，不必依赖浏览器会话。
      if (window.__DIAG__ && typeof window.__DIAG__.event === 'function') {
        window.__DIAG__.event('plugin.load', {
          id: pl.id,
          files: (pl.files || []).length,
          ok: !(st && st.error),
          error: (st && st.error) || null,
          ms: Date.now() - t0,
          registered: (typeof api.loadReport === 'function' ? api.loadReport() : [])
        }, { level: (st && st.error) ? 'warn' : 'info', plugin: pl.id });
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { loadPlugins().catch((e) => log('error', `插件加载流程异常: ${e.message}`)); });
  } else {
    loadPlugins().catch((e) => log('error', `插件加载流程异常: ${e.message}`));
  }
}
