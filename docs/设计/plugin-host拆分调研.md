# plugin-host 拆分调研

> 基线：`1bac1b6`（0.5.9 之后），测量日期 2026-10-31。
> 方法：正则解析 `src/web/infra/plugin-host.js` 的函数/状态/导出面 + `git show` 统计最近提交的 hunk 分布。
> 本文只做调研，**不含任何代码改动**。

---

## 一、现状量化

### 1) 文件构成

| 指标 | 数值 |
|---|---|
| 总行数 | **1792**（`wc -l`） |
| 代码行（剔除纯注释行/空行） | **1047** |
| 注释与空行占比 | **42%** |
| 顶层函数 | 4 个（`makeLogger` / `toUint8Array` / `describeType` / `injectScript`）+ `createPluginHost` |
| `createPluginHost` | **1704 行**（89–1792），占全文 95% |
| 工厂内具名函数 | **39 个**（合计 987 代码行） |
| `hostApi` 对象字面量 | 192 行（122 代码行），含 **4 个方法** |
| 工厂作用域状态 | **26 个**（`const`/`let`） |

### 2) 内部函数清单（按代码行降序；只列 ≥15 行的，其余的见文末小函数表）

| 行 | 名称 | 代码行 | 职责一句话 | 主要调用者 |
|---|---|---|---|---|
| 1265 | `materialize` | **156** | 容器单文件 → 解包 → 校验 → 注册进 VFS 前缀，返回入口地址与文件清单 | `model-actions.js`（对外）、`doLoadAll` 预热链 |
| 296 | `fetchFile` | **133** | 取资源根里的文件字节（唯一取字节通道，带 worker/同步两条路与诊断） | `model-actions`、`materialize` 下游、`resolveViaWorker` |
| 1700 | `report` | **62** | 汇总宿主状态报告（插件/效果/插槽/失败）供排障与自检 | 对外 `hostApi.report`、`effectsReport` |
| 1202 | `scheduleWarmup` | 46 | 空闲时排队预热（只按内存准入，不看耗时） | `materialize`、`doLoadAll` |
| 1036 | `resolveFromServer` | 43 | 走服务端解包接口（本地没有能力时的兜底） | `resolveViaProvider` |
| 774 | `resolveViaWorker` | 41 | 用 worker 解包，失败**不抛**返回 `{ok:false}` 由调用方回落 | `resolveViaProvider` |
| 1598 | `doLoadAll` | 40 | 装载全部插件的执行体（发现 → 注入 → 统计） | `loadAll` |
| 854 | `resolveViaProvider` | 35 | 按优先级试每个 provider 的 resolve（worker → 同步） | `materialize` |
| 915 | `resolvedUsable` | 35 | 判断 provider 的 resolve 结果是否可用（半成品拦截） | `resolveViaProvider` |
| 553 | `unloadPlugin` | 31 | 卸载一个插件：逆序跑 disposer + 清插槽/效果/提供者 + 派发事件 | 对外 `hostApi` |
| 733 | `ensureUnpackWorker` | 29 | 取/建某 provider 的 worker（建不起来返回 null） | `resolveViaWorker`、`warmup` |
| 508 | `loadPlugin` | 27 | 注入单个插件脚本并登记装载状态 | `doLoadAll` |
| 1118 | `fetchCapacity` | 25 | 拉服务端内存容量（预热准入依据） | `warmup` |
| 1673 | `findProvider` | 23 | 按文件挑 provider（canHandle 同步布尔） | 对外 `hostApi`、`fetchFile` |
| 1570 | `initSlotRegistry` | 22 | 按 `/api/plugins` 建插槽注册表（必须在注入脚本前） | `doLoadAll` |
| 952 | `registerResolved` | 21 | 把解包产物注册进 VFS 并解析入口地址（不碰渲染） | `materialize` |
| 604 | `effectsReport` | 20 | 回收报告（验"卸载到底发生了没有"） | 对外 `hostApi`、`unloadPlugin` |
| 246 | `legacyControlToSlotSpec` | 18 | 老接口控件 → 插槽 spec 的包装 | `registerControls`（hostApi 方法） |
| 1155 | `warmup` | 17 | 预热主流程（内存准入 + 指纹去重） | `scheduleWarmup` |
| 667 | `validateResolved` | 16 | 校验 resolve 返回值形状（禁半成品） | `resolveViaProvider` |
| 422 | `registerControls`（hostApi 方法） | 54 | **兼容层**：老接口转插槽注册（标题→id、隐式声明） | 插件脚本 |
| 359 | `registerEffect`（hostApi 方法） | 34 | 登记效果声明（清单校验 + 装载窗口） | 插件脚本 |
| 317 | `register`（hostApi 方法，`slots.register`） | 26 | 插槽注册入口（转给 slotRegistry） | 插件脚本 |

