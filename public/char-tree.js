/*!
 * char-tree.js —— 左栏「同角色二级展开」树面板（spine-multi-viewer 自有代码）
 *
 * 需求（用户 2026-10-02）：
 *   「前端归一，显示在一起，前端左侧边栏动态加宽，同一角色二级展开」
 *
 * 做什么：
 *   把同一角色的多个变体（立绘 / 技能 / 技能2 / 各 Mod 版本）在**显示层**归到一个角色条目下，
 *   角色为一级、变体为二级（点击展开）；左栏宽度按内容动态调整。
 *
 * 为什么是「显示层归一」而不是合并数据：
 *   各变体仍是独立模型（各自有自己的骨架/图集/贴图），不做数据合并；
 *   后端只如实返回原始模型数据，**分组完全在前端渲染时计算**（见下方 charKeyOf）。
 *   角色 key 规则：去掉 cutscene_ 前缀与 _N 形态后缀
 *     例：char000206 / cutscene_char000206 / cutscene_char000206_2  -> 均归入 char000206
 *
 * 为什么用独立浮层（挂 body）而不是插进 React 的侧栏 DOM：
 *   侧栏由 React 管理，直接插入的节点会在重渲染时被移除。
 *   浮层挂在 body 上并定位到侧栏的几何位置，React 无法影响它。
 *   原列表仅用 CSS 隐藏（仍在 DOM 中），点击变体时复用它的 [data-mid] 元素触发加载，
 *   从而走通「已验证的加载路径」（含 local-roots.js 的懒加载拦截）。
 */

