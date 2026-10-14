# Bundle 地图（P1 只读侦察产出）

> 输入：`src/app-shell.html`（816,875 chars / 823,636 bytes，"0.8MB 压缩应用层" + HTML 外壳）
> 扫描脚本：`tool/bundle-map.mjs`（零依赖；词法掩码 + 括号配平 + 特征串锚点）
> 本文所有偏移都是**字符偏移**（不是字节偏移），区间写法 `[start, end)` 左闭右开。
> 生成方式与复核命令见文末第十节；本文表格由脚本输出整理，脚本每次运行都会重新自校验锚点。

---

## 〇、结论摘要（先看这 5 条）

1. **`src/app-shell.html` 里没有 `window.__SPINE_RUNTIME_SOURCES__` 赋值语句**，只有一个占位注释
   `/*__SPINE_RUNTIME_SOURCES_PLACEHOLDER__*/`（@134426）；真正的赋值在**构建期/响应期**注入
   （`tool/build.mjs` 的 `PLACEHOLDER` 替换）。磁盘上的 `baseline/index.html` / `dist/index.html`
   里它已变成 3,554,846 字符的大对象，并把后面的 module 脚本整体后移 3,554,683 字符。
   → 模块脚本里的两处 `__SPINE_RUNTIME_SOURCES__`（@518220、@518336）是**读取点**（运行时懒加载器），不是赋值点。
2. **渲染引擎类 `mt` 是纯类（无 React 依赖）**：类体内 `S.use*`/`he.use*`/`v.jsx`/`useState`/`useRef`/
   `useEffect`/`useCallback`/`useMemo` 命中数全部为 0；类体内 7 处 `createElement` 全部是
   `document.createElement("canvas")`（WebGL 画布）。但它**不是零依赖**：依赖打包器助手 `de` 与
   同 bundle 的 12 个引擎辅助符号（全部定义在紧邻其前的 `[521938, 534612)` 区）。
3. `mt` 是**类表达式 + 双名**：`const mt=class mt{…}`（@534612），类体 `[534621, 588576)`，
   共 53,955 字符；随后静态字段 `de(mt,"NON_SUBJECT_RE",…)` 等 8 个，并在 @589350 出现
   `let Xd=mt;` —— **`Xd` 与 `mt` 是同一个引擎类的两个绑定**，应用层用 `new Xd({…})`（@739634）实例化，
   实例挂在主组件 `AL` 的 `c.current`（@741026 `c.current=B`）。
4. 事件层（双指缩放/拖拽/滚轮）**在 React 组件体内**（`AL` 组件，`function AL(...)` 区间 `[739199, 810874)`）：
   `[746389, 748274)` 这一段声明串，事件通过 JSX `onWheel:Rf, onPointerDown:_f, onPointerMove:au,
   onPointerUp:ru, onPointerCancel:ru`（@766612）绑到舞台元素上，最终调 `c.current.applyZoom / applyPan /
   setCameraZoom / resetCamera`。
5. 第三方库不止文档里列的 7 个：还有 **scheduler、tailwind-merge、zustand**（文档里的 `Fe`→zustand hook 已证实）。
   `framer-motion` 与 `radix-ui` **没有 license 横幅**，靠特征串判定（见第七节，标"推断"）。

---

## 一、外壳分区（HTML 层，非 JS）

| id | 区间 | 大小 | 内容概述 | 依赖 | 可抽性 | 置信 / 依据 |
|----|------|------|----------|------|--------|-------------|
| S1 | [0, 410) | 0.4KB | 版权注释 `<!-- Vibed by Souling & 豆包 -->` + DOCTYPE/meta/title | 无 | 不动（外壳） | 精确 / 文件头 |
| S2 | [410, 134378) | 130.8KB | `<style>` 全部 CSS：`/*! tailwindcss v4.3.3 \| MIT License */`（@453）+ 自定义样式（含 radix / sonner 选择器） | 无（纯 CSS） | 可整体抽 `src/app.css`，但**会破坏逐字节等价**（大小写/空白），P2 阶段不动 | 精确 / `<style>`…`</style>` |
| S3 | [134380, 134543) | 0.2KB | boot 内联脚本：`window.__SPINE_SINGLE_FILE__ = true;` + 占位符注释 `@134426` + `window.__SPINE_DEMO__ = {};` | 无 | 保留（这是"单文件"开关与运行时注入点） | 精确 / `<script>`…`</script>` |
| S4 | [134543, 134565) | 22 字符 | `<script type="module">` 开标签 | 无 | 不动 | 精确 |
| S5 | [816818, 816875) | 0.1KB | `</script></body></html>` + 尾部版权注释 | 无 | 不动 | 精确 |

