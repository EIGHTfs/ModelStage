# Live2D 运行时：自持目录 + 统一入口（多版本 API 收敛）

> 状态：设计（待实施）｜ 关联：`docs/参考/Live2D.md`、`docs/契约/交付纪律.md`

## 一、问题（都是真实现象，不是假设）

```
① 运行时库放在项目之外（工作区/spive2d/static/lib），项目自己不带库
   ⇒ 外部目录一改（换版本/删目录/改名），ModelStage 就静默降级或直接坏掉，
     而"库从哪来"只藏在一个探测脚本的搜索顺序里，看代码看不出来。
② 库与代码对 API 版本假设不一致，表现为两句互相矛盾的错：
   · 代码侧：pickSettingsCtor() 找 window.PIXI.live2d.Cubism4ModelSettings → 取不到 ⇒ no-settings-ctor
   · 库侧：实际导出的是 CubismModelSettings / CubismLegacyModelSettings（新命名）
③ 版本差异散落在业务代码里，一处一处判断，加一个版本就要改多处 —— 必然漏。
```

实测环境（2026-10-27）：

```
pixi.min.js              8.19.0
index.min.js             pixi-live2d-display（PIXI 8 世代）：导出 CubismModelSettings / CubismLegacyModelSettings
live2d.min.js            2.1.00          （Cubism 2 运行时）
live2dcubismcore.min.js  Cubism 4 核心
live2dcubismframework.min.js
```

## 二、目标

```
1. 运行时库纳入项目：src/web/live2d-runtime/（随仓库分发，不再依赖外部目录）
2. 业务代码只通过**一个入口**取运行时能力：src/web/live2d/runtime-adapter.js
3. 版本差异（类名 / 构造签名 / 渲染器差异）只允许在 adapter 里出现，别处一律用中性 API
4. 新版本接入 = 加库文件 + 在 adapter 的兼容表里加一行，业务代码零改动
```

## 三、目录与入口形状

```
src/web/live2d-runtime/
  pixi.min.js                   ← 从 spive2d/static/lib 拷入（保留原文件名，便于比对版本）
  index.min.js
  live2d.min.js
  live2dcubismcore.min.js
  live2dcubismframework.min.js
  VERSIONS.json                 ← { "pixi": "8.19.0", "display": "...", "cubism2": "2.1.00" }（人工/脚本更新）

src/web/live2d/runtime-adapter.js       ← 唯一入口
  export function loadRuntime()          动态注入 <script>（顺序：cubismcore → pixi → live2d → index）
  export function runtimeInfo()          { pixi, display, cubism2, settingsCtorName }
  export function getSettingsCtor(kind)  'cubism4' | 'cubism2' → 可用的构造器（内部做命名兼容）
  export function createModel(settings)  → PIXI.live2d.Live2DModel 的兼容包装
  export function attachToStage(app, model)  ┐ 挂载方式差异（addChild / filters 位置）
  export function setFilters(app, filters)   ┘ 收在这里，业务侧只说"设不设"
  export function isReady() / waitReady()
```

**兼容表**（adapter 内部唯一真相）：

| 目标类 | 依次尝试的名字 |
|---|---|
| Cubism 4 设置 | `Cubism4ModelSettings` → `CubismModelSettings` |
| Cubism 2 设置 | `Cubism2ModelSettings` → `CubismLegacyModelSettings` |
| 模型类 | `Live2DModel` → `PIXI.live2d.Live2DModel` |
| 设置必须的方法 | `resolveURL`（没有则视为不兼容，明确报 version-unsupported，不静默回落） |

## 四、业务侧改造点（只改用入口，不改逻辑）

```
src/web/live2d/vfs-settings.js   pickSettingsCtor → runtimeAdapter.getSettingsCtor(kind)
src/web/live2d/pixi-app.js       库加载（loadScript 序列）→ runtimeAdapter.loadRuntime()
src/web/render/live2d.js         模型创建/挂载/filters → adapter 的 createModel / attachToStage / setFilters
```

**禁止**：在业务文件里再出现 `PIXI.live2d.*`、`Cubism4ModelSettings`、`Cubism2ModelSettings` 等字样
（加一条 grep 门禁：这些字样只允许出现在 adapter 内）。

## 五、服务端配合（1 处）

