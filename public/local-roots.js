/*!
 * local-roots.js —— 本地资源根自动加载（spine-multi-viewer 自有代码）
 *
 * 作用：页面启动后自动从服务端读取「本地设备文件夹」配置，构造模型列表并注入
 *      原版 的模型库，免去每次手动导入；并支持在界面上浏览本机目录添加新资源根。
 *
 * 为什么需要本脚本：
 *   原版 原是纯浏览器工具（File System Access API 手动选文件夹，模型进内存、
 *   刷新即丢）。本机/NAS 上的资源浏览器选不到，必须由服务端代理（/api/tree、/api/file），
 *   再由本脚本把服务端元数据转成 原版 能识别的模型对象。
 *
 * 性能设计（关键）：
 *   只拉取**目录元数据**构造模型对象，不下载 .skel/.atlas/.png 文件内容；
 *   文件内容在用户点击具体模型时，由 原版 通过 url 按需下载。
 *   因此加载 231 个角色（425 套资源）的启动成本仅是若干次轻量目录列举。
 *
 * 依赖：window.__SPINE_STORE__（由 server.mjs 在返回 index.html 时注入，
 *       暴露 原版 内部 zustand store；file:// 直接打开产物时不存在，本脚本会自动跳过）
 */

{
  'use strict';

  // ---------------------------------------------------------------- 工具
  const $ = (sel) => document.querySelector(sel);

  function api(path, opts) {
    return fetch(path, opts || {}).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
  }

  /** 等待 原版实现的 store 出现（React 挂载后才注入）。 */
  function waitStore(timeoutMs) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      (function poll() {
        const s = window.__SPINE_STORE__;
        if (s && typeof s.getState === 'function') return resolve(s);
        if (Date.now() - started > (timeoutMs || 15000)) {
          return reject(new Error('未找到 __SPINE_STORE__（可能以 file:// 直接打开，或服务未注入）'));
        }
        setTimeout(poll, 120);
      })();
    });
  }

  /** 模型文件的 URL（按需下载，不预取内容）。 */
  function fileUrl(rootId, relPath) {
    return `/api/file?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(relPath)}`;
  }

  const MIME_BY_EXT = {
    '.skel': 'application/octet-stream',
    '.atlas': 'text/plain',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.json': 'application/json',
  };

  /**
   * 从某个角色目录里的文件清单构造一个 原版 模型对象。
   * 结构对齐 原版 自带的 demo 模型（SpineBoy），只是把 url 指向我们的 /api/file。
   *
   * @param {string} rootId   资源根 id
   * @param {string} rootName 资源根显示名（归一 key）
   * @param {string} charDir  角色目录相对路径（如 "000101" 或 "000101/cutscene"）
   * @param {Array}  files    /api/tree 返回的文件清单
   */
  /* ---------------------------------------------------------------------------
   * 已停用（保留原实现备查）：模型对象构造已移到服务端。
   *
   * 停用原因：原实现由前端递归调用 /api/tree 数百次来拼模型列表，刷新一次耗时数十秒。
   *   现改由服务端用 fs 直接遍历并把结果落盘为清单（config/models.<rootId>.json），
   *   前端只需 1 次 /api/models 请求即可拿到全部模型（命中清单时约 0.03s）。
   *   服务端对应实现见 server.mjs 的 buildModelServer / scanRootServer / getModels。
   * 保留此段以便回退对照（两者构造出的模型对象结构必须保持一致）。
   *
  function buildModel(rootId, rootName, charDir, files) {
    const byExt = (ext) => files.find((f) => f.ext === ext);
    const base = charDir.split('/').pop();

    const skel = byExt('.skel') || byExt('.json');
    const atlas = byExt('.atlas');
    if (!skel || !atlas) return null; // 缺骨架或图集，不构成可加载模型

    const textures = files.filter((f) => ['.png', '.jpg', '.jpeg', '.webp'].includes(f.ext));
    const format = skel.ext === '.json' ? 'json' : 'binary';

    const mk = (f) => ({
      name: f.name,
      path: `${charDir}/${f.name}`,
      size: f.size,
      type: MIME_BY_EXT[f.ext] || 'application/octet-stream',
      url: fileUrl(rootId, `${charDir}/${f.name}`),
    });

    // 归一 key：来自 atlas 内容首行的贴图名（服务端探测，去扩展名 + 已小写）。
    const assetKey = atlas.assetKey || base;
    const dirPath = `${rootId}/${assetKey}`;
    const directory = `${rootName}/${assetKey}`;

    return {
      id: `local-${rootId}-${charDir.replace(/\//g, '_')}`,
      name: assetKey,
      directory,
      dirPath,
      version: skel.spineVersion || '',
      format,
      skeletonFile: mk(skel),
      atlasFile: mk(atlas),
      textureFiles: textures.map(mk),
      textureCount: textures.length,
      fileSize: skel.size + atlas.size + textures.reduce((s, t) => s + t.size, 0),
      atlasPma: false,
      animations: [],
      skins: [],
      boneCount: 0,
      slotCount: 0,
      importedAt: Date.now(),
      source: 'user',
      localRoot: true,
    };
  }
   * --------------------------------------------------------------------------- */

  /**
   * 遍历一个资源根下的所有角色目录，构造模型列表。
   * 角色目录内若含 cutscene/ 子目录（技能动画），一并作为该角色的另一个 variant 收集。
   */
  /**
   * 取一个资源根下的模型列表。
   *
   * 改由服务端提供：服务端用 fs 直接遍历并把结果落盘为清单（config/models.<rootId>.json），
   * 前端这里只需 1 次请求即可拿到全部模型。
   *   旧做法：前端递归调用 /api/tree 数百次（BD2 231 + Mod 158），刷新耗时数十秒。
   *   新做法：1 次 /api/models，且服务端有清单缓存，刷新几乎瞬时。
   */
  async function collectRoot(root) {
    const r = await api(`/api/models?root=${encodeURIComponent(root.id)}`);
    console.info(`[local-roots] ${root.name}: ${r.count} 个模型${r.cached ? '（来自服务端清单缓存）' : '（首次扫描）'}`);
    return r.models || [];
  }

  // ---------------------------------------------------------------- 隐藏「模型导入模式」UI
  //
  // 需求：本项目只追加、不覆盖，界面上不该再让用户看到/选择「替换」。
  //   （此前只在代码里强制 loadMode=append，把这个选择 UI 漏掉了。）
  // 思路：该区块是 React 渲染的通用容器（div.space-y-1.5 > span.text-xs + 两个按钮），
  //   既没有可用的类名特征，CSS 也无法按文本匹配，因此按**文本**定位 span 再隐藏其父块。
  //   区块只在右栏设置面板打开时才渲染，故用 MutationObserver 保证它出现后被隐藏
  //   （rAF 节流，避免频繁回调影响性能）。
  function hideImportModeUI() {
    let pending = false;
    const hide = () => {
      for (const span of document.querySelectorAll('span.text-xs')) {
        if ((span.textContent || '').trim() !== '模型导入模式') continue;
        const box = span.parentElement;
        if (box && box.style.display !== 'none') {
          box.style.display = 'none';
          console.info('[local-roots] 已隐藏「模型导入模式」选择（本项目只追加、不覆盖）');
        }
      }
    };
    const schedule = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; hide(); });
    };
    schedule();
    try {
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    } catch { /* 观察器不可用时至少隐藏一次已渲染的 */ }
  }

  // 读「本次要恢复的模型 id」= 最后活跃那个游戏的上次模型。
  //   与 char-tree.js 共用同一个 localStorage 键与结构（每个游戏各存一个默认值）。
  const LS_KEY = 'spine-multi-viewer.tree-state.v1';
  function readSavedTargetId() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (s.lastByGame && s.activeGame && s.lastByGame[s.activeGame]) return s.lastByGame[s.activeGame];
      if (s.lastByGame) {
        const v = Object.values(s.lastByGame).filter(Boolean);
        if (v.length) return v[0];
      }
      return typeof s.lastModelId === 'string' ? s.lastModelId : null;   // 旧格式兼容
    } catch { return null; }
  }

  // 若存档里是 Live2D 模型，先把 Spine 画布藏起来。
  //
  // 需求：刷新时「上次看的」要直接呈现，不能先闪一下默认模型。
  // 为什么这里也要管：原版 注入模型时会把**本批第一个 Spine 模型**设为当前模型并立即加载
  //   （即名为「默认」的那一项），而 Live2D 的恢复要等 char-tree 拉完 Live2D 列表才做——
  //   两者并发，本脚本的注入通常先完成，中间这段就会先渲染出那个默认。
  //   提前把画布设为不可见即可让它不可见；char-tree 若恢复失败会调 stage.hide() 把画布恢复。
  function hideSpineCanvasIfSavedIsLive2D() {
    try {
      const id = readSavedTargetId() || '';
      if (!id.startsWith('live2d-')) return false;
      const cv = document.querySelector('canvas.absolute.inset-0');
      if (cv) cv.style.visibility = 'hidden';
      console.info('[local-roots] 存档为 Live2D，已先隐藏 Spine 画布（避免先渲染出默认模型）');
      return true;
    } catch { return false; }
  }

  // ---------------------------------------------------------------- 主流程
  async function main() {
    let store;
    try {
      store = await waitStore();
    } catch (e) {
      console.warn('[local-roots] 跳过自动加载:', e.message);
      return;
    }

    let rootsData;
    try {
      rootsData = await api('/api/roots');
    } catch (e) {
      console.warn('[local-roots] 读取资源根失败:', e.message);
      return;
    }

    const roots = (rootsData.roots || []).filter((r) => r.exists);
    if (!roots.length) {
      console.info('[local-roots] 未配置可用资源根');
      return;
    }

    console.info(`[local-roots] 开始加载 ${roots.length} 个资源根:`, roots.map((r) => r.name).join(', '));

    const all = [];
    for (const r of roots) {
      try {
        const models = await collectRoot(r);
        console.info(`[local-roots] ${r.name}: ${models.length} 个模型`);
        all.push(...models);
      } catch (e) {
        console.warn(`[local-roots] 资源根 ${r.name} 加载失败:`, e.message);
      }
    }

    if (!all.length) {
      console.warn('[local-roots] 未收集到任何模型');
      return;
    }

    // 注入 原版 模型库（追加模式，不清空用户已有的手动导入）
    const st = store.getState();
    if (typeof st.addModels !== 'function') {
      console.error('[local-roots] store 缺少 addModels');
      return;
    }
    // 只追加、不覆盖。
    //
    // 背景：原版实现的 addModels 会从 store 读 loadMode：
    //   const { models, loadMode } = getState();
    //   loadMode === "replace" && 新模型含 source==="user" && 清空已有模型
    // 而本项目注入的模型 source 正是 "user"，一旦 loadMode 为 replace 就会清空用户已加载的模型。
    // 原实现只在「恰好为 replace」时才临时改为 append；现在**无条件**设为 append，
    // 以保证任何来源（持久化设置、原版 自带 UI、其它脚本）都无法把它切回覆盖语义。
    if (typeof st.setLoadMode === 'function') {
      st.setLoadMode('append');
    }

    // 刷新时「上次看的模型」优先于「默认（本批第一个）」。
    //
    // 背景：addModels 在「追加模式且当前无选中模型」时会把**本批第一个模型**设为当前模型
    //   （currentModelId: loadMode==="replace" && y ? y.id : (t().currentModelId ?? y?.id ?? null)），
    //   响应它的 effect 会立即加载——于是刷新时先加载了「默认」再被 char-tree 切回「上次」，
    //   用户能看到一次多余的切换。
    // 做法：把上次选中的模型**排到本批最前**，让 addModels 直接选中它，
    //   这样只加载一次、不会先出默认。
    // 注意：存档里若记录的是 Live2D 模型，它不在本批（Live2D 不走 原版 模型库），
    //   此处 findIndex 找不到即不动；Live2D 的恢复由 char-tree.js 尽早执行。
    try {
      const savedId = readSavedTargetId();
      if (savedId) {
        const i = all.findIndex((m) => m.id === savedId);
        if (i > 0) {
          const [m] = all.splice(i, 1);
          all.unshift(m);
          console.info(`[local-roots] 已把上次选中的模型排到最前，刷新不再先加载默认: ${m.name}`);
        }
      }
    } catch { /* 存档读不到就用默认顺序 */ }

    // 关键（解决「刷新时先报 atlas 文件为空或无法读取」）：
    //   addModels 会把本批第一个设为当前模型，而响应它的 effect 会**立即加载**，
    //   且只对 source==="demo" 补内容（用户模型不补）——于是 content 尚空 → 报
    //   「atlas 文件为空或无法读取」。因此在 addModels **之前**先把首个模型的内容填好。
    hideSpineCanvasIfSavedIsLive2D();

    console.info('[local-roots] 预加载首个模型内容（避免自动选中时报错）…');
    try {
      await ensureContent(all[0]);
      console.info('[local-roots] 首个模型内容就绪:', all[0].name);
    } catch (e) {
      console.warn('[local-roots] 首个模型预加载失败（不影响其余模型）:', e.message);
    }

    st.addModels(all);
    console.info(`[local-roots] 已注入 ${all.length} 个模型`);

    // 启用懒加载拦截：列表只有元数据，点击具体模型时才下载内容
    setupLazyLoading(store);

    // 安全网：若自动选中的当前模型不是本批首个（例如已有旧选中），
    // 且其内容尚未就绪，则补内容后重新触发一次加载。
    const cur = store.getState().currentModel;
    if (cur && cur.localRoot && !(cur.atlasFile && cur.atlasFile.content)) {
      ensureContent(cur)
        .then(() => {
          // 先置空再设回，令响应 currentModel 的 effect 重新执行（此时内容已就绪）
          store.getState().setCurrentModel(null);
          store.getState().setCurrentModel(cur.id);
          console.info('[local-roots] 已补内容并重新触发加载:', cur.name);
        })
        .catch((e) => console.warn('[local-roots] 当前模型补内容失败:', e.message));
    }

    // 自检钩子（默认不触发）：访问 ?selftest=1 时自动点击第一个模型，
    // 便于验证「点击 -> 按需下载 -> 加载」整条链路是否可用，无需人工点。
    if (new URLSearchParams(location.search).get('selftest') === '1') {
      setTimeout(() => {
        const first = document.querySelector('[data-mid]');
        if (!first) { console.warn('[local-roots][selftest] 未找到模型项'); return; }
        console.info('[local-roots][selftest] 自动点击:', first.getAttribute('data-mid'));
        first.click();
      }, 500);
    }
  }

  /**
   * 按需下载并填充模型文件内容（懒加载）。
   *
   * 为什么必须填 content（关键，踩过坑）：
   *   原版 读取模型靠的是**对象的 content 字段**，不是 url——
   *   `Io(f)` 取 atlas：f.content 是 string/ArrayBuffer 才有效，否则返回 "" 并抛
   *   "atlas 文件为空或无法读取"；`Od(f)` 取骨架同理；贴图加载只认 ArrayBuffer 或
   *   data:/http 开头的 string。
   *   因此仅给 url 不够，必须把文件内容真正填进 content。
   *
   * 类型对照（对齐 原版 自带 demo 加载器的写法）：
   *   atlas      -> string
   *   skel(json) -> string
   *   skel(二进制) -> ArrayBuffer   ← BD2 的 .skel 是二进制，必须是 ArrayBuffer
   *   png        -> ArrayBuffer
   *
   * @param {object} model 模型对象（store 内的引用，直接改属性即可）
   */
  async function ensureContent(model) {
    if (model.skeletonFile && model.skeletonFile.content
      && model.atlasFile && model.atlasFile.content) return true;

    const fetchOne = async (f, as) => {
      const r = await fetch(f.url);
      if (!r.ok) throw new Error(`${f.name} 下载失败: HTTP ${r.status}`);
      return as === 'text' ? r.text() : r.arrayBuffer();
    };

    // 并行下载三件套（骨架 / 图集 / 所有贴图）
    const jobs = [];
    jobs.push(fetchOne(model.skeletonFile, model.format === 'json' ? 'text' : 'buffer')
      .then((c) => { model.skeletonFile.content = c; model.skeletonFile.size = c.byteLength || c.length; }));
    jobs.push(fetchOne(model.atlasFile, 'text')
      .then((c) => { model.atlasFile.content = c; model.atlasFile.size = c.length; }));
    (model.textureFiles || []).forEach((tf) => {
      jobs.push(fetchOne(tf, 'buffer').then((c) => {
        tf.content = c;
        tf.size = c.byteLength;
      }));
    });

    await Promise.all(jobs);
    model.fileSize = model.skeletonFile.size + model.atlasFile.size
      + (model.textureFiles || []).reduce((s, t) => s + (t.size || 0), 0);

    // 自检证据：打印填充结果（确认 content 真的被下载并填入，而非仅"没报错"）
    console.info(
      `[local-roots] 内容已填充 ${model.name}: `
      + `skel=${model.skeletonFile.size}B(${(model.skeletonFile.content instanceof ArrayBuffer) ? 'ArrayBuffer' : typeof model.skeletonFile.content}), `
      + `atlas=${model.atlasFile.size}B(${typeof model.atlasFile.content}), `
      + `贴图=${(model.textureFiles || []).length} 张`
    );
    return true;
  }

  /** 正在补内容的模型 id 集合（防重复触发 / 防无限循环）。 */
  const loading = new Set();

  /**
   * 懒加载拦截：点击模型时若 content 为空，先下载填充再放行。
   *
   * 必须在**捕获阶段**监听——原版 的选中由 React 事件驱动，
   * 捕获阶段早于目标阶段，可先阻止默认行为，异步补完内容后重新触发点击。
   * 这样列表仍只持有元数据（启动快），真正做到"点哪个才下载哪个"。
   */
  function setupLazyLoading(store) {
    document.addEventListener('click', (e) => {
      const el = e.target && e.target.closest ? e.target.closest('[data-mid]') : null;
      if (!el) return;

      const mid = el.getAttribute('data-mid');
      if (!mid || loading.has(mid)) return;

      const model = (store.getState().models || []).find((m) => m.id === mid);
      if (!model || !model.localRoot) return;   // 非本脚本注入的模型，放行
      if (model.skeletonFile && model.skeletonFile.content
        && model.atlasFile && model.atlasFile.content) return; // 已填充，放行

      // 内容未就绪 -> 阻止本次点击，下载完成后重新触发
      e.preventDefault();
      e.stopPropagation();
      loading.add(mid);

      const oldText = el.textContent;
      el.textContent = '加载中…';

      ensureContent(model)
        .then(() => {
          loading.delete(mid);
          el.textContent = oldText;
          // 重新触发点击（此时 content 已就绪，会被放行）
          el.click();
        })
        .catch((err) => {
          loading.delete(mid);
          el.textContent = oldText;
          console.error('[local-roots] 内容加载失败:', err.message);
          alert('模型内容加载失败：' + err.message);
        });
    }, true); // 捕获阶段
  }

  // 暴露给 roots-ui.js：添加资源根后调用本函数重新加载模型库。
  // 重复调用安全——addModels 按 (name+fileSize+dirPath) 去重，已存在的模型会被跳过。
  window.__LOCAL_ROOTS__ = { reload: main };

  // 隐藏「模型导入模式」选择：与 main() 无关，即使模型加载提前返回也要生效
  hideImportModeUI();

  // 自检（默认不触发）：?selftest=importmode
  //   打开右栏设置面板（该区块在其中），确认「模型导入模式」已被隐藏。
  if (new URLSearchParams(location.search).get('selftest') === 'importmode') {
    setTimeout(() => {
      const menuBtn = [...document.querySelectorAll('button')].find((b) => b.title === '菜单');
      console.info(`[selftest] 导入模式: 顶部「菜单」按钮=${!!menuBtn}`);
      if (menuBtn) menuBtn.click();
      setTimeout(() => {
        const span = [...document.querySelectorAll('span.text-xs')]
          .find((s) => (s.textContent || '').trim() === '模型导入模式');
        const box = span ? span.parentElement : null;
        console.info(`[selftest] 导入模式: 区块存在=${!!box}`
          + ` 已隐藏=${box ? box.style.display === 'none' : 'N/A'}`);
      }, 1500);
    }, 3500);
  }

  // 等 DOM 就绪再跑，避免与 React 首屏竞争
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { main().catch((e) => console.error('[local-roots]', e)); });
  } else {
    main().catch((e) => console.error('[local-roots]', e));
  }
}