## 二、module 体分区表（`[134565, 816818)`，首尾相接、无缝覆盖）

**置信说明**：`精确` = 由 license 横幅 / 括号配平 / 顶层语句边界给出；`近似` = 由特征串 + 相邻块边界推定（压缩产物没有模块分隔符）。

| id | 区间 | 大小 | 类 | 内容概述 | 依赖 | 可抽性评估 | 置信 |
|----|------|------|----|----------|------|-----------|------|
| V0 | [134565, 136282) | 1.7KB | vendor | 打包器前导：CJS interop（`iT/cb/aT/de/ub/dn/db/gm`…）与 `__esModule` 标记 | 无 | 不抽（`de` 被 `mt` 用到，抽 `mt` 时需带 or 保留） | 精确 |
| V1 | [136282, 137006) | 0.7KB | vendor | `react-jsx-runtime.production.js`（@136289 license） | react | 不抽 | 精确 |
| V2 | [137006, 145132) | 7.9KB | vendor | `react.production.js`（@137013） | 无 | 不抽 | 精确 |
| V3 | [145132, 149006) | 3.8KB | vendor | `scheduler.production.js`（@145139） | 无 | 不抽 | 精确 |
| V4 | [149006, 152847) | 3.8KB | vendor | `react-dom.production.js`（@149013） | react | 不抽 | 精确 |
| V5 | [152847, 331154) | 174.1KB | vendor | `react-dom-client.production.js`（@152854）；主体是 `[153099, 330859)` 的 173.6KB CJS 包装函数 | react / scheduler | 不抽 | 近似（左精确、右由 V6 起点界定） |
| V6 | [331154, 333523) | 2.3KB | vendor | **zustand**：`const wb=n=>{…createStore…}`（@331154）+ `yT`(useStore) + `Mb` | react(useSyncExternalStore) | 不抽 | 近似 |
| V7 | [333523, 366680) | 32.4KB | vendor | **sonner**：toast 图标表、`PT(\`:where(html[dir="ltr"])…\`)` 样式注入（@339671）、Toast 组件 | react | 不抽 | 近似 |
| A1 | [366680, 382123) | 15.1KB | app | 应用 store `const Fe=vT((n,t)=>({models:[],…`（[367348, 382146)）+ 模型源判定 `pd`、示例模型常量 | zustand | **必抽/必读**（右栏 UI 的单一数据源） | 近似 |
| V8 | [382123, 496774) | 111.9KB | vendor | **framer-motion**（含 motion-dom / motion-utils），无 license 横幅；特征 `framerAppearId`@389671、`data-framer-portal-id`@390993 | react | 不抽 | 近似 |
| V9 | [496774, 515981) | 18.8KB | vendor | **lucide-react v0.468.0** 图标体（47 个 license 横幅，首个 @496781；图标由 `_e(name, shapes)` 生成） | react | 不抽 | 精确 |
| A2 | [515981, 521938) | 5.8KB | app | lucide 最后几个图标 + 应用常量，**同一条 `const` 语句**：`bw=_e("X",…)`、`Sd=["3.6"…"4.3"]`、`WD={"/spine-runtimes/…"}` | lucide | 语句级**无边界**，切分要按 declarator（逗号）切 | 精确 |
| A3 | [521938, 534612) | 12.4KB | app | **引擎辅助区**：`let Yd=Is` 运行时管理器、`Tp/Ep/xw` 日志与文件工具、`rk/sk/lk` 贴图加载、`Io/Od` 骨架/atlas 解析、`Fm`(默认滤镜)、`yk/vk`(滤镜表/着色器) | 无（自包含） | **与 `mt` 一起抽**（mt 的 12 个外部符号全在这） | 近似 |
| E1 | [534612, 588577) | 52.7KB | **engine** | ★ `const mt=class mt{…}`：类体 [534621, 588576) 53,955 字符；76 个私有字段；渲染循环/相机/缩放/滤镜/PMA/上下文丢失恢复/截图导出 | V0 的 `de` + A3 的 12 个符号 | **P2 首个抽取目标** | 精确（括号配平） |
| E2 | [588577, 589360) | 0.8KB | engine | `mt` 静态字段 8 个：`NON_SUBJECT_RE / CORE_RE / FIT_MAX_RATIO / FIT_MARGIN / SCALE_MIN / SCALE_MAX / ZERO_DURATION_EPS / SOFTWARE_RE`，末尾 `let Xd=mt;`（@589350） | E1 | 与 E1 同抽（类语义的一部分） | 精确 |
| A4 | [589360, 595123) | 5.6KB | app | `const bk=\`…\``：内联 ZIP worker 源码字符串（`'use strict'` + `findEOCD` 等，独立 worker 脚本） | 无 | 不抽（纯字符串） | 精确 |
| A5 | [595123, 607391) | 12.0KB | app | 引擎/应用其余工具：`let Xa=null,kc=null,aa=!1;function xk(){…}` 等（运行时缓存、导出、GL 相关） | E1 | 阅读优先，抽取次优先 | 近似 |
| V10 | [607391, 623920) | 16.1KB | vendor | **tailwind-merge**：`const xt=n=>{…isThemeGetter…}` + 属性/颜色冲突表（`"color-dodge"`@609313） | 无 | 不抽 | 近似 |
| A6 | [623920, 638730) | 14.5KB | app | shadcn UI 基础件：`function pn(...n){return uj(Pw(n))}`（cn = tailwind-merge + clsx）、Button（@624800，`data-slot:"button"`）、`window[Symbol.for("radix-ui")]=!0`（@631246） | V10 / radix | 抽（UI 层） | 近似 |
| V11 | [638730, 720789) | 80.1KB | vendor | **radix-ui primitives**：Primitive/Slider/Dialog/Menu/Presence 等（`data-radix-*` @632032…@717906） | react | 不抽 | 近似 |
| A7 | [720789, 739199) | 18.0KB | app | 应用 UI 组件（右栏/工具栏/设置面板等，含 radix 封装：`function EM(n){return n?"open":"closed"}` @720789） | V11 / A6 | 抽（UI 层） | 近似 |
| A8 | [739199, 810874) | 70.0KB | app | ★ **主应用组件** `function AL({bootPhase,bootDetail,onPhaseChange})`：创建引擎 `new Xd({…})`@739634 → `c.current=B`@741026，含事件层（见第四节） | E1 / A1 / A6 / V11 | **P3 目标**（事件层 P3.2 先抽） | 精确（语句边界） |
| A9 | [810874, 816818) | 5.8KB | app | 收尾：`function RL(){const{loadSettings:n}=Fe(),…}`、demo 模型模块 `jL/kL`（`Object.freeze(Object.defineProperty({…},Symbol.toStringTag,{value:"Module"}))`） | A1 | 抽（应用层） | 精确 |