其余 20 个函数（合计约 200 代码行，均 ≤13 行）：`addEffect`、`normalizeStage`、`publishSlotStats`、`publishEffectStats`、`rejectRegistration`、`groupIdOfTitle`、`fileUrlOf`、`unloadAll`、`prefilterReason`、`bytesOf`、`filesOfProvider`、`onWorkerProgress`、`classHistogramOf`、`filesCount`、`providerFromPrefix`、`firstFulfilled`、`loadAll`、`countRegistered`、`providersFor`、`notify`。

### 3) 闭包共享状态（26 个）

| 名称 | 类型 | 声明行 | 引用它的内部函数数 |
|---|---|---|---|
| `say`（logger） | const | 90 | **12** |
| `discovered`（发现到的清单） | let | 266 | **9** |
| `loaded`（已装载集合） | let | 267 | **9** |
| `emit`（事件派发） | const | 93 | **8** |
| `providers`（provider 表） | const | 97 | **8** |
| `slotRegistry` | let | 140 | **8** |
| `loadState` | const | 110 | 7 |
| `registeredEffects` | const | 104 | 6 |
| `pluginEffects` | const | 119 | 5 |
| `base` / `manifestEffects` | const | 94 / 102 | 4 / 4 |
| `loadingPluginId` | let | 106 | 4 |
| `hostApi` | const | 314 | 4 |
| `workerPool` | const | 704 | 3 |
| `manifestProvides` / `registrationRejects` / `lastLoadedPluginId` / `pluginSettings` | — | 99/127/130/148 | 2 各 |
| `loadingPromise` / `ORDINARY_ASSET_EXT` / `MAX_BUNDLE_BYTES` / `capCache` / `CAP_TTL_MS` / `warmupInflight` / `WARMUP_PHASE_TEXT` | — | 274/633/643/1109/1110/1185/1192 | 2 各 |
| `MAX_FRAGMENT_CHARS` | const | 108 | 1 |

统计：**引用数 ≥5 的 9 个**（`say` 12、`discovered` 9、`loaded` 9、`emit` 8、`providers` 8、`slotRegistry` 8、`loadState` 7、`registeredEffects` 6、`pluginEffects` 5）；2–4 的 16 个；≤1 的 1 个。

> 这就是拆分的主要阻力：**9 个高频状态被 5~12 个函数读写**，任何切法都要么把它们做成显式 context 参数（每个模块都拿到），要么保留为"组装层持有、模块回调取用"——两种都只是把耦合从"闭包"变成"参数/回调"，并没有减少耦合。

### 4) 对外导出面（19 个键）与外部消费者

| 键 | 外部消费者 | 用法 |
|---|---|---|
| `slotSections` | `panel-settings.js` | 面板聚合插槽控件 |
| `pluginSettings` | `panel-settings.js` | 取清单声明的 settings（默认值兜底） |
| `registeredEffectIds` | `panel-settings.js`、`main.js` | 能力键白名单 |
| `effectDeclarations` | `panel-settings.js` | 效果链下发 |
| `loadAll` | `main.js`、`model-actions.js` | 页面启动装载 / 重新装载 |
| `materialize` | `model-actions.js` | 容器解包 |
| `providersFor` | `model-actions.js` | 选 provider |
| `warmup` | `model-actions.js` | 预热 |
| `fetchFile` | `model-actions.js` | 取字节 |
| `unloadPlugin` / `unloadAll` / `effectsReport` | 无外部调用（仅宿主内部与排障） | — |
| 其余 8 键（`findProvider`、`prefilterReason`、`report`、`isLoaded`、`host`、`effectOwner`、`effectDeclarations`…） | 无外部调用 | — |

