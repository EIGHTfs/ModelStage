# ModelStage · 新前端（`src/web/`）

纯 HTML + 原生 ES 模块 + 手写 CSS 的前端实现，与旧前端（`legacy/source/app-shell.html` + `legacy/source/js/**` + `legacy/patches/**`）
**新端已独立**：新前端跑在 8804，由 `src/server/serve.mjs` 同时提供静态文件、全部接口与模型资源，
**不再反代 8803**。旧前端 8803 仅作历史对照保留，新端不依赖它。

设计依据：`doc/任务-前端重写路线图.md`（功能 8 块 / L1 视觉 + L2 结构 + L3 行为三层判据 / M1~M8 里程碑）、
进度看板：`doc/任务-前端重写.md`。

## 一、目录结构

```
src/web/
├── index.html        五区域骨架：顶栏 / 左栏（角色库）/ 舞台 / 右栏 / 底栏
├── style.css         变量 + 基础重置 + 舞台 + 五区域容器几何（尺寸对齐旧前端实测 rect）
├── components.css    控件外观：品牌、按钮、搜索框、三级树行、右栏分组行、底栏分组、错误横幅
├── main.js           入口：品牌、面板开关、资源根加载、名册挂载、渲染器装配、错误兜底、window.__WEB__ 调试出口
├── transport.js      底部播放条渲染
├── README.md         本文件（前端源码目录；服务端在 src/server/）
│
├── infra/            基础设施（与业务无关，可复用）
│   ├── api.js        同源 JSON 请求封装（统一错误口径）
│   ├── vfs.js        内存资源视图（统一登记表 + 字节缓存）
│   └── diag.js       诊断探针 window.__DIAG__（错误/警告/关键事件 + 落盘 /api/diag）
│
├── roster/           左栏名册
│   ├── list.js       数据层：按根取模型清单 + 名表合并 + 角色归并
│   ├── view.js       视图层：状态、事件、懒加载、搜索过滤、选中态、持久化
│   └── rows.js       三级树的行渲染（纯 DOM 工厂，无状态）
│
├── panel/            右栏控制面板
│   ├── schema.js     9 组 + 播放条控件的声明式定义
│   ├── view.js       手风琴渲染（能力不支持的不构建；未接线才 disabled + data-pending）
│   └── panel.css     右栏/播放条内部样式
│
├── render/           舞台与渲染面
│   ├── surface.js    渲染面：几何唯一来源、背景模式、渲染器切换与生命周期
│   ├── spine.js      Spine 渲染器（相机 backend 指向引擎）
│   ├── live2d.js     Live2D 渲染器（相机 backend 指向桥）
│   ├── interaction.js 交互层：滚轮/拖动/双指/重置，绑舞台区域而非某块画布
│   └── camera/
│       ├── constants.js 缩放范围、步进、边距、主体排除名单（唯一来源）
│       └── index.js     统一相机（唯一钳制点，backend 只提供 getScale/setScale/pan/resetView）
│
├── spine/            Spine 运行时
│   ├── canvas.js     引擎封装（加载、动画、滤镜、适配、相机转发）
│   └── runtimes.js   多版本运行时加载与选择
│
├── live2d/           Live2D 运行时
│   └── stage.js      库加载、模型挂载、缩放/平移桥
│
└── debug/            调试
    ├── log.js        环形日志缓冲
    ├── panel.js      日志面板
    ├── panel.css     面板样式
    └── model-cmp.js  模型差异采集（尺寸/包围盒/适配中间值，排障用）
```

拆分原则：单文件控制在 400 行内；同一类职责归一个目录，`main.js` 只做装配，不承载具体实现。

### 目录约定

| 目录 | 放什么 | 不放什么 |
|---|---|---|
| `infra/` | 与业务无关的通用能力（请求、存储、诊断） | 任何模型/渲染相关逻辑 |
| `roster/` `panel/` | 左栏、右栏的视图与数据 | 渲染与相机 |
| `render/` | 渲染面、渲染器、相机、交互 | 具体模型的加载实现（在 `spine/`、`live2d/`） |
| `spine/` `live2d/` | 各自运行时的加载与能力封装 | 跨渲染器的公共逻辑 |
| `debug/` | 日志与排障工具 | 生产路径依赖 |