---

## 三、关键区块四元组（P2/P3 直接要用的）

### 3.1 渲染引擎类 `mt`

| 项 | 值 |
|----|----|
| 起 | `const mt=class mt{` @534612（类体 `{` @534629） |
| 止 | 类体结束 `}` @588575（含 `}` 的区间 `[534621, 588576)`），语句到 `;` @588576 |
| 概述 | Spine WebGL 渲染引擎：`constructor(t={})` 初始化 76 个私有字段（canvas/gl/runtime/runtimeInfo/mode/skeleton/skeletonData/state/stateData/renderer/debugRenderer/camera/atlas/animationId/.../renderLoop/lastEmitTime），31 个方法，含 `loadSkeletonFromData / render / applyZoom / setCameraZoom / applyPan / resetCamera / getCameraZoom / refreshResolution / dispose`、滤镜、PMA 探测、上下文丢失恢复、截图导出 |
| 依赖 | `de`（V0 的私有字段助手，类体内 76 次）、A3 的 12 个符号（见 3.2）；**无 React**；无第三方库直接引用（Spine 运行时通过 `this.runtime` 动态注入） |
| 可抽性 | **高**：类边界由括号配平精确给出，可与 A3 一起整块搬到 `src/engine.js`；`de(...)` 需在头部登记为待解析符号或改成 `Object.defineProperty` 包装 |

**`mt` 外部符号表（权威结果，用 acorn 做自由变量分析得到；脚本内还有一路正则粗筛）**