补充事实：
- **没有任何 node 测试 import `createPluginHost`**（`tool/check-plugin-host.mjs` 是自带的 vm 垫片，与真实宿主无关；`test/bundle-shape.test.mjs` 只测解包形状）。
- 浏览器的 `panel-actions` 套件**间接**依赖面板侧产物（`slotSections` 等），不直接碰工厂内部。
- 也就是说：**工厂的 39 个内部函数与 26 个状态，一个都不在自动化测试的直接覆盖范围内**（靠浏览器套件端到端覆盖）。

### 5) 按职责分组的代码行数

| 组 | 函数数 | 代码行 | 占比 |
|---|---|---|---|
| 资源取用 / 解包（`materialize`、`fetchFile`、`resolveVia*`、`warmup` 链…） | 23 | **705** | 64% |
| 注册与校验（`slots.register`、`registerEffect`、`registerControls`、`initSlotRegistry`、`rejectRegistration`…） | 10 | **193** | 17% |
| 装载 / 卸载 / 回收（`loadAll`、`doLoadAll`、`loadPlugin`、`unloadPlugin`、`unloadAll`、`addEffect`、`effectsReport`） | 8 | **142** | 13% |
| 报告（`report`） | 1 | **62** | 6% |
| 其它（`normalizeStage`） | 1 | 4 | <1% |
| **合计** | **43**（39 函数 + 4 方法） | **1106** | 100% |

---

## 二、三种候选切法

### A. 按职责拆成 5 个模块，工厂只做组装（最彻底）

| 新文件 | 内容 | 代码行 | 物理行（按 42% 注释折算） |
|---|---|---|---|
| `plugin-host-unpack.js` | 资源取用/解包组（23 函数） | 705 | ≈1215 |
| `plugin-host-registry.js` | 注册与校验组（10 项） | 193 | ≈333 |
| `plugin-host-lifecycle.js` | 装载/卸载/回收（8 函数） | 142 | ≈245 |
| `plugin-host-report.js` | `report` | 62 | ≈107 |
| `plugin-host.js` | 状态声明 + 组装 + 少量胶水 | ≈ 60 | ≈150 |

- **新增的跨模块参数**：一个 `ctx` 对象 ≈ **12 个字段**（9 个高频状态 + `say` / `emit` / `publishSlotStats` 三个回调）
- **需要搬动的共享状态**：26 个里 **全部**（高频 9 个必须外提，低频 17 个随宿主模块）
- **风险等级：高**。具体三处时序风险：
  1. `slotRegistry` 是**惰性初始化**（`doLoadAll` 里才建），而 `registerControls` / `slots.register` 在脚本注入期就要用 ⇒ 装配顺序错了会静默丢注册
  2. `loadingPluginId` 是"装载期窗口"的判定依据，与 `injectScript` 的执行栈耦合，拆到两个模块后要显式传窗口状态
  3. `workerPool` / `warmupInflight` 是**跨调用累积**的生命周期对象，外提后要处理"模块被重新导入"（HMR/重复实例）时的重复建池
- **工作量**：**6–10 小时**（含逐块搬迁、跑面板/顶栏/卸载、以及浏览器端到端复核）

### B. 只把"最大且最独立"的一块搬出去（最小）

先纠正一个前提：**`materialize` 并不独立**。它的依赖闭包是 **25 个函数 / 665 代码行**（`fetchFile`、`resolveViaProvider`、`resolvedUsable`、`registerResolved`、`ensureUnpackWorker`…），等于把整个解包组搬走，那就是 A 的第一刀而不是"最小动作"。

真正可搬的最小块（按闭包从小到大）：

| 候选 | 闭包 | 代码行 | 需要注入的状态 |
|---|---|---|---|
| `report` | 1 函数 | **62** | `loaded` / `discovered` / `providers` / `pluginEffects` / `slotRegistry` / `say`（6） |
| `unloadPlugin` 链 | 3 函数 | 45 | `pluginEffects` / `providers` / `slotRegistry` / `loaded` / `say` / `emit`（6） |
| `warmup` 链 | 3 函数 | 88 | `workerPool` / `capCache` / `providers` / `say`（4） |

- 选 `report` 作为第一刀：**代码行减少 ~62（占工厂 6%）**，物理行减少 ~93 行，跨模块参数 **6 个**
- **风险等级：低-中**（`report` 只读状态，不参与时序）
- **工作量**：**2–3 小时**（搬迁 + 6 个状态注入 + 跑一次面板/顶栏回归）

### C. 不拆文件，只做分段注释 + 索引（零风险）

