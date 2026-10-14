# 复刻版前端：性能优化 + localForage 资源缓存方案

> 按 plan-template-enhanced 模板编制。本方案为设计草案，确认后执行。
> 上一任务（复刻版骨架 + 渲染核心，见 doc/frontend-rebuild.md 期 1）进行中：
> 渲染已通，适配居中问题已定位（OrthoCamera lookAt 目标点语义 + transformer 顶点回调），验证收尾与本方案合并执行。

---

## 一、修改目标

- **问题描述**：复刻版当前每次打开模型都重新走网络（`/files/` 无任何缓存）；模型列表一次性渲染 700+ DOM 节点；渲染循环在标签页不可见时空转。
- **期望效果**：第二次打开同一模型加载耗时接近 0（IndexedDB 命中）；首次打开后有本地缓存，断网（服务重启）后已看过的模型仍可打开；列表滚动不卡顿；后台标签页 CPU 占用≈0。
- **成功标准**：
  1. 同一模型第二次 `show()` 网络请求数为 0（IndexedDB 命中）；
  2. `document.hidden` 时 `requestAnimationFrame` 循环暂停，恢复可见后继续；
  3. 现有功能（列表/播放/切肤/运行时切换）回归不变。

---

## 二、潜在问题分析

| 风险类型 | 可能性 | 影响 | 缓解措施 |
|----------|--------|------|----------|
| 性能退化 | 中 | 顶点回调 transformer 每帧遍历全部顶点做平移 | 仅在 centerX/Y 非零时启用；后续可改为 root 骨骼偏移 |
| 兼容性破坏 | 中 | AssetManager 内部用 XHR，无法直接挂缓存 | 自建装载层替代 AssetManager（见 5.2），spine 对象手动构造 |
| 安全漏洞 | 低 | IndexedDB 无跨域风险（同源） | 不存敏感数据，仅模型资源 |
| 依赖冲突 | 中 | localForage 为第三方库，项目零依赖约束 | 仅取 dist 单文件内联进产物（vendor/ 目录 + LICENSE 保留），不建 package.json |
| 数据丢失 | 低 | 缓存被浏览器清除 | 缓存是加速不是真源， miss 时回源网络 |
| 存储容量爆满 | 中 | 贴图大（单张数 MB），IndexedDB 有配额 | LRU 容量逐出（默认 500MB，可配） |
| file:// 双击即用 | 高 | IndexedDB 在 file:// 下部分浏览器不可用 | localForage 自动降级 localStorage→内存；缓存不可用时静默回源 |

**额外边界条件检查**：

1. 缓存打开失败（隐私模式/file://）→ `catch` 后降级直连网络，功能不阻塞；
2. 网络请求 404/超时 → 不写缓存，toast 提示加载失败，页面不崩；
3. 同一模型并发重复点击 → 装载层加「当前装载令牌」，后到的请求取消先到的（复用主站 showSeq 思路）；
4. 缓存写入与读取并发（同 key 正在回源）→ 单飞（inflight map 去重）。

---

## 三、Skill 学习检查

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 已有类似 skill | 有 | `media-persist-cache`（IndexedDB 缓存优先+流式兜底+LRU 逐出+静默降级模式）；`zero-dep-nodejs-no-packagejson`（禁止建 npm 清单） |
| 同类问题方案 | 有 | media-persist-cache 的「缓存优先、网络兜底、etag 指纹失效、LRU 容量逐出」直接复用 |
| 官方推荐 | 有 | localForage 1.10.0 官方 API（setItem/getItem 返回 Promise，自动选 IndexedDB→WebSQL→localStorage） |
| 现成库 | 有 | localForage 已下载至 `rebuild/vendor/localforage.min.js`（29.7KB，MIT，LICENSE 已保留） |

**学习结论**：
1. 复用 media-persist-cache 的四条结构（缓存优先/指纹失效/LRU 逐出/静默降级）；
2. spine 装载不用 AssetManager（其 XHR 无法挂缓存），改为自建装载层：`cache.get → miss 时 fetch → spine 对象手动构造`；
3. 不建 package.json，vendor 文件构建时内联（与 CSS/JS 同路）。

---

## 四、涉及文件汇总

| 文件路径 | 操作 | 行数预估 | 说明 |
|----------|------|----------|------|
| `rebuild/js/cache.js` | 新增 | +90 | localForage 封装：缓存优先/LRU 逐出/单飞/静默降级 |
| `rebuild/js/stage.js` | 修改 | ±60 | 移除 AssetManager，改自建装载（缓存接入）；渲染循环可见性暂停 |
| `rebuild/js/app.js` | 修改 | ±25 | 列表渲染改文档片段+按需补渲染；缓存命中状态提示 |
| `tool/build-rebuild.mjs` | 修改 | ±6 | JS 内联清单加 `vendor/localforage.min.js`、`js/cache.js` |
| `rebuild/app.html` | 修改 | ±2 | 无实质变化（占位符不变） |
| `test/` | 新增 | +80 | 缓存单测（命中/miss/逐出/降级） |

---

## 五、逐文件改动详情

### 5.1 `rebuild/js/cache.js`（新增）

- 结构（照 media-persist-cache 四条）：
  - `cacheGet(key)`：localForage.getItem → 命中返回；miss → 单飞 fetch → 写回（含 `ts`/`size` 指纹）；
  - `cacheMeta()`：容量统计（遍历 meta 键），超容量按 `lastUsed` LRU 逐出；
  - 全程 try/catch，任何异常静默降级为直连 fetch；
