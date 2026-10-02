# Spine Multi Viewer（暂定名）

> ⚠️ **项目名待定**：当前目录名 `spine-multi-viewer` 为占位名，待用户确认后统一改名（目录 + README + git remote）。

从 原版 拆分而来的模块化 Spine 动画预览器，目标是演进成**多游戏通用**的 Spine / Live2D 查看器。

---

## 来源与署名（保留来源）

本项目代码源自 **原版**，原作者 **souling01**：

- 原仓库：https://github.com/souling01/spine-viewer-webgl
- 原项目在线版：https://souling01.github.io/spine-viewer-webgl/
- 拆分基线 commit：`12b5fd6`（clone from souling01/spine-viewer-webgl@main）
- 基线文件：`baseline/index.html`（4.17 MB，原版单文件，仅作对比校验用，不参与构建）

## 合规状态（重要）

| 项目 | 许可证 | 影响 |
|---|---|---|
| 原版（本项目代码来源） | **无 LICENSE（`license: null`）** | 默认保留全部权利 |
| Spine Runtimes（本工具内联使用） | 自定义协议（NOASSERTION） | 受 Spine Runtimes License Agreement 约束 |
| spive2d（同为参考项目，非本库代码） | MIT | 若将来以其为基础重做，需保留 MIT 声明 |

**当前状态**：本仓库为**私有、本地自用**。未经原作者授权，**不得对外分发、不得部署到公开 Pages**。
若要合法公开，需走以下路径之一（详见方案文档第十一节）：
1. 取得 souling01 明确授权（但其授权覆盖不了第三方组件）；或
2. 以 **spive2d（MIT）** 为基础自研重做（推荐，最干净）。

## Spine Runtimes 申明（保留自原 README 第 66 行）

> 本工具使用官方 Spine Runtimes（[Esoteric Software](https://esotericsoftware.com)），受 [Spine Runtimes License Agreement](https://esotericsoftware.com/spine-runtimes-license) 约束。集成预览可以，但每个使用 Spine 数据的终端用户仍需拥有 Spine 编辑器授权。

**仓库内不含任何游戏提取资源**（BD2 / 碧蓝航线等模型文件均不入库）。

---

## 为什么拆分

原版 是 **4.17 MB 单文件**（`index.html`），其中 **3.39 MB（81%）** 是内联的 7 个 Spine 版本运行时源码字符串，应用代码仅约 0.8 MB 且为压缩混淆态。在 4.17 MB 单行文件上做功能迭代成本极高。

拆分后：

| 阶段 | 基线 | 现在 |
|---|---|---|
| 单文件体积 | 4.17 MB | 外壳 `src/app-shell.html` 仅 **798 KB** |
| Spine 运行时 | 内联字符串，不可读 | `src/spine-runtimes/*.js` **7 个独立可读文件**（3.2 MB，带缩进与真实变量名） |
| 构建 | 无 | `tool/build.mjs` 一键打包回单文件 |

**关键设计**：**开发用模块化，发布打包成单文件**。
因 原版 核心特性是 `file://` 双击即用，运行时若改外链会被浏览器 CORS 拦截（与 8792 站点"双击打不开"同一坑），故构建时必须**内联回字符串**（原逻辑 `evalRuntimeIsolated` 用 `new Function` 执行该字符串）。

## 目录结构

```
spine-multi-viewer/
├── baseline/index.html      原版基线（4.17 MB，只读参考，用于等价性校验）
├── src/
│   ├── app-shell.html       应用外壳（798 KB，含运行时占位符；应用代码仍为压缩态，待进一步拆）
│   └── spine-runtimes/      7 个 Spine 运行时源码（可读）
│       ├── spine-3.6.js     (367 KB, 10035 行)
│       ├── spine-3.7.js     (393 KB)
│       ├── spine-3.8.js     (412 KB)
│       ├── spine-4.0.js     (425 KB)
│       ├── spine-4.1.js     (499 KB)
│       ├── spine-4.2.js     (540 KB)
│       └── spine-4.3.js     (621 KB, 16166 行)
├── tool/
│   ├── extract-runtimes.mjs 从基线抽出 7 个运行时到 src/
│   ├── split-app.mjs        从基线剥离运行时，生成 app-shell.html
│   ├── build.mjs            打包回单文件 dist/index.html
│   └── verify.mjs           校验产物与基线等价
└── dist/index.html           构建产物（等价于基线）
```

## 工具用法

```bash
node tool/extract-runtimes.mjs   # 从基线抽出运行时（已执行，产物在 src/spine-runtimes/）
node tool/split-app.mjs          # 生成应用外壳（已执行，产物 src/app-shell.html）
node tool/build.mjs              # 打包回单文件 -> dist/index.html
node tool/verify.mjs             # 校验产物与基线等价
```

## 校验状态

`node tool/verify.mjs` 结果（2026-10-02）：

- 字节数：基线 4,378,319 == 产物 4,378,319 ✅
- 7 个运行时源码：**逐字节一致** ✅
- 运行时对象 raw 文本长度：一致 ✅

即：**拆分后的构建产物与原版行为等价**。

## 下一步（待办）

按渐进拆分路线，运行时部分已完成；剩余工作是应用代码（798 KB 压缩混淆态）的模块化拆分：

- [ ] 拆出 React / 第三方库（改外链或依赖）
- [ ] 拆 `store.js`（models / roots / activeRootId / roleGroups）
- [ ] 拆 `importer/`（addModels / 去重 / 建 root / 打 rootId）
- [ ] 拆 `components/`（左栏 LibrarySidebar 等）
- [ ] 拆 `renderer/`（WebGL 渲染 / PMA / 相机）
- [ ] 【需求一】多文件夹根目录分大类
- [ ] 【需求二】同角色归一 + 多 mod 共存（不覆盖）
- [ ] 【需求三】支持部署设备本地文件夹打开（语义待确认）

完整改造方案见：`../spine-viewers/2026-10-02-原版多文件夹根目录分大类改造方案.MD`

## 免责

本 README 中的许可证与合规说明基于对原仓库元数据的查证与开源许可一般原理，**不构成法律意见**。对外分发前建议咨询专业 IP 律师。

## 致谢与来源

**前端界面（布局、结构与样式）借用自 [Boneview](https://github.com/souling01/spine-viewer-webgl)（作者 souling01）**；本项目在其渲染产物基础上做参数化与能力扩展，服务端、插件机制、解析与导出工具链均为本项目自行实现。

- 原项目在线版：https://souling01.github.io/spine-viewer-webgl/
- 原项目未声明 LICENSE（`license: null`），默认保留全部权利