| 符号 | 类体内引用次数 | 定义位置 | 用途（由上下文推断） |
|------|---------------|----------|----------------------|
| `de` | 76 | @134747（V0） | 打包器私有字段定义助手 `de(this,"x",v)` → `Object.defineProperty` |
| `Io` | 5 | @531820（A3） | atlas 文本解析（`Io(t.atlasFile)`） |
| `Fm` | 3 | @534446（A3，`,Fm=`） | 默认滤镜 id（`currentFilterId` 初值） |
| `Od` | 3 | @532009（A3） | 骨架数据解析（`Od(t.skeletonFile)`） |
| `Ep` | 2 | @522383（A3，`,Ep=`） | 日志器（`Ep.error("[SpinePlayer][...]")`） |
| `Tp` | 2 | @522394（A3） | atlas 路径/内容预处理 |
| `Yd` | 1 | @521938（A3，`let Yd=Is`） | Spine 运行时管理器单例（`Yd.getInstance()`） |
| `xw` | 1 | @522496（A3） | 贴图文件归一化 |
| `rk` | 1 | @525184（A3） | 贴图批量加载（`await rk(...)`） |
| `sk` | 1 | @526101（A3） | PMA 探测（`sk(pmaMode, pmaDetection, runtime)`） |
| `lk` | 1 | @527450（A3） | 像素/贴图变换（`await lk(imageData)`） |
| `yk` | 1 | @534461（A3） | 滤镜 id 校验（`yk(t)?t:Fm`） |
| `vk` | 1 | @534504（A3） | 滤镜着色器表（返回 `{vs, fs}`） |

> 12 个 A3 符号的定义位置全部落在 `[521938, 534504]` —— 全部紧邻 `mt` 之前，
> 且 `mt` 的声明起点 @534612 紧跟其后结束。**结论：`mt` 所在的引擎模块在 bundle 内自包含**，
> 抽 `mt` = 抽 `[521938, 589360)`（A3 + E1 + E2，含 `let Xd=mt`）+ 从 V0 借一个 `de`。

### 3.2 事件层（双指缩放 / 拖拽 / 滚轮）

| 项 | 值 |
|----|----|
| 起 | `[746389, 748274)`（声明串起点 = `const`，`wn=S.useRef(new Map)` @746628） |
| 概述 | React 组件 `AL` 内的指针事件层：指针集合 Map + 双指距离 + 滚轮 + down/move/up 三个 `useCallback` |
| 依赖 | React（`S.useRef` / `S.useCallback`）、引擎实例 `c.current` |
| 可抽性 | 中：逻辑集中、可整理成 `bindStageEvents(engineGetter, canvas)`，但**必须保留 React hooks 外壳**（`useRef`/`useCallback`），P3.2 计划把 `useCallback` 改普通函数再由 React 层 `useMemo` 包回 |

符号与偏移：

| 压缩名 | 偏移 | 推断真名 | 证据 |
|--------|------|----------|------|
| `wn` | 746628 | `pointersMap`（pointers Map） | `wn.current.set(M.pointerId,{x,y})`、`wn.current.size===1/2` |
| `oo` | 746679（`oo=S.useRef(0)`） | `pinchStartDistance` | `oo.current=iu(ue[0],ue[1])`，move 中 `se/oo.current` 算比例 |
| `nu` | 746708 | `pinchStartZoom` | `nu.current=c.current.getCameraZoom()??1` |
| `vr` | 746729 | `pinchCenter`/`lastPinchCenter` | `vr.current={x:(ue[0].x+ue[1].x)/2,…}`，move 中作为上次中点 |
| `Rf` | 746702 | `onWheel` | `M.deltaY>0?-1:1` → `c.current.applyZoom(B)` |
| `iu` | 746796 | `pointerDistance` | `(M,B)=>Math.sqrt((M.x-B.x)**2+(M.y-B.y)**2)` |
| `_f` | 746843 | `onPointerDown` | `setPointerCapture` + size===2 → 记录 `oo/nu/vr` |
| `au` | 747316 | `onPointerMove` | 双指 → `setCameraZoom`、平移中线 → `applyPan` |
| `ru` | 748001 | `onPointerUp`/`onPointerCancel` | `delete(pointerId)` + `releasePointerCapture` |
| `Ml` | 748274 | `onResetCamera` | `c.current.resetCamera()` |
| `ms` | 746571（`ms=S.useRef(!1)`） | `panArmed`（单指可拖标志） | size===1 → `ms.current=!0`，move 里 `size===1&&ms.current` 才平移 |
| `yr` | 746600 | `lastPanPoint` | `yr.current={x:M.clientX,y:M.clientY}` |
| `wl` | 746628 前（`wl=S.useRef(!1)` @746620） | `dragMoved`（是否真拖动过） | move 中 |Δ|>2 → `wl.current=!0` |
| `Ct` | 746569（`Ct=S.useRef(null)`） | 提示条定时器 id（**不是** canvasRef） | 与 `window.setTimeout/clearTimeout` 成对使用 @748768-749034 |
| `c` | AL 内 `c=S.useRef(null)` @739295 | 引擎实例 ref | `c.current=B` @741026（`B=new Xd({…})` @739634） |
| `Fe` | 367348 | zustand store hook（应用全局 store） | `const Fe=vT((n,t)=>({models:[],…` |
| `Xd` | 589350（`let Xd=mt`） | 引擎类别名 | `new Xd({onStateChange:…,onLog:…})` @739634 |