- 在工厂内按第 5 节的 5 个组分段落加分区标题注释，并在文件头加一份"函数索引（名称 → 行 → 职责 → 分组）"
- 代码行变化：**0**（只增注释，物理行 ≈ +60）
- 跨模块参数：**0**；搬动的状态：**0**
- **风险等级：零**
- **工作量**：**0.5–1 小时**

---

## 三、收益（能量化的都量化）

### 1) 审计阈值：拆完不会带来"解拦"收益

- 本仓审计对 **diff 范围**只报 `readability/max-function-length` 作为 **blocker**，而 `createPluginHost` 这类**工厂函数一直被计入豁免**：本轮多次 `code_audit scope=diff` 结果均为 **0 blocker**（最近一次 92.61/A）。
- 结论：**拆分在审计上没有收益**。唯一可能的收益是 `scope=full` 全量审计时"单函数 50 行"口径不再需要豁免——但那是报表美观，不影响门禁。

### 2) 定位成本：改动天然跨区，拆分只能减少"文件内搜索"

最近 4 次真正改到 `plugin-host.js` 的提交（hunk 数 / 涉及行域）：

| 提交 | 主题 | hunk 数 | 行域 |
|---|---|---|---|
| `9a815c6`（0.5.0） | 老接口迁移到插槽注册 | 4 | 219–529 |
| `0047fca`（0.5.1） | props getter + spec.setting | 2 | 103–1596 |
| `29c85ec`（0.5.2） | 清理老链收敛通路 | **7** | 102–1601 |
| `c3a9192`（0.5.7） | 键值插槽/单值插槽 | 1 | 1579 |

观察：
- 一次"插槽类改动"平均要动 **2–7 处**，且**必然横跨**「状态声明区（100–150）→ 注册区（314–505）→ 装载区（1570–1660）」三段。
- 按 A 拆法，这三段落进 **3 个不同文件** ⇒ 单次改动要开 3 个文件而不是滚 1 个文件；**定位成本不一定下降，编辑成本上升**（跨文件跳转 + 参数核对）。
- 反过来，**当前热点（插槽）根本不碰解包区**：解包区是 296–1265（705 行、占 64%），最近 4 次提交**没有一次落进去**。也就是说"把最大的一块搬走"对当前改动热点的定位成本**没有帮助**。

### 3) 并行开发：拆分**不能**真正解耦

判据是第 3 节的共享状态：`loaded`、`providers`、`pluginEffects`、`slotRegistry` 这四个被 **5–9 个函数**读写，且**每个职责组都要用**。拆分后它们要么进 `ctx`、要么留在组装层——两种形态下，两个人同时改「解包」与「卸载回收」**仍然会撞同一批状态**（只是从"改同一文件"变成"改同一个 ctx 契约 + 两个文件"）。

相比现状，拆分带来的并行收益仅限：**两处改动互不触碰对方函数时，diff 不冲突**。这在单文件里其实也成立（git 按行合并），只是冲突概率随文件变大而略升。

---

## 四、成本与风险

### 1) 需要动的测试

| 套件 / 工具 | 是否受影响 | 说明 |
|---|---|---|
| `test/bundle-shape.test.mjs` | **否** | 只测解包产物形状（`src/server/unpack`），不 import 前端宿主 |
| `tool/check-plugin*.mjs` | **否** | 自带 vm 垫片，独立于真实宿主 |
| 浏览器 `panel-actions`（25 项） | **间接** | 依赖 `slotSections/pluginSettings/registeredEffectIds/effectDeclarations` 四个键；只要导出面不变就不受影响 |
| 其它 node 套件 | **否** | 全仓无 `import { createPluginHost }` |

结论：**没有任何自动化用例直接覆盖工厂内部** ⇒ 拆分的安全性**无法靠现有测试兜底**，只能靠端到端手验。

### 2) 真实回归面（必须人工验）

```
① 三个插件各点一次：unity-spine-bundle（容器解包）、unity-live2d-bundle（目录）、unitypy-bundle（另一类容器）
② 面板：插件控件渲染 / 三档切换 / spec.setting 存值 / 卸载后控件消失与内置恢复
③ 顶栏：插件按钮出现、按下态、横向滚动、影院模式
④ 卸载与回收：unloadPlugin 后 effectsReport 的 slots/effects 归零、DOM 无残留
⑤ 预热：warmup 只在内存允许时触发（fwh 日志里 allowWarmup 分支）
```

