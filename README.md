# ModelStage

**多游戏通用的 Spine / Live2D 动画预览器。** 把不同游戏导出的骨骼动画与 Live2D 模型放在同一个界面里浏览：
左栏按「游戏 → 角色 → 变体」组织，右侧面板调渲染参数，底栏控制播放。

支持两类内容、两种资源形态：

| 维度 | 支持 |
|---|---|
| 内容类型 | **Spine**（3.6 / 3.7 / 3.8 / 4.1 运行时）· **Live2D**（Cubism 2 / 4） |
| 资源形态 | **目录型**（散装 skel/atlas/贴图 或 model3.json）· **容器型**（Unity 资源包，由插件解包） |

---

## 主要能力

| 能力 | 说明 |
|---|---|
| 三级名册 | 游戏 → 角色 → 变体；支持搜索、懒加载、展开态与上次选择记忆 |
| 两套渲染面 | Spine 与 Live2D 共用同一套相机语义与面板；切换只有唯一入口，不会叠加 |
| 面板按能力生成 | 面板只问「当前渲染器支持什么」，不支持的项**不构建**（而非灰化占位） |
| 动作与循环 | 动作列表带时长、当前项高亮；「混合模式」与「循环播放」两个开关正交 |
| 资源包解包 | 服务端解包 + 内存准入判断；解包产物带指纹缓存 |
| 背景 | 棋盘格 / 纯色 / 透明 / 自定义图；纯色预设可增删改名（服务端存储） |
| 调试与诊断 | 浮层日志（四档多选）、就绪信号（给机器读的阶段状态机）、诊断探针落盘 |
| 零依赖 | 无 `package.json`、无 `node_modules`，纯原生 ES 模块 + Node 内置能力 |

能力细节与当前限制见 **[docs/架构/能力层.md](docs/架构/能力层.md)**。

---

## 快速开始

```bash
bash web.sh start      # 启动（默认端口 8804）
bash web.sh status     # 查看状态
bash web.sh restart    # 重启
bash web.sh stop       # 停止
```

启动后打开 `http://<本机IP>:8804/`。

**前置**：Node.js（内置模块即可，无需装依赖）。
Spine / Live2D 运行时源码**不入库**（授权原因），需自备 —— 放到 `src/spine-runtimes/`，
或用环境变量 `SPINE_RUNTIME_DIR` 指定目录，或放到工作区共享目录 `../spine-runtimes/`。
缺失时会显式报错并给出修复指引。

---

## 配置资源根

资源根指「本机某个游戏资源目录」。在 `config/resources.json` 里登记，界面即可看到。
每个根可配 `profile`（游戏差异适配，如动作分组与循环规则）。

新增资源根的完整步骤见 **[docs/参考/接口清单.md](docs/参考/接口清单.md)** §三。

**仓库内不含任何游戏提取资源** —— 模型文件均不入库，需自备。

---

## 目录结构

```
src/
  web/        前端：main.js + app / engine / render / spine / live2d / roster / panel / debug / infra
  server/     服务端：serve.mjs + routes / http / data / unpack
plugins/      插件（容器解析）：unity-live2d-bundle
tool/         工具与门禁脚本（含回归入口 test-all.mjs）
test/         回归套件
config/       资源根与插件配置
data/         运行时数据（不入库）
docs/         文档
web.sh        启停脚本
```

模块划分与职责边界见 **[docs/架构/总览.md](docs/架构/总览.md)**。

---

## 文档

完整索引：**[docs/README.md](docs/README.md)**

| 想了解 | 看这里 |
|---|---|
| 能做什么、有什么限制 | [docs/架构/能力层.md](docs/架构/能力层.md) |
| 架构分层与模块职责 | [docs/架构/总览.md](docs/架构/总览.md) |
| 改代码不能碰的红线 | [docs/契约/](docs/契约/README.md)（13 条不变量 + 各层契约） |
| 相机、界面、状态的设计 | [docs/设计/](docs/设计/) |
| 渲染接入与 API 参考 | [docs/参考/](docs/参考/) |
| 还没解决的问题 | [docs/已知问题.md](docs/已知问题.md) |
| 文档与代码的出入 | [docs/文档与代码不一致.md](docs/文档与代码不一致.md) |

---

## 常用工具

```bash
node tool/test-all.mjs                    # 全量回归（含前置静态门禁）
node tool/check-single-source.mjs         # 单一数据源门禁
node tool/check-plugin.mjs                # 插件契约检查
node tool/export-bundle.mjs --root=<id> --path=<资源>   # 资源包 → 标准模型目录
node tool/resolve-live2d-runtimes.mjs     # 查看 Live2D 运行时探测结果（排查用）
```

导出与工具细节见 **[docs/参考/接口清单.md](docs/参考/接口清单.md)** §五。

---

## 致谢与来源

**前端界面（布局、结构与样式）** 取自 [Boneview](https://github.com/souling01/spine-viewer-webgl)（作者 souling01）。
服务端、插件机制、解析与导出工具链、渲染引擎均为本项目自行实现。

- 原项目在线版：https://souling01.github.io/spine-viewer-webgl/
- 原项目未声明 LICENSE（`license: null`），默认保留全部权利

## 合规状态（重要）

| 项目 | 许可证 | 影响 |
|---|---|---|
| Boneview（前端界面来源） | **无 LICENSE（`license: null`）** | 默认保留全部权利 |
| Spine Runtimes（本项目内联使用） | 自定义协议（NOASSERTION） | 受 Spine Runtimes License Agreement 约束 |
| spive2d（参考项目，非本库代码） | MIT | 若将来以其为基础重做，需保留 MIT 声明 |

**当前状态**：本仓库为**私有、本地自用**，不对外分发，也不部署到公开 Pages。

## Spine Runtimes 申明

> 本工具使用官方 Spine Runtimes（[Esoteric Software](https://esotericsoftware.com)），
> 受 [Spine Runtimes License Agreement](https://esotericsoftware.com/spine-runtimes-license) 约束。
> 集成预览可以，但每个使用 Spine 数据的终端用户仍需拥有 Spine 编辑器授权。

---

## 免责

本 README 中的许可证与合规说明基于对原仓库元数据的查证与开源许可一般原理，**不构成法律意见**。
对外分发前建议咨询专业 IP 律师。

## 导出物版权

`tool/export-bundle.mjs` 导出的 `moc3`、`physics3`、贴图 PNG 等均为**游戏原始素材**，
仅供本地研究与个人使用，请勿再分发。导出产物默认写入 `data/export/`（该目录已在 `.gitignore`）。