接线（证据 @766612）：舞台元素 `className:"… cursor-grab active:cursor-grabbing touch-none", onWheel:Rf, onPointerDown:_f, onPointerMove:au, onPointerUp:ru, onPointerCancel:ru`。

### 3.3 运行时注入点

| 项 | 值 |
|----|----|
| 占位符 | `/*__SPINE_RUNTIME_SOURCES_PLACEHOLDER__*/`，区间 `[134426, 134467)`（S3 内） |
| 注入实现 | `tool/build.mjs`：`PLACEHOLDER`/`KEY` 常量 + `shell.replace(PLACEHOLDER, stmt)`；`tool/split-app.mjs` 反向抽出 |
| 读取点 | @518220、@518336（`a.__SPINE_SINGLE_FILE__ && a.__SPINE_RUNTIME_SOURCES__[t]` → `evalRuntimeIsolated(d)`，分段懒执行 Spine 运行时） |
| 磁盘对照 | `baseline/index.html` / `dist/index.html`：注入后的 boot 脚本 `[134380, 3689226)`（3,554,846 字符），module 脚本 `[3689248, 4371501)`；相对 `src/app-shell.html` 的偏移量 **+3,554,683** |

### 3.4 主应用组件 `AL`

| 项 | 值 |
|----|----|
| 区间 | `[739199, 810874)`（70.0KB，P1 之前未知，由 acorn 顶层语句清单查出） |
| 概述 | `function AL({bootPhase,bootDetail,onPhaseChange})`：boot 阶段、引擎创建与生命周期、事件层、右栏 UI 接线、设置导入导出等 |
| 依赖 | `mt`(=`Xd`)、`Fe`(store)、shadcn/radix UI、lucide 图标 |
| 可抽性 | 低（70KB 组件，且与 UI 深度耦合）→ 对应步骤文档里的**降级分支 B2**：应用层整块可读化，只抽 engine/pointer/l2d |

---

## 四、符号表初稿（压缩名 → 推断真名）

标注：`已证` = 有直接代码证据；`推断` = 由上下文/用途推定。