- key 规则：`res:<rootId>:<path>`（资源）、`meta:<key>`（元数据）；
- 容量默认 500MB，`window.__CACHE_LIMIT_MB__` 可覆盖（不硬编码）。

### 5.2 `rebuild/js/stage.js`（修改）

- **替换 AssetManager**（当前 L150-165 附近）：
  - `atlas` 文本：`cacheGet` → `new spine.TextureAtlas(text, loader)`；
  - 贴图：先解析 atlas 页名 → 逐页 `cacheGet` blob → `createImageBitmap` → `loader` 里同步返回 `new spine.GLTexture(gl, bitmap)`（解决 textureLoader 必须同步的问题）；
  - skel/json：`cacheGet`（skel 为 ArrayBuffer，json 为文本）→ 原 `SkeletonBinary/SkeletonJson` 分支不变；
- **渲染循环按需暂停**：`document.visibilitychange` → hidden 时 `cancelAnimationFrame`，可见时恢复（`lastFrame` 归零防大步进）；
- **transformer 收敛**：`centerX/Y` 均零时传 `null`（已有判断，保留）。

### 5.3 `rebuild/js/app.js`（修改）

- `renderList()`：一次性插入改 `DocumentFragment`；超过 LIMIT 的列表只渲染可视前 200 条 + 滚动到底部增量渲染（简单分页，不引虚拟滚动库）；
- 底部状态栏加「缓存命中」标记（调试期可见，正式版可关）。

### 5.4 `tool/build-rebuild.mjs`（修改）

- `JS_FILES` 前插 `vendor/localforage.min.js`、`js/cache.js`（顺序：库→缓存→舞台→应用）。

---

## 六、影响分析

| 维度 | 程度 | 说明 |
|------|------|------|
| 现有功能 | 低 | 装载层替换是对 stage.js 内部实现的重构，对外 API（show/setAnimation/…）不变 |
| 性能 | 高（正向） | 二次打开零网络；后台页零 CPU；列表滚动更顺 |
| 兼容性 | 低 | 缓存层全静默降级；file:// 下等同现状 |
| 安全性 | 低 | 仅缓存同源公开资源 |
| 可维护性 | 中 | vendor 引入 29.7KB 第三方库（LICENSE 随附），换来零依赖手写 IndexedDB 封装的成本 |

---

## 七、任务看板

### 阶段一：准备
- [x] skill 检索与结论（第三节）
- [ ] `git add` 现场并打本地小提交基线
- [ ] 确认 rebuild 当前渲染验证收尾（transformer 居中截图确认）

### 阶段二：改动（从简到难，每步一提交）
- [ ] Step 1：渲染循环可见性暂停（stage.js，最小改动）
- [ ] Step 2：列表渲染 DocumentFragment + 分页（app.js）
- [ ] Step 3：新增 cache.js（localForage 封装 + LRU + 单飞 + 降级）
- [ ] Step 4：stage.js 换自建装载层接入缓存（最大改动）
- [ ] Step 5：build-rebuild.mjs 内联清单更新

### 阶段三：验证
- [ ] `test/cache.test.mjs`：命中/miss/LRU 逐出/降级 四用例
- [ ] 浏览器实测：同模型二次打开网络面板 0 请求；`document.hidden` 暂停 rAF
- [ ] 回归：列表/播放/切肤/运行时切换/8803 主站不受影响

### 阶段四：收尾
- [ ] README 功能表补「复刻版缓存」行
- [ ] 经验固化（见十二）
- [ ] squash 为一次语义提交

---

## 八、验证方案

- 单测：`node --test test/`（缓存层四用例，mock localForage 为内存实现）；
- 集成：浏览器 DevTools Network 面板断言二次加载 0 请求；`/files/` 只在首次出现；
- 人工：断开服务重启后，已看过的模型仍能打开（缓存真源验证）；
- 回归：8803 主站完全不动（改动只在 rebuild/ 与 build-rebuild.mjs）。

---

## 九、中断与插入管理

执行中若用户插入新需求 → 暂停分析、默认不执行、继续原任务并回报。
已知挂起项：复刻渲染「适配居中」验证收尾（本方案阶段一第 3 项一并处理，属阻塞前置条件）。

---

## 十、后续优化清单（本次不做）

- [ ] transformer 顶点平移改为 root 骨骼偏移（需解决动画覆盖问题）
- [ ] 贴图按需解码（仅渲染可见页）
- [ ] 缓存 quota 持久化配额申请（navigator.storage.persist）

---

## 十一、是否执行？

请回复 **确认** 或 **修改方案**。
确认过的方案将按 `{日期}{关键词}.MD` 格式存 `doc/` 入库（本文件即入库稿）。

---

## 十二、经验固化（占位）

执行中出现的 bug/坑，按「现象/根因/解决/防再犯」四条写入对应 skill：
- spine 渲染类经验 → 项目 `skills/`（若建）或技能仓库 `ai-work-archive/skills/`；
- 本方案已知候选：① OrthoCamera 的 lookAt 第二参数是目标点而非方向；② skeleton.x/y 不参与 updateWorldTransform；③ AssetManager 无法挂缓存需自建装载层；④ write 工具大内容截断需程序化生成。