## 二、怎么起

```bash
# 启动新前端（8804，独立服务，不依赖旧端）
cd <项目根>
bash web.sh restart
```

后台启停用项目根的脚本（**不要用 nohup**，PID/日志由脚本统一管理）：

```bash
bash web.sh start|stop|restart|status     # 默认 8804（独立服务）
```

> 说明：脚本内部用绝对路径自调用（`SELF`），`bash web.sh restart` 可直接用。

打开：`http://<本机IP>:8804/`

环境变量（都有默认值，不写死）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8804` | 新前端监听的端口 |

> 历史说明：早期版本用 `UPSTREAM=http://127.0.0.1:8803` 把 `/api` `/files` `/icons` `/live2d-lib` 反代到旧端；
> 该路径已在「新端自带服务端」之后**整体移除**，现在两个端口互不依赖。

> 为什么现在不需要反代：新端自带服务端，页面与接口同源，`/api/tree`、`/api/models` 直接可用，
> 也不再受「上游没发 CORS 头」的限制。

## 三、品牌与标题

品牌**不写死在前端**：启动时 `GET /api/brand` 取 `title` / `icon` / `iconKind`，同时应用到顶栏与
`document.title`；服务端配置为空（返回 `null`）时回落到默认品牌名 `ModelStage`。

- `iconKind === 'text'`：当文字/emoji 渲染
- `iconKind === 'image'`：当 `<img>` 渲染（站内绝对路径 / http(s) / data:）
- 两者均空：保留 `index.html` 内置的内联 SVG 图标

改配置后刷新页面即生效，无需重启服务。

## 四、当前进度

### M1 骨架（已完成）

- [x] `index.html` 五区域骨架，几何与旧前端在 1920×1080 实测值**逐值一致**
      顶栏 `[0,0,1920,48]` / 左栏 `[0,48,304,968]` / 舞台铺满 `[0,0,1920,1080]` /
      右栏 `[1744,48,176,968]` / 底栏浮条 `[600,1023,720,42]`
- [x] `style.css` 手写深色主题（背景 `#131416`、卡片 `#1f2326`、主色 `#1fc0c5`、棋盘格舞台）
- [x] 品牌走 `GET /api/brand`：顶栏标题、`document.title`、图标三处同源；空配置回落 `ModelStage`
- [x] 服务端由 `src/server/serve.mjs` 提供（静态 + 全部接口 + 资源）；起在 8804，不碰 8803
- [x] 控制台 0 错误、无横向滚动条

### M2 名册三级树（已完成）

- [x] 一级 = **游戏**（按资源根配置的 name 合并同名根，照 `char-tree.js` 的 buildTree 规则）：
      碧蓝航线的 3 个根（azurlane / azurlane_spine / azurlane_bundle）合并成 **1 个游戏节点**，
      节点上标「N 根」（title 列出根 id）。二级 = 角色，三级 = 变体
- [x] **按游戏懒加载**：启动只拉 `/api/roots`；首次展开某游戏才请求它名下各根的
      `/api/names?root=` + `/api/catalog?root=`（catalog 把 spine 模型、live2d 模型、
      容器单文件合并成一份清单，所以不再按"根的 kind"猜该问哪个扫描器）；
      已加载过的游戏再展开不再发请求
- [x] **角色跨根归并**：同一游戏下把各根模型并成一个数组再归并，同一角色来自不同根的变体
      落在**同一个角色节点**下（实测：阿尔比恩 = Live2D `aerbien_3` + Spine `aerbien_4`）
- [x] 归并规则逐条照 `legacy/patches/char-tree.js`：`charKeyOf`（去 `cutscene_` / `_hx` / `_N`）、
      `assetCandidates` 逐级放宽查表、命中用英文名归组 + 标题「中文名 英文名」、
      变体排序立绘在前技能在后、角色排序普通角色在前 NPC 在后、角色键 `char:游戏名|组名`
- [x] 实测规模（与旧前端一致）：**2 游戏 / 354 角色 / 721 变体**
      —— 棕色尘埃2 109 角色 / 389 变体；碧蓝航线 245 角色 / 332 变体（3 根跨根归并后）
