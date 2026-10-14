/*!
 * char-tree.js —— 左栏「同角色二级展开」树面板（spine-multi-viewer 自有代码）
 *
 * 设计目标：
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

'use strict';

// 为什么用「顶层块」而不是常见的 IIFE 包装（(function(){…})()）：
//   两者作用域行为一致 —— 块内的 const / function 都只在本块内可见，不往 window 上放东西；
//   但 IIFE 会把整份文件包成**一个函数**，静态度量与审计都会把它当成「一个几百行的巨型函数」。
//   块不是函数，因此函数长度度量看到的是文件里真正的一个个函数。
//   块不构成函数级指令原句，故把 'use strict' 提到文件首行（脚本级指令原句，严格模式覆盖整个脚本）。
{
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
    // 归一化规则（顺序不可换）：
    //   ① 去 cutscene_ 前缀（技能/剧情变体）
    //   ② 去换装后缀 _hx（婚纱/换装；碧蓝 L2D 里 15 个未命中名表的模型**全部**是这个后缀）
    //   ③ 去尾部形态序号 _N
    // 为什么 _hx 必须在 _N 之前：`dafeng_2_hx` 若先剥 _N 会因结尾不是数字而剥不掉，
    //   结果停在 `dafeng_2_hx` 永远归不了组；先剥 _hx 得 `dafeng_2`，再剥 _N 得 `dafeng`。
    return String(name || '')
      .replace(/^cutscene_/i, '')
      .replace(/_hx$/i, '')
      .replace(/_\d+$/, '');
  }

  // ---------------------------------------------------------------- 角色名表
  // 名表是**数据**（config/names/*.json，由 tool/import-name-table.mjs 从上游映射表转换而来），
  // 服务端通过 /api/names?root=<id> 按资源根返回。此处只做查表，不在代码里写死任何角色名。
  // 有了角色名后，归组可按**真实角色**（同一角色的多套服装归到一起），比按资源名更准确。
  let nameTable = null;
  const nameCache = new Map();   // 资源名(小写) -> {name, costume, npc} | null

  // 资源名后缀归一化（分组逻辑抽公共的一部分，对 Live2D 与 Spine 同等生效）。
  //
  // 依据（对碧蓝名表与模型列表的实际核对）：碧蓝名表 `config/names/azurlane.json` 的 byAsset 2,557 条里
  //   带 `_hx` 的键只有 1 条；Live2D（root=azurlane）119 个模型里 15 个查不到名表，**全部**是 `_hx` 尾缀
  //   （`abeikelongbi_3_hx`、`dafeng_2_hx`、`chaijun_4_hx` …）。而剥离 `_hx` 后：
  //     `dafeng_2_hx` → `dafeng_2` → 名表命中「大凤 / 服装=毒苹果」✓
  //     `chaijun_4_hx` → `chaijun_4` → 命中柴郡的对应服装 ✓
  //   于是这些换装变体得以与同角色的其它模型归到**同一个角色条目**下。
  //
  // 查表顺序（逐级放宽，命中即止）：① 原样 → ② 剥 `_hx` → ③ 再剥尾部 `_N`；
  //   三级都未命中时由调用方用 charKeyOf() 的归一化名兜底做分组键（仍是同一路径，不做特例）。
  const ASSET_SUFFIX_PATTERNS = [/_hx$/i];

  /** 依次放宽的候选资源名（小写）。 */
  function assetCandidates(name) {
    const raw = String(name || '').toLowerCase();
    const out = [raw];
    for (const re of ASSET_SUFFIX_PATTERNS) {
      const prev = out[out.length - 1];
      const v = prev.replace(re, '');
      if (v && v !== prev) out.push(v);
    }
    const prev = out[out.length - 1];
    const noNum = prev.replace(/_\d+$/, '');
    if (noNum && noNum !== prev) out.push(noNum);
    return out;
  }

  /** 单次查表（键已小写）。 */
  function lookupNameInTable(key) {
    const id = nameTable.byAsset[key];
    const c = id ? nameTable.characters[id] : null;
    // nameZh 来自中文译名叠加层（config/names/<名表>.zh.json，服务端已合并）
    if (!c || !c.name) return null;
    return { name: c.name, nameZh: c.nameZh || '', costume: c.costume || '', npc: !!c.npc };
  }

  function lookupName(assetName) {
    const raw = String(assetName || '').toLowerCase();
    if (nameCache.has(raw)) return nameCache.get(raw);
    let out = null;
    if (nameTable && nameTable.byAsset && nameTable.characters) {
      for (const key of assetCandidates(raw)) {
        const hit = lookupNameInTable(key);
        if (hit) {
          // matchedKey/via 只用于自检统计与排查，不影响分组语义
          out = { ...hit, matchedKey: key, via: key === raw ? 'exact' : 'suffix' };
          break;
        }
      }
    }
    nameCache.set(raw, out);
    return out;
  }

  /** 变体标签：只保留**基础类型标签**。
   *
   *  规则：Spine 模型 → `Spine`；Live2D 模型 → `Live2D`。就这两种。
   *  历史（已移除）：曾按资源名再细分「技能 / 技能N」（`^cutscene_`）与「NPC」（`^npc`）——
   *    这两类属额外标签，已收敛为类型标签。
   *  注意：角色行上的「原名」绿标签取自该组基础变体的资源名，与变体标签是两码事。
   */
  function variantLabel(m) {
    if (!m) return 'Spine';
    if (m.kind === 'live2d') return 'Live2D';
    if (m.kind === 'bundle') {
      // 资源包条目的标签文字由**展示类型插件**声明（宿主转达，如「Live2D包」）。
      // 插件没声明/没加载时用中性兜底，避免显示成 Spine（那会让用户以为它是骨架模型）。
      const p = window.SpineViewerPlugins;
      return (p && p.labelFor && p.labelFor('bundle')) || '资源包';
    }
    return 'Spine';
  }

  /** 变体标签配色：按类型取底色，其余样式两种类型完全一致（白字 / 4px 圆角 / 内边距 / 10px 字号）。
   *  - `Spine`  → `#2b6cb0`（蓝）
   *  - `Live2D` → `#6d28d9`（紫，沿用早期 Live2D 徽标用的紫）
   *  - 资源包（bundle）→ 同样用 Live2D 紫：包内是 Live2D 模型，配色按"内容类型"而不按容器类型，
   *    这样不新增配色、也和真正 Live2D 条目视觉一致。
   *  抽成常量 + 函数，避免同一串样式在多处内联出现。
   */
  const VARIANT_LABEL_BG = { spine: '#2b6cb0', live2d: '#6d28d9' };
  function variantLabelStyle(m) {
    const isL2dLike = m && (m.kind === 'live2d' || m.kind === 'bundle');
    const bg = isL2dLike ? VARIANT_LABEL_BG.live2d : VARIANT_LABEL_BG.spine;
    return `flex:0 0 auto;background:${bg};color:#fff;border-radius:4px;padding:0 5px;font-size:10px`;
  }

  /** 按基础角色分组（显示层归一）。 */
  // 构建三级树：一级 = 游戏（资源根配置的 name）、二级 = 角色、三级 = 变体。
  //
  // 树为三级：一级是 JSON 配置里的游戏名。
  // 思路：
  //   一级按模型自带的 rootName 分组 —— 同名资源根**合并**为一个游戏条目
  //     （例如原版与 mod 的 name 都是「棕色尘埃2」，合并后其下同时汇总两边的角色）；
  //   二级在一级内部按**角色名**（来自名表）归组，无名表或未命中时退回资源名推导的键；
  //   三级是该角色的各变体（立绘 / 技能 / 各套服装）。
  //   注意：三级树的 key 里带上游戏名，避免不同游戏下同名角色互相干扰展开状态。
  /**
   * 排序 + 自检统计收尾（在 buildTree 归组之后调用）。
   *   · 组内排序：立绘在前、技能在后；再按资源名数字序
   *   · 二级排序：普通角色在前、NPC 在后；同组按显示名
   *   · 一级排序：按游戏名
   *   · stats：游戏/角色条目数 + 实际用到的变体标签集合
   *     （供无人值守验证：名表命中率、归组效果、「全树只出现 Spine 与 Live2D 两种标签」）
   */
  function finalizeTree(out, stats) {
    const rank = (m) => (/^cutscene_/i.test(m.name) ? 1 : 0);
    for (const g of out) {
      g.chars = [...g.charMap.values()];
      delete g.charMap;
      for (const c of g.chars) {
        c.variants.sort((a, b) => rank(a) - rank(b)
          || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
      }
      g.chars.sort((a, b) => (a.npc - b.npc)
        || a.title.localeCompare(b.title, undefined, { numeric: true }));
    }
    out.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));

    stats.games = out.length;
    stats.chars = out.reduce((n, g) => n + g.chars.length, 0);
    for (const g of out) {
      for (const c of g.chars) {
        for (const m of c.variants) {
          const l = variantLabel(m);
          stats.labels[l] = (stats.labels[l] || 0) + 1;
        }
      }
    }
    window.__CHAR_TREE_STATS__ = stats;
    return out;
  }

  function buildTree(models) {
    const games = new Map();
    // 自检统计（只读汇总，供无人值守验证/排查；见 window.__CHAR_TREE_STATS__）
    const stats = { models: models.length, exact: 0, suffix: 0, miss: 0, chars: 0, games: 0, labels: {} };
    for (const m of models) {
      const gameName = m.rootName || m.rootId || '未命名资源根';
      if (!games.has(gameName)) {
        games.set(gameName, { key: `game:${gameName}`, title: gameName, charMap: new Map() });
      }
      const g = games.get(gameName);

      // Live2D 与 Spine 走**同一条**分组路径（分组逻辑抽公共）：
      //   名表命中 → 用英文名归组、标题显示「中文名 英文名」；未命中 → 用归一化名（剥 cutscene_ / _hx / _N）归组。
      //   历史实现给 Live2D 留过一条特例分支（`kind==='live2d'` → 每模型一个 leaf 条目、绕过名表），
      //   导致同一角色的多个 Live2D 变体各自成条、也不与 Spine 归并；该分支已删除，改为统一路径。
      const nm = lookupName(m.name);
      if (nm) stats[nm.via === 'exact' ? 'exact' : 'suffix']++;
      else stats.miss++;
      const groupName = nm ? nm.name : charKeyOf(m.name);
      const charTitle = nm && nm.nameZh ? `${nm.nameZh} ${nm.name}` : groupName;
      const charKey = `char:${gameName}|${groupName}`;
      if (!g.charMap.has(charKey)) {
        g.charMap.set(charKey, { key: charKey, title: charTitle, npc: nm ? nm.npc : false, variants: [] });
      }
      g.charMap.get(charKey).variants.push(m);
    }

    return finalizeTree([...games.values()], stats);
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
    // 同时隐藏它的搜索框：那个框只按模型名（资源号）过滤，中文搜不到，留着容易误用（只能按资源号搜）。
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
        /* 显隐过渡：与原版栏同款「滑出 + 淡出」观感。
           原版由 framer-motion 逐帧写 inline style（实测约 300–400ms、显著减速曲线：
           位移 208 → 278 → 317 → 320px，computed opacity 0.478 → 0.185 → 0.015 → 0），
           CSS 无法逐帧复刻，故用 300ms ease-out 近似同一条减速曲线。
           终态字面量固定为：opacity 0 + translateX(-320px)（-320px 不随面板宽度变化）。 */
        transition: opacity 300ms ease-out, transform 300ms ease-out;
      }
    `;
    document.head.appendChild(st);
  }

  // ---------------------------------------------------------------- 面板显隐（与顶栏「模型库」按钮同步）
  //
  // 顶栏「模型库」按钮控制**本面板**；显隐用原版同款过渡（滑出 + 淡出，非 display 切换）
  //   （滑出 + 淡出），禁止 display:none 硬切。
  // 实现要点：
  //   · 隐藏 = inline `opacity:0` + `transform:translateX(-320px)`；显示 = `opacity:1` + `transform:none`
  //     —— 与 React 在原版栏上写的终态值完全一致（见上方实测数据）。
  //   · opacity:0 的元素**仍可点击**，会挡住它下面的画布，故隐藏时一并置 `pointer-events:none`，
  //     显示时清掉恢复默认（原版栏由 React 控制显隐、没有这层需要，这里是我们自己补的防穿透）。
  //   · 顶栏按钮的视觉态沿用**原版自己的 Tailwind 令牌**（实测：展开时 `bg-secondary border
  //     border-primary text-primary`，收起时 `border border-transparent`），不新造样式。
  const HIDDEN_TRANSFORM = 'translateX(-320px)';
  let panelHidden = false;
  let headerBtnSyncing = false;

  /** 面板当前是否隐藏（供自检/外部查询）。 */
  function isPanelHidden() {
    return panelHidden;
  }

  /** 顶栏「模型库」按钮：按面板显隐切换原版同款令牌（隐藏=收起态）。 */
  function syncHeaderButton() {
    const btn = document.querySelector('header button[title="模型库"]');
    if (!btn) return false;
    headerBtnSyncing = true;
    try {
      const open = !panelHidden;
      btn.classList.toggle('bg-secondary', open);
      btn.classList.toggle('border-primary', open);
      btn.classList.toggle('text-primary', open);
      btn.classList.toggle('border-transparent', !open);
      // data-state：原版按钮没有该属性，这里补一个只读标记便于自检/后续样式挂钩（不改视觉）
      btn.setAttribute('data-ct-panel-state', open ? 'open' : 'closed');
    } finally {
      headerBtnSyncing = false;
    }
    return true;
  }

  /**
   * 设置面板显隐（顶栏按钮与面板内「收起」按钮共用此函数）。
   * @param {boolean} hidden
   */
  function setPanelHidden(hidden) {
    panelHidden = !!hidden;
    if (panel) {
      panel.style.opacity = panelHidden ? '0' : '1';
      panel.style.transform = panelHidden ? HIDDEN_TRANSFORM : 'none';
      panel.style.pointerEvents = panelHidden ? 'none' : '';
      panel.setAttribute('data-state', panelHidden ? 'closed' : 'open');
    }
    syncHeaderButton();
    console.info(`[char-tree] 面板${panelHidden ? '已收起' : '已展开'}（顶栏「模型库」按钮状态同步）`);
  }

  /** 切换面板显隐。 */
  function togglePanel() {
    setPanelHidden(!panelHidden);
  }

  /**
   * 顶栏「模型库」按钮接线：点它切换**我们的面板**。
   *
   * 为什么必须 stopPropagation：原版按钮的 React onClick 会把原版侧栏状态置为收起，
   *   进而在动画结束后 `removeChild` 卸载该节点；而该节点已被我们删除（见 removeOriginalSidebar），
   *   让 React 走到卸载分支会抛 NotFoundError（commit 阶段异常）。
   *   在按钮自身监听并阻断冒泡后，React 的委托监听（挂在 #root）收不到这次点击 → 不会触发卸载。
   */
  function wireHeaderModelButton() {
    const btn = document.querySelector('header button[title="模型库"]');
    if (!btn) return false;
    if (btn.dataset.ctWired === '1') return true;
    btn.dataset.ctWired = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    }, true);
    // React 若因其它原因重渲染该按钮并覆盖 className，这里把状态再同步回去
    // （观察自身写入会再次触发回调，用 headerBtnSyncing 防重入）
    const mo = new MutationObserver(() => {
      if (headerBtnSyncing) return;
      const expectOpen = !panelHidden;
      const hasOpen = btn.classList.contains('text-primary');
      if (expectOpen !== hasOpen) syncHeaderButton();
    });
    mo.observe(btn, { attributes: true, attributeFilter: ['class'] });
    return true;
  }

  /**
   * 删除原版左侧栏（模型库）DOM。
   *
   * 为什么可删（依据：本文件下方 selectVariant 自带兜底路径）：
   *   · 装载不依赖它：删除后 [data-mid] 归 0，我们的树点击变体仍能把 store.currentModelId 改过去；
   *     内容懒加载改由 selectVariant 里的 ensureLocalContent 承担（见该函数注释）。
   *   · 首帧不闪烁仍由两处 CSS 兜底：server.mjs 在 <head> 注入的
   *     `.bv-sidebar.left-0{display:none!important}`（早于本脚本执行）+ 本文件 injectStyle() 的同名规则。
   * 为什么要守护（MutationObserver）：原版侧栏由 React 条件渲染，某些状态变化会让它重新挂载；
   *   这里持续移除，保证该侧栏不出现在界面上。移除只针对**左侧**栏（left-0），右侧栏（right-0）不动。
   */
  function removeOriginalSidebar() {
    const kill = () => {
      const els = [...document.querySelectorAll('.bv-sidebar.left-0')];
      for (const el of els) el.remove();
      return els.length;
    };
    const removed = kill();
    if (window.__CHAR_TREE_SIDEBAR_SWEEPER__) return removed;
    const mo = new MutationObserver(() => {
      if (document.querySelector('.bv-sidebar.left-0')) kill();
    });
    // 监听 body 子树的新增节点（React 重挂载会插入新节点）
    mo.observe(document.body, { childList: true, subtree: true });
    window.__CHAR_TREE_SIDEBAR_SWEEPER__ = mo;
    return removed;
  }

  // ---------------------------------------------------------------- 面板
  let panel = null;
  // 三级树的展开状态（两级各自独立）：
  //   一级「游戏」与二级「角色」**默认全部收起**（默认全折叠）。
  //   展开/收起状态与最后选中的模型会存进 localStorage，刷新后自动恢复。
  let tree = [];
  // 建树用的全部模型（Spine + Live2D + 资源包）：插件迟到时用它重建树，
  //   让「变体标签由插件声明」这件事在插件晚注册的情况下也能生效。
  let allModelsRef = null;
  let expandedGames = new Set();
  let expandedChars = new Set();
  let lastModelId = null;   // 最后选中的变体（全局，仅用于日志/兼容）
  let activeGame = null;    // 最后活跃的游戏名
  let earlyRestoredId = null; // 已由「提前恢复」显示过的模型 id（避免常规恢复重复 show）
  const lastByGame = {};    // 每个游戏各自的上次模型 { 游戏名: 模型id }
  let keyword = '';

  // ---------------------------------------------------------------- 状态持久化
  //
  // 刷新后恢复「上次浏览器加载的」状态（展开到哪一层、最后看的是哪个模型）；
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

  /** 创建面板外壳（容器 + 头部控件 + 树体）并挂到 body。 */
  function createPanelShell() {
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
    //
    // 「收起」的职责（面板内只保留这一个按钮）：
    //   只收起**树节点**（清空两级展开状态），面板本身保留在屏幕上。
    //   **面板显隐只由顶栏「模型库」按钮控制**（与顶栏按钮共用同一份显隐状态），
    //   面板内不再放隐藏面板的按钮。
    const head = document.createElement('div');
    head.style.cssText = 'padding:8px 10px;border-bottom:1px solid #3a3a3a;flex:0 0 auto';
    head.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <strong style="font-size:13px">角色库</strong>
        <span style="flex:1"></span>
        <button id="ct-add-root" title="浏览本机目录，添加资源根（同名资源根会合并为一个游戏条目）"
          style="background:#2b6cb0;color:#fff;border:none;border-radius:5px;padding:3px 8px;cursor:pointer;font-size:11px">选择目录</button>
        <button id="ct-collapse" title="只收起展开的树节点（面板保留；隐藏面板用顶栏「模型库」按钮）"
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
  }

  /** 绑定面板头部控件：搜索框 / 「选择目录」/「收起」。 */
  function wirePanelControls() {
    panel.querySelector('#ct-search').oninput = (e) => { keyword = e.target.value.trim().toLowerCase(); render(); };
    // 「选择目录」：调用 roots-ui.js 暴露的目录浏览器
    panel.querySelector('#ct-add-root').onclick = () => {
      if (window.__ROOTS_UI__ && typeof window.__ROOTS_UI__.open === 'function') {
        window.__ROOTS_UI__.open();
      } else {
        console.warn('[char-tree] 目录选择器未就绪（roots-ui.js 未加载？）');
      }
    };
    // 收起按钮（#ct-collapse）：只清空两级的展开状态，面板保留（与服务端无关的纯前端状态）
    panel.querySelector('#ct-collapse').onclick = () => { expandedGames.clear(); expandedChars.clear(); saveTreeState(); render(); };
  }

  function buildPanel(store, models) {
    createPanelShell();
    wirePanelControls();
    return panel;
  }

  // 头像渲染与取值。
  //
  // 所有条目（Spine 与 Live2D）都要能显示角色头像，头像来源外置可配（服务端解析）。
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

  /** 逐层筛选：一级按「游戏名命中」或「其下任一角色命中」；命中的角色整组显示（含其全部变体）。 */
  function visibleGamesOf(source) {
    const out = [];
    for (const g of source) {
      if (!keyword) { out.push(g); continue; }
      const gameHit = String(g.title).toLowerCase().includes(keyword);
      const chars = gameHit ? g.chars : g.chars.filter(charMatches);
      if (chars.length) out.push({ key: g.key, title: g.title, chars });
    }
    return out;
  }

  /** 一级：游戏行 HTML（箭头 + 游戏名 + 角色数）。 */
  function gameRowHtml(g, gOpen) {
    return `
        <div data-game="${g.key}" style="display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;border-left:2px solid #4a7">
          <span style="width:10px;color:#9aa">${gOpen ? '▾' : '▸'}</span>
          <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600">${g.title}</span>
          <span style="color:#8a9;font-size:11px">${g.chars.length}</span>
        </div>`;
  }

  /** 二级：角色行 HTML（角色组头像 + 显示名 + 绿色「原名」标签 + 变体数）。 */
  function charRowHtml(c, cOpen) {
    // 角色行的「原名」绿标签（取代早期只在名表 npc=true 时显示的 `NPC` 字面标签）。
    //
    // 取值规则：该角色组**归一化键** = charKeyOf(组内基础变体的原始资源名)。
    //   为什么用归一化键而不是基础变体的原样资源名：一个角色常有多个皮肤/变体
    //   （大凤组有 `dafeng_2/_hx/_3/_4/_6`），拿其中某一个变体代表整组既不准确，
    //   也会随变体增减而变；归一化后稳定且与名表键一致。
    //   实例：阿达尔伯特亲王组→`adaerbote`；大凤组→`dafeng`；`char060301`/`npc200551`/`aijierB` 不变。
    //
    // 覆盖范围：**所有角色都显示**（不再以 c.npc 为条件）。
    // 去重（工程判断）：名表未命中时行标题本身就是归一化名（charKeyOf(name)），可能与归一化键完全相同
    //   （例：`char003803` 角色组）——那种情况标签没有信息增量，只会显示成「char003803 char003803」，
    //   故省略标签；名表命中的角色一律显示。
    const baseName = c.variants.length ? charKeyOf(String(c.variants[0].name || '')) : '';
    const origTag = baseName && baseName !== String(c.title)
      ? `<span style="flex:0 0 auto;color:#8a9;font-size:10px;border:1px solid #4a5;border-radius:3px;padding:0 3px">${baseName}</span>`
      : '';
    return `
          <div data-char="${c.key}" style="display:flex;align-items:center;gap:6px;padding:3px 10px 3px 22px;cursor:pointer">
            <span style="width:10px;color:#9aa">${cOpen ? '▾' : '▸'}</span>
            ${iconHtml(groupIcon(c))}
            <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.title}</span>
            ${origTag}
            <span style="color:#8a9;font-size:11px">${c.variants.length}</span>
          </div>`;
  }

  /** 三级：变体行 HTML（类型标签 + 服装名/目录名）。 */
  function variantRowHtml(m) {
    const label = variantLabel(m);
    const nm = lookupName(m.name);
    // 服装名优先（来自名表）；无名表时退回目录名（含中文皮肤名，如「莱维亚-原皮技能（无甲）」）
    const dirName = (m.srcDir || '').split('/').slice(-1)[0] || '';
    const sub = (nm && nm.costume) ? nm.costume : (dirName || m.name);
    // 原名后缀（小号灰字，跟在主文本后面同一行、随主文本一起省略）：
    //   主文本本身就是原名时不重复显示，避免出现「X · X」。origName 统一 String() 化，
    //   防止 m.name 为空/非字符串时把 undefined 拼进可见文本。
    const origName = String(m.name || '');
    const showOrig = Boolean(origName) && sub !== origName;
    // 悬停提示：资源名 + 目录名；两者相同（目录名就是资源名）时只显示一次，避免「X  ·  X」
    const tip = `${origName}${dirName && dirName !== origName ? '  ·  ' + dirName : ''}`;
    return `
            <div data-variant="${m.id}" title="${tip}"
              style="display:flex;align-items:center;gap:6px;padding:4px 10px 4px 40px;cursor:pointer;color:#cfd6dd">
              <span style="${variantLabelStyle(m)}">${label}</span>
              <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sub}${showOrig ? ` · <span style="font-size:11px;color:#8a94a0">${origName}</span>` : ''}</span>
            </div>`;
  }

  /** 事件：一级开合游戏、二级开合角色、三级选中变体。 */
  function bindTreeEvents(body) {
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
  }

  /** 更新头部计数文案（游戏 / 角色 / 变体）。 */
  function updateCountText(visibleGames) {
    const totalChars = visibleGames.reduce((s, g) => s + g.chars.length, 0);
    const totalVariants = visibleGames.reduce(
      (s, g) => s + g.chars.reduce((t, c) => t + c.variants.length, 0), 0);
    const cnt = panel.querySelector('#ct-count');
    if (cnt) cnt.textContent = `${visibleGames.length} 游戏 / ${totalChars} 角色 / ${totalVariants} 变体`;
  }

  /**
   * 生成整棵可见树的行 HTML（三级：游戏 → 角色 → 变体）。
   *
   * 每个游戏最多渲染的角色行数 RENDER_LIMIT_PER_GAME。
   * 为什么按**游戏**限额而不是全局：实测天命之子有 2185 个 Live2D 角色且排序在棕色尘埃2 之前，
   *   用全局上限会被它一个游戏吃光，导致另一个游戏一个条目都显示不出来（自检发现）。
   * 思路：每个游戏各自计数，保证都有展示；超出部分提示用搜索缩小范围
   *   （搜索命中的结果通常很少，且 loading="lazy" 的头像也只会请求可见的那些）。
   */
  function buildRows(visibleGames) {
    const RENDER_LIMIT_PER_GAME = 400;
    const rows = [];
    let skipped = 0;
    for (const g of visibleGames) {
      // 展开规则（明确、无主观阈值）：
      //   ① 手动开合过的层保持其状态；② 有搜索词时一律展开到变体（搜什么就展开什么）。
      const gOpen = expandedGames.has(g.key) || keyword.length > 0;
      // 一级：游戏
      rows.push(gameRowHtml(g, gOpen));
      if (!gOpen) continue;

      let renderedHere = 0;
      for (const c of g.chars) {
        if (renderedHere >= RENDER_LIMIT_PER_GAME) { skipped++; continue; }
        renderedHere++;
        // 说明：早期版本这里有一条 Live2D「叶子条目」分支（单行 + 紫色自创徽标）。
        //   抽公共后 Live2D 与 Spine 同形（角色行 → 展开 → 变体行），
        //   该分支与自创紫色徽标一并删除，标签沿用变体行既有样式（由 variantLabel 给出 Spine/Live2D）。

        const cOpen = expandedChars.has(c.key) || keyword.length > 0;
        // 二级：角色 + 三级：变体
        rows.push(charRowHtml(c, cOpen));
        if (!cOpen) continue;
        for (const m of c.variants) rows.push(variantRowHtml(m));
      }
    }
    if (skipped) {
      rows.push(`<div style="padding:8px 10px;color:#9aa;font-size:11px;line-height:1.5">
        还有 ${skipped} 项未显示（每个游戏最多渲染 ${RENDER_LIMIT_PER_GAME} 行），请用上方搜索缩小范围</div>`);
    }
    return rows;
  }

  function render() {
    const body = panel && panel.querySelector('#ct-body');
    if (!body) return;

    const visibleGames = visibleGamesOf(tree);
    updateCountText(visibleGames);

    if (!visibleGames.length) {
      body.innerHTML = '<div style="padding:10px;color:#888">无匹配</div>';
      updateWidth();
      return;
    }

    body.innerHTML = buildRows(visibleGames).join('');
    bindTreeEvents(body);

    updateWidth();
  }

  /**
   * 确保「本地资源根」模型的文件内容已下载进对象（懒加载）。
   *
   * 为什么现在必须由本文件承担：
   *   server.mjs 注入的 local-roots.js 只在「点击 [data-mid]」时做懒加载拦截
   *   （捕获阶段拦下点击 → 下载 skeleton/atlas/贴图 → 重放点击）。
   *   本文件在挂载后已把原版左栏 DOM 删除，[data-mid] 不复存在 → 那条拦截永远不会触发，
   *   若只调 store.setCurrentModel(id) 会拿到「content 为空」的模型 → atlas/骨架读取失败、渲染空白。
   *   故这里把同一件事在本文件内做掉（类型规则与 local-roots.js 完全一致，见下）。
   *
   * 为什么必须填 content 而不是只给 url（local-roots.js 踩过的坑，此处照抄结论）：
   *   原版 读模型靠对象的 content 字段：atlas 取 string、json 骨架取 string、
   *   二进制 .skel 取 ArrayBuffer、贴图取 ArrayBuffer；仅给 url 会读到空内容。
   *
   * 复用优先：若将来 local-roots.js 把 ensureContent 暴露到 window.__LOCAL_ROOTS__，
   *   这里直接复用它（避免两份实现漂移）；否则用下面这份等价实现。
   */
  async function ensureLocalContent(m) {
    if (!m || !m.localRoot) return true;
    if (m.skeletonFile && m.skeletonFile.content && m.atlasFile && m.atlasFile.content) return true;

    const upstream = window.__LOCAL_ROOTS__ && window.__LOCAL_ROOTS__.ensureContent;
    if (typeof upstream === 'function') return upstream(m);

    const fetchOne = async (f, as) => {
      const r = await fetch(f.url);
      if (!r.ok) throw new Error(`${f.name} 下载失败: HTTP ${r.status}`);
      return as === 'text' ? r.text() : r.arrayBuffer();
    };
    const jobs = [];
    if (m.skeletonFile && !m.skeletonFile.content) {
      jobs.push(fetchOne(m.skeletonFile, m.format === 'json' ? 'text' : 'buffer')
        .then((c) => { m.skeletonFile.content = c; m.skeletonFile.size = c.byteLength || c.length; }));
    }
    if (m.atlasFile && !m.atlasFile.content) {
      jobs.push(fetchOne(m.atlasFile, 'text').then((c) => { m.atlasFile.content = c; m.atlasFile.size = c.length; }));
    }
    for (const t of (m.textureFiles || [])) {
      if (t && !t.content) {
        jobs.push(fetchOne(t, 'buffer').then((c) => { t.content = c; t.size = c.byteLength; }));
      }
    }
    await Promise.all(jobs);
    return true;
  }

  /**
   * 选中某个变体。
   * 优先复用 原版 原列表的 [data-mid] 元素并触发 click（走它自身的选中逻辑 +
   *   local-roots.js 的懒加载拦截）——**仅当原列表仍存在时**（兼容未删除左栏的部署）。
   * 原列表已被本文件删除时走自己的通道：补齐内容（ensureLocalContent）→ 直接设置当前模型。
   */
  // id -> 模型对象（Spine 与 Live2D 都在内）。点击变体时按 id 取回对象，
  //   Live2D 项需要对象本身（含 modelUrl 等）交给渲染舞台，Spine 项只需 id 触发原列表点击。
  const modelById = new Map();

  async function selectVariant(modelId) {
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

    // 资源包（bundle 根里的单文件）：交给声明了 bundle 种类的展示类型插件去读。
    // 这一步只做到"插件读取并回报素材"；渲染接线在后续阶段完成，失败时给出可读提示，
    //   不落到 Spine 路径上（那会因为没有 atlas/骨架而报出难以理解的错误）。
    if (m && m.kind === 'bundle') {
      const p = window.SpineViewerPlugins;
      const plug = p && p.pickFor ? p.pickFor('bundle') : null;
      if (!plug) {
        console.warn('[char-tree] 没有能读资源包的插件（plugins/ 下缺少展示类型插件）');
        return;
      }
      try {
        console.info(`[char-tree] 交给插件 ${plug.id} 读取资源包: ${m.name}`);
        const report = await plug.open({
          rootId: m.rootId, rel: m.rel, name: m.name, size: m.size,
          profile: m.profile, host: p.host,
        });
        console.info(`[char-tree] 资源包读取完成: ${m.name}`, {
          moc3: report.moc3 && report.moc3.bytes,
          physics3: report.physics3 && report.physics3.bytes,
          textures: report.textures.map((t) => `${t.name} ${t.width}x${t.height}`),
          motions: report.motions ? report.motions.length : 0,
          groups: report.motionGroups,
        });
        // 渲染：插件已把素材拼成与现有 Live2D 模型同形的对象（kind:"live2d" + modelUrl + motions），
        //   这里直接交给现有 Live2D 舞台 —— 复用它的渲染、原版右栏动作区与公共事件层。
        const stage = window.__LIVE2D_STAGE__;
        if (report.model && stage) {
          // 装载前先让插件准备好内存资源通道（blob: URL 需要页面加载器的中间件先就位）
          if (typeof report.model.prepare === 'function') await report.model.prepare();
          const ok = await stage.show(report.model);
          console.info(`[char-tree] 资源包交给 Live2D 舞台渲染: ${ok ? '成功' : '失败'}`);
        } else if (report.model) {
          console.warn('[char-tree] Live2D 舞台未就绪，资源包已解析但未渲染');
        }
      } catch (e) {
        console.error(`[char-tree] 资源包读取失败（${m.name}）: ${e.message}`);
      }
      return;
    }

    // Spine：走原有加载路径。
    //
    // 揭盖顺序（踩坑，必须按此顺序）：**不能在装载新模型之前收起 Live2D 盖层**。
    //   盖层一收，Spine 画布立刻亮出来，而画布上仍是上一张 Spine 的最后一帧
    //   （切到 Live2D 时只是把画布藏起来，没有清屏）——于是画面先"回跳"到上一张 Spine，
    //   等新模型装好再切过去；实测这个中间态持续约 2.3 秒（2000ms 级）。
    //   正确顺序：先在盖层后面把新模型装好（引擎照常渲染到那张被藏起来的画布上），
    //   装载完成后再收盖层 + 亮出画布，从 Live2D 一步切到新 Spine。
    const stage = window.__LIVE2D_STAGE__;
    const wasL2dActive = !!(stage && stage.isActive());
    const store = window.__SPINE_STORE__;
    // 切换前记下 Spine 画布内容（上一张 Spine 的最后一帧）：收起盖层前要等它变掉
    const digestBefore = wasL2dActive ? spineCanvasDigest() : null;
    // 持住"揭盖"：切换期间盖层可以收（引擎自己也会收），但 Spine 画布先不亮出来，
    //   等新模型首帧画好再释放——否则会先亮出上一张 Spine 的最后一帧（中间回跳）。
    if (wasL2dActive && stage && typeof stage.holdSpineCover === 'function') stage.holdSpineCover(7000);

    try {
      const el = document.querySelector(`[data-mid="${modelId}"]`);
      if (el) {
        el.click();
      } else {
        // 原列表已删除（removeOriginalSidebar）→ 本文件自己保证内容就绪后直设当前模型。
        // 这与 local-roots.js 的「拦截点击 → 下载 → 重放点击」是同一件事的两个半程。
        if (!store) return;
        try {
          await ensureLocalContent(m);
        } catch (e) {
          console.error('[char-tree] 模型内容加载失败:', e.message);
          return;
        }
        // 重选同一模型时先置空，令响应 currentModel 的 effect 重新执行（local-roots.js 同款兜底）
        if (m && store.getState().currentModelId === modelId) store.getState().setCurrentModel(null);
        store.getState().setCurrentModel(modelId);
      }
      // 等引擎在新模型上真的画出第一帧，再收盖层
      if (wasL2dActive) await waitSpineFirstFrame(store, modelId, digestBefore, 6000);
    } finally {
      // 兜底：无论走哪条路径（含异常/超时/取消），盖层都必须收掉，
      //   否则会卡在 Live2D 画面里出不来。
      if (wasL2dActive) stage.hide();
      // 释放揭盖保持：此时画布上已是新模型的首帧（或已超时兜底），亮出来即可；
      //   没有 hold/release API 时退回 hide() 自己亮（旧行为）。
      if (wasL2dActive && stage && typeof stage.releaseSpineCover === 'function') stage.releaseSpineCover();
    }
  }

  /**
   * Spine 画布内容指纹：把画布缩到 48×27 采样，返回 { sum, ink }。
   *   sum 是像素加权和（内容变化即变），ink 是非透明采样点数（空画布≈0）。
   * 用途：判断引擎是否已经在新模型上画出了第一帧——这是"能不能收起 Live2D 盖层"的判据。
   */
  function spineCanvasDigest() {
    try {
      const cv = document.querySelector('canvas.absolute.inset-0');
      if (!cv) return null;
      const c2 = document.createElement('canvas');
      c2.width = 48; c2.height = 27;
      const g = c2.getContext('2d');
      g.drawImage(cv, 0, 0, 48, 27);
      const d = g.getImageData(0, 0, 48, 27).data;
      let sum = 0; let ink = 0;
      for (let i = 0; i < d.length; i += 4) {
        sum = (sum + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7 + d[i + 3]) % 999983;
        if (d[i + 3] > 8) ink++;
      }
      return { sum, ink };
    } catch { return null; }
  }

  /**
   * 等引擎把新 Spine 模型的第一帧画到画布上。
   *
   * 为什么不能只看 store：store 里的模型对象会被引擎装载时**就地补上** animations / boneCount，
   *   同一个模型重选时这些字段已经在（缓存），只看 store 会在"还没重画"时就放行，
   *   于是一收盖层，画面上仍是上一张 Spine 的最后一帧——中间回跳仍在。
   * 判据（实测）：显示 Live2D 期间引擎是停的、Spine 画布内容冻结不变；
   *   所以「画布内容与切换前不同」且「画布确实有内容（ink > 8）」即表示新模型已经画上去了。
   * 超时（默认 6 秒）返回 'timeout'：调用方照常收盖层，画面不会一直停在盖层后面。
   */
  function waitSpineFirstFrame(store, modelId, before, timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const limit = timeoutMs || 6000;
      let firstLogged = false;
      const check = () => {
        let onTarget = false;
        try { const cm = store && store.getState().currentModel; onTarget = !!(cm && cm.id === modelId); } catch { onTarget = false; }
        const d = spineCanvasDigest();
        const hasInk = !!(d && d.ink > 8);
        const changed = !!(before && d && (d.sum !== before.sum || d.ink !== before.ink));
        const pass = onTarget && hasInk && (changed || !before);
        const fmt = (x) => (x ? `${x.sum}/${x.ink}` : 'null');
        // 观测点：让运行日志自证判据（每次切换只打两行：首次轮询 + 判定通过）
        if (!firstLogged) {
          firstLogged = true;
          console.info(`[char-tree] 等 Spine 首帧：切换前=${fmt(before)} 当前=${fmt(d)} onTarget=${onTarget} 内容已变=${changed}`);
        }
        if (pass) {
          console.info(`[char-tree] Spine 首帧就绪（等 ${Date.now() - t0}ms）：切换前=${fmt(before)} 现在=${fmt(d)}`);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve('ready')));
          return;
        }
        if (Date.now() - t0 > limit) {
          console.warn(`[char-tree] 等 Spine 首帧超时（${limit}ms）：切换前=${fmt(before)} 当前=${fmt(d)} onTarget=${onTarget} 有内容=${hasInk} —— 照常收盖层`);
          resolve('timeout');
          return;
        }
        setTimeout(check, 40);
      };
      check();
    });
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
  /**
   * ①a 按资源根拉取名表与 Live2D 模型列表（各自失败互不影响整体）。
   *   名表让归组按「真实角色」进行（同一角色的多套服装/技能归到一起），并在界面上显示角色名与服装名；
   *   拉取失败不影响基本使用（退回按资源名归组）。Live2D 与 Spine 是两套扫描接口，这里一并取回。
   */
  async function fetchNamesAndLive2D(tables, live2dModels, bundleModels) {
    const rootsData = await api('/api/roots');
    for (const r of (rootsData.roots || [])) {
      try {
        const d = await api(`/api/names?root=${encodeURIComponent(r.id)}`);
        if (d && d.tableId && d.characters) tables.set(d.tableId, d);
      } catch { /* 单个资源根无名表不影响整体 */ }
      const rootKind = r.kind || 'spine';
      if (rootKind === 'bundle') {
        // 资源包根：文件是 UnityFS 单文件（常常**没有扩展名**），服务端已按魔数识别，
        //   这里把它们做成与 Spine/Live2D 同形的条目，进同一棵三级树（按名表归组）。
        // profile 一并带上：插件据此选 profiles/<游戏>.json，游戏差异不进代码。
        try {
          const d = await api(`/api/tree?root=${encodeURIComponent(r.id)}`);
          for (const f of (d.files || [])) {
            if (f.kind !== 'bundle') continue;
            bundleModels.push({
              id: `bundle:${r.id}:${f.rel}`,
              name: f.name,
              kind: 'bundle',
              rootId: r.id,
              rootName: r.name,
              profile: r.profile || null,
              rel: f.rel,
              size: f.size,
              container: f.container,
            });
          }
        } catch { /* 单个资源根读失败不影响整体 */ }
        continue;
      }
      // Live2D：与 Spine 是两套扫描接口，这里一并取回并合并到同一棵树
      try {
        const d = await api(`/api/live2d/models?root=${encodeURIComponent(r.id)}`);
        for (const m of (d.models || [])) live2dModels.push(m);
      } catch { /* 单根失败不影响整体 */ }
    }
    if (live2dModels.length) {
      console.info(`[char-tree] 并入 ${live2dModels.length} 个 Live2D 模型（与 Spine 显示在一起）`);
    }
    if (bundleModels.length) {
      console.info(`[char-tree] 并入 ${bundleModels.length} 个资源包条目（交展示类型插件读取）`);
    }
  }

  /**
   * ①b 存档指向 Live2D 时**提前恢复**（不等 Spine 模型注入完成）。
   * 为什么：原版 注入模型时会把「本批第一个 Spine 模型」设为当前模型并立即加载
   *   （即界面呈现的「默认」模型）；若存档里是 Live2D，等到 Spine 注入后才恢复，
   *   中间就会先渲染一次那个默认。提前显示 Live2D 覆盖层可把它盖住。
   * 用「最后活跃那个游戏的上次模型」（每个游戏各有一个默认值）。
   */
  function restoreEarlyLive2D(live2dModels) {
    const earlyId = readSavedTargetId();
    if (!earlyId || !String(earlyId).startsWith('live2d-')) return;
    const m = live2dModels.find((x) => x.id === earlyId);
    const stage = window.__LIVE2D_STAGE__;
    if (!m || !stage) return;
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

  /** ①c 合并各资源根的名表到全局 nameTable（同一份名表只取一次；无表时退回按资源名归组）。 */
  function mergeNameTables(tables) {
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
  }

  /** ① 拉名表 + Live2D 列表；若存档指向 Live2D 则提前恢复（不等 Spine 注入）。返回 Live2D 模型数组。 */
  async function prepareSources() {
    const live2dModels = [];
    const bundleModels = [];
    const tables = new Map();
    try {
      await fetchNamesAndLive2D(tables, live2dModels, bundleModels);
      restoreEarlyLive2D(live2dModels);
      mergeNameTables(tables);
    } catch (e) {
      console.warn('[char-tree] 拉取名表失败（不影响使用）:', e.message);
    }
    return { live2d: live2dModels, bundles: bundleModels };
  }

  // ② 等 Spine 模型注入完成 → 与 Live2D 合并 → 建树 → 恢复展开态与上次选中。返回 Spine 模型数组。
  async function buildTreeAndRestore(store, sources) {
    const live2dModels = (sources && sources.live2d) || [];
    const bundleModels = (sources && sources.bundles) || [];
    // 再等 Spine 模型注入完成（放在 Live2D 提前恢复之后，避免先渲染出默认模型）
    const models = await waitLocalModels(store);
    console.info(`[char-tree] 收到 ${models.length} 个本地模型`
      + `（另并入 Live2D ${live2dModels.length} 个、资源包 ${bundleModels.length} 个）`);

    // Spine + Live2D + 资源包合并成一棵树；同时建 id -> 模型 映射（点击变体时按 id 取回对象，
    // Live2D/资源包项需要对象本身交给渲染舞台或展示类型插件）
    const allModels = models.concat(live2dModels, bundleModels);
    allModelsRef = allModels;
    // 等展示类型插件完成注册：变体标签文字由插件声明（如「Live2D包」），
    //   不等就会先按兜底值算一遍统计与 DOM（实测踩过：统计里出现兜底标签）。
    const pluginHost = window.SpineViewerPlugins;
    if (pluginHost && typeof pluginHost.ready === 'function') {
      const how = await pluginHost.ready({ timeoutMs: 3000 });
      console.info(`[char-tree] 插件宿主就绪（${how}），已注册插件 ${pluginHost.list().length} 个`);
    }
    modelById.clear();
    for (const m of allModels) modelById.set(m.id, m);

    tree = buildTree(allModels);
    // 展开状态：默认**全部收起**；若浏览器里存有上次的状态则恢复（刷新加载回上次的）
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

    // 恢复上次选中的模型（刷新后加载回上次浏览器看的内容）。
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


    return models;
  }

  // ③ 挂面板 + 显隐接线 + 删除原版左栏 + 首屏自检日志 + resize 监听。
  /** ③b 首屏自检日志：报告面板状态与树规模（便于无人值守验证，不依赖截图 / dump）。 */
  function logMountSelfCheck() {
    const body = panel.querySelector('#ct-body');
    // 分别核对左右侧栏的显示状态。
    // 为什么必须分开查：`bv-sidebar` 这个类**左右两个侧栏共用**，
    //   只查第一个匹配（左栏）会漏掉「右栏被一并隐藏」的问题——实测踩过这个坑。
    //   期望：左栏隐藏、右栏保持可见（右栏是菜单面板：动画/皮肤/混合模式等）。
    //   注意要查侧栏元素**自身**的 computed display；查其内部子元素会得到子元素自己的
    //   display 值（非 none），从而误判为「没隐藏」。
    const asides = [...document.querySelectorAll('.bv-sidebar')];
    const dispOf = (el) => (el ? getComputedStyle(el).display : 'N/A');
    // 变更说明（2026-10-14）：左栏已在挂载阶段被**删除 DOM**（不再只是 display:none），
    //   所以这里不再期望查到 leftAside；改为报告「删除是否彻底」，右栏仍按原样核对。
    const leftStillThere = asides.some((el) => String(el.className).includes('left-0'));
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
      + `左栏DOM=${leftStillThere ? '仍存在(异常)' : '已删除'} `
      + `右栏可见=${rightAside ? dispOf(rightAside) !== 'none' : '未挂载(需点顶部「菜单」) '}`
      + `面板=${panelHidden ? '已收起' : '展开'} `
      + `顶栏模型库按钮=${(() => { const b = document.querySelector('header button[title="模型库"]'); return b ? (b.getAttribute('data-ct-panel-state') || '未接线') : '未找到'; })()} `
    );
  }

  function mountPanelAndWire(store, models) {
    injectStyle();
    buildPanel(store, models);

    // ---- 面板显隐接线 + 删除原版左侧栏 ----
    // 1) 顶栏「模型库」按钮改控本面板（阻断 React 对原版栏的 toggle，见 wireHeaderModelButton）
    // 2) 把原版左侧栏从 DOM 删除（首帧仍由 server.mjs/本文件的 CSS 隐藏，不会闪）
    // 3) 初始同步一次状态：面板默认展开，顶栏按钮呈展开态
    wireHeaderModelButton();
    const removedSidebars = removeOriginalSidebar();
    setPanelHidden(false);
    // 自检标记：便于确认浏览器加载到的是本次改动后的脚本（避免静态缓存旧版本）
    window.__CHAR_TREE_PANEL_API__ = { toggle: togglePanel, setHidden: setPanelHidden, isHidden: isPanelHidden };
    window.__CHAR_TREE_VERSION__ = '2026-10-14-panel-toggle';
    console.info(`[char-tree] 原版左栏已删除 ${removedSidebars} 个节点；`
      + `顶栏「模型库」按钮已接线（panelId=${PANEL_ID}）`);

    // 默认全部收起（不预展开任何角色）。
    // 说明：此前曾"默认展开前 3 个角色"，那只是为了让二级效果一眼可见的主观选择，
    //   规则不明确（为什么是前 3 个？），已去掉。展开规则改为：
    //   ① 启动/切换时全部收起；② 搜索时自动展开所有命中的角色（见 render）。
    render();
    logMountSelfCheck();

    // 插件**迟到注册**时重建树：变体标签文字取自插件声明，插件晚到就必须重算一次
    //   （统计窗口 __CHAR_TREE_STATS__ 也在 buildTree 里刷新），否则标签会停在兜底值。
    window.addEventListener('spineviewer:plugin-registered', () => {
      if (!allModelsRef) return;
      const before = JSON.stringify(window.__CHAR_TREE_STATS__ && window.__CHAR_TREE_STATS__.labels);
      tree = buildTree(allModelsRef);
      const after = JSON.stringify(window.__CHAR_TREE_STATS__ && window.__CHAR_TREE_STATS__.labels);
      if (before !== after) {
        console.info(`[char-tree] 插件注册后重算变体标签: ${before} → ${after}`);
        render();
      }
    });

    // 窗口尺寸变化时重算宽度。
    //
    // 变更说明（同功能重构）：此前还监听了 .bv-sidebar 的 ResizeObserver 并做 3 秒轮询，
    //   用于跟随侧栏的开合动画对齐位置；现在侧栏已整体隐藏、定位改为 CSS 固定值，
    //   这两项都失去意义，故去掉（保留 resize 以在窗口变化时重算宽度）。
    window.addEventListener('resize', positionPanel);
  }

  // ④ 自检钩子（默认不触发）：?selftest=state|switch|picker|rightbar|<模型名> / ?select=<id 子串>
  function installSelfChecks(qs, store) {
    // 自检钩子（默认不触发）：
    //   ?selftest=state   展开第一个游戏与角色并选中第一个变体（用于验证刷新后能否恢复）

    // ?selftest=switch&game=<游戏名>
    //   在同一游戏内先选 Live2D 模型、再选 Spine 模型，检查切换后是否**残留**：
    //   覆盖层是否收起、Spine 画布是否恢复可见、Spine 模型是否真的被选中。
    if (qs.get('selftest') === 'switch') hookSelftestSwitch(qs);

    if (qs.get('selftest') === 'state') hookSelftestState(qs);

    // 自检钩子（默认不触发）：
    //   ?selftest=picker    点击「选择目录」，验证目录浏览器是否真的弹出（端到端验证按钮接线）
    //   ?selftest=<模型名>  逐个点击同名变体并报告各自填充的 atlas/skel 内容长度
    //   ?select=<id 子串>   只选中匹配的一个模型（用于渲染对比）
    
    if (qs.get('selftest') === 'picker') hookSelftestPicker();

    // 验证右侧栏（菜单面板）未被误隐藏：点顶部工具栏的「菜单」按钮后应能出现且可见。
    if (qs.get('selftest') === 'rightbar') hookSelftestRightbar();

    hookSelectParam(qs, store);

    hookSelftestByName(qs, store);
  }

  /** ④a ?selftest=switch&game=<游戏名>：同一游戏内先选 Live2D 再选 Spine，检查切换后是否残留。 */
  function hookSelftestSwitch(qs) {
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

  /** ④b ?selftest=state&kind=spine|live2d：展开第一个游戏与角色并选中第一个变体（验证刷新后能否恢复）。 */
  function hookSelftestState(qs) {
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

  /** ④c ?selftest=picker：点击「选择目录」，验证目录浏览器是否真的弹出（端到端验证按钮接线）。 */
  function hookSelftestPicker() {
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

  /** ④d ?selftest=rightbar：验证右侧栏（菜单面板）未被误隐藏——点顶部「菜单」后应出现且可见。 */
  function hookSelftestRightbar() {
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

  /** ④e ?select=<id 子串>：只选中匹配的一个模型（用于渲染对比）。 */
  function hookSelectParam(qs, store) {
    const selectParam = qs.get('select');
    if (!selectParam) return;
    setTimeout(() => {
      const m = (store.getState().models || []).find(
        (x) => x.localRoot && String(x.id).includes(selectParam));
      if (!m) { console.warn('[select] 未找到匹配模型:', selectParam); return; }
      console.info(`[select] 选中 id=${m.id} srcDir=${m.srcDir}`);
      const el = document.querySelector(`[data-mid="${m.id}"]`);
      if (el) el.click(); else store.getState().setCurrentModel(m.id);
    }, 3000);
  }

  /**
   * ④f ?selftest=<模型名>：逐个点击同名变体并报告各自填充的 atlas/skel 内容长度。
   *   '1' 是「自动点击第一个模型」的旧约定，'picker' 是上面的目录选择器自检——
   *   两者都不是模型名，需排除，否则会被当成模型名去找而输出无意义的「找到 0 个变体」。
   */
  function hookSelftestByName(qs, store) {
    const stParam = qs.get('selftest');
    if (!stParam || stParam === '1' || stParam === 'picker') return;
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

  /** 主流程：准备数据源 → 建树并恢复状态 → 挂面板接线 → 安装自检钩子。 */
  async function main() {
    const store = await waitStore();
    const sources = await prepareSources();
    const models = await buildTreeAndRestore(store, sources);
    mountPanelAndWire(store, models);
    installSelfChecks(new URLSearchParams(location.search), store);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { main().catch((e) => console.error('[char-tree]', e)); });
  } else {
    main().catch((e) => console.error('[char-tree]', e));
  }
}