### 3) 拆分后可能引入的新问题

```
· 间接层：ctx 对象让"谁在读状态"从词法作用域变成运行时对象，静态可读性下降；
  改错一个字段名不会报错（undefined 静默），而闭包变量引错名字是 ReferenceError
· 参数传递：12 字段 ctx 在每个模块入口展开，调用点变长（可读性换取"可拆分"）
· 时序：slotRegistry 的惰性初始化、loadingPluginId 的窗口语义、workerPool 的生命周期
  —— 这三处是"闭包自然保证、拆开后要显式维持"的约束，最容易出隐性回归
```

### 4) 一次性工作量估计（以我能独立完成的小时数）

| 方案 | 工作量 | 依据 |
|---|---|---|
| A（5 模块） | **6–10 h** | 705+193+142+62 行搬迁 + ctx 设计 + 5 项人工回归；参考历史：本轮 4 个功能提交平均 1.5–3h/个，且都只改 2–7 处 |
| B（只搬 `report`） | **2–3 h** | ≈62 代码行 + 6 状态注入 + 1 次端到端回归 |
| C（只加索引注释） | **0.5–1 h** | 纯注释，零行为变化 |

---

## 五、结论与建议

### 结论：**不拆文件**

数据依据（三条，均可复核）：

1. **审计无收益**：diff 审计对 `createPluginHost` 一直豁免，本轮多次实测 0 blocker（92.61/A）。拆分不会减少任何拦截。
2. **对当前热点无帮助**：最近 4 次改动全部落在「状态/注册/装载」区（102–1660），**解包区（296–1265，占 64% 代码）一次都没碰**；而拆分的主收益恰恰来自"把解包区搬走"。
3. **并行收益有限**：9 个高频共享状态被 5–12 个函数跨组读写，拆完仍要共享（ctx 或组装层），两人同时改解包与回收依旧撞同一批状态契约。

再加一条硬约束：工厂内部**零自动化测试覆盖**，任何搬迁都只能用"人工点三个插件 + 面板/顶栏/回收"来兜底 —— 高风险低收益。

### 替代手段（把定位成本降下来，且零风险）

**第一步（建议只做这个）**：方案 C —— 在 `createPluginHost` 内加 5 个分区注释段 + 在文件头加一份**函数索引表**（名称 / 行号 / 职责 / 分组 / 是否导出）。验收方式：

```
· 纯注释改动，git diff 里不出现任何可执行语句变化（可用 `git diff -U0 | grep '^[+-][^+-]'` 人工核对）
· 跑一次浏览器 panel-actions（25 项）确认零影响
· 抽查：新人在索引表里按"插槽"搜，能一次定位到 register/registerEffect/initSlotRegistry 三处
```

**若将来确实要拆**（例如代码涨到 3000 行，或出现第三人并行开发）：按 A 的切法**先切解包组**，但前置条件是先做一步"状态收敛"——

```
前置：把 9 个高频状态 + say/emit/publishSlotStats 收敛成一个显式 ctx 对象（在单文件内先做，不拆文件），
     并让 43 个函数全部改用 ctx.xxx。
    这一步本身约 3–4h，但它把"隐式闭包耦合"变成"显式契约"，之后切模块才有意义；
验收：收敛后跑全量 node 套件 + panel-actions + 三个插件手验，行为零变化。
```

也就是说：**真正的第一步不是搬代码，而是把状态显式化**。没有这一步，任何"按职责拆文件"都只是把 1704 行的隐式耦合摊到 5 个文件里。

---

## 附：小函数表（≤15 代码行）