- [x] 搜索：角色名 / 服装名 / 资源名 / 目录名（前端过滤；首次输入时并行补加载各游戏，之后走内存）
- [x] 选中态：点变体行高亮（`aria-selected` + `.is-selected`），再点别的行自动切换
- [x] 展开/折叠 + 「收起」按钮（只清空展开状态，面板保留）
- [x] 状态持久化沿用旧前端键名 `spine-multi-viewer.tree-state.v1`（`games` / `chars` /
      `activeGame` 存游戏名 / `lastByGame` 按游戏名存上次模型 id）
- [x] 键盘可达：树行 `tabindex=0`，Enter / 空格等价于点击
- [x] **定位当前角色（F3）**：选中后把该行滚进可视区（`roster/reveal.js`）。三条纪律：
      已可见不动；用户滚动手势 800ms 内不抢（`lastReveal=skipped-user-scrolling`）；
      目标被折叠时先展开父级再滚；启动自动恢复同样定位
- [x] 控件接线状态：能力不支持的**不构建**、未接线才 `disabled` + `data-pending`
      （顶栏截图导出/影院模式已接线、导入与菜单已删除、左栏选择目录已改为服务端目录浏览器；
      底栏 7 个全部接线）—— 明细见「表现侧接线记录（F1/F2/F3/F4/F5）」
- [x] 穷举实操 31 项全过 + 控制台零错误（`test/roster-actions.js` + `tool/check-console.mjs`）

## 表现侧接线记录（F1 / F2 / F3 / F4）

原则：**能点的按钮必须真的生效**；做不了就在声明里说清原因，不留"看着能点却没反应"的控件。

### F1 四个外壳控件（右栏「设置」组）

| 控件 | 点了之后发生什么 | 判据（自动化） |
|---|---|---|
| 显示状态信息 | 关：舞台顶部状态行清空并隐藏，**日志照旧进 `__WEB__.stageLog` 与控制台**；开：状态行恢复 | `data-show-status` = on/off；`#stage-hint.hidden`；日志条数增长 |
| 调试日志 | 关：右下角调试日志浮层隐藏（已采内容保留，开回来还能看）；开：显示 | `data-debug-log`；`#debug-panel-host.hidden`；`log.entries()` 条数 |
| 防卡死保护 | 开：每 1s 采样舞台帧数，连续 3 次不增长（且有模型在渲染）判为停滞 → 写 warn + `pause()→play()` 自愈一次；关：定时器停 | `__WEB__.hangGuard{ticks,stalls,recoveries}`；停滞时日志出现「渲染停滞」 |
| 导出设置 / 导入设置 / 恢复默认 | 导出：前端生成 JSON 并触发下载（内容同步留 `__WEB__.settingsExport`）；恢复默认：清本地存储 → 按面板声明默认值重放 → 视图复位；**导入：后端 `POST /api/config/import` 仍是 501，按钮如实禁用并注明原因** | `__WEB__.settingsExport.text` 可解析；`data-settings-restored`；导入按钮 `data-disabled-reason` |

### F2 顶栏按钮

| 按钮 | 点了之后发生什么 | 判据（自动化） |
|---|---|---|
| 截图导出 | 从舞台画布 `gl.readPixels`（WebGL 缓冲不保留，`toDataURL` 可能拿到空图）→ 翻转成 2D 画布 → 叠加可见的 Live2D 覆盖层 → `toBlob` 触发下载；文件名 `modelstage-<模型名>-<YYYYMMDD-HHMMSS>.png` | `__WEB__.screenshotExport{filename,bytes,width,height,nonEmpty}`；`data-screenshot` |
| 影院模式 | 切 `<html data-cinema="on">`：顶栏与左右栏滑出、舞台铺满；静止 3s 播放条与光标淡出，鼠标一动回来；Esc 退出 | `data-cinema`；顶栏 `bottom≤0`、左栏 `x<0`、右栏 `x≥视口宽`，再点复位 |
| 菜单 | **按钮已删除**：没有可放的内容（本项目的操作都在顶栏与右栏面板里，无下拉菜单概念），留空菜单等于骗点击 | `#btn-menu` 不存在 |
| 导入模型 | **按钮已删除**：本项目按资源根目录扫描加载模型（`/api/roots` + 名册树），没有"导入单个模型"这条路径；旧前端的导入也没在这条链路上 | `#btn-import` 不存在 |

