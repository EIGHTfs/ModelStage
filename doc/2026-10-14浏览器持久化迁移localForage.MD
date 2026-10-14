# 浏览器持久化迁移方案：localStorage JSON → localForage（IndexedDB）

> 按 plan-template-enhanced 模板编制。方案确认后执行。
> 前置：首屏防闪烁修复已完成验证（同仓库，先提交推送——用户已确认）。

## 一、修改目标

- **问题描述**：项目浏览器侧持久化用 localStorage 存 JSON 字符串（两个键：`spine-multi-viewer.tree-state.v1` 角色树状态、`spine-viewer-settings-v2` 原版 UI 偏好），容量 5MB 上限、同步阻塞主线程、无结构化存储能力。
- **期望效果**：全部浏览器侧持久化迁到 localForage（IndexedDB，异步、容量大、结构化存对象无需 JSON 手拼）；旧 localStorage 键**一次性迁移后清理**；资源文件（atlas/贴图/skel）纳入同一缓存层，二次打开零网络。
- **成功标准**：
  1. 刷新后角色树展开态/每游戏上次模型/UI 偏好与迁移前一致（老用户无感升级）；
  2. 迁移完成后 localStorage 中两个旧键被删除；
  3. 打开过的模型二次打开 0 网络请求（IndexedDB 命中）；
  4. `localStorage` 全键扫描不再出现项目相关键（除迁移标记）。

## 二、潜在问题分析

| 风险类型 | 可能性 | 影响 | 缓解措施 |
|----------|--------|------|----------|
| 数据丢失 | 中 | 迁移中途断电/关页 → 新旧都可能有或都无 | 迁移是「读旧→写新→验证→删旧」四步，删旧前校验写入成功；任何一步失败保留旧键下次重试 |
| 兼容性破坏 | 中 | 原版 bundle 的 `spine-viewer-settings-v2` 由 React 闭包读写（键名在 bundle 里），本项目只能「搬走+删旧」不能改它的读写路径 → 原版运行时还会往 localStorage 写回 | settings-io 已接管原版导入/导出按钮；每次启动把 localForage 值**回写**给 store（importSettings），原版回写 localStorage 的键在每次启动时清理 |
| 隐私模式/file:// 降级 | 高 | IndexedDB 不可用 | localForage 自动降级 localStorage→内存；降级时功能不阻塞 |
| 性能退化 | 低 | 异步化使启动时读状态从同步变异步 | 读状态本来就是启动流程的一部分，await 一次；首帧渲染不依赖它（恢复模型在早期恢复路径） |
| 并发写冲突 | 低 | 双标签页同时写同一键 | localForage/IndexedDB 同源串行写；状态写入频率低（点击时），冲突窗口极小 |

**边界条件检查**：
1. 旧键不存在（新用户）→ 跳过迁移直接用新层；
2. localForage 打开失败 → 全部 try/catch 降级：状态读写退回 localStorage 旧行为（保功能不保新特性）；
3. 存入对象含不可结构化数据（undefined/函数）→ 只存纯数据对象，写前 JSON.stringify 校验一轮可序列化性；
4. 贴图 blob 体积大 → 资源缓存独立库（`res:` 前缀），LRU 容量逐出（默认 500MB 可配），与状态库分开。

## 三、Skill 学习检查

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 已有同类 skill | 有 | `media-persist-cache`：缓存优先/网络兜底/etag 指纹/LRU 逐出/静默降级——资源缓存四条结构直接复用 |
| 零依赖约束 | 有 | `zero-dep-nodejs-no-packagejson`：localForage 只取 dist 单文件内联（已下载 `rebuild/vendor/localforage.min.js` 29.7KB，MIT + LICENSE），不建 npm 清单 |
| 已有库 | 有 | localForage 1.10.0 已落盘 |

**学习结论**：状态迁移用「四步迁移」；资源缓存用 media-persist-cache 四条结构；库文件从 rebuild/vendor 提到 public/vendor 共用（主站与复刻版同用一份）。

## 四、涉及文件汇总

| 文件 | 操作 | 预估 | 说明 |
|------|------|------|------|
| `public/vendor/localforage.min.js` | 新增 | 29.7KB | 从 rebuild/vendor 移入（主站也用） |
| `public/vendor/localforage.LICENSE` | 新增 | 随附 | MIT 许可保留 |
| `public/persist.js` | 新增 | +110 | 统一持久化层：状态库（迁移+读写）+ 资源库（LRU/单飞/降级） |
| `server.mjs` | 修改 | ±4 | `/index.html` 注入清单加 persist.js 与 localforage（persist 之前） |
| `public/char-tree.js` | 修改 | ±20 | LS_KEY 读写改走 persist.js（异步化，调用点适配） |
| `public/local-roots.js` | 修改 | ±10 | readSavedTargetId 改异步 |
| `public/settings-io.js` | 修改 | ±15 | 偏好读写改走 persist.js + 启动回写 store + 清理原版回写键 |
| `test/check-persist.mjs` | 新增 | +60 | 迁移/清理/资源命中断言 |