| 行 | 名称 | 代码行 | 职责 |
|---|---|---|---|
| 151 | `addEffect` | 9 | 往插件级效果容器加一条（disposer 统一回收） |
| 171 | `normalizeStage` | 4 | 归一化当前阶段（缺省回退 S1） |
| 180 | `publishSlotStats` | 7 | 把插槽统计挂到 `window.__SLOT_STATS__` |
| 189 | `publishEffectStats` | 7 | 把效果统计挂到 window |
| 207 | `rejectRegistration` | 13 | 注册拒绝的标准出口（可读原因 + likelyOwner） |
| 230 | `groupIdOfTitle` | 7 | 标题 → 内置分组 id |
| 286 | `fileUrlOf` | 3 | 拼 VFS 取文件 URL |
| 591 | `unloadAll` | 6 | 全部卸载 |
| 649 | `prefilterReason` | 12 | provider 预筛原因 |
| 685 | `bytesOf` | 11 | 求文件字节数 |
| 707 | `filesOfProvider` | 4 | 某 provider 的文件清单 |
| 713 | `onWorkerProgress` | 13 | worker 进度回调 → 事件 |
| 839 | `classHistogramOf` | 13 | 字节量直方图（内存准入用） |
| 986 | `filesCount` | 5 | 文件计数 |
| 1004 | `providerFromPrefix` | 5 | 前缀 → provider |
| 1015 | `firstFulfilled` | 13 | 取第一个 fulfilled |
| 1550 | `loadAll` | 6 | 装载入口（去重 + 委派 doLoadAll） |
| 1558 | `countRegistered` | 3 | 计数 |
| 1659 | `providersFor` | 6 | 列 provider |
| 317/359/422/500 | hostApi 方法（`register`/`registerEffect`/`registerControls`/`notify`） | 26/34/54/5 | 见上表 |

---

## 后续参考：状态收敛成显式 ctx（本轮不做，留作将来）

> 结论已定：**本轮只做 C（分区注释 + 函数索引）**；下面这条是"若将来真要拆模块"的前置步骤，
> 现在不执行，仅作为以后参考。

```
目标：把 9 个高频共享状态从"闭包隐式共享"改成"显式 ctx 对象"
  —— 行为零变化，纯结构调整；改完仍是单文件，不切模块
为什么先做它：拆文件的真正难点从来不是文件数，而是共享状态。
  26 个闭包状态里有 9 个被 5~12 个函数跨组读写；不先把它们显式化，切模块时只能整包塞进 ctx 参数，
  等于把隐式耦合变成显式耦合，收益有限（调研里 A 方案 ctx ≈12 字段就是这个原因）。
预计工作量：3~4 小时（含逐函数核对与回归）
验收方式：行为零变化（全量测试 + 浏览器套件 + 三个插件各点一次），
         且 ctx 字段在文件头有唯一一份说明（谁写/谁读/时序约束）
触发条件（满足其一再考虑）：
  · 开发重心从"插槽/注册"转向"解包/预热"（新容器格式、worker 策略调整）
  · 需要两人以上同时改 plugin-host 的不同区
  · 单次改动平均需要跨 3 个以上分区
```

**本轮执行范围**：只有 C（分区注释 + 函数索引 + 高频状态文字说明），代码零变化。

---

## 分批拆分计划（已决定执行，按此顺序）

> 结论里"不拆"是当时的性价比判断；既然决定拆，就按调研给出的**正确顺序**执行：
> 先收敛状态（B0），再搬代码（B1+）。每批独立可验证、可回退，前一批不通过不进下一批。

| 批 | 内容 | 代码行变化 | 验收 | 回退 |
|---|---|---|---|---|
| **B0** | 把 9 个高频共享状态收敛成显式 `ctx` 对象（**仍是单文件**，不切模块） | 结构变、行为零变化 | 全量 28 套 + 浏览器套件 + 三个插件各点一次；文件头 ctx 字段表（谁写/谁读/时序） | 还原为闭包变量 |
| **B1** | 抽出最独立的三块：`report`（62 行）、`unloadPlugin` 链（45 行）、`warmup` 链（88 行）→ 各自独立模块 | 减约 195 行 | 同上 + 卸载/预热各实测一次 | 三块独立，可单独回退 |
| **B2** | 抽出「注册与校验」区（G2，193 行）→ `slot-registration.mjs` | 减约 193 行 | 同上 + 注册/拒绝各三条实测（已声明/未声明/未开放） | 独立模块，可单独回退 |
| **B3** | 抽出「装载与装载期窗口」+「卸载与回收」剩余部分（G3+G4） | 减约 180 行 | 同上 + 装载窗口语义（异步注册被拒）实测 | 独立模块，可单独回退 |
| **B4**（可选） | `fetchFile` 拆三职责（取字节 / 两种取法 / 装载统计） | G1 内部重构 | 同上 + 解包一次真实包 | 函数级，可单独回退 |

不进分批的：`materialize` 的依赖闭包 25 函数 / 665 行（等于整个解包组，搬它风险最高、收益最低）。

**每批的硬约束**：行为零变化（不许顺手改逻辑）、单批单独提交、提交信息写明本批验收结果。