截图导出在无头环境只能验到"blob 生成 + 文件名字段正确"（约 1.7MB / 1920×1080 / 非空像素 75 万），**真实落盘需人工确认**。

### F3 角色树「定位当前角色」（左栏）

选中一个模型后，左栏自动把该行滚进可视区（实现：`roster/reveal.js`）。三条纪律：

| 纪律 | 行为 | 可观测判据 |
|---|---|---|
| ① 已可见不动 | 行本来就在可视区 ⇒ 完全不滚动（避免每次选中都跳） | `lastReveal === 'visible'` |
| ② 不跟用户抢 | 用户滚动手势（wheel / touchstart / pointerdown / scroll）后 **800ms 冷静期**内不自动滚 | `lastReveal === 'skipped-user-scrolling'`，`scrollTop` 不变 |
| ③ 折叠先展开 | 目标行藏在折叠的父级里 ⇒ 先按展开状态把父级展开（状态驱动再渲染）再滚 | `expandedChars` 增加、渲染行数从 0 变 N |

补充两点实现细节：
- 程序自己触发的 `scrollIntoView` 也会派发 `scroll` 事件，用 `autoScrollUntil` 时间窗排除，**不会自我误判成用户滚动**；
- 启动自动恢复（`restoreLast`）同样走这套定位，所以"恢复到上次模型"也会把行滚进视野，但用户正在滚时照样让位。

### F4 资源根管理（左栏）

左栏顶部「资源根 N 个 / 管理」区块，接 `POST /api/roots` 四个动作（`add` / `rename` / `toggle` / `remove`）：

| 动作 | 交互 | 结果与提示 |
|---|---|---|
| 新增 | 填**服务端绝对路径** + 可选显示名 → 「选择目录」提交 | 成功提示「已添加资源根：名字（路径）」；非绝对路径 400、目录不存在 400、已登记 409 都原样显示后端文案 + 状态码 |
| 改名 | 行内「改名」→ 输入框 → 保存 | 成功「已改名为「X」」；**命中已有名字时后端返回 `merged:true`，界面提示「已合并到同名根「X」」**（分组数 -1），不显示成改名成功 |
| 启停 | 行内「停用 / 启用」 | 传**真布尔**（字符串 "false" 会被后端 400）；停用后条目仍留在管理列表里（用后端 `rootsAll` 渲染），随时可再启用 |
| 删除 | 行内「删除」→ 行内二次确认「确认删除 / 取消」 | 成功「已删除资源根：id」；404 未找到原样显示 |

为什么用文本框收路径而不是系统目录选择器：模型是**服务端**扫描自己文件系统加载的，
浏览器 `showDirectoryPicker()` 给出的是客户端沙箱句柄，**变不成服务端可读路径**，传过去毫无意义；
项目也没有服务端目录浏览接口（属于 M5 插件接口范畴）。所以这里用绝对路径输入 + 已有根做 datalist 提示 + 后端校验兜底。

已知接口缺口：`GET /api/roots` **只返回启用项**，所以"刷新页面后，已停用的根"在管理列表里看不到
（当次会话内不会消失，因为后续列表都用 POST 返回的 `rootsAll` 渲染）。要彻底解决需要后端补
`GET /api/roots?all=1` 或 `{action:"list"}`。

未做（后续里程碑）：

- [x] 右栏控件与底栏播放条接线（M3 / M6）—— 见 §F1、§F5
- [x] 舞台渲染（M4 Spine、M5 Live2D）
- [x] 设置导入导出（M7）—— 见 §F1 的「设置」组
- [ ] 顶栏空闲自动隐藏（旧前端空闲时把 header 上移 48px；视觉已降级，M6 再谈）

### F5 动作列表与循环（右栏「动作」组）

「动作」组内是**两个开关 + 一份动作列表**：