(function () {
  'use strict';

  const PANEL_ID = 'char-tree-panel';
  const STYLE_ID = 'char-tree-style';

  // ---------------------------------------------------------------- 工具
  function waitStore(timeoutMs) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      (function poll() {
        const s = window.__SPINE_STORE__;
        if (s && typeof s.getState === 'function') return resolve(s);
        if (Date.now() - started > (timeoutMs || 20000)) return reject(new Error('未找到 __SPINE_STORE__'));
        setTimeout(poll, 150);
      })();
    });
  }

  /** 等模型注入完成（local-roots.js 注入后 models 里才有 localRoot 项）。 */
  function waitLocalModels(store, timeoutMs) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      (function poll() {
        const models = (store.getState().models || []).filter((m) => m.localRoot);
        if (models.length) return resolve(models);
        if (Date.now() - started > (timeoutMs || 90000)) return reject(new Error('等待本地模型注入超时'));
        setTimeout(poll, 300);
      })();
    });
  }

  /** 简单的 JSON 请求助手（本文件独立于 local-roots.js，需自带）。 */
  function api(path) {
    return fetch(path).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
  }

  /**
   * 基础角色 key —— **前端自己算**，后端不参与。
   *
   * 职责划分：后端只如实返回每个模型（name 取自 atlas 内容、srcDir 为真实目录），
   *   不做任何分组/聚合；「同角色归一」纯属显示层行为，在此计算。
   * 规则：去掉 cutscene_ 前缀与 _N 形态后缀
   *   例：char000206 / cutscene_char000206 / cutscene_char000206_2  -> 均归入 char000206
   */
  function charKeyOf(name) {
    return String(name || '').replace(/^cutscene_/i, '').replace(/_\d+$/, '');
  }

  // ---------------------------------------------------------------- 角色名表
  // 名表是**数据**（config/names/*.json，由 tool/import-name-table.mjs 从上游映射表转换而来），
  // 服务端通过 /api/names?root=<id> 按资源根返回。此处只做查表，不在代码里写死任何角色名。
  // 有了角色名后，归组可按**真实角色**（同一角色的多套服装归到一起），比按资源名更准确。
  let nameTable = null;
  const nameCache = new Map();   // 资源名(小写) -> {name, costume, npc} | null

  function lookupName(assetName) {
    const k = String(assetName || '').toLowerCase();
    if (nameCache.has(k)) return nameCache.get(k);
    let out = null;
    if (nameTable && nameTable.byAsset && nameTable.characters) {
      const id = nameTable.byAsset[k];
      const c = id ? nameTable.characters[id] : null;
      // nameZh 来自中文译名叠加层（config/names/<名表>.zh.json，服务端已合并）
      if (c && c.name) out = { name: c.name, nameZh: c.nameZh || '', costume: c.costume || '', npc: !!c.npc };
    }
    nameCache.set(k, out);
    return out;
  }

  /** 变体类型标签：立绘 / 技能 / 技能N / NPC。 */
  function variantLabel(m) {
    const n = String(m.name || '');
    if (/^cutscene_/i.test(n)) {
      const s = n.match(/_(\d+)$/);
      return s ? `技能${s[1]}` : '技能';
    }
    if (/^npc/i.test(n)) return 'NPC';
    return '立绘';
  }

  /** 按基础角色分组（显示层归一）。 */
  // 构建三级树：一级 = 游戏（资源根配置的 name）、二级 = 角色、三级 = 变体。
  //
  // 需求：列表为三级，一级是 JSON 配置里的游戏名。
  // 思路：
  //   一级按模型自带的 rootName 分组 —— 同名资源根**合并**为一个游戏条目
  //     （例如原版与 mod 的 name 都是「棕色尘埃2」，合并后其下同时汇总两边的角色）；
  //   二级在一级内部按**角色名**（来自名表）归组，无名表或未命中时退回资源名推导的键；
  //   三级是该角色的各变体（立绘 / 技能 / 各套服装）。
  //   注意：三级树的 key 里带上游戏名，避免不同游戏下同名角色互相干扰展开状态。
  function buildTree(models) {
    const games = new Map();
    for (const m of models) {
      const gameName = m.rootName || m.rootId || '未命名资源根';
      if (!games.has(gameName)) {
        games.set(gameName, { key: `game:${gameName}`, title: gameName, charMap: new Map() });
      }
      const g = games.get(gameName);

      // Live2D 模型（kind==='live2d'）与 Spine 模型并到同一棵树里一起显示。
      // 与 Spine 的差别：Live2D 每个模型**本身就是角色**（没有「立绘/技能」这类变体），
      //   故做成**叶子条目**（leaf）——单行直接可点渲染，不再多套一层展开，节点数也少一半。
      if (m.kind === 'live2d') {
        const charKey = `char:${gameName}|live2d|${m.name}`;
        if (!g.charMap.has(charKey)) {
          g.charMap.set(charKey, {
            key: charKey, title: m.name, npc: false, leaf: true, variants: [m],
          });
        }
        continue;
      }

      const nm = lookupName(m.name);
      // 分组键用**英文名**（稳定，不受译名增删影响）；显示标题用「中文 英文」
      const groupName = nm ? nm.name : charKeyOf(m.name);
      const charTitle = nm && nm.nameZh ? `${nm.nameZh} ${nm.name}` : groupName;
      const charKey = `char:${gameName}|${groupName}`;
      if (!g.charMap.has(charKey)) {
        g.charMap.set(charKey, { key: charKey, title: charTitle, npc: nm ? nm.npc : false, variants: [] });
      }
      g.charMap.get(charKey).variants.push(m);
    }

    // 组内排序：立绘在前、技能在后；再按资源名数字序
    const rank = (m) => (/^cutscene_/i.test(m.name) ? 1 : 0);
    const out = [...games.values()];
    for (const g of out) {
      g.chars = [...g.charMap.values()];
      delete g.charMap;
      for (const c of g.chars) {
        c.variants.sort((a, b) => rank(a) - rank(b)
          || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
      }
      // 二级排序：普通角色在前、NPC 在后；同组按显示名
      g.chars.sort((a, b) => (a.npc - b.npc)
        || a.title.localeCompare(b.title, undefined, { numeric: true }));
    }
    // 一级排序：按游戏名
    out.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
    return out;
  }

  // ---------------------------------------------------------------- 样式
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    // 隐藏原作者的**左侧**边栏（模型库）。
    //
    // ⚠️ 关键：`bv-sidebar` 这个类**左右两个侧栏都在用**——
    //   左侧栏：... left-0 ... border-l-0 rounded-r-lg ... bv-sidebar ...
    //   右侧栏：... right-0 ... border-r-0 rounded-l-lg ... bv-sidebar ...
    //   若只用 `.bv-sidebar` 选择器，会把右侧栏（菜单面板：动画/皮肤/混合模式等）一并隐藏。
    //   故用 `left-0` 限定，只命中左侧栏。
    //   （两侧栏的开关都在顶部工具栏，不在侧栏内部，隐藏左栏不会丢掉右栏入口。）
    //
    // 为什么是「隐藏」而不是删源码：该侧栏由 React 在运行时渲染（不在 HTML 源里），
    //   无法从源码删除；且 baseline/index.html 是原版的逐字节参照，不应改动。
    //   隐藏只影响显示，原列表仍在 DOM 中——点击变体时仍复用它的 [data-mid] 元素触发加载
    //   （display:none 的元素用 el.click() 依然能派发事件、触发 React 的 onClick）。
    // 同时隐藏它的搜索框：那个框只按模型名（资源号）过滤，中文搜不到，留着会让用户误用。
    //
    // 面板几何：改由本样式固定给出（left/top/bottom），不再读取侧栏的 getBoundingClientRect()。
    //   侧栏被隐藏后其 rect 为全 0，继续依赖它会定位错乱。
    //   top/bottom 取值与原侧栏在桌面断点下的位置一致（顶部 3rem、底部 4rem），视觉上无缝衔接。
    st.textContent = `
      .bv-sidebar.left-0 { display: none !important; }
      #${PANEL_ID} {
        position: fixed;
        left: 0;
        top: calc(3rem + env(safe-area-inset-top, 0px));
        bottom: 4rem;
        z-index: 60;
      }
    `;
    document.head.appendChild(st);
  }

  // ---------------------------------------------------------------- 面板
  let panel = null;
  // 三级树的展开状态（两级各自独立）：
  //   一级「游戏」与二级「角色」**默认全部收起**（需求：列表默认全折叠）。
  //   用户的展开/收起与最后选中的模型会存进 localStorage，刷新后自动恢复。
  let tree = [];
  let expandedGames = new Set();
  let expandedChars = new Set();
  let lastModelId = null;   // 最后选中的变体（全局，仅用于日志/兼容）
  let activeGame = null;    // 最后活跃的游戏名
  let earlyRestoredId = null; // 已由「提前恢复」显示过的模型 id（避免常规恢复重复 show）
  const lastByGame = {};    // 每个游戏各自的上次模型 { 游戏名: 模型id }
  let keyword = '';

  // ---------------------------------------------------------------- 状态持久化
  //
  // 需求：刷新后恢复「上次浏览器加载的」状态（展开到哪一层、最后看的是哪个模型）；
  //   且**每个游戏各存一个默认值**——各游戏记住自己上次看的模型，互不干扰。
  // 思路：存 localStorage（浏览器本地，不涉及服务端）。
  //   lastByGame 按游戏名分别记录；activeGame 记录最后活跃的游戏；
  //   启动时恢复「最后活跃那个游戏的上次模型」。
  //   搜索词不恢复——刷新后还留着搜索词容易让人以为列表缺内容。
  const LS_KEY = 'spine-multi-viewer.tree-state.v1';

  function saveTreeState() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        games: [...expandedGames],
        chars: [...expandedChars],
        activeGame,
        lastByGame,
      }));
    } catch { /* 隐私模式等写不了就忽略 */ }
  }

  // 读「本次要恢复的模型 id」= 最后活跃那个游戏的上次模型。
  //   兼容旧格式（单个 lastModelId）：读到也能用，下次保存即迁移成按游戏存。
  function readSavedTargetId() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (s.lastByGame && s.activeGame && s.lastByGame[s.activeGame]) return s.lastByGame[s.activeGame];
      if (s.lastByGame) {
        const v = Object.values(s.lastByGame).filter(Boolean);
        if (v.length) return v[0];
      }
      return typeof s.lastModelId === 'string' ? s.lastModelId : null;
    } catch {
      return null;
    }
  }

  function loadTreeState() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      // 兼容旧格式：只有 lastModelId 时按「无游戏归属」处理（readSavedTargetId 会兜底）
      const lastByGame = (s.lastByGame && typeof s.lastByGame === 'object') ? { ...s.lastByGame } : {};
      return {
        games: new Set(Array.isArray(s.games) ? s.games : []),
        chars: new Set(Array.isArray(s.chars) ? s.chars : []),
        activeGame: typeof s.activeGame === 'string' ? s.activeGame : null,
        lastByGame,
      };
    } catch {
      return { games: new Set(), chars: new Set(), activeGame: null, lastByGame: {} };
    }
  }
  let sidebarWidthRem = 20;

  function buildPanel(store, models) {
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'position:fixed', 'z-index:60', 'display:flex', 'flex-direction:column',
      'background:#1f2224', 'color:#e6e6e6', 'border:1px solid #3a3a3a',
      'border-left:none', 'border-radius:0 10px 10px 0', 'overflow:hidden',
      'box-shadow:0 8px 28px rgba(0,0,0,.45)', 'font-size:12px',
    ].join(';');

    // 头部：标题 + 「选择目录」+ 收起 + 计数 + 搜索
    //
    // 「选择目录」取代了原作者侧栏里的「导入」：它打开本机的服务端目录浏览器
    //   （public/roots-ui.js 提供的浮层，走 /api/browse 列目录），
    //   选中目录即作为一个资源根加入，随后本面板重新拉取模型并刷新三级树。
    //   注意：这不是浏览器的文件选择器——资源在 NAS 上，必须由服务端列目录才能导航。
    const head = document.createElement('div');
    head.style.cssText = 'padding:8px 10px;border-bottom:1px solid #3a3a3a;flex:0 0 auto';
    head.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <strong style="font-size:13px">角色库</strong>
        <span style="flex:1"></span>
        <button id="ct-add-root" title="浏览本机目录，添加资源根（同名资源根会合并为一个游戏条目）"
          style="background:#2b6cb0;color:#fff;border:none;border-radius:5px;padding:3px 8px;cursor:pointer;font-size:11px">选择目录</button>
        <button id="ct-collapse" title="全部收起"
          style="background:#333;color:#ddd;border:1px solid #555;border-radius:5px;padding:3px 7px;cursor:pointer;font-size:11px">收起</button>
      </div>
      <div id="ct-count" style="color:#9aa;font-size:11px;margin-bottom:6px"></div>
      <input id="ct-search" placeholder="搜索角色 / 服装 / 变体…"
        style="width:100%;box-sizing:border-box;background:#2a2d30;color:#eee;border:1px solid #555;border-radius:6px;padding:5px 8px;font-size:12px">
    `;

    // 树体
    const body = document.createElement('div');
    body.id = 'ct-body';
    body.style.cssText = 'flex:1 1 auto;overflow:auto;padding:4px 0';

    panel.appendChild(head);
    panel.appendChild(body);
    document.body.appendChild(panel);

    panel.querySelector('#ct-search').oninput = (e) => { keyword = e.target.value.trim().toLowerCase(); render(); };
    // 「选择目录」：调用 roots-ui.js 暴露的目录浏览器
    panel.querySelector('#ct-add-root').onclick = () => {
      if (window.__ROOTS_UI__ && typeof window.__ROOTS_UI__.open === 'function') {
        window.__ROOTS_UI__.open();
      } else {
        console.warn('[char-tree] 目录选择器未就绪（roots-ui.js 未加载？）');
      }
    };
    // 收起按钮：清空两级的展开状态（一级游戏也一并收起，便于总览）
    panel.querySelector('#ct-collapse').onclick = () => { expandedGames.clear(); expandedChars.clear(); saveTreeState(); render(); };

    return panel;
  }

  // 头像渲染与取值。
  //
  // 需求：所有条目（Spine 与 Live2D）都要能显示角色头像，头像来源外置可配（服务端解析）。
  // 思路：
  //   - 头像按**角色组**取：组内第一个有 iconUrl 的变体。
  //     实测 BD2 图标只覆盖立绘（char000101 有、cutscene_char000101 没有），
  //     若按变体取会有近半变体没图。
  //   - 加载控制（BD2 有 200+、天命之子有 2185 个角色，不能一次全拉）：
  //     ① loading="lazy" 只请求滚动到可见区域的；
  //     ② decoding="async" 解码不阻塞主线程；
  //     ③ 定宽定高 + object-fit，图片未到时占位不跳动（避免布局抖动）；
  //     ④ 渲染行数上限见 render() 的 RENDER_LIMIT。
  function iconHtml(url) {
    if (!url) return '<span style="flex:0 0 26px;width:26px"></span>';
    return `<img loading="lazy" decoding="async" alt="" src="${url}"
      style="flex:0 0 26px;width:26px;height:26px;object-fit:contain;background:#111;border-radius:4px">`;
  }

  function groupIcon(c) {
    for (const m of c.variants) if (m.iconUrl) return m.iconUrl;
    return null;
  }

  /** 单个变体的可搜索文本（资源名 / 目录名 / 角色名 / 服装名）。 */
  function variantText(m) {
    const nm = lookupName(m.name);
    return `${m.name} ${m.srcDir || ''} ${nm ? `${nm.nameZh} ${nm.name} ${nm.costume}` : ''}`.toLowerCase();
  }

  /**
   * 二级「角色」是否命中搜索词（按角色整组判定）。
   *
   * 为什么按角色整组而不是按变体过滤：搜角色名（如 Lathel）时，应显示该角色的**全部**服装/技能，
   *   而不是只显示名字里带该词的个别变体（变体名是资源号，本身不含角色名）。
   * 可搜内容：角色名 / 服装名 / 资源名 / 目录名（含中文皮肤名，如「莱维亚-原皮技能（无甲）」）。
   */
  function charMatches(c) {
    if (!keyword) return true;
    if (String(c.title).toLowerCase().includes(keyword)) return true;
    return c.variants.some((m) => variantText(m).includes(keyword));
  }

  function render() {
    const body = panel && panel.querySelector('#ct-body');
    if (!body) return;

    // 逐层筛选：一级按「游戏名命中」或「其下任一角色命中」；命中的角色整组显示（含其全部变体）
    const visibleGames = [];
    for (const g of tree) {
      if (!keyword) { visibleGames.push(g); continue; }
      const gameHit = String(g.title).toLowerCase().includes(keyword);
      const chars = gameHit ? g.chars : g.chars.filter(charMatches);
      if (chars.length) visibleGames.push({ key: g.key, title: g.title, chars });
    }

    const totalChars = visibleGames.reduce((s, g) => s + g.chars.length, 0);
    const totalVariants = visibleGames.reduce(
      (s, g) => s + g.chars.reduce((t, c) => t + c.variants.length, 0), 0);
    const cnt = panel.querySelector('#ct-count');
    if (cnt) cnt.textContent = `${visibleGames.length} 游戏 / ${totalChars} 角色 / ${totalVariants} 变体`;

    if (!visibleGames.length) {
      body.innerHTML = '<div style="padding:10px;color:#888">无匹配</div>';
      updateWidth();
      return;
    }

    const rows = [];
    // 每个游戏最多渲染的角色行数。
    // 为什么按**游戏**限额而不是全局：实测天命之子有 2185 个 Live2D 角色且排序在棕色尘埃2 之前，
    //   用全局上限会被它一个游戏吃光，导致另一个游戏一个条目都显示不出来（自检发现）。
    // 思路：每个游戏各自计数，保证都有展示；超出部分提示用搜索缩小范围
    //   （搜索命中的结果通常很少，且 loading="lazy" 的头像也只会请求可见的那些）。
    const RENDER_LIMIT_PER_GAME = 400;
    let skipped = 0;
    for (const g of visibleGames) {
      // 展开规则（明确、无主观阈值）：
      //   ① 用户手动开合过的层保持其状态；② 有搜索词时一律展开到变体（搜什么就展开什么）。
      const gOpen = expandedGames.has(g.key) || keyword.length > 0;
      // 一级：游戏
      rows.push(`
        <div data-game="${g.key}" style="display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;border-left:2px solid #4a7">
          <span style="width:10px;color:#9aa">${gOpen ? '▾' : '▸'}</span>
          <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600">${g.title}</span>
          <span style="color:#8a9;font-size:11px">${g.chars.length}</span>
        </div>`);
      if (!gOpen) continue;

      let renderedHere = 0;
      for (const c of g.chars) {
        if (renderedHere >= RENDER_LIMIT_PER_GAME) { skipped++; continue; }
        renderedHere++;
        // Live2D 叶子条目：单行直接可点渲染（它本身就是角色，没有变体层级）
        if (c.leaf) {
          const m = c.variants[0];
          rows.push(`
            <div data-variant="${m.id}" title="Live2D · ${m.srcDir || m.name}"
              style="display:flex;align-items:center;gap:6px;padding:3px 10px 3px 22px;cursor:pointer">
              ${iconHtml(m.iconUrl)}
              <span style="flex:0 0 auto;background:#6d28d9;color:#fff;border-radius:4px;padding:0 5px;font-size:10px">Live2D</span>
              <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.title}</span>
            </div>`);
          continue;
        }

        const cOpen = expandedChars.has(c.key) || keyword.length > 0;
        // 二级：角色（显示角色名；无名表时退回资源号）+ 角色组头像
        rows.push(`
          <div data-char="${c.key}" style="display:flex;align-items:center;gap:6px;padding:3px 10px 3px 22px;cursor:pointer">
            <span style="width:10px;color:#9aa">${cOpen ? '▾' : '▸'}</span>
            ${iconHtml(groupIcon(c))}
            <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.title}</span>
            ${c.npc ? '<span style="flex:0 0 auto;color:#8a9;font-size:10px;border:1px solid #4a5;border-radius:3px;padding:0 3px">NPC</span>' : ''}
            <span style="color:#8a9;font-size:11px">${c.variants.length}</span>
          </div>`);
        if (!cOpen) continue;

        // 三级：变体（显示服装名 + 类型标签）
        for (const m of c.variants) {
          const label = variantLabel(m);
          const nm = lookupName(m.name);
          // 服装名优先（来自名表）；无名表时退回目录名（含中文皮肤名，如「莱维亚-原皮技能（无甲）」）
          const dirName = (m.srcDir || '').split('/').slice(-1)[0] || '';
          const sub = (nm && nm.costume) ? nm.costume : (dirName || m.name);
          rows.push(`
            <div data-variant="${m.id}" title="${m.name}${dirName ? '  ·  ' + dirName : ''}"
              style="display:flex;align-items:center;gap:6px;padding:4px 10px 4px 40px;cursor:pointer;color:#cfd6dd">
              <span style="flex:0 0 auto;background:#2b6cb0;color:#fff;border-radius:4px;padding:0 5px;font-size:10px">${label}</span>
              <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sub}</span>
            </div>`);
        }
      }
    }
    if (skipped) {
      rows.push(`<div style="padding:8px 10px;color:#9aa;font-size:11px;line-height:1.5">
        还有 ${skipped} 项未显示（每个游戏最多渲染 ${RENDER_LIMIT_PER_GAME} 行），请用上方搜索缩小范围</div>`);
    }
    body.innerHTML = rows.join('');

    // 事件：一级开合游戏、二级开合角色、三级选中变体
    body.querySelectorAll('[data-game]').forEach((el) => {
      el.onclick = () => {
        const k = el.getAttribute('data-game');
        if (expandedGames.has(k)) expandedGames.delete(k); else expandedGames.add(k);
        saveTreeState();
        render();
      };
    });
    body.querySelectorAll('[data-char]').forEach((el) => {
      el.onclick = () => {
        const k = el.getAttribute('data-char');
        if (expandedChars.has(k)) expandedChars.delete(k); else expandedChars.add(k);
        saveTreeState();
        render();
      };
    });
    body.querySelectorAll('[data-variant]').forEach((el) => {
      el.onclick = () => selectVariant(el.getAttribute('data-variant'));
    });

    updateWidth();
  }

  /**
   * 选中某个变体。
   * 复用 原版 原列表的 [data-mid] 元素并触发 click —— 这样会走通它自身的选中逻辑，
   * 同时命中 local-roots.js 的懒加载拦截（内容未就绪时先下载再重放点击）。
   */
  // id -> 模型对象（Spine 与 Live2D 都在内）。点击变体时按 id 取回对象，
  //   Live2D 项需要对象本身（含 modelUrl 等）交给渲染舞台，Spine 项只需 id 触发原列表点击。
  const modelById = new Map();

  function selectVariant(modelId) {
    lastModelId = modelId;
    const mm = modelById.get(modelId);
    // 每个游戏各记一个「上次」：选中哪个游戏里的模型，就更新那个游戏的记录
    const gname = mm && (mm.rootName || mm.rootId);
    if (gname) {
      activeGame = gname;
      lastByGame[gname] = modelId;
      console.info(`[char-tree] 记住「${gname}」的上次模型: ${mm.name}`);
    }
    saveTreeState();
    const m = mm;

    // Live2D：交给渲染舞台（它会把 Spine 画布藏起来、在原区域渲染 Live2D）
    if (m && m.kind === 'live2d') {
      const stage = window.__LIVE2D_STAGE__;
      if (stage) stage.show(m);
      else console.warn('[char-tree] Live2D 舞台未就绪（live2d-stage.js 未加载？）');
      return;
    }

    // Spine：先切回 Spine 渲染（若当前在显示 Live2D），再走原有加载路径
    const stage = window.__LIVE2D_STAGE__;
    if (stage && stage.isActive()) stage.hide();

    const el = document.querySelector(`[data-mid="${modelId}"]`);
    if (el) { el.click(); return; }
    // 兜底：列表项不存在时直接设置当前模型
    const store = window.__SPINE_STORE__;
    if (store) store.getState().setCurrentModel(modelId);
  }

  // 面板宽度同步。
  //
  // 变更说明（同功能重构）：此前这里读取 .bv-sidebar 的 getBoundingClientRect()
  //   来同步 left/top/height；现在侧栏已整体隐藏（其 rect 恒为全 0），
  //   定位改由 injectStyle() 注入的 CSS 固定给出（left/top/bottom），
  //   故此处只负责写宽度。
  //   顺带消除一条老坑：读几何会触发强制同步重排——曾因改侧栏宽度后立刻读 rect
  //   把渲染进程打崩（SIGTRAP），现在完全不碰侧栏。
  function positionPanel() {
    if (!panel) return;
    panel.style.width = `${sidebarWidthRem}rem`;
  }

  /** 左栏动态加宽：按最长条目估算宽度并写入 CSS（!important 以压过 Tailwind 固定宽度）。 */
  /**
   * 左栏动态加宽。
   *
   * 重要（踩坑）：**不能**用 CSS 去改 `.bv-sidebar` 的宽度——
   *   该元素由 framer-motion 做布局动画，用 `!important` 改宽后立刻读几何
   *   （getBoundingClientRect）会触发强制同步重排，实测直接把渲染进程打崩
   *   （SIGTRAP / Trace-breakpoint trap）。
   * 改为：只调整**本浮层**的宽度。浮层覆盖在侧栏之上且更宽，视觉上侧栏即变宽，
   *   而 React 管理的侧栏布局完全不受影响。
   */
  function updateWidth() {
    const body = panel && panel.querySelector('#ct-body');
    if (!body) return;

    // 以最长文本行估算（中文按 1em、其他按 0.62em 粗算），clamp 到 [18, 34] rem
    let maxEm = 12;
    body.querySelectorAll('div').forEach((d) => {
      const t = (d.textContent || '').trim();
      if (!t) return;
      let em = 0;
      for (const ch of t) em += /[\u4e00-\u9fa5]/.test(ch) ? 1 : 0.62;
      if (em > maxEm) maxEm = em;
    });
    const rem = Math.min(34, Math.max(18, Math.ceil(maxEm * 0.62) + 6));
    if (rem !== sidebarWidthRem) sidebarWidthRem = rem;

    // 只写本浮层宽度（不触碰 .bv-sidebar 的布局）
    panel.style.width = `${sidebarWidthRem}rem`;
    positionPanel();
  }

  // ---------------------------------------------------------------- 主流程
  async function main() {
    const store = await waitStore();

    // 拉取名表（可选）：按资源根请求 /api/names，同一份名表只取一次并合并。
    // 名表让归组按「真实角色」进行（同一角色的多套服装/技能归到一起），
    // 并在界面上显示角色名与服装名；拉取失败不影响基本使用（退回按资源名归组）。
    // 同时拉取 Live2D 模型（与 Spine 并到同一棵树里一起显示）。
    const live2dModels = [];
    try {
      const rootsData = await api('/api/roots');
      const tables = new Map();
      for (const r of (rootsData.roots || [])) {
        try {
          const d = await api(`/api/names?root=${encodeURIComponent(r.id)}`);
          if (d && d.tableId && d.characters) tables.set(d.tableId, d);
        } catch { /* 单个资源根无名表不影响整体 */ }
        // Live2D：与 Spine 是两套扫描接口，这里一并取回并合并到同一棵树
        try {
          const d = await api(`/api/live2d/models?root=${encodeURIComponent(r.id)}`);
          for (const m of (d.models || [])) live2dModels.push(m);
        } catch { /* 单根失败不影响整体 */ }
      }
      if (live2dModels.length) {
        console.info(`[char-tree] 并入 ${live2dModels.length} 个 Live2D 模型（与 Spine 显示在一起）`);
      }

      // Live2D 的恢复**不等 Spine 模型注入完成**，拿到 Live2D 列表就立刻显示。
      // 为什么：原版 注入模型时会把「本批第一个 Spine 模型」设为当前模型并立即加载
      //   （即用户说的「默认」）；若存档里是 Live2D，等到 Spine 注入后才恢复，
      //   中间就会先渲染一次那个默认。提前显示 Live2D 覆盖层可把它盖住。
      // 用「最后活跃那个游戏的上次模型」（每个游戏各有一个默认值）
      const earlyId = readSavedTargetId();
      if (earlyId && String(earlyId).startsWith('live2d-')) {
        const m = live2dModels.find((x) => x.id === earlyId);
        const stage = window.__LIVE2D_STAGE__;
        if (m && stage) {
          console.info(`[char-tree] 提前恢复 Live2D 模型（不等 Spine 注入）: ${m.name}`);
          // 记下已提前恢复的 id：下面的常规恢复必须跳过它。
          //   否则同一个模型会被 show() 两次——第二次加载后**第一个模型不会被销毁**，
          //   一直留在后台渲染（实测现象：刷新时「加载两遍、其中一个留在背景」）。
          earlyRestoredId = earlyId;
          // 失败时把 Spine 画布恢复回来（local-roots 可能已提前把它藏起来），
          //   否则会既没有 Live2D 也没有 Spine，舞台一片空白。
          stage.show(m).then((ok) => {
            if (!ok) {
              console.warn('[char-tree] Live2D 提前恢复失败，恢复 Spine 画布');
              earlyRestoredId = null;   // 失败则不占用，让常规恢复再试一次
              stage.hide();
            }
          });
        }
      }
      if (tables.size) {
        const merged = { byAsset: {}, characters: {} };
        for (const t of tables.values()) {
          Object.assign(merged.byAsset, t.byAsset || {});
          Object.assign(merged.characters, t.characters || {});
        }
        nameTable = merged;
        console.info(`[char-tree] 已加载名表 [${[...tables.keys()].join(', ')}]`
          + `：${Object.keys(merged.characters).length} 个角色 / ${Object.keys(merged.byAsset).length} 个资源`);
      } else {
        console.info('[char-tree] 无可用名表，按资源名归组');
      }
    } catch (e) {
      console.warn('[char-tree] 拉取名表失败（不影响使用）:', e.message);
    }

    // 再等 Spine 模型注入完成（放在 Live2D 提前恢复之后，避免先渲染出默认模型）
    const models = await waitLocalModels(store);
    console.info(`[char-tree] 收到 ${models.length} 个本地模型`);

    // Spine + Live2D 合并成一棵树；同时建 id -> 模型 映射（点击变体时按 id 取回对象，
    // Live2D 项需要对象本身交给渲染舞台）
    const allModels = models.concat(live2dModels);
    modelById.clear();
    for (const m of allModels) modelById.set(m.id, m);

    tree = buildTree(allModels);
    // 展开状态：默认**全部收起**；若浏览器里存有上次的状态则恢复（需求：刷新加载回上次的）
    const saved = loadTreeState();
    expandedGames = saved.games;
    expandedChars = saved.chars;
    activeGame = saved.activeGame;
    Object.assign(lastByGame, saved.lastByGame);
    lastModelId = readSavedTargetId();
    console.info(`[char-tree] 展开状态: ${saved.games.size ? '已恢复上次（游戏 ' + saved.games.size
      + ' / 角色 ' + saved.chars.size + '）' : '默认全折叠'}`);
    const charCount = tree.reduce((s, g) => s + g.chars.length, 0);
    console.info(`[char-tree] 归为 ${tree.length} 个游戏 / ${charCount} 个角色（显示层归一，未合并数据）`);

    // 恢复上次选中的模型（需求：刷新后加载回上次浏览器看的内容）。
    // 延后一帧执行：Spine 模型要走「点击原列表项」的既有路径，需等列表 DOM 就绪。
    if (lastModelId && lastModelId === earlyRestoredId) {
      console.info(`[char-tree] 该模型已由提前恢复显示，跳过常规恢复: ${lastModelId}`);
    } else if (lastModelId) {
      if (modelById.has(lastModelId)) {
        const m = modelById.get(lastModelId);
        console.info(`[char-tree] 恢复上次选中的模型: ${m.name}（${m.kind || 'spine'}）`);
        requestAnimationFrame(() => selectVariant(lastModelId));
      } else {
        console.info(`[char-tree] 上次选中的模型已不存在，忽略: ${lastModelId}`);
        lastModelId = null;
        saveTreeState();
      }
    }


    injectStyle();
    buildPanel(store, models);

    // 默认全部收起（不预展开任何角色）。
    // 说明：此前曾"默认展开前 3 个角色"，那只是为了让二级效果一眼可见的主观选择，
    //   规则不明确（为什么是前 3 个？），已去掉。展开规则改为：
    //   ① 启动/切换时全部收起；② 搜索时自动展开所有命中的角色（见 render）。
    render();

    // 自检日志：报告面板状态与树规模（便于无人值守验证，不依赖截图 / dump）
    const body = panel.querySelector('#ct-body');
    // 分别核对左右侧栏的显示状态。
    // 为什么必须分开查：`bv-sidebar` 这个类**左右两个侧栏共用**，
    //   只查第一个匹配（左栏）会漏掉「右栏被一并隐藏」的问题——实测踩过这个坑。
    //   期望：左栏隐藏、右栏保持可见（右栏是菜单面板：动画/皮肤/混合模式等）。
    //   注意要查侧栏元素**自身**的 computed display；查其内部子元素会得到子元素自己的
    //   display 值（非 none），从而误判为「没隐藏」。
    const asides = [...document.querySelectorAll('.bv-sidebar')];
    const dispOf = (el) => (el ? getComputedStyle(el).display : 'N/A');
    const leftAside = asides.find((el) => String(el.className).includes('left-0'));
    const rightAside = asides.find((el) => String(el.className).includes('right-0'));
    // 面板几何自检：改为 CSS 固定定位后，确认它确实铺在预期位置（左侧、顶 3rem、底部留白）
    const pr = panel.getBoundingClientRect();
    const addBtn = panel.querySelector('#ct-add-root');
    // 头像加载自检：`complete && naturalWidth > 0` 才算真的加载成功——
    //   只统计 DOM 里的 <img> 数量无法区分「占位未加载」与「加载失败」
    const imgs = [...body.querySelectorAll('img')];
    const imgsLoaded = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
    console.info(
      `[char-tree] 面板已挂载: 在DOM=${document.body.contains(panel)} `
      + `几何=left:${Math.round(pr.left)} top:${Math.round(pr.top)} `
      + `宽:${Math.round(pr.width)} 高:${Math.round(pr.height)} `
      + `选择目录按钮=${!!addBtn} `
      + `游戏=${body.querySelectorAll('[data-game]').length} `
      + `角色=${body.querySelectorAll('[data-char]').length} `
      + `变体=${body.querySelectorAll('[data-variant]').length} `
      + `头像=${imgs.length}(已加载${imgsLoaded}) `
      + `左栏隐藏=${leftAside ? dispOf(leftAside) === 'none' : '未挂载'} `
      + `右栏可见=${rightAside ? dispOf(rightAside) !== 'none' : '未挂载(需点顶部「菜单」) '}`
    );

    // 窗口尺寸变化时重算宽度。
    //
    // 变更说明（同功能重构）：此前还监听了 .bv-sidebar 的 ResizeObserver 并做 3 秒轮询，
    //   用于跟随侧栏的开合动画对齐位置；现在侧栏已整体隐藏、定位改为 CSS 固定值，
    //   这两项都失去意义，故去掉（保留 resize 以在窗口变化时重算宽度）。
    window.addEventListener('resize', positionPanel);

    // 自检钩子（默认不触发）：
    //   ?selftest=state   展开第一个游戏与角色并选中第一个变体（用于验证刷新后能否恢复）
    const qs = new URLSearchParams(location.search);

    // ?selftest=switch&game=<游戏名>
    //   在同一游戏内先选 Live2D 模型、再选 Spine 模型，检查切换后是否**残留**：
    //   覆盖层是否收起、Spine 画布是否恢复可见、Spine 模型是否真的被选中。
    if (qs.get('selftest') === 'switch') {
      setTimeout(async () => {
        const gname = qs.get('game') || '碧蓝航线';
        const g = tree.find((x) => x.title === gname);
        if (!g) { console.warn('[selftest] 未找到游戏:', gname); return; }
        const l2dChar = g.chars.find((c) => c.variants[0] && c.variants[0].kind === 'live2d');
        const spineChar = g.chars.find((c) => c.variants[0] && c.variants[0].kind !== 'live2d');
        if (!l2dChar || !spineChar) { console.warn('[selftest] 该游戏缺少 Live2D 或 Spine 模型'); return; }
        const stage = window.__LIVE2D_STAGE__;
        const spineCv = () => document.querySelector('canvas.absolute.inset-0');
        const report = (tag) => {
          const ov = document.getElementById('live2d-stage');
          const cv = spineCv();
          const cur = window.__SPINE_STORE__.getState().currentModel;
          console.info(`[selftest] ${tag}: 覆盖层display=${ov ? ov.style.display : '无'}`
            + ` Spine画布visibility=${cv ? (cv.style.visibility || '(可见)') : '无'}`
            + ` Live2D活跃=${stage ? stage.isActive() : '?'}`
            + ` 当前选中=${cur ? cur.name : '无'}`);
          // 画布清单：确认是否还有别的画布在显示 Spine 渲染（那样隐藏一个也不够）
          const list = [...document.querySelectorAll('canvas')].map((c, i) => {
            const st = getComputedStyle(c);
            return `#${i}${c.id ? '(' + c.id + ')' : ''} vis=${st.visibility} disp=${st.display}`
              + ` z=${st.zIndex} ${Math.round(c.getBoundingClientRect().width)}x${Math.round(c.getBoundingClientRect().height)}`;
          });
          console.info(`[selftest] 画布清单(${list.length}): ${list.join(' | ')}`);
        };

        console.info(`[selftest] 先选 Live2D: ${l2dChar.variants[0].name}`);
        selectVariant(l2dChar.variants[0].id);
        await new Promise((r) => setTimeout(r, 7000));
        report('切到 Live2D 后');

        console.info(`[selftest] 再选 Spine: ${spineChar.variants[0].name}`);
        selectVariant(spineChar.variants[0].id);
        await new Promise((r) => setTimeout(r, 7000));
        report('切回 Spine 后');
      }, 3000);
    }

    if (qs.get('selftest') === 'state') {
      setTimeout(() => {
        // ?selftest=state&kind=spine|live2d 指定要选中的模型类型（默认第一个游戏）
        const kind = qs.get('kind');
        const wantGame = qs.get('game');
        let g = wantGame ? (tree.find((x) => x.title === wantGame) || tree[0]) : tree[0];
        let c = null;
        if (kind) {
          // 指定了 game 就只在该游戏里找（否则会被下面的遍历覆盖成其它游戏）
          const pool = wantGame ? [g] : tree;
          for (const gg of pool) {
            const hit = gg.chars.find((cc) => {
              const m = cc.variants[0];
              return m && (kind === 'live2d' ? m.kind === 'live2d' : m.kind !== 'live2d');
            });
            if (hit) { g = gg; c = hit; break; }
          }
        }
        if (!g) { console.warn('[selftest] 无游戏可展开'); return; }
        expandedGames.add(g.key);
        if (!c) c = g.chars[0];
        if (c) expandedChars.add(c.key);
        saveTreeState();
        render();
        console.info(`[selftest] 已展开并保存: 游戏=${expandedGames.size} 角色=${expandedChars.size}`);
        if (c && c.variants[0]) {
          console.info(`[selftest] 选中变体: ${c.variants[0].name}`);
          selectVariant(c.variants[0].id);
        }
        // 展开后等图片真正加载完再报告一次头像状态
        //   （挂载时那次日志在展开之前，必然是 0 个）
        setTimeout(() => {
          const b2 = panel && panel.querySelector('#ct-body');
          if (!b2) return;
          const is = [...b2.querySelectorAll('img')];
          const ok = is.filter((i) => i.complete && i.naturalWidth > 0).length;
          console.info(`[selftest] 头像加载: DOM ${is.length} 个，成功 ${ok} 个，失败 ${is.length - ok} 个`);
          if (is.length && ok === 0) {
            console.warn(`[selftest] 头像全部未加载，首个 src=${is[0].getAttribute('src')}`);
          }
        }, 4000);
      }, 3000);
    }

    // 自检钩子（默认不触发）：
    //   ?selftest=picker    点击「选择目录」，验证目录浏览器是否真的弹出（端到端验证按钮接线）
    //   ?selftest=<模型名>  逐个点击同名变体并报告各自填充的 atlas/skel 内容长度
    //   ?select=<id 子串>   只选中匹配的一个模型（用于渲染对比）
    
    if (qs.get('selftest') === 'picker') {
      setTimeout(() => {
        const btn = panel.querySelector('#ct-add-root');
        console.info(`[selftest] 选择目录: 按钮存在=${!!btn}`);
        if (btn) btn.click();
        setTimeout(() => {
          const box = document.querySelector('#roots-ui-panel');
          console.info(`[selftest] 选择目录: 面板已弹出=${!!box}`
            + ` 有目录列表=${!!document.querySelector('#roots-ui-body')}`);
        }, 1500);
      }, 3000);
    }

    // 验证右侧栏（菜单面板）未被误隐藏：点顶部工具栏的「菜单」按钮后应能出现且可见。
    if (qs.get('selftest') === 'rightbar') {
      setTimeout(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.title === '菜单');
        console.info(`[selftest] 右栏: 顶部「菜单」按钮=${!!btn}`);
        if (btn) btn.click();
        setTimeout(() => {
          const right = [...document.querySelectorAll('.bv-sidebar')]
            .find((el) => String(el.className).includes('right-0'));
          console.info(`[selftest] 右栏: 元素已挂载=${!!right}`
            + ` 可见=${right ? getComputedStyle(right).display !== 'none' : 'N/A'}`);
        }, 1200);
      }, 3000);
    }

    const selectParam = qs.get('select');
    if (selectParam) {
      setTimeout(() => {
        const m = (store.getState().models || []).find(
          (x) => x.localRoot && String(x.id).includes(selectParam));
        if (!m) { console.warn('[select] 未找到匹配模型:', selectParam); return; }
        console.info(`[select] 选中 id=${m.id} srcDir=${m.srcDir}`);
        const el = document.querySelector(`[data-mid="${m.id}"]`);
        if (el) el.click(); else store.getState().setCurrentModel(m.id);
      }, 3000);
    }

    const stParam = qs.get('selftest');
    // '1' 是「自动点击第一个模型」的旧约定，'picker' 是上面的目录选择器自检——
    // 两者都不是模型名，需排除，否则会被当成模型名去找而输出无意义的「找到 0 个变体」。
    if (stParam && stParam !== '1' && stParam !== 'picker') {
      setTimeout(async () => {
        const all = (store.getState().models || []).filter((m) => m.localRoot && m.name === stParam);
        console.info(`[selftest] 找到 ${all.length} 个名为 ${stParam} 的变体`);
        for (const m of all) {
          const el = document.querySelector(`[data-mid="${m.id}"]`);
          console.info(`[selftest] 点击 id=${m.id} srcDir=${m.srcDir} 有列表项=${!!el}`);
          if (el) el.click();
          await new Promise((r) => setTimeout(r, 4000));
          const cur = (store.getState().models || []).find((x) => x.id === m.id) || m;
          const aLen = cur.atlasFile && cur.atlasFile.content ? cur.atlasFile.content.length : null;
          const sLen = cur.skeletonFile && cur.skeletonFile.content
            ? (cur.skeletonFile.content.byteLength || cur.skeletonFile.content.length) : null;
          console.info(`[selftest] 结果 id=${m.id}`
            + ` atlas内容=${aLen}(期望${m.atlasFile.size})`
            + ` skel内容=${sLen}(期望${m.skeletonFile.size})`
            + ` 当前选中=${store.getState().currentModelId}`);
        }
      }, 3000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { main().catch((e) => console.error('[char-tree]', e)); });
  } else {
    main().catch((e) => console.error('[char-tree]', e));
  }
})();