```
tool/resolve-live2d-runtimes.mjs
  原：在工作区里按顺序探测 spive2d/… 等外部目录
  新：**首选项目自带 src/web/live2d-runtime/**，外部目录只作为"项目未带库"时的兜底，
      并在探测结果里明确打印"库来源 = 项目自带 / 外部兜底"，让来源可见
```

## 六、验收

```
1. 拔掉外部 spive2d 目录（改名为 .bak）后，Live2D 仍能装载并渲染（证明真的自持）
2. runtimeInfo() 返回实际版本；设置构造器解析到新命名（CubismModelSettings）
3. 资源包（aijier_3）与松散目录（adaerbote_2）两种输入都能出画
4. 切 3D 模型再切回 Live2D，不残留 canvas / 不报 doDrawModel
5. grep 门禁：业务文件里 0 处 `PIXI.live2d.` / `Cubism4ModelSettings` / `Cubism2ModelSettings`
6. panel-actions / f1-controls / f3-reveal 三套仍绿
```

## 七、明确不做

```
· 不做运行时热切换（用户不换库就那一个版本）
· 不引入 npm 依赖（零依赖原则；库是文件，不是包）
· 不在 adapter 里包一层"万能代理"（只包版本差异点，其余直通）
```

## 八、库来源与许可（实施后补）

**目录**（与 `src/spine-runtimes` 并列，都在 `src/` 下、由服务端供给 `/live2d-lib/*`）

```
src/live2d-runtimes/
  VERSIONS.json          版本与 md5 记录（人工/脚本维护，不是运行时依赖）
  v6-6.5.3/              pixi 6.5.3 + 配套 index / live2d / cubismcore / cubismframework   ← 默认选它
  v8-8.19.0/             pixi 8.19.0 + 配套 index / cubismcore …                           ← 对照版本
```

**为什么整目录 gitignore**

```
Live2D Cubism Core 与 Cubism 2 运行时受 Live2D Proprietary Software License 约束：
文件头自称 "Redistributable Code" 的含义是"允许随你的应用一起分发"，不等于
可以把它放进公开仓库对外再分发。
pixi / pixi-live2d-display 虽是 MIT，但整目录排除更一致 —— 避免"半个目录入库"
（同一目录里有的能公开、有的不能，读代码的人分不清）。
⇒ VERSIONS.json 也在被忽略的目录内，不要当成入库文件。
```

**运行时怎么选中版本**（`tool/resolve-live2d-runtimes.mjs`）

```
searchRoots() 首选 <项目>/src/live2d-runtimes（项目自带优先）
CANDIDATE_SUBPATHS 里的版本子目录（v6-6.5.3 / v8-8.19.0）逐个探测
pixiMajor() 读 pixi.min.js 主版本号 → PIXI 6 排第一（更稳），6 缺位时才选 8
读不出版本号时打 warn（否则"6 优先"对该候选静默失效 —— 历史上就这么失效过一次）
外部目录（别的项目里的 static/lib）只在项目自带全缺时兜底
```

**加一个新版本要做的事**

```
1. 在 src/live2d-runtimes/ 下拷一个 v<major>-<version>/ 目录（文件名保持原样）
2. 在 tool/resolve-live2d-runtimes.mjs 的 CANDIDATE_SUBPATHS 加一行版本子目录名
   （不做自动发现：显式列举让"支持哪些版本"一眼可见）
3. 在 runtime-adapter.js 的 VERSION_MATRIX 加一行（settings 候选名 / appInit 策略）
4. 在 VERSIONS.json 记版本与 md5（抓不到版本号就写 unknown，不要猜）
业务代码零改动。
```

**版本差异矩阵（adapter 内唯一真相，与代码同源）**

| 世代 | settings（cubism4 / cubism2） | `PIXI.Application` |
|---|---|---|
| v6（6.5.3） | `Cubism4ModelSettings` / `Cubism2ModelSettings` | `new Application(opts)`（同步构造） |
| v8（8.19.0） | `CubismModelSettings` / `CubismLegacyModelSettings` | `new Application()` + `await app.init(opts)` |
| 未登记世代 | 两套名字取并集 | 探测 `prototype.init` 兜底 |

`PIXI.Filter` 构造与 `Live2DModel.from` 签名两代一致，不做分叉。
