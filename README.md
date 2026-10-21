# Spine Multi Viewer（暂定名）

> ⚠️ **项目名待定**：当前目录名 `spine-multi-viewer` 为占位名，改名需同步目录 + README + git remote。

从 原版 拆分而来的模块化 Spine 动画预览器，目标是演进成**多游戏通用**的 Spine / Live2D 查看器。

---

## 开发方向（2026-10-17 起）

**重心转向功能层；现有前端仅作行为参考，后续将更换前端框架。**

- 投入优先级：**能力层/接口** > 前端交互细节
- 能力层 = 服务端 API + 插件机制 + 纯函数解析库（`plugins/*/lib/*.js`）+ 诊断探针；这些与前端框架无关，换框架时零改动
- 现有 `legacy/patches/*.js`（角色库树、设置导入导出、本地根等）属**现前端实现**，不构成契约，新前端不必移植
- 新前端接入所需的接口、契约与已知缺口，见 [doc/参考-功能层接口清单.md](doc/参考-功能层接口清单.md)
- 后续新增功能应优先落在能力层（API / 插件 / 纯函数），前端只做展示与交互

---


## 致谢与来源

**前端界面（布局、结构与样式）借用自 [Boneview](https://github.com/souling01/spine-viewer-webgl)（作者 souling01）**；本项目在其渲染产物基础上做参数化与能力扩展，服务端、插件机制、解析与导出工具链均为本项目自行实现。

- 原项目在线版：https://souling01.github.io/spine-viewer-webgl/
- 原项目未声明 LICENSE（`license: null`），默认保留全部权利

## 合规状态（重要）

| 项目 | 许可证 | 影响 |
|---|---|---|
| Boneview（前端界面来源） | **无 LICENSE（`license: null`）** | 默认保留全部权利 |
| Spine Runtimes（本工具内联使用） | 自定义协议（NOASSERTION） | 受 Spine Runtimes License Agreement 约束 |
| spive2d（同为参考项目，非本库代码） | MIT | 若将来以其为基础重做，需保留 MIT 声明 |

**当前状态**：本仓库为**私有、本地自用**，不对外分发，也不部署到公开 Pages。

## Spine Runtimes 申明（保留自原 README 第 66 行）

> 本工具使用官方 Spine Runtimes（[Esoteric Software](https://esotericsoftware.com)），受 [Spine Runtimes License Agreement](https://esotericsoftware.com/spine-runtimes-license) 约束。集成预览可以，但每个使用 Spine 数据的终端用户仍需拥有 Spine 编辑器授权。

**仓库内不含任何游戏提取资源**（BD2 / 碧蓝航线等模型文件均不入库）。

---

## 为什么拆分

原版 是 **4.17 MB 单文件**（`index.html`），其中 **3.39 MB（81%）** 是内联的 7 个 Spine 版本运行时源码字符串，应用代码仅约 0.8 MB 且为压缩混淆态。在 4.17 MB 单行文件上做功能迭代成本极高。

拆分后：

| 阶段 | 基线 | 现在 |
|---|---|---|
| 单文件体积 | 4.17 MB | 外壳 `legacy/source/app-shell.html` 仅 **798 KB** |
| Spine 运行时 | 内联字符串，不可读 | `src/spine-runtimes/*.js` **7 个独立可读文件**（3.2 MB，带缩进与真实变量名） |
| 构建 | 无 | `tool/build.mjs` 一键打包回单文件 |

**关键设计**：**开发用模块化，发布打包成单文件**。
因 原版 核心特性是 `file://` 双击即用，运行时若改外链会被浏览器 CORS 拦截（与 8792 站点"双击打不开"同一坑），故构建时必须**内联回字符串**（原逻辑 `evalRuntimeIsolated` 用 `new Function` 执行该字符串）。

## 目录结构

```
spine-multi-viewer/
├── server.mjs               本地服务：静态托管 + 资源扫描 + 路由（零依赖）
├── server.sh / web.sh       两个前端的启停脚本（旧 8803 / 新 8804）
├── src/                     在演进的新实现
│   ├── web/                 新前端（纯 HTML + 原生 ES 模块 + 手写 CSS，无构建）
│   ├── server/              服务端数据层（catalog/tree/models/live2d/plugins…）
│   └── spine-runtimes/      7 个 Spine 运行时源码（**不入库**，见 .gitignore）
├── legacy/                  既有实现（只读参考，不再演进）
│   ├── source/              从产物提取的可读源码（engine.js / app-shell.html / js/**）
│   ├── baseline/            原版基线（4.17 MB，等价性校验 + 运行时兜底来源）
│   ├── patches/             注入到旧前端的补丁脚本（local-roots / char-tree / live2d-stage…）
│   └── extract-tools/       提取与回填工具（build-* / rebuild-from-slices / slices.json）
├── dist/index.html          旧前端的构建产物（8803 实际服务对象；**不入库**）
├── runtime/                 运行时产物：*.log / *.pid（**不入库**，由启停脚本创建）
├── plugins/                 展示类型插件（声明 fileKinds，按能力提供解析）
├── config/                  资源根配置 + 角色名表 + 自动生成的资源清单（清单不入库）
├── data/                    上游名表源数据留档、诊断日志等运行数据
├── doc/                     文档，按前缀分类
│   ├── 架构-*.md            分层与接口规范（基础能力/插件、模型来源、扩展性）
│   ├── 任务-*.md            任务看板与验收口径
│   ├── 参考-*.md|html       实现参考（面板结构、schema、色板、渲染要点）
│   └── 记录-YYYY-MM-DD-*.md  按日期的执行记录与决策留档
├── tool/                    运行期工具（探测/校验/截图对比/导入导出）
└── test/                    验证脚本（*-actions.js 页面动作；*.test.mjs 纯模块单测）

命名约定：文档「分类-主题.md」，历史记录「记录-YYYY-MM-DD-主题.md」；代码小写 kebab；
测试分两类：`*-actions.js`（浏览器内动作断言）、`*.test.mjs`（node --test 纯模块单测）。

已中止的实验：前端复刻（rebuild/ + dist-rebuild/，2026-10-14 中止）——现场移 .trash/，
git 已出库（历史保留可回溯）。
```

`legacy/patches/live2d-stage.js` 的两条几何约定（决定「模型画在哪、多大」）：

- **覆盖层几何 = Spine 画布 rect**：`syncRect()` 把 Spine 画布的 `getBoundingClientRect()` 逐值写进覆盖层的 `left/top/width/height`（铺满整窗），所以 Live2D 的可视舞台与 Spine 完全一致（同尺寸同位置，背景/棋盘格覆盖范围也一致）。覆盖层是 `pointer-events:none`，因此铺满不会挡住左右侧栏。
- **渲染器尺寸随覆盖层校准**：`fitAppToOverlay()` 在「PIXI app 创建后」与「每次 `syncRect()` 写完覆盖层尺寸后」把 `renderer.width/height`（除以 resolution）与覆盖层实际 CSS 尺寸对齐，随后把 canvas 的 `style` 拉回 `100%` 并重排模型；`ResizeObserver` 同时观察**覆盖层**与 **Spine 画布**。
  只靠 PIXI 的 `resizeTo` 不够：它只跟随 window resize，而 app 可能在覆盖层还没有尺寸时创建 → 渲染器停在 PIXI 默认 800×600，模型会被居中到 800×600 的逻辑空间里（表现为「模型缩在左上角、被角色库面板盖住」）。

## 本地资源根（指定本机设备文件夹）

解决原 原版「每次都要手动选文件夹导入、刷新即丢」的问题：项目直接指定本机资源目录，
打开页面即自动加载。

### 当前已接入的资源（实测规模）

| 资源根 id | 游戏 | 类型 | 模型数 | 说明 |
|---|---|---|---|---|
| `bd2` | 棕色尘埃2 | Spine 4.1 | 425 | 原版立绘/技能 |
| `spine_mod` | 棕色尘埃2 | Spine 4.1 | 56 | Mod 包（与 bd2 共用名表与头像） |
| `live2d` | 天命之子 | Live2D Cubism 2 | 2185 | 目录名即角色 ID，名字来自社区数据 |
| `azurlane` | 碧蓝航线 | Live2D Cubism 4 | 178 | 目录名为拼音，无名字表/无头像 |
| `azurlane_spine` | 碧蓝航线 | Spine 3.8 | 202 | 立绘（`azurlane_spinepainting`） |

> **同名资源根会合并为一个游戏条目**：`bd2` 与 `spine_mod` 都是「棕色尘埃2」；
> `azurlane`（Live2D）与 `azurlane_spine`（Spine）都是「碧蓝航线」。
> 合并后同一角色的不同来源归到一起——实测碧蓝航线：
> `aerbien` → `aerbien_3`(Live2D) + `aerbien_4`(Spine)；`aidang` → `aidang_2` + `aidang_6`。
> 归组键取自资源名去掉 `_N` 皮肤后缀（无名字表时），Live2D 目录名与 Spine 的 atlas 名恰好同源。
>
> **后缀归一化（含 `_hx`）**：Live2D 与 Spine 走同一套规则 ——
> ① 先按资源名**原样**查角色名表；② 未命中则剥掉换装后缀 `_hx` 再查一次；③ 仍未命中再剥尾部 `_N`；④ 三级都未命中才用归一化名（剥 `cutscene_` / `_hx` / `_N`）当分组键。
> 依据与实测（`config/names/azurlane.json` 的 `byAsset` 2,557 条里带 `_hx` 的键只有 1 条，而碧蓝 Live2D 查不到名表的 15 个模型**全部**是 `_hx` 尾缀）：
> 剥掉 `_hx` 后 `dafeng_2_hx → dafeng_2` 命中「大凤 / 服装=毒苹果」，于是这些换装变体得以并进各自角色组。
> 碧蓝 Live2D 实测：**119 个模型 → 78 个角色条目**，名表命中 **104 条原样 + 15 条归一 = 119/119**。

### 两种添加方式

1. **界面添加**（推荐）：页面左栏「＋资源根」→ 浏览本机目录 → 填显示名称 → 添加。
   服务端校验后**自动写入** `config/resources.json`，无需手改文件。
2. **手改配置**：编辑 `config/resources.json`（JSONC，支持 `//` 注释）。

### 显示名称 = 归一 key

`name`（显示名称）同时作为**归一依据**：不同资源根若 `name` 相同，界面合并为一个游戏。
典型用法：BD2 原版资源与 Mod 资源都命名为「棕色尘埃2」→ 合并显示，原版与 Mod 共存不覆盖。
`id` 仅作内部唯一标识（从路径派生，撞名自动加后缀）。

### 模型标识（归一 key）来自 atlas 内容

模型的标识取自 **`.atlas` 文件内容首行的贴图名**（去扩展名 + 转小写），
而不是目录名。原因：同一资源的目录命名可能大小写不统一（实测 `Char000203_2` 与 `char000203`），
且不同资源根层级各异；而 atlas 引用的贴图名是资源内部一致的信息，用它归一更可靠。

刻意**不做**多余加工：保留 `cutscene_` 前缀（立绘/技能是真实区分）、保留 `_2`/`_3` 形态后缀。
纯 png 目录（缺骨架或图集）不构成可加载模型，自动跳过。

### 清单缓存（解决刷新重载）

服务端扫描资源目录后，把结果**落盘**为 `config/models.<rootId>.json`，前端每次刷新只读清单：

| 环节 | 耗时 |
|---|---|
| 首次扫描（BD2，424 个模型） | 约 0.45s |
| **命中清单缓存** | **约 0.02–0.03s** |

相比「前端递归调用数百次 `/api/tree`」的旧做法（刷新需数十秒），这是数量级的改善。
强制重扫：请求 `/api/models?root=<id>&refresh=1`，或删除对应清单文件。

### 模型内容懒加载

清单只含**元数据**（不下载 `.skel`/`.atlas`/`.png` 内容），页面加载因此很快。
点击某个模型时才由前端下载该模型的三件套并填入 `content`（捕获阶段拦截点击，
补完内容后重新触发），做到「点哪个才下载哪个」。

> 为什么必须填 `content`：原版 读取模型靠对象内的 `content` 字段而非 `url`——
> 仅给 url 会报「atlas 文件为空或无法读取」。类型要求：atlas→string、
> skel(二进制)/png→ArrayBuffer。

> ⚠️ **刷新时首个模型必须先预填内容**（否则每次刷新都会先弹一次「atlas 文件为空或无法读取」）：
> 原版实现的 `addModels` 在「追加模式且当前无选中模型」时，会把**本批第一个模型**设为当前模型
> （`currentModelId: ... ?? y?.id`，`y` 即本批首项）；而响应 `currentModel` 变化的 effect 会
> **立即加载**它，且只对 `source === "demo"` 补内容（用户模型不补）。
> 因此 `local-roots.js` 在调用 `addModels` **之前**先 `ensureContent(all[0])`，
> 让首次自动加载即成功；并对「已有旧选中」的情况加了补内容后重新触发加载的安全网。

## 左栏三级树（游戏 → 角色 → 变体）

原作者左侧边栏对应的 DOM 已被**整体移除**（不是简单隐藏：`legacy/patches/char-tree.js` 移除节点并持续守护，
避免 React 重渲染把它放回来），界面改由本项目自己的面板承载。左栏用**三级树**：

- 面板显隐**只由顶栏「模型库」按钮控制**（用与原版一致的滑出 + 淡出过渡：`opacity` + `translateX(-320px)`，不是 `display` 切换）
- 面板内只有**两个按钮**：「选择目录」（打开服务端目录浏览器、添加资源根）与「收起」（**只收起树节点**，面板保留）
- 原版右侧栏（菜单面板：动作 / 皮肤 / 播放 / 滤镜…）保持原样不动，是 Live2D 与 Spine 共用的唯一控制面板

| 层级 | 内容 | 来源 |
|---|---|---|
| 一级 | **游戏名** | 资源根配置的 `name` 字段；**同名资源根合并**为一个条目 |
| 二级 | **角色** | 角色名表（`config/names/*.json`）；无名表时退回资源名推导的角色键。**Live2D 与 Spine 走同一条分组路径** |
| 三级 | **变体** | 该角色的各套模型：Spine 立绘/技能各版本 + Live2D 各换装 |

```
▾ 棕色尘埃2                        109          ← 一级：游戏（默认展开）
    ▸ Lathel                        8          ← 二级：角色（默认收起）
    ▾ Justia        16
         Spine  Pool Party
         Spine  Pool Party 2
    ▾ 大凤            5
         Live2D 毒苹果
         Live2D 毒苹果
         Live2D 放学后的甜蜜时光
         Live2D 凤鸣春晓
         Live2D 海滨的白日美梦
```

**标签体系（两种，不再细分）**

- 变体标签只有两个：**`Spine`**（蓝底 `#2b6cb0`）与 **`Live2D`**（紫底 `#6d28d9`）。
  历史版本曾按资源名再细分成「技能 / 技能N」（`cutscene_*`）与「NPC」（`npc*`），现已收敛为类型标签。
- 角色行有**绿色「原名」标签**：显示该角色组的**归一化键**（`charKeyOf(基础变体的 name)`：剥 `^cutscene_`、`_hx`、尾部 `_\d+`，例如 `adaerbote`、`dafeng`、`char060301`、`npc200551`、`aijierB`）。这样「被中文名替换掉的原始名」仍然可见，且多皮肤角色不会随变体增减而改变标签；
  当行标题本身就等于该键时（名表未命中的角色，标题就是用归一化名渲染的）省略该标签，避免出现 `char003803 char003803` 这种重复。
- 变体行的可见文本 = **主文本 · 弱化原名**：
  - 主文本优先**服装名**（名表 `costume` 字段），无名表时退回目录名，再退回原名；
  - 后面接同行的**小号灰字原名**（`font-size:11px;color:#8a94a0`），随主文本一起参与省略（ellipsis）；
  - **去重**：主文本本身就等于原名时不重复显示（避免 `X · X`）。
  - 例：`[Live2D] 闭店后的特别时光 · adaerbote_2`、`[Live2D包] 浴室中的小小意外 · adaerbote_3`。
- 变体行的悬停提示（`title`）= 资源名 + 目录名；**两者相同则只显示一次**（避免 `adaerbote_2  ·  adaerbote_2`）。
- 同皮肤的**多载体并列两条**：分组只按「角色」（`char:<游戏>|<角色名>`）、不按服装名去重，所以同一皮肤的目录版与单文件版各占一条变体（标签分别为 `Live2D` / `Live2D包`）。

**展开规则**：
1. 启动时**默认全部收起**（只显示游戏名那一层）
2. 手动开合过的层保持其状态（两级各自独立）
3. 有搜索词时一律展开到变体（搜什么就展开什么）

**刷新恢复上次状态**：展开到哪一层、最后看的是哪个模型，都存进 `localStorage`
（键 `spine-multi-viewer.tree-state.v1`），刷新后自动恢复；
无存档时即为「默认全折叠」。搜索词**不恢复**——刷新后还留着搜索词容易让人以为列表缺内容。

**每个游戏各有一个默认值（各自的上次）**：存档按游戏名分开记：

```json
{
  "games": ["game:棕色尘埃2"],
  "chars": ["char:棕色尘埃2|Lathel"],
  "activeGame": "棕色尘埃2",
  "lastByGame": {
    "棕色尘埃2": "local-bd2-021301_char021301",
    "天命之子": "live2d-live2d-c000_01"
  }
}
```

- 选中某个模型时，记录到**它所属游戏**名下，并把该游戏标为「最后活跃」
- 启动时恢复「**最后活跃那个游戏**的上次模型」——切到别的游戏看过之后刷新，回来看到的是那个游戏的
- 各游戏的记录互不覆盖（实测：先看 棕色尘埃2 的 `char060301`、再看 天命之子 的 `c000_01`，
  刷新回到 `c000_01`；反向再看 棕色尘埃2，刷新回到 `char060301`）
- 旧格式（单个 `lastModelId`）读得到，下次保存即迁移为按游戏存

**上次的模型优先于默认**：刷新时不会「先加载默认再切回上次」。
- **Spine**：注入前把上次选中的模型**排到本批最前**——原版实现的 `addModels` 会把本批第一个设为当前模型，
  排到最前后它直接选中上次那个，只加载一次（实测日志：`已把上次选中的模型排到最前` + `首个模型内容就绪: char060301` 为同一模型）
- **Live2D**：它不在 原版 模型库里，无法靠排序避开默认，故 `local-roots.js` **先隐藏 Spine 画布**再注入
  （默认模型仍会被加载但不可见），同时 `char-tree.js` **不等 Spine 注入完成**就提前显示 Live2D
  （实测时序：`存档为 Live2D → 首个模型内容就绪 → 已注入 → 提前恢复 → 已渲染`）
- 没有存档时（初始状态）才用现在的默认：全部收起 + 原版 自动选中本批第一个

> ⚠️ **踩坑记录：同一模型被 show() 两次 → 一个留在背景**。
> 「提前恢复」加进来后，常规恢复**没有跳过**它，于是同一个 Live2D 模型被 `show()` 两次。
> 而 `show()` 是异步的：两次都在加载完成后 `addChild`，`st.model` 只指向后完成的那次，
> **先完成的那次成了孤儿**，永远留在舞台上继续渲染（实测现象：「刷新加载了两遍默认，
> 其中一个一直留在背景」）。
> 修法两层：
> 1. `char-tree.js` 记下已提前恢复的 id，常规恢复**跳过**它（消除重复调用）
> 2. `live2d-stage.js` 加**加载序号守卫**：每次 `show()` 递增序号，完成时若序号已过期就
>    自行销毁并返回 false，绝不往舞台上放（防止将来任何并发调用再产生孤儿）
>
> 验证：修复前 `已渲染` 出现 **2** 次，修复后 **1** 次；Spine 存档场景 Live2D 渲染 0 次。

**按游戏限额渲染**：每个游戏最多渲染 400 行，超出提示用搜索缩小范围。
为什么按**游戏**而不是全局限额：实测天命之子有 2185 个角色且排序在棕色尘埃2 之前，
用全局上限会被它一个游戏吃光，导致另一个游戏一个条目都显示不出来（自检发现）。

**归一发生在显示层，不合并数据**：每个变体仍是独立模型（各自有骨架/图集/贴图），
只是渲染时归到一个角色条目下。有了角色名表后，归组按**真实角色**进行——
同一角色的多套服装/技能归到一起（实测 481 个模型由「按资源名 257 组」收敛为「按角色 118 个」）。

**头像**：所有条目都带头像（`<img loading="lazy" decoding="async">`，定宽定高防抖动）。
头像按**角色组**取——组内第一个有 `iconUrl` 的变体，因为图标通常只覆盖立绘。

**左栏动态加宽**：按最长条目估算宽度（clamp 18–34rem），只调整浮层自身宽度。

> 实现说明（`legacy/patches/char-tree.js`）：树面板是挂在 `body` 上的**独立浮层**。
> 原列表仍在 DOM 中（只是其父级 `.bv-sidebar` 被 `display:none`），点击变体时复用它的
> `[data-mid]` 元素触发加载——`display:none` 的元素用 `el.click()` 依然能派发事件、
> 触发 React 的 onClick，从而走通已验证的加载路径（含懒加载拦截）。
>
> 面板定位：由注入的 CSS **固定给出**（`left:0` / `top:3rem` / `bottom:4rem`），
> 不再读取侧栏的 `getBoundingClientRect()`——侧栏隐藏后其 rect 恒为全 0，依赖它会定位错乱。
>
> ⚠️ 踩坑记录：**`bv-sidebar` 这个类左右两个侧栏都在用**——
> 左侧栏带 `left-0 border-l-0 rounded-r-lg`，右侧栏（菜单面板：动画/皮肤/混合模式等）带
> `right-0 border-r-0 rounded-l-lg`。只用 `.bv-sidebar` 选择器会把**右侧栏一并隐藏**。
> 故必须用 `.bv-sidebar.left-0` 限定，只隐藏左侧栏。
> （两侧栏的开关都在**顶部工具栏**——「模型库」与「菜单」两个按钮，不在侧栏内部，
> 所以隐藏左栏不会丢掉右栏的入口。）
>
> ⚠️ 踩坑记录：**不可**用 CSS `!important` 改 `.bv-sidebar` 宽度后立刻读几何——
> 该元素有 framer-motion 布局动画，强制同步重排会直接打崩渲染进程（SIGTRAP）。
> 现在完全不碰侧栏，这条坑也随之消失。

## 「选择目录」取代原作者侧栏的「导入」

面板头部的**选择目录**按钮打开本机的服务端目录浏览器（`legacy/patches/roots-ui.js`），
选中目录即作为一个资源根加入，随后面板重新拉取模型并刷新三级树。

- 走 `/api/browse` 由**服务端**列目录——资源在 NAS 上，浏览器文件选择器拿不到绝对路径
- 同名资源根会合并为同一个游戏条目（便于把原版与 Mod 归到一起对比）
- 入口由 `roots-ui.js` 暴露为 `window.__ROOTS_UI__.open()`，供面板按钮调用
  （此前是往原作者侧栏的标题行注入按钮，侧栏隐藏后改为暴露入口）

### 只追加，不覆盖

本项目**不使用「替换」语义**：注入模型前无条件把 `loadMode` 设为 `append`，
并**隐藏右栏设置面板里的「模型导入模式」选择**（那个「替换 / 追加」二选一按钮组）。

> 为什么必须强制：原版实现的 `addModels` 会从 store 读 `loadMode`，
> 当其为 `"replace"` 且新模型含 `source === "user"` 时**会清空已有模型**——
> 而本项目注入的模型 `source` 正是 `"user"`。若只在前端「恰好为 replace」时才临时改，
> 一旦有其它入口（持久化设置、原版 自带 UI）把它切回覆盖语义就会清空模型。
>
> 默认值也是 `"replace"`：全新浏览器（无 localStorage）与点过「恢复默认」之后，
> `loadMode` 都会回到 `"replace"`，所以这个强制不能省。
>
> 隐藏 UI 的做法（`legacy/patches/local-roots.js` 的 `hideImportModeUI()`）：该区块是 React 渲染的
> 通用容器（`div.space-y-1.5 > span.text-xs` + 两个按钮），**既无可用的类名特征、
> CSS 也无法按文本匹配**，故按文本「模型导入模式」定位 `span` 再隐藏其父块；
> 区块只在右栏打开时才渲染，用 rAF 节流的 MutationObserver 保证它出现后被隐藏。


## 模型对象必须与原生 原版 一致（重要）

服务端构造的模型对象，其**功能性字段必须与 原版 自己导入文件时算出的值完全一致**，
否则同一个模型在本项目与原生 原版 里**渲染结果会不同**。

原版 的构造逻辑（内联在 `index.html` 的导入流程里）与对应实现：

| 字段 | 原版 的算法 | 本项目实现 |
|---|---|---|
| `version` | 默认 `"4.0"`；`.json`→解析 `skeleton.spine`；`.skel`→按版本区间正则匹配；结果归一到主次版本 | `detectJsonVersion` / `detectSkelVersion` + `normalizeVersion` |
| `format` | 文件名含 `.skel` → `"skel"`，否则 `"json"` | 同 |
| `atlasPma` | 解析 atlas 的 `pma:` 声明 → `true`/`false`；**未声明 → `null`（未知）** | `detectAtlasPma` |
| `fileSize` | 骨架 + 图集 + 各贴图之和 | 同 |
| `textureFiles` | 由 atlas 内容列出的页名，在同目录匹配；**找不到时退化为全根按文件名找** | `parseAtlasPages` + 同目录优先/全根兜底 |
| `animations`/`skins`/`boneCount`/`slotCount` | 固定空/0（加载后才由运行时填充） | 同 |

> 校验工具：`node tool/compare-with-原版.mjs`
> 它把 原版 的公式在 Node 里原样实现，对同一批磁盘文件算出「原版 会得到的模型对象」，
> 再与本项目的输出逐字段比对并列出差异。

### 曾踩的坑（三个字段都曾写错，导致与 8801 渲染不一致）

1. **`atlasPma` 硬编码 `false`** —— 它是**三态**（`true`/`false`/**`null` 未声明**）。
   本项目资源里 478 个 atlas 未声明 pma（应为 `null`，交给前端像素检测）、
   3 个明确声明 `pma:true`（应为 `true`）。硬编码 `false` 两个方向都错，会污染 PMA 判定。
2. **`.json` 骨架的 `version` 为空串** —— 原先只对 `.skel` 探测，
   41 个 JSON 骨架模型拿到空串，导致前端 `getRuntimeWithFallback("")` **选错运行时**。
3. **`format` 写成 `"binary"`** —— 原版 的取值是 `"skel"`，会影响其 JSON 嗅探分支。
4. **贴图只在同目录找** —— 多页图集的后续页可能与 atlas 不在同一目录
   （实测 mod 里 23 个模型如此：`cutscene_char067302.atlas` 声明的第 2 页
   `cutscene_char067302_2.png` 在**兄弟目录** `char067302_2/莱维亚-原皮技能（无甲）/`），
   只查同目录会缺页 → 加载/渲染异常。原版 自身的匹配有「不限目录」的兜底，已照做。

**教训**：拼装这类对象时，必须去读**对方自己的构造代码**并逐字段复现其语义，
不能照抄内置示例对象的「字段外形」——外形一样、语义可能完全不同。

## 角色名表（显示角色名 / 服装名）

各游戏的名字与头像来源五花八门，本项目**一律转成同一套 JSON 规范**再读
（规范定义在 `tool/name-table-spec.mjs`，前端与后端只认这一套）。

### 统一规范（specVersion 1）

```json
{
  "_meta": {
    "spec": "spine-multi-viewer/character-table",
    "specVersion": 1,
    "game": "棕色尘埃2",
    "source": "character_list.ts",
    "sourceUrl": "",
    "generatedAt": "ISO 时间",
    "counts": { "characters": 231, "assets": 421 },
    "icon": { "pattern": "icon_{asset}.png", "note": "..." }
  },
  "characters": {
    "000101": {
      "name": "Lathel",
      "costume": "Herb Tracker",
      "npc": false,
      "assets": ["char000101", "cutscene_char000101"],
      "icon": "icon_char000101.png"
    }
  },
  "byAsset": { "char000101": "000101" }
}
```

**名字与头像同在**这一份 JSON 里——这是本项目的既定规范。

> **头像为什么只存文件名、目录另配**：文件名是可移植的数据（跟着名表走），
> 而目录是机器相关路径（本机绝对路径），放进 JSON 会导致换机器失效。
> 故目录由 `config/resources.json` 的 `roots[].icons.dir` 指定。

### 各游戏怎么转

| 游戏 | 上游形态 | 转换命令 |
|---|---|---|
| 棕色尘埃2 | 源码里硬编码的对象字面量（`character_list.ts`） | `node tool/import-name-table.mjs <输入.ts> config/names/bd2.json --game=棕色尘埃2 --icons-dir=<头像目录>` |
| 天命之子 | 社区查看器的 `childs.json`（`{基名:{name,variants}}`） | `node tool/import-name-table-dcg.mjs <childs.json> config/names/dcg.json --game=天命之子` |
| 碧蓝航线 | `AzurLaneData` 的 `ship_skin_template.json` + `name_code.json`（源数据已留档 `data/upstream/azurlane/`） | `node tool/import-name-table-azurlane.mjs data/upstream/azurlane/ship_skin_template.json data/upstream/azurlane/name_code.json config/names/azurlane.json --game=碧蓝航线 --icons-dir=<shipmodels 目录>` |

- **棕色尘埃2**：231 个角色 / 421 个资源；头像外置在 `BD2-L2D-Viewer/src/assets/char_icons`，
  命名 `icon_<资源名>.png`。加 `--icons-dir` 会**校验文件真实存在**并挑出该角色的头像文件名
  （图标只覆盖立绘，技能变体没有）。
- **天命之子**：上游 `assets/names.json` **只是目录名索引数组**（`["c000_01", ...]`），
  不含任何角色名——所以光靠上游只能显示 `c000_01` 这种 ID。
  故改用社区查看器 Live2D-DCG 的角色数据（`{ "c000": { "name": "Master", "variants": {...} } }`），
  与我们的目录名结构（`<基名>_<两位后缀>`）完全对应，**覆盖率 98.4%**（2156/2191）。
  头像无需配置：每个角色目录自带 `icon.png`。
- **碧蓝航线**：上游 `AzurLaneData` 的 `ship_skin_template.json` 里 `painting` 就是资源目录名
  （Live2D 的 `live2d/<painting>/` 与 Spine 立绘的 `docs/<base>/<painting>/` 同名），
  `ship_group` 是角色归组号、`skin_type===-1` 基础皮肤的 `name` 是角色名（占位符
  `{namecode:NN}` 用 `name_code.json` 解析）。两根共用 `config/names/azurlane.json`
  （2558 条，1825 条带头像），**同一角色跨 Live2D/Spine 自动聚合**；
  头像取 `AzurLane-Live2D-Viewer/shipmodels/<painting>.png`。
  源数据留档在 `data/upstream/`（碧蓝 6 个 + 天命之子 1 个 JSON，含来源说明 `data/upstream/README.md`）。

资源根在 `config/resources.json` 里用 `names` 字段指向名表；服务端提供 `GET /api/names?root=<id>`；
前端据此显示角色名与服装名，并**按真实角色归组**。

**效果**：按资源名归组时是 257 组（`char000101`、`char000102` 各算一个），
用名表按角色归组后收敛为 **118 个角色**（同一角色的多套服装/技能归到一起）。

### 中文译名（与英文同级，同一份文件）

中文名与英文名在**文件层面同级**，就在同一份名表的同一条目里：

```json
"021301": {
  "name": "Ren Yamashiro",   // 英文
  "nameZh": "山城恋",         // 中文（同级字段）
  "costume": "Lord of the Cosmos",
  "npc": false,
  "assets": ["char021301", "cutscene_char021301"],
  "icon": "icon_char021301.png"
}
```

**前端只负责显示顺序**（中文在前：`山城恋 Ren Yamashiro`）；没有 `nameZh` 时只显示英文。
搜索同时匹配中英文。译名依据：萌娘百科。

> **重跑转换不会冲掉中文名**：主名表由转换器生成，重跑会整个覆盖；而 `nameZh` 是人工整理的增量数据。
> 故两个转换器写入前会先 `readKeepZh(outFile)` 读取**已有名表里的 `nameZh`** 并沿用
> （匹配顺序：行内自带 → 按角色ID → 按英文名）。
> 已实测：写入 `山城恋` 后重跑转换，两条译名仍在。

## 左栏搜索（支持中文目录名 / 角色名 / 服装名）

搜索**按角色组判定**：组内任一变体命中即整组显示（搜角色名可看到该角色全部服装）。

可搜内容：角色名 / 服装名 / 资源名 / **目录名（含中文皮肤名）**。

> 注意：原版 自带的搜索框只按模型名（资源号）过滤，中文搜不到，
> 故已用 CSS 隐藏它，只保留本面板的搜索框。
> 踩坑记录：曾只隐藏了它的模型列表而漏掉搜索框，导致误用（反馈「只能搜 id、搜中文搜不到」）。

## 配置导出 / 导入（改造原版按钮）

右栏设置面板底部的**导出设置 / 导入设置**两个按钮已被本项目接管
（`legacy/patches/settings-io.js`，用捕获阶段拦截点击）。

原版这两个按钮只搬 20 项 UI 偏好（存 localStorage），**不含本项目的配置**——
换台机器或清浏览器就全丢。改造后**一个文件同时带走两部分**：

```json
{
  "_meta":   { "app": "spine-multi-viewer", "formatVersion": 1, "exportedAt": "..." },
  "project": { "files": { "resources.json": "<原文>", "names/bd2.json": "<原文>" } },
  "viewer":  { "loadMode": "...", "playbackSpeed": 1, "...": "（原版 20 项偏好）" }
}
```

- **`project`**：服务端配置的**文件原文**（保留 JSONC 注释、字段顺序）
- **`viewer`**：原版那 20 项偏好，字段与原版导出完全一致

### 两个 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config/export` | 返回 `{ files: { 相对路径: 原文 } }` |
| POST | `/api/config/import` | 请求体 `{ files: {...} }`；**校验 → 备份 → 写入 → 清单缓存失效** |

**导入的三道保障**：

1. **校验**：`resources.json` 需能按 JSONC 解析且 `roots` 是数组、每项含 `id`/`path`；
   `names/*.json` 需是合法 JSON；白名单外的文件一律拒绝。**任一项不合格则整体拒绝**，
   不做部分写入（避免配置处于半新半旧状态）。
2. **备份**：被覆盖的原文件先复制到 `config/.bak-<时间戳>/`（保留相对路径结构）；
   只保留最近 5 份，更早的移入 `config/.trash/`（不永久删除，可恢复）。
3. **原子写**：每个文件先写 `.tmp` 再 `rename`，避免写一半中断导致配置损坏。

> 为什么搬「文件原文」而不是解析后的对象：配置是 JSONC（带 `//` 注释），
> 解析后再序列化会把注释冲掉；搬原文可完整往返。
>
> **已知限制**：用界面「选择目录」添加资源根时，`writeConfig` 会重写 `resources.json`，
> 只保留第一个 `{` 之前的**头部注释**，数组内部的 `//` 注释会被冲掉。
> 因此要紧的说明请写在**文件头部**（头部会被保留）。
>
> 兼容性：导入时若文件顶层直接就是那 20 项偏好（原版导出的旧文件），按「仅偏好」处理。
>
> ⚠️ 踩坑记录：偏好部分的导入必须要求**有字段**才应用——原版 `importSettings` 内部是
> `{...默认值, ...传入值}`，传入空对象等于把偏好**重置为默认**；
> 若把空对象也当成功，导入一个空文件就会静默清掉自己的偏好（自检抓到过这个问题）。

## Live2D 集成（天命之子，与 Spine 同一界面）

Spine 与 Live2D 是两套完全不同的渲染体系，但在本项目里**显示在一起**：
同一个左栏三级树列出两者，选中谁就在同一个舞台区域渲染谁。

### 怎么做到同界面共存

- 左栏三级树同时收纳 Spine 与 Live2D 条目，**走同一条分组路径**：查角色名表命中就用角色名归组、
  行标题显示「中文名 英文名」，未命中才退回归一化资源名；展开后按变体列出（Live2D 的换装变体与
  Spine 的立绘/技能并列，标签分别为 `Live2D` / `Spine`）
- 选中 **Live2D** 条目 → 在 Spine 画布之上**覆盖一层 Live2D 画布**渲染（`legacy/patches/live2d-stage.js`），
  同时把 Spine 画布设为 `opacity:0`（视觉隐藏但**保留命中测试**，见下）
- 选中 **Spine** 条目 → 隐藏 Live2D 覆盖层并恢复 Spine 画布
- 覆盖层与 Spine 画布**几何完全一致**（`syncRect()` 逐值同步 rect），所以舞台尺寸、背景覆盖范围两者相同

> 为什么是 `opacity:0` 而不是 `visibility:hidden`：原版的**公共事件层绑在 Spine 画布上**
> （滚轮 / 单指拖动 / 双指缩放）；`visibility:hidden` 会让画布退出命中测试，
> 事件就落不到公共事件层。Live2D 覆盖层自身是 `pointer-events:none`，于是所有交互都
> 下穿到 Spine 画布、由原版公共事件层统一驱动 —— Live2D 与 Spine 共用同一条交互路径。

> 运行时库（PIXI / Cubism 核心 / pixi-live2d-display，合计约 1.4MB）**按需懒加载**：
> 只有第一次选中 Live2D 模型时才注入 `<script>`，不拖慢 Spine 首屏。

### Live2D 接入原版公共管线（没有自建 UI）

Live2D 走的是**原版自己的通路**，界面上不额外造一套控件：

- **动作区**：原版右栏「动作」区直接列出当前 Live2D 的 motions（标签形如 `idle / idle`，
  即「动作组 / 文件名」，`idle` 组排最前），点击即切换 —— 走
  「原版 UI → 引擎 `setAnimation()` → `bridge.playLabel(label)` → 模型 `motion(group, index)`」。
  自建的紫色控制区块、缩放滑杆、±/重置按钮、动作下拉、表情下拉**已全部删除**（不再有两套重复控件）。
- **缩放/平移/复位与 Spine 同源**：引擎在 Live2D 激活时把相机方法委托给桥 ——
  `applyUserScale()` → `bridge.setZoomRatio(userScale)`、`applyPan()` → `bridge.pan(dx, dy)`、
  `resetCamera()` → `bridge.resetView()`。语义两侧一致：**`userScale` 越大模型越大**，
  所以双指**捏开变大**、捏合变小；滚轮同理（`applyZoom()` 里的 L2D 分支写在
  `if (!this.camera) return;` **之前** —— Live2D 不建 Spine 相机，否则滚轮会在计算缩放前提前返回而完全失效）。
- **画布与几何**：覆盖层几何 = Spine 画布 rect（铺满整窗），PIXI 渲染器尺寸由 `fitAppToOverlay()`
  校准到覆盖层实际尺寸，模型按真实包围盒居中（实测 `modelCenter = (960, 540)`、离中心 **0px**、
  渲染器 `1920×1080`）。
- **表达式**：原版「皮肤」区对应 Live2D 的 expressions（`bridge.setExpressions(names)`）。
- **改动位置（历史做法；该切片已在 B6 删除，下述标记块与构建命令不再是现行路径）**：当时引擎侧改动写在旧引擎切片的
  `/*<<<MOD id>>>*/ … /*<<<ENDMOD id>>>*/` 标记块内（原文一字未动，剥块后可逐字节还原）；
  产物构建用 `node legacy/extract-tools/build-product.mjs --out /tmp/product.html`，等价性校验用 `node legacy/extract-tools/build-byte-equal.mjs`。

> ⚠️ **踩坑记录：覆盖层铺满整窗并不会挡住侧栏**（前提：覆盖层 `pointer-events:none`）。
> 早期实现担心遮挡，把覆盖层**收窄**到「左栏右侧 ~ 右栏左侧」之间，副作用是 Live2D 的可视舞台
> 比 Spine 小（实测 1200×1080 @ x=544，模型拖到两侧会被裁掉），背景覆盖范围也与 Spine 不一致。
> 改为 `pointer-events:none` 之后几何规避已无必要，现在覆盖层与 Spine 画布同几何；
> 右栏可点性用 `document.elementFromPoint` 做**命中测试**复核（程序化派发事件测不出遮挡问题）。
>
> ⚠️ **踩坑记录：只靠 PIXI 的 `resizeTo` 会停在 800×600**。覆盖层尺寸由 `syncRect()` 在
> `requestAnimationFrame` 里写入，而 PIXI app 可能在此之前就创建完成（那时覆盖层还没有尺寸）
> → 渲染器停在 PIXI 默认 800×600，模型被居中到 800×600 的逻辑空间（表现为「模型缩在左上角、
> 被左栏面板盖住」）。修法：`fitAppToOverlay()` 在「app 创建后」与「每次 `syncRect()` 后」
> 显式对齐渲染器尺寸、把 canvas 的 `style` 拉回 `100%`，并让 `ResizeObserver` 同时观察
> **覆盖层**与 **Spine 画布**（画布恒为整窗，单观察它几乎不触发）。

> **为什么没有 Spine 那三档「初始缩放」**：Spine 的「主体优先 / 全部部件 / 动画全程」在 Live2D 上
> **没有对应物**——实测 `internalModel.width/height`、`originalWidth/Height` 与真实包围盒
> （`getBounds()`）完全一致（都是 960x1600），三档结果必然相同，做成三档只会误导。
> 故 Live2D 只按真实包围盒适配，缩放统一由原版公共事件层（滚轮 / 双指）与原版「重置视图」控制。

### 适配视图：用真实包围盒，不用画布尺寸

Live2D 的 `internalModel.width/height` 是**画布尺寸**，角色往往只占其中一部分——
直接拿它算缩放会出现「偏小 + 不居中」。正确做法是用 `getBounds()` 拿真实绘制包围盒再居中：

```js
model.scale.set(1); model.position.set(0, 0);   // 先归零，否则包围盒会随缩放变化
const b = model.getBounds();                     // 世界坐标（已含变换）
const s = Math.min(W / b.width, H / b.height) * 0.98 * zoom;
model.scale.set(s);
model.x = W / 2 - (b.x + b.width / 2) * s;       // 包围盒中心对齐视口中心
model.y = H / 2 - (b.y + b.height / 2) * s;
```

**交互**：滚轮缩放 / 单指拖动 / 双指捏合都由**原版公共事件层**（Spine 画布上的指针与滚轮处理）
统一驱动，再经引擎委托给桥；原版底部工具条里的「重置视图」同样能复位 Live2D 视图
（`resetCamera()` → `bridge.resetView()`）。覆盖层自身 `pointer-events:none`，不接管任何事件。

> ⚠️ 自检陷阱：`getBounds()` 返回的是**世界坐标**（已包含位置与缩放），
> 校验居中时**不能再乘一次缩放**——曾因此算出「偏差 234px」的假象，实际完全居中。
> 桥里的 `bridge.fitInfo()` 提供只读读数（读完原样恢复现场）：适配矩形、渲染器尺寸、
> 模型包围盒中心、离中心像素差。实测 `modelCenter=(960,540)`、`offCenterPx=0`、
> 渲染器 `1920×1080`；连续缩小 8 次（`modelScale 0.16283 → 0.07009`）与放大 14 次
> （`→ 0.26618`）全程中心不变、画布恒为 1920×1080。

### 资源形态与识别

**同时支持两代 Live2D**，两代定义文件的结构不同，扫描器都要处理：

| 游戏 | 代 | 定义文件 | 模型数据 | 贴图/动作路径 | 实测规模 |
|---|---|---|---|---|---|
| 天命之子 | **Cubism 2** | `model.json` | `model.moc` | 同目录裸文件名 | **2185** 个模型 |
| 碧蓝航线 | **Cubism 4** | `*.model3.json` | `*.moc3` | **带子目录**（`textures/`、`motions/`） | **178** 个模型 |

天命之子（DestinyChildLive2D）目录形态：

```
c000_01/
├── model.json        定义文件（引用下面这些，全部是**相对路径**）
├── model.moc         模型数据（Cubism 2 二进制）
├── texture_00.png    贴图
├── *.mtn             动作（idle / idle_facial_nokey / idle_stay 等组）
├── *.exp.json        表情（21 个）
└── icon.png          缩略图（未被定义文件引用，用作列表图标）
```

碧蓝航线（AzurLane-Live2D-Viewer）目录形态（目录名是拼音，如 `abeikelongbi_3`）：

```
abeikelongbi_3/
├── abeikelongbi_3.model3.json   定义文件（文件引用都在 FileReferences 下）
├── abeikelongbi_3.moc3          模型数据（Cubism 4）
├── abeikelongbi_3.physics3.json 物理
├── textures/texture_00.png      贴图（**在子目录里**）
└── motions/*.motion3.json       动作（14 组）
```

服务端扫描器识别标志：目录里存在 `model.json`（Cubism 2）或 `*.model3.json`（Cubism 4，
两者同目录时取 4）。与 Spine 扫描器**并列独立**（Spine 是「骨架 + 同名图集」配对，
Live2D 是「一个定义文件引用 moc/贴图/动作/表情」）。

> ⚠️ **两代的字段名大小写不同，必须都兼容**：
> Cubism 2 用小写（`model` / `textures` / `expressions[].file` / `motions[].file`），
> Cubism 4 用大写且嵌在 `FileReferences` 下（`Moc` / `Textures` / `Expressions[].File` / `Motions[].File`）。
> 只按一种取会让另一代的动作/表情**全部丢失**（实测踩过：只按大写取，天命之子 21 个表情变成 0）。
>
> 另外 Cubism 4 的引用**带子目录**（`textures/texture_00.png`），
> 故文件存在性按**磁盘相对模型目录**判断，而不是只在「本目录直接子文件」里找。

### 必须用「路径式 URL」（关键设计点）

Live2D 定义文件内部用**相对路径**引用同目录文件，而 pixi-live2d-display 按浏览器 URL 规则解析它们。
若用查询串式 URL（`/api/file?root=x&path=y`），相对解析会**丢掉查询串**而 404。

因此新增了路径式路由：

```
GET /files/<rootId>/<相对路径>
```

例：`/files/live2d/c000_01/model.json` → 其内部引用的 `model.moc`、`texture_00.png` 会被
正确解析成 `/files/live2d/c000_01/model.moc`、`/files/live2d/c000_01/texture_00.png`。

### 运行时库：与 Spine 同一套自探测思路

`live2d.min.js`（Cubism 2 核心）/ `pixi.min.js` / `index.min.js`（pixi-live2d-display）/
`live2dcubismcore.min.js` **都不纳入仓库**（Cubism Core 受 Live2D Inc. 专有许可约束），
由 `tool/resolve-live2d-runtimes.mjs` 在运行时自动探测，经 `/live2d-lib/<文件名>` 供给页面。

探测优先级（与 `tool/resolve-runtimes.mjs` 同一套思路）：

1. 环境变量 `LIVE2D_RUNTIME_DIR`
2. 项目内 `src/live2d-runtimes/`（已 gitignore）
3. 工作区共享 `../live2d-runtimes/`
4. 在搜索根（默认 `工作区/` 与 `工作区/spine-viewers/`，可用 `LIVE2D_SEARCH_ROOTS` 覆盖）
   下的各项目里按候选相对路径（`lib` / `static/lib` / `js/lib` …）查找

> **为什么第 4 步要「收集全部候选再按完整度择优」**：本工作区里多个项目各自打包了这些库，
> 且版本并不一致——实测 `AzurLane-Live2D-Viewer` 与 `spive2d` 的 `live2d.min.js`
> **不是同一份**（MD5 不同），而 `spive2d` 的那份与 `DestinyChildLive2D` 自用的完全相同
> （即目标资源的同源核心）。按「文件更全」择优能自然选中 spive2d 那套
> （额外含 Cubism 4 框架，共 5 个文件；AzurLane 只有 4 个）。

### 加载顺序（不可颠倒）

```html
<script src="/live2d-lib/live2dcubismcore.min.js"></script>  <!-- 必须最先 -->
<script src="/live2d-lib/live2d.min.js"></script>
<script src="/live2d-lib/pixi.min.js"></script>
<script src="/live2d-lib/index.min.js"></script>
```

> ⚠️ 踩坑记录：`live2dcubismcore.min.js` **即使只渲染 Cubism 2 模型也必须先加载**——
> pixi-live2d-display 初始化时就会检查它，缺失直接抛
> 「Could not find Cubism runtime. This plugin requires live2dcubismcore.js to be loaded.」
> 导致 `PIXI.live2d` 根本不存在、整页渲染不可用。因此它在探测脚本里被列为**必需**文件。

### PIXI 版本兼容与**运行时组合优选**

运行时库由服务端自探测供给，不同机器可能探到不同组合
（实测：`AzurLane` 那套是 **PIXI 6.5.3**，`spive2d` 那套是 **PIXI 8.19**）。

**两处兼容处理**：

1. **初始化 API 不同**：PIXI 7 起构造不初始化、需再 `await app.init()`；
   页面用**特性检测**分支处理：`typeof PIXI.Application.prototype.init === 'function'`。
2. **优选 PIXI 6 组合**（探测脚本按 PIXI 主版本排序，6 优先）。实测依据：

| 组合 | Cubism 2（天命之子） | Cubism 4（碧蓝航线） |
|---|---|---|
| **PIXI 6.5.3**（AzurLane 自带） | ✅ 正常 | ✅ 正常 |
| **PIXI 8.19**（spive2d 打包） | ✅ 正常 | ❌ **卡住** |

> ⚠️ 踩坑记录：PIXI 8 组合加载 Cubism 4 时**永久挂起**——
> `model3.json` 与 `moc3` 都能取到、`Moc.fromArrayBuffer` 也能成功解析
> （单独用 Cubism Core 验证：Model 创建成功、408 个绘制对象），
> 但**贴图永不请求**，`Live2DModel.from()` 的 Promise 永不 resolve（15 秒超时实测）。
> 同一模型换 PIXI 6 组合立即正常（6000x6000）。
> 另外该 PIXI 8 组合的库要求 Cubism Core 6.x，配旧 core 会直接报
> 「Failed to start up Cubism framework」——即两套库与各自的 core 是**绑定**的，不能混搭。
> 故探测脚本按 PIXI 主版本优选（PIXI 6 优先），文件完整度降为次级判据。

## HTTP API（server.mjs）

| GET | `/api/live2d/models?root=<id>` | Live2D 模型列表（Cubism 2/4，含动作/表情） |
| GET | `/files/<rootId>/<路径>` | 路径式文件访问（Live2D 相对引用必需） |
| GET | `/icons/<rootId>/<文件名>` | 角色头像（外置头像目录，目录由 roots[].icons.dir 指定） |
| GET | `/live2d-lib/<文件名>` | Live2D 运行时库（不入库，自探测供给） |
| GET | `/api/config/export` | 导出项目配置（文件原文） |
| POST | `/api/config/import` | 导入项目配置（校验+备份+写入） |


| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 页面（返回 dist/index.html，并注入 store hook 与自有脚本） |
| GET | `/api/roots` | 资源根列表 + 按 name 归并的 `groups` |
| POST | `/api/roots` | 添加资源根（写 config/resources.json）；同名返回 `merged:true` |
| GET | `/api/models?root=<id>[&refresh=1]` | 该资源根的模型列表（服务端扫描 + 清单缓存） |
| GET | `/api/tree?root=<id>&path=<相对路径>` | 列目录（含 `spineVersion`/`assetKey` 探测） |
| GET | `/api/file?root=<id>&path=<相对路径>` | 读文件（正确 MIME；路径限制在 root 内防穿越） |
| GET | `/api/browse?path=<绝对路径>` | 浏览服务端本机目录（供界面选文件夹） |

> 为什么需要服务端目录浏览：浏览器 File System Access API 只能选浏览器所在机器上的文件，
> 且拿不到绝对路径；而资源在 NAS/部署设备上，必须由服务端列目录。

## 工具用法

```bash
node tool/extract-runtimes.mjs   # 从基线抽出运行时（产物在 src/spine-runtimes/）
node tool/split-app.mjs          # 生成应用外壳（产物 legacy/source/app-shell.html）
node tool/build.mjs              # 打包回单文件 -> dist/index.html
node tool/verify.mjs             # 校验产物与基线等价
node tool/resolve-runtimes.mjs   # 查看 Spine 运行时探测结果（排查用）
node tool/resolve-live2d-runtimes.mjs      # 查看 Live2D 运行时探测结果（排查用）
node tool/import-name-table.mjs <输入.ts> <输出.json>       # 转 BD2 形态名表 -> 统一规范
node tool/import-name-table-dcg.mjs <childs.json> <输出.json> # 转天命之子名表 -> 统一规范
node tool/compare-with-原版.mjs        # 与原生 原版 逐字段对照（校验模型对象）
bash server.sh start|stop|restart|status   # 启停服务（默认端口 8803）
```

## 校验状态

`node tool/verify.mjs` 结果（2026-10-02）：

- 字节数：基线 4,378,319 == 产物 4,378,319 ✅
- 7 个运行时源码：**逐字节一致** ✅
- 运行时对象 raw 文本长度：一致 ✅

即：**拆分后的构建产物与原版行为等价**。

> **切片级 MOD 的登记与门禁（2026-10-16 更新：基线已重新变绿）**
>
> 顶部栏的标题与图标已参数化：读 `window.__APP_BRAND__`（服务端从项目根 `.env` 注入 `<head>`；缺省回落
> 源码内置默认标题「骨骼动画预览器」与原版 lucide 图标）。这是本项目**首次切片级 MOD**（此前所有改动
> 都走服务端注入、不落构建切片）。
>
> 做法：`legacy/source/app-shell.html` 必须始终与 `src/.app-shell.orig.html` **逐字节一致**（校验链的 ⓪ 项），
> 所以改动只落在**切片**里（`legacy/source/js/app/main-component.js`），并在 `tool/mods/app-shell.json` 里声明
> `{id, file, from, to, netChars}`（本次两处：标题 +51 字符、图标 +283 字符，合计 +334）。
> 基线模式（`node legacy/extract-tools/build-byte-equal.mjs`）会先剥 MOD 块标记、再按清单把「现片段」反替换回「原片段」，
> 之后仍要求与原文区间**逐字节相等** —— 门禁强度没有削弱，反而更严：
> 声明的现片段必须**恰好命中 1 次**、原片段必须**已不存在**、净增字符数必须与声明**完全一致**。
>
> 为什么用清单而不是 MOD 块标记（`/*<<<MOD id>>>*/`）：该标记要求标记**单独成行**（见 `tool/lib/mods.mjs`
> 的 OPEN/CLOSE 正则），而本片是压缩过的单行代码，表达式中间插不进整行标记。
>
> 自证（实测）：把切片里一个**非 MOD 字节**改 1 个字符（`截图导出`→`截土导出`）→ 门禁报 5 项失败（分片、
> 拼接、装配、基线回填全红）；还原（sha256 复核一致）→ 全绿。产物模式同样通过（`dist ≡ 产物（含 MOD）`）。
>
> 产物重建：`node legacy/extract-tools/rebuild-from-slices.mjs --out <tmp>` 或 `node legacy/extract-tools/build-product.mjs --out <tmp>`
> （两者都**拒绝直接写 dist/**，需自行 `cp` 到 `dist/index.html`）。

## 进度

### 已完成

- [x] 拆出 7 个 Spine 运行时（`src/spine-runtimes/`，可读源码）+ 构建/校验工具链（产物与基线逐字节等价）
- [x] 运行时移出仓库 + 自动探测获取（换机器/新克隆也能构建，含基线兜底）
- [x] 服务端（`server.mjs`，零依赖）：静态托管 + 资源根 API
- [x] 资源根配置化（`config/resources.json`，JSONC 支持注释）+ 界面添加即自动写入
- [x] **【需求一】多资源根分大类** —— `name` 作归一 key，同名资源根合并显示（已验证：BD2 原版 424 + Mod 54 = 478 个模型合并展示）
- [x] **【需求三】支持部署设备本地文件夹打开** —— 服务端目录浏览 + 自动加载，免手动导入
- [x] 清单缓存（落盘 `config/models.<rootId>.json`）：刷新从数十秒降到约 0.02s
- [x] 模型内容懒加载（清单只含元数据，点击才下载三件套）
- [x] 模型标识取自 atlas 内容（不受目录命名大小写影响）
- [x] **【需求二】同角色归一（显示层）** —— 左栏两级树：一级角色、二级变体（立绘/技能/Mod），
      按 `charKey` 归组但不合并数据；左栏宽度按内容动态调整（实测 478 个模型 → 255 个角色）

### 待办

- [ ] **展示类型插件机制（动态加载）** —— 往项目根 `plugins/` 放 js 即给网页增加一种「展示类型」能力，
      不预解包、不改 `dist` 核心。宿主 `legacy/patches/plugin-host.js` 暴露 `window.SpineViewerPlugins`
      （`register` / `list` / `host`），插件以 `{ id, name, label, fileKinds, probe, open }` 声明能力；
      **模块文件按功能命名、不带序号**，加载顺序由 `plugin.json` 的 `files` 数组声明；
      服务端新增 `GET /api/plugins`（扫描项目根 `plugins/`，支持 `plugin.json` 清单）；
      资源根新增 `kind:"bundle"`（目录里是无扩展名单文件，按 `UnityFS` 魔数识别），
      其条目**进现有角色库**（左栏三级树，与 Live2D 模型并列，按名表归组）。
- [ ] **首个插件：Unity Live2D 资源包（通用，不止碧蓝航线）** —— `plugins/unity-live2d-bundle/`
      面向「Unity AssetBundle 内嵌 Live2D/Cubism」这一类文件：解析 `UnityFS` 容器 → 抽
      `.moc3`（可能藏在 MonoBehaviour 字节数组，魔数 `MOC3` + 前置 u32 长度）、
      `TextAsset`（`.model3.json` / `.motion3.json` / `physics3.json`）、`Texture2D`
      （按 `m_TextureFormat` 分发的解码器，本样本为 `ETC2_RGBA8`）→ 重建 `model3.json`；
      **Unity 集成版**（只有 AnimationClip、无 motion3）另需把动画曲线转 `motion3.json`。
      各游戏差异放 `profiles/<游戏>.json`（数据，不写死游戏名），碧蓝航线为首个 profile；
      渲染复用现有 Live2D 桥与公共管线（原版右栏动作区、双指缩放同源）。
      方案、模块拆分与验证关卡见 `doc/契约/插件契约.md`。
- [ ] **前端内置诊断探针（`__DIAG__`）** —— 把「临时注入 console 探针」变成前端内置能力，
      出问题时前端可自证、AI 可直接取证（不依赖浏览器会话）：
      · **采集**：`window.onerror` / `unhandledrejection` / 资源加载失败 / 包装 `console.error|warn|info`
        （幂等、保留原引用、防递归）
      · **条目结构**：`{t, level, src, event, data, model, plugin}`；大对象只记摘要（TypedArray → 字节数），
        环形缓冲默认 500 条
      · **内置事件语义**：`plugin.load`（插件加载/耗时/注册表）、`bundle.parse`（容器/对象数/moc3/纹理/
        motions emitted-skipped）、`model.mount`（形状/动作数/各阶段耗时）、`motion.fail`（框架
        MotionManager 失败 → 动作名 + 错误摘要）、`interaction`（缩放/拖动低频采样）
      · **读取**：`window.__DIAG__.dump() / errors() / warnings() / timeline() / tail(n) / clear() / size()`；
        并 `POST /api/diag` 追加写 `data/diag.jsonl`（服务端只追加、不接受前端指定路径）
      · **开关**：复用右栏现有「调试日志」开关——开 = 面板可视化；关 = 仍保留内存缓冲与落盘（避免出问题没证据）
- [ ] 应用代码（798 KB 压缩混淆态）的进一步模块化拆分：
      React / 第三方库、`store.js`、`importer/`、`components/`、`renderer/`
- [ ] 资源根管理界面（当前只能添加；改名 / 删除 / 启用停用待做）
- [ ] 角色树：记住展开状态 / 定位当前播放的角色
- [ ] 清单失效：资源文件增删后需 `?refresh=1` 或删清单文件（未做自动检测）

### 已知未修复 bug（挂起）

- [x] **Live2D 双指捏合缩放**：已实现 —— 双指手势由原版公共事件层（Spine 画布）接住，
      经引擎 `applyZoom()` → `applyUserScale()` 委托给桥（`bridge.setZoomRatio(userScale)`）；
      语义与 Spine 一致：捏开变大。实测 `modelScale 0.16283 → 0.65132`（userScale 1 → 4）。
- [x] **右栏控件重复**：已消除 —— 自建的 Live2D 紫色控制区块（缩放滑杆 / ± / 重置 / 动作下拉 /
      表情下拉）整体删除，右栏只保留 原版 原生控件（「动作」区直接列出 L2D motions）。
- [ ] **碧蓝航线 16 个未命名字目录**（Live2D 7 + Spine 9）：上游
      `ship_skin_template.json` 没有这些键（`_ii`/`_new`/罗马数字等后缀变体），
      界面回退显示拼音目录名，功能不受影响（见 `data/upstream/README.md`「待重设计」节）
- [x] **重影（已修复，2026-10-21）**：`aimierbeierding_3` / `aimierbeierding_3_hx` 这类
      带裁剪遮罩（18 个遮罩对象）且含常驻半透明叠加层（110 个默认不透明度 < 1 的绘制对象，
      部件名含 `doubleshadow`）的模型，此前渲染出来有半透明覆层，观感即"重影"。

      **原判断「缺陷在模型数据本身、非渲染代码缺陷」不成立**——引擎重写后按正确口径处理了
      半透明层的预乘 alpha 与混合模式（`src/web/engine/pma.js` 的三分支检测 +
      `engine/blend.js` 的 `blendFuncSeparate` 钩子），该现象消失，画面干净。

      当时的推断链是「第三方查看器上也复现 ⇒ 模型有问题」，这个反推是错的：第三方查看器
      对同一套 alpha 口径同样敏感，它复现只能说明"这是个常见坑"，不能证明"模型数据坏了"。

完整改造方案见：`../spine-viewers/2026-10-02-原版多文件夹根目录分大类改造方案.MD`

## 免责

本 README 中的许可证与合规说明基于对原仓库元数据的查证与开源许可一般原理，**不构成法律意见**。对外分发前建议咨询专业 IP 律师。

## 导出物版权

`tool/export-bundle.mjs` 导出的 `moc3`、`physics3`、贴图 PNG 等均为**游戏原始素材**，仅供本地研究与个人使用，请勿再分发。导出产物默认写入 `data/export/`（该目录已在 `.gitignore`）。