| 压缩名 | 真名 | 状态 | 证据 |
|--------|------|------|------|
| `mt` | `SpineEngine`（命名建议） | 已证（语义） | 类名 `mt`、76 字段、31 方法（WebGL/camera/skeleton） |
| `Xd` | `SpineEngine` 的别名 | 已证 | `let Xd=mt;` @589350；`new Xd({…})` @739634 |
| `c.current` | engine 实例 | 已证 | `c.current=B` @741026（`B=new Xd(...)`）；事件层 `c.current.applyZoom/applyPan/setCameraZoom/resetCamera` |
| `Fe` | zustand store hook | 已证 | `const Fe=vT((n,t)=>({models:[],…` @367348 |
| `wn` | `pointersMap` | 已证 | 指针 Map（`setPointerCapture` + `size===2` 判定） |
| `oo` / `nu` / `vr` | `pinchStartDistance` / `pinchStartZoom` / `pinchCenter` | 推断（证据强） | down 记录、move 用比例与中点 |
| `Rf` / `_f` / `au` / `ru` / `Ml` | `onWheel` / `onPointerDown` / `onPointerMove` / `onPointerUp`+`onPointerCancel` / `onResetCamera` | 已证 | 函数体行为 + @766612 的 JSX 接线 |
| `iu` | `pointerDistance` | 已证 | `Math.sqrt((M.x-B.x)**2+(M.y-B.y)**2)` |
| `ms` / `yr` / `wl` / `Ct` | `panArmed` / `lastPanPoint` / `dragMoved` / 提示条定时器 | 推断 | 见 3.2 表 |
| `S` | react（命名空间） | 已证 | `S.useRef`、`S.useState`、`react.production.js` 导出 |
| `v` | react/jsx-runtime | 已证 | `v.jsx(…)`/`v.jsxs(…)` + `react-jsx-runtime.production.js` |
| `he` | react（另一处绑定） | 推断 | zustand/sonner 内 `he.useSyncExternalStore`、`he.createElement` |
| `Wx` | `Sparkles` 图标 | 已证 | `const Wx=_e("Sparkles",…)` @513517 |
| `XD` / `zD` / `bw` | `Settings` / `EyeOff` / `X` 图标 | 已证 | `_e("Settings")`@511657 / `_e("EyeOff")`@503374 / `_e("X")`@515990 |
| `pn` | `cn`（className 合并 = tailwind-merge + clsx） | 已证 | `function pn(...n){return uj(Pw(n))}` @623920 |
| `Yd` | Spine 运行时管理器 | 已证 | `let Yd=Is` @521938；`Yd.getInstance()` |
| `Fm` / `yk` / `vk` | 默认滤镜 id / 滤镜校验 / 滤镜着色器 | 推断 | 用法：`currentFilterId=Fm`、`yk(t)?t:Fm`、`vk(id)→{vs,fs}` |
| `Io` / `Od` | atlas 解析 / 骨架解析 | 推断 | `Io(t.atlasFile)`、`Od(t.skeletonFile)` |
| `rk` / `sk` / `lk` / `xw` | 贴图加载 / PMA 探测 / 像素变换 / 文件归一化 | 推断 | 见 3.1 外部符号表 |

---

## 五、依赖方向与拆分顺序（决定 P2 抽取方式）

```
        ┌──────────────────────────── React 19 (react / react-dom / scheduler / jsx-runtime) ─────────────┐
        │                                                                                                │
        │   zustand(V6) ──► Fe store(A1) ─────────────────┐                                              │
        │   sonner(V7) / lucide(V9) / framer(V8) / radix(V11) / tailwind-merge(V10)                       │
        └──────────────────────────────┬─────────────────────────────────────────────────────────────────┘
                                       │ 只有应用层用
        ┌──────────────────────────────┴──────────────────────────────────┐
        │  A3 引擎辅助区 [521938, 534612)  ← 12 个符号                     │   ← 无 React
        │  E1 mt 类       [534621, 588576)  ← 用 de + A3 的 12 个符号      │   ← 无 React
        │  E2 静态字段+别名 [588577, 589360)                              │   ← 无 React
        └──────────────────────────────┬──────────────────────────────────┘
                                       │ c.current / new Xd()
        ┌──────────────────────────────┴──────────────────────────────────┐
        │  A8 主组件 AL [739199, 810874)  ← 事件层 [746389, 748274)        │   ← 依赖 React hooks
        └─────────────────────────────────────────────────────────────────┘
```

**结论（回答"mt 是否纯类"）：是纯类，但不是零依赖。**

- 无 React：类体内 React 特征串命中 0（含 `v.jsx`/`useRef`/`useCallback`…）；7 处 `createElement` 全是 `document.createElement("canvas")`。
- 有同 bundle 依赖：`de`（打包器助手）+ A3 的 12 个符号 → 抽取时 `src/engine.js` 头部必须登记"待解析外部符号表"（步骤文档 P2.1 已经预留了这个动作）。
- 抽取顺序（与步骤文档 P1.3 的结论一致）：**先 `mt`（+A3）→ 再事件层 → 最后 React UI**；
  进一步地，A3 与 E1/E2 在 bundle 内是**连续的**（[521938, 589360) 共 67,422 chars ≈ 65.8KiB），
  可以一次整块搬出，避免 `mt` 与 A3 互相引用造成的"部分抽取"状态。

---

## 六、V1 验证结果（边界抽查 + 自检）