| 元素 | 管什么 | 开 / 关 |
|---|---|---|
| 混合模式 | 切换动作那一瞬间的过渡 | 开 = 约 0.2s 渐变（旧动作渐隐、新动作渐显）；关 = 硬切 |
| 循环播放 | 播完之后接谁 | 开 = 按列表顺序连播、末尾回到第一条；关 = 停留当前动作重复播 |
| 动作列表 | 按模型动画逐条列出 | 每条显示「名字 · 时长」，当前播放项高亮；取不到时长只显名字，不显示 0s |

两个开关**正交**：改一个不改变另一个的状态与行为。设置随面板偏好持久化
（与其它面板设置同一个存储键的 `panel` 字段，刷新后保持）。

**数据来源唯一**：`app/anim-list.js` 的 `buildAnimationList()`，右栏与底栏都只调它。

```
Spine    读骨架动画（含时长）
Live2D   读 motion groups，标签形如 `group / motion`；
         时长取自动作文件的 Meta.Duration，装载后预取并缓存，无需先播一遍
```

底栏动作控件与右栏是**同一份数据**：内容逐项一致（同顺序、同文案、同时长），
点任一处都能播放，另一处的高亮经 `#transport-motion` 的值同步。

循环推进时，时长为 0 的空动画用固定间隔跨过（否则会停在第一条空动画上）。

### M3 右栏面板骨架 + 播放条（已完成）

> 本节记录 **M3 阶段**的骨架状态（当时多数控件尚未接线、底栏为 8 项）。
> **当前实际状态**见 §F1～§F5 的接线记录。

- [x] 右栏 **9 个手风琴分组**：动作 / 皮肤 / 播放 / 滤镜 / PMA 预乘 / 运行时 / 主题背景 / 调试绘制 / 设置
      （分组名与顺序逐字照旧前端；默认只展开「动作」）
- [x] 设置组 **10 个子项全部列全**：渲染帧率（60 FPS / 30 FPS）、渲染像素比 DPR（自动 / 1 / 1.5 / 2）、
      初始缩放（主体优先 / 全部部件 / 动画全程，含旧前端的悬停说明）、纹理过滤（双线性 / 最邻近）、
      抗锯齿 MSAA（自动 / 关闭）、防卡死保护 / 显示状态信息 / 调试日志（开关）、
      导出设置 / 导入设置 / 恢复默认（按钮）
      （「模型导入模式（替换 / 追加）」控件已删除：本项目模型来源是资源根目录扫描，没有"导入单个模型"这条路径）
- [x] 底部播放条 **7 个控件**：上一个 / 皮肤（下拉）/ 播放暂停 / 动作（下拉）/ 下一个 / 重置视图 / 背景
      （「单动循环」已移除：该名字字面上是"单个动作反复播"，与真实行为相反；
      循环改由右栏「动作」组的「循环播放」开关控制，语义见 §F5）
- [x] **接线边界**（铁律 1）：手风琴开合是真实行为（aria-expanded + body.hidden 同步）；
      组内控件与播放条控件**一律 disabled + `data-pending=true`**，M6 统一接线
- [x] 区域几何与旧前端逐值相同：右栏 `[1744,48,176,968]`、播放条 `[600,1023,720,42]`
- [x] 控件数对比（旧前端 8803 实测 → 新前端）：
      右栏 旧 40（可见 37）/ 新 32（9 手风琴 + 23 未接线控件）；差集 = 缺 7 个动作按钮（模型相关，M6 由
      `dynamic-list` 填充）+ 多 2 个（替换/追加，旧前端被自家补丁隐藏，M3 口径要求列全）；
      底栏 旧 10（可见 8，另 2 个是移动端重复的 上一个/下一个）/ 新 8
- [x] 穷举实操 20 项全过 + 控制台零错误（`test/panel-actions.js`）

## 五、诊断（window.__DIAG__）

页面自带诊断探针，**API 与旧前端 `legacy/patches/diag.js` 完全一致**（同一套检查代码可对两个前端跑）。
`main.js` 在模块体第一件事就安装它，保证早期错误也能被抓到。

采什么（只收错误/警告/关键事件，**不做每帧采样**）：

- `window.onerror`（含资源加载失败：img/script/link/video/audio，capture 阶段）
- `unhandledrejection`
- 包装 `console.error / warn / info`（幂等：重复注入只生效一次；保留原引用；内部日志不自激）
- 业务主动上报：`__DIAG__.event('stage.load', { … })`