## 五、逐文件改动详情

### 5.1 `public/persist.js`（新增，核心）

```
状态库 state（键 'pmsv:state'）：{ games, chars, activeGame, lastByGame, uiPrefs }
资源库 res（键 'res:<rootId>:<path>'）：{ blob, size, ts }，meta 键 'resmeta:*'
迁移标记 'pmsv:migrated:v1'：完成置 1
```

- `persist.init()`：**四步迁移**（读旧 localStorage 两键 → 写 localForage → 读回验证 → 删旧键 + `localStorage.removeItem('spine-viewer-settings-v2')`）；
- `persist.getState()/setState(patch)`：状态读写（内存缓存 + 落 localForage）；
- `persist.getRes(key)/putRes(key, blob)`：资源缓存（LRU 容量 `window.__CACHE_LIMIT_MB__ || 500`）；
- 全程 try/catch 静默降级：IndexedDB 不可用时 setState 退回 localStorage（键名不变，兼容旧读取）。

### 5.2 `public/char-tree.js` / `local-roots.js`

- `saveTreeState()`/`readSavedTargetId()` 改调 persist API；调用点本就在事件回调/启动流程，可 await；
- 旧 LS_KEY 常量删除，读路径只走 persist（迁移在 persist.init 已完成）。

### 5.3 `public/settings-io.js`

- 原版偏好读写改走 persist（`uiPrefs` 字段）；启动时若迁移带来 uiPrefs 则 `store.importSettings(uiPrefs)` 回写 React；
- 原版运行时仍会往 localStorage 写 `spine-viewer-settings-v2` → persist.init 时删除 + 监听 `storage` 事件（跨标签）与启动清理兜底。

### 5.4 `server.mjs`

- 注入清单：`<script src="/vendor/localforage.min.js">` + `<script src="/persist.js">` 置于 local-roots.js **之前**（它最先把状态备好）。

## 六、影响分析

| 维度 | 程度 | 说明 |
|------|------|------|
| 现有功能 | 低 | 三个消费方只换读写底层；接口行为不变 |
| 性能 | 正向 | 大对象不再 JSON 字符串化；资源二次加载零网络；IndexedDB 异步不阻塞主线程 |
| 兼容性 | 中 | 迁移四步保证老用户无感；原版回写键需持续清理（已列兜底） |
| 安全 | 低 | 同源存储，仅缓存公开资源 |
| 可维护性 | 中 | 新增一层抽象，但换走三处散落的 localStorage 直读写 |

## 七、任务看板

- [ ] Step 0：提交推送「防闪烁修复」（上一任务成果，git_commit_push）
- [ ] Step 1：localforage 移入 public/vendor + persist.js（一提交：`feat: 统一持久化层 persist.js（localForage/IndexedDB + 迁移 + 资源缓存）`）
- [ ] Step 2：三个消费方接入（char-tree / local-roots / settings-io）+ server.mjs 注入（一提交：`feat: 浏览器状态与偏好迁移到 localForage，清理旧 localStorage JSON 键`）
- [ ] Step 3：资源缓存接入装载链路（模型资源 blob 缓存，二次打开零网络）（一提交）
- [ ] Step 4：`bash server.sh restart` + 浏览器实测（迁移/清理/命中三断言）+ test/check-persist.mjs
- [ ] Step 5：handover/README 补说明 + 经验固化 + 推送

## 八、验证方案

- 浏览器实测三断言：①改状态→刷新→状态保持；②localStorage 扫描无旧键；③二次打开模型 Network 面板 0 请求；
- `test/check-persist.mjs`：CDP 采样断言（迁移完成标记存在、旧键已删、资源命中计数）；
- 回归：角色树聚合/上次浏览恢复/原版偏好导入导出/8803 其他功能不变。

## 九、中断管理

迁移逻辑涉及老用户数据——任何迁移步骤实测失败即暂停回报，不硬上线。

## 十、后续优化清单

- [ ] 服务端扫描索引（config/*.json）的缓存策略另行评估（不在本任务）
- [ ] 资源缓存 quota 持久化申请（navigator.storage.persist）

## 十一、是否执行？

本方案随「先提交推送闪烁修复」的确认已一并获批（用户选「先提交推送闪烁修复（推荐）」+ 明确缓存对象为「浏览器端资源缓存」+ 要求「清理原 JSON 缓存」）。按看板 Step 0 → Step 5 顺序执行。

## 十二、经验固化（预留）

候选：localStorage→IndexedDB 迁移四步法；原版闭包回写键的持续清理兜底。