1. **边界抽查（3 个区块，脚本断言）**
   - ✅ `mt` 类 [534621, 588576) 53,955 chars
   - ✅ 事件层 [746389, 748274) 1,885 chars
   - ✅ react-dom-client 横幅区块 [152854, 156950) 4,096 chars
   - ✅ 抠掉 3 块 → 按原偏移回填 ≡ 原文（816,875 / 816,875 chars，逐字符相等）
2. **分区表自检**：✅ 28 个区块（外壳 5 + module 体 23）锚点全部命中；✅ module 体 `[134565, 816818)` 首尾相接、无缝覆盖、无重叠。
3. **词法掩码自检**：module 体内代码位括号计数 `{}` 7032/7032、`()` 18804/18804、`[]` 3104/3104。
4. **acorn AST 交叉验证（开发期一次性）**：把 `src/app-shell.html` 的 module 体交给 acorn 解析，
   按"字面量 / 注释 / 模板串定界符 = 非代码位"生成真值，与脚本掩码逐字符比对括号归属：
   **61,445 个括号字符，分歧 0 处**（字面量 8,720 / 注释 53 / 模板串 328 / 模板定界符 810）。
   → 掩码可信，脚本给出的 `mt` 起止、事件层起止可用作 P2 的区间表基线。

---

## 七、第三方库清单（12 项）

| 库 | 版本 | 判据（证据） | 区间（近似） | 是否需抽 |
|----|------|--------------|--------------|----------|
| tailwindcss | v4.3.3 | CSS banner `/*! tailwindcss v4.3.3 \| MIT License */` @453 | S2 [410, 134378) | 否 |
| react-jsx-runtime | React 19 世代 | license 横幅 @136289，`react.transitional.element` | V1 | 否 |
| react | 同上 | license 横幅 @137013 | V2 | 否 |
| scheduler | 同上 | license 横幅 @145139 | V3 | 否 |
| react-dom | 同上 | license 横幅 @149013 | V4 | 否 |
| react-dom-client | 同上 | license 横幅 @152854；`createRoot` @329844 | V5 [152847, 331154) | 否 |
| zustand | v5 世代（`getInitialState`） | `const wb=n=>{…setState/getState/getInitialState/subscribe}` @331154；`yT` 用 `useSyncExternalStore` @331525 | V6 [331154, 333523) | 否（但 `Fe` 要用） |
| sonner | 未知（无 banner） | `sonner-loading-wrapper` @333744、`data-sonner-toast` ×95、样式注入 @339671 | V7 [333523, 366680) | 否 |
| framer-motion | 未知（无 banner，**推断**） | `framerAppearId` @389671、`data-framer-portal-id` @390993、`animation/whileHover` 属性表 @386989、bezier/easing 实现 @409510 | V8 [382123, 496774) | 否 |
| lucide-react | v0.468.0 | 47 个 license 横幅（首个 @496781） | V9 [496774, 515981) | 否 |
| tailwind-merge | 未知（**推断**） | `const xt=n=>{…isThemeGetter…}` @607391、属性组表（`"color-dodge"` @609313） | V10 [607391, 623920) | 否 |
| radix-ui | 未知（**推断**，无 `@radix-ui` 字面量） | `window[Symbol.for("radix-ui")]=!0` @631246（Primitive 组件）、`data-radix-*` ×9（@632032…@717906）、`hasPointerCapture` @643796 | V11 [638730, 720789) | 否 |

补充说明：
- **`clsx`**：`pn` = `uj(Pw(n))`，`Pw` 是 clsx 风格实现、`uj` 是 twMerge → clsx 体积很小，已内联进 A6 区，未单独成块。
- **Spine 运行时不在 `src/app-shell.html` 里**：3.39MB 运行时只在 `baseline/index.html` / `dist/index.html`
  的注入脚本中（运行期按需 `eval`）。所以 P2 抽 `mt` 时**不需要**处理运行时；`this.runtime` 由注入的
  `window.__SPINE_RUNTIME_SOURCES__[version]` 提供。
- **`framer-motion` / `radix-ui` / `tailwind-merge` 三个没有 license 横幅**，其区间是"特征串首末"推定的近似值；
  若 P3 要精确切分，需要改用构建端 sourcemap 或按顶层语句清单（acorn）切。

---

## 八、与既有事实的对照 / 修正记录