怎么读（浏览器控制台）：

```js
__DIAG__.__installed          // true = 已安装
__DIAG__.errors()             // 所有 error 级条目（含 window / rejection / resource.fail）
__DIAG__.warnings()           // warn 级
__DIAG__.timeline()           // 一行一条的时间线（便于贴给 AI 看）
__DIAG__.tail(10)             // 最近 10 条完整条目
__DIAG__.size()               // { buffered, capacity, pendingFlush, sinceMs }
__DIAG__.dump()               // 全部缓冲（最多 capacity 条）
__DIAG__.clear() / flushNow() // 清空 / 立即落盘
__DIAG__.config               // 当前配置（capacity=500 等）
```

落盘：批量 `POST /api/diag` → 服务端追加写 **`data/diag.jsonl`**（一行一条 JSON）。
落盘失败会静默降级为仅内存，不影响页面。查看方式：`wc -l data/diag.jsonl` / `tail -3 data/diag.jsonl`。

面板显示：本阶段不做（等 M6 的「调试日志」开关）。

## 六、自测方式

### 测试脚本的前置条件（跑之前先看这张表）

每个 `test/*.js` 都是"页面上下文里的自求值 async IIFE"，由 `tool/check-console.mjs --script` 执行。

**三条硬规矩**（踩过多次才总结出来）：

1. **判据的前置条件必须由脚本自己建立或自己断言**——不能依赖"上次跑时环境正好合适"
   （踩过：F1③ 依赖"页面恰好有模型"、F2 里两行从未被使用的死变量、F4 依赖临时目录存在）；
2. **脚本里不出现硬编码绝对路径**（`/tmp/...`、`/volume1/...` 都不行）：需要路径的一律由**调用方传参**，
   或从项目内相对位置派生。跨平台（Windows 无 `/tmp`）也能跑；
3. **缺前置 = skip，不是 fail**：断言文案以 `skipped:` 开头，报告里单列 `skipped` 计数；
   真正该失败的仍然 fail（不许拿 skip 放水）。

| 脚本 | 前置 | 传参 | 无前置时的行为 |
|---|---|---|---|
| `f1-controls.js` | 页面已启动；配置里至少一个能扫出模型的资源根 | 无（自动从 `GET /api/roots` 找第一个有模型的根） | F1③ 记 `skipped:`（其余三项不依赖模型，照跑） |
| `f2-topbar.js` | 同上（截图要有画面可截） | 无（同上自动发现） | F2② 记 `skipped:`（按钮集合、影院、Esc 照跑） |
| `f3-reveal.js` | 名册有足够长的列表 | 无（自己挑"变体最多的游戏"展开全部角色制造滚动） | 断言里写明行数/可滚高度，不足即 fail（属真实功能判据） |
| `f4-roots.js` | **服务端存在一个探针目录**（浏览器建不了服务端目录） | **要**：`?f4probe=<服务端已存在的目录>` | 写入类 5 条 + 清理记 `skipped:`；错误路径 400/409/404 照跑 |
| `spine-actions.js` | 配置里至少一个能扫出模型的根；WebGL 可用 | 无（`pickModel` 先按偏好根、找不到就跨根兜底） | 整份记 1 条 `skipped:` 并提前返回（不崩） |
| `panel-actions.js` | 页面已启动 | 无 | — |
| `roster-actions.js` | `GET /api/roots` 可用 | 无 | — |

F4 的跑法（探针目录**别用点开头的隐藏目录**：`/api/browse` 不列隐藏项，会被预检判成不存在）：

```bash
mkdir -p runtime/f4probe            # 幂等；runtime/ 已 gitignore、不含模型，登记成根不会触发大扫描
node tool/check-console.mjs "http://127.0.0.1:8804/?f4probe=$(pwd)/runtime/f4probe" \
     --json --script test/f4-roots.js
```

不传 `?f4probe=` 时输出示例（`failed=0`、`skipped=6`，错误路径仍实测）：

