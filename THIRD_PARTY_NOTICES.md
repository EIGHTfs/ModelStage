# 第三方组件与授权声明（THIRD PARTY NOTICES）

本项目（ModelStage）自身代码以 **MIT** 发布，见 [LICENSE](LICENSE)。
以下第三方组件的授权**不由本项目授予**，各自遵循其原始协议。本项目**不随仓库、也不随 npm 包分发这些运行时的源码**。

---

## 1. Spine Runtimes（Esoteric Software）

```
组件         Spine Runtimes（spine-webgl / spine-ts，多版本：3.6 / 3.7 / 3.8 / 4.1）
权利方       Esoteric Software LLC
协议         Spine Runtimes License Agreement
项目位置     不入库（.gitignore：src/spine-runtimes/），也不在 npm 包的 files 白名单内
获取方式     由使用者在本地自行放置；项目不下载、不内嵌、不再分发
```

**使用者需要注意的两点：**

1. **持有许可**：将包含 Spine Runtimes 的软件分发给他人的，需要有效的 Spine 编辑器许可
   （Spine Essential 等，按 Esoteric Software 现行条款）。
2. **"服务端把运行时报给浏览器"属于分发**：本项目的服务会把本地运行时的文件发给访问者
   （`/spine-runtimes/*`）。因此**部署为公开可访问的服务**时，请自行确认上述条款是否覆盖该场景。

协议全文与最新条款见 Esoteric Software 官方站点（Spine Runtimes License Agreement）。
本文件不复制其条款正文，以避免版本过期造成误读。

---

## 2. Live2D Cubism SDK（Live2D Inc.）

```
组件         Live2D Cubism Core / Cubism Framework（以及配套的 Live2D 运行时目录）
权利方       Live2D Inc.
协议         Live2D Proprietary Software License Agreement
项目位置     不入库（.gitignore：src/live2d-runtimes/），也不在 npm 包的 files 白名单内
获取方式     由使用者在本地自行放置；项目不下载、不内嵌、不再分发
```

运行时文件头自带声明（示例）：

```
/**
 * Live2D Cubism Core
 * (C) 2019 Live2D Inc. All rights reserved.
 *
 * This file is licensed pursuant to the license agreement below.
 * This file corresponds to the "Redistributable Code" in the agreement.
 * https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
 */
```

**要点**：

- 该文件属于协议中的 **"Redistributable Code"** —— 允许随**你的应用**分发，但**不等于**可以把它
  放进公开源码仓库对外再分发。本项目据此把它排除在仓库与 npm 包之外。
- **商业使用**（含以 Live2D 内容提供服务的场景）需要按 Live2D 的条款取得相应授权。
- 分发时需保留上述版权与协议声明，不得移除。

---

## 3. pixi.js（仅当使用者自备的 Live2D 运行时目录内含它）

```
组件         pixi.js（部分 Live2D 运行时目录会带 pixi.min.js）
协议         MIT
```

如果使用者的 Live2D 运行时目录里含 `pixi.min.js`，其 MIT 许可与版权归 pixi.js 作者所有；
它同样位于不入库的运行时目录内，不随本项目分发。

---

## 4. Node.js 内置模块

项目为零运行时依赖（不引入 npm 依赖包），仅使用 Node.js 内置模块，其许可归 Node.js 项目所有。

---

## 5. 上游数据与各自游戏的资源

本项目是一个**查看器/解包器**：它读取使用者本地的资源包并渲染。
资源包中的美术、模型、动画等内容的版权归**各自的权利方**（游戏厂商/素材作者）所有，
本项目不提供、也不分发任何此类内容。使用者需自行确认其使用场景的合法性。

---

## 维护说明

本声明随项目维护更新。若你发现遗漏的第三方组件，请提交 issue 指出。