| 既有说法 | 本次实测 | 处理 |
|----------|----------|------|
| "应用层总长 798KB（src/app-shell.html）" | 文件 816,875 chars / **823,636 bytes = 804.3 KiB**；其中 HTML 外壳 134,565 chars、module 体 682,253 chars（798KB 应属"约数"或按另一种口径） | 记录差异，按实测值使用；文中一律写实测 |
| "渲染引擎类在 @约534621：class mt{…}" | ✅ 类体起点正是 @534621；但完整形态是 `const mt=class mt{…}`（**类表达式**，声明语句起点 @534612），类体 [534621, 588576) | 精确化：抽取区间建议按整条语句 [534612, 588577) + E2 |
| "事件层 @约746777" | ✅ 命中区间内（`ru` 附近）；完整区间 `[746389, 748274)`，`iu` 在 @746796 | 精确化 |
| "`__SPINE_RUNTIME_SOURCES__` 占位符在文件头部区域" | ✅ 占位符 `[134426, 134467)`；但**磁盘产物里没有赋值语句**，@518220/@518336 是读取点；赋值由 `tool/build.mjs` 在构建期替换 | 已在摘要第 1 条写明（P2/P3 改动时不要试图"切出赋值语句"） |
| "`Fe`→zustand store hook" | ✅ 证实（`const Fe=vT((n,t)=>({…}` @367348） | 保留 |
| "`Wx`→Sparkles 图标" | ✅ 证实（`Wx=_e("Sparkles",…)` @513517） | 保留 |
| "第三方库：React / react-dom / framer-motion / radix / lucide / zustand / sonner / tailwind" | 实测多 2 个：**scheduler**（React 内部依赖，独立块）与 **tailwind-merge**；framer/radix/tailwind-merge 为**推断**（无横幅） | 见第七节 |

---

## 九、给 P2 的抽取建议与风险

1. **抽取单元**：`[521938, 589360)`（A3 + E1 + E2，67,422 chars ≈ 65.8KiB）整块 → `src/engine.js`。
   头部登记外部符号：`de`（来自 V0）；若保持逐字节回填，则回填仍用 **bundle 原文区间**，`src/engine.js` 只作阅读视图（步骤文档阶段二的"双真相"架构）。
2. **不要按"语句"切 A2/V8**：`bw=_e("X",…), Sd=[…], WD={…}` 与 `Fe(…), qp=S.createContext({})` 是**同一条 `const` 语句**
   （declarator 级边界），按语句切会把 lucide 尾部和 framer 头部一起切进来。
3. **风险 R1（边界切错）**：本文件的锚点自检 + 边界抽查已能兜住"手抄偏移错"；
   真正危险的是**跨语句的 declarator 级边界**（A2、A1/V8 两处），切分时务必用逗号级扫描而不是整语句切。
4. **风险 R2**：`mt` 内部 31 个方法名可读，但**字段初始化顺序**由 76 个 `de(this,…)` 决定
   （构造函数里按固定顺序），重排会改变运行时行为 → 抽取时只做**语义重命名**，不动顺序。
5. **风险 R3**：`mt` 与 A3 是双向引用（`mt` 调 `Io/Od/rk/sk/lk/vk/yk/Fm/Tp/Ep`，A3 是否回引 `mt` 未逐一验证）——
   建议一次整块搬，别只搬 `mt`。

---

## 十、复现命令（相对项目根）

```bash
# 1) 全量扫描（人读报告：分区表 + mt/事件层 + 库锚点 + 自检）
node tool/bundle-map.mjs

# 2) 只跑边界抽查（V1 验收用，3 区块 + 回填等价）
node tool/bundle-map.mjs --spot

# 3) 结构化输出（JSON，机器读）
node tool/bundle-map.mjs --json

# 4) 可选：用真实解析器交叉验证词法掩码（需要 acorn 所在目录；非项目依赖）
node tool/bundle-map.mjs --cross-check <含 acorn 的 node_modules 目录>
#   或：ACORN_DIR=<...> node tool/bundle-map.mjs
```

退出码：0 = 全部自检通过（掩码配平 + 分区锚点 + 覆盖 + 回填等价）；1 = 有自检失败；2 = 掩码自检失败。

> 本文件不含任何绝对路径；区间数值全部由脚本重新计算，脚本每次运行都会校验本文表格中的锚点字符串。