```
✅ F4 前置自证（探针目录可由参数传入） | skipped: 未传 ?f4probe=<服务端已存在的目录>
✅ （跳过）F4① 添加资源根            | skipped: 未传 ?f4probe=…
✅ F4⑤ 错误如实显示（400/409/404）    | 相对路径→400「path 必须是绝对路径」…
```

```bash
# 1) 零错误自证（四类信号：console.error / 未捕获异常 / 浏览器日志 error / 4xx 与请求失败）
node tool/check-console.mjs http://127.0.0.1:8804/
# 有错退出码 2，可直接进 CI/验收脚本

# 2) 穷举实操 + 断言（脚本在页面上下文里执行，结果随报告一起打印）
node tool/check-console.mjs http://127.0.0.1:8804/ --script test/roster-actions.js
#    M3 面板/播放条：node tool/check-console.mjs http://127.0.0.1:8804/ --script test/panel-actions.js
#    动作脚本的形态约定：文件内容是一个自求值 async IIFE，返回值即结果
#    （这样既能在页面里 await，又能通过 node --check 的语法检查）

# 3) 数据源（本端自带，不依赖旧端）
curl -s http://127.0.0.1:8804/api/roots | head -c 200
curl -s http://127.0.0.1:8804/api/brand

# 4) 页面状态快照（浏览器控制台里读，自动化断言也用这个）
#    window.__WEB__.rosterSnapshot()
#    → { games:[{key,name,roots,status,sources,chars,variants,miss}],
#        expandedGames, expandedChars, keyword, selected, domRows }
```

## 七、决策记录（已裁决）

1. **一级节点按 name 合并**：与旧前端 `char-tree.js` 一致（2 个游戏节点），角色**跨根归并**。
   早期一版按一根一行实现（4 个节点），已按裁决改回合并口径。
2. **搜索补加载全部游戏**：为做全局过滤，首次输入关键词时并行拉齐各游戏（服务端有清单缓存，
   实测 <1s）。取舍：宁可多一次请求，也要搜得到——只搜已展开的游戏会让人以为列表缺内容。
3. **`tool/diff-rect.mjs` 不做**：视觉已降级，区域几何改用 `tool/shot-compare.mjs` 或人工核对。
4. **穷举动作脚本入库在 `test/roster-actions.js`**：M2 的回归脚本，改左栏行为后先跑它。

## 八、渲染面与目录的当前约定

### 8.1 独立服务端

```
入口：src/server/serve.mjs（web.sh 默认启动它）
提供：静态文件 + /api/* 全部接口 + /files/* 模型资源 + /engine.js + /live2d-lib/* + /spine-runtimes/*
不依赖：8803（旧前端仅作对照，可随时停）
```

验证方式（停掉旧端后仍应全部可用）：

```bash
bash server.sh stop
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8804/            # 200
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8804/api/catalog?root=bd2'  # 200
bash server.sh start
```

### 8.2 尺寸与相机的唯一来源

| 事 | 唯一负责人 | 说明 |
|---|---|---|
| 舞台几何（CSS 像素） | `render/surface.js` 的 `geometry()` | 渲染器只读取，不得自行测 DOM |
| 背板像素尺寸（canvas.width / resolution） | 由 `geometry()` 推导后交给渲染器 | 不允许出现第二处 DPR 计算 |
| 相机（范围、步进、锚点、复位） | `render/camera/index.js` | 唯一钳制点；Spine 与 Live2D 语义一致 |
| 交互（滚轮/拖动/双指） | `render/interaction.js`，绑定 `surface.interactionTarget` | 绑舞台区域，不绑某块画布 |
| 背景（棋盘/纯色/透明） | `surface.setBackground()` | 写 `data-bg` 的唯一入口，渲染器不画背景 |

调参只改 `render/camera/constants.js`（`MIN 0.125 / MAX 16 / STEP 0.1 / FIT_MARGIN 0.05`），逻辑里不允许出现同样的裸数字。

### 8.3 目录规则

```
新增文件先问职责：基础设施 → infra/；某块业务 → 对应目录；渲染与相机 → render/
文件名不带模块前缀（在目录里已经表达了归属）
单文件 ≤ 400 行；main.js 只做装配
搬迁必须分批（每批 ≤5 个文件），每批做语法 + 相对 import 扫描 + 页面实测，再单独提交
```
