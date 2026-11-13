# 任务书 · 只读分析 API（分步）

## 总目标

给 AI 一个**只读**分析入口：能吃任意路径的容器文件，回答「这是什么、能不能支持、缺什么」。
不限路径（不限资源根），只读不写。

## 全程纪律（每步都要逐条回应）

```
1 只读：分析路径不写任何文件、不改配置、不动被分析的源文件
2 不写死：路径/插件 id/条数不许硬编码进代码或测试
3 不设超时：产品代码不写 AbortSignal.timeout / 超时兜底；确需限量用"样本量上限"而非时间
4 不用 sed 改代码：只用 edit 工具；改完 node --check + 跑相关套件
5 注释只写事实与结论：不写规则号、不写对话残留、不写"用户要求"
6 测试要能自证红：新增断言在修复前必须失败（先造红，再变绿）
7 只跑相关套件（node --test test/xxx.test.mjs）；不跑 --all / --browser（Lead 跑）
8 可本地 commit（精确 paths），不许 push
9 单线程：同一时刻只有你一个成员改文件
```

## 分步计划（本步只做第 1 步）

| 步 | 内容 | 状态 |
|---|---|---|
| 1 | **解耦**：能力声明 + 注册分派，删掉本体对插件 id 的硬编码 | ← 本次下发 |
| 2 | `/api/analyze?path=` 单文件分析（节点名/对象表/TextAsset 名/骨架版本/纹理格式/判读） | 待下发 |
| 3 | 目录递归 + 结论聚合 | 待下发 |
| 4 | 限额与收尾（大文件抽样、内存上限、文档、测试） | 待下发 |

## 第 1 步：解耦（详细要求）

### 现状证据

```
tool/lib/bundle-probe-node.mjs:22   const PROBE_PLUGIN_ID = 'unity-live2d-bundle'
                                    ↑ 本体按插件名去读它的 lib 文件
插件 manifest 未声明"能分析"这个能力，只有 files[] 列了 lib
```

### 要做成

```
① 契约：docs/契约/插件.md §一 增加角色 bundle-analyzer
   · 职责：对容器字节流给出分析结论（不改数据、不产模型）
   · 接口：analyze(bytes) -> { verdict, container, objects, textAssets, textures, warnings }
   · 现状列：与其它角色同样标注「已落地 / 留位」

② 插件侧：unity-live2d-bundle、unity-spine-bundle 在 plugin.json 声明该角色，
   并在 index.js 暴露 analyze()（实现直接复用各自已有的 lib/bundle-probe.js，不重写解析）

③ 本体侧：新增 analyzer 注册表（按 provides 分派）
   · 找到第一个声明 bundle-analyzer 的插件 → 用它分析
   · 一个都没有 → 降级：只用魔数判定（UnityFS / CAB- / MOC3 / ZIP / JSON），
     结论里写清「需要安装 unity-*-bundle 插件才能细看」
   · 删掉 PROBE_PLUGIN_ID 硬编码；libDirFor/libOrderFor 改为接收"提供者描述"

④ 行为不变：现有 /api/bundle/probe 与页面预检的结论、字段、文案**保持不变**
   （这次是"把硬编码换成按能力找提供者"，不是重写预检）
```

### 验收判据

```
A. 只启用 unity-spine-bundle  → 分析结论与现在一致
B. 只启用 unity-live2d-bundle → 分析结论与现在一致
C. 两个都禁用                 → 不报错，给降级结论 + 提示装哪个插件
D. 全量 node 套件里与预检相关的（bundle-probe / catalog-bundle / plugin-contract）保持绿
E. grep 证明源码里不再有 'unity-live2d-bundle' 这类插件名硬编码在 tool/ 或 src/ 的分派逻辑里
```

### 交付物

```
· 改动代码（src/、tool/、plugins/ 各自范围内）
· 新增/更新的 node 测试（能自证红）
· 一份简短说明：改了什么、A~E 五项怎么验的、遗留
```

## 第 1 步补充要求（Lead 实测发现，必须一并修）

### 缺陷：目录过滤与 registry 不一致

```
src/server/plugins/registry.mjs:392     if (e.name.startsWith('.')) continue;   ← 正式约定：跳过 . 开头
tool/lib/bundle-probe-node.mjs:49       （无此过滤）                          ← 新分派器照抄了旧逻辑的疏漏

后果：插件被停用/删除后留下的副本（.trash / .bak-* / .off-*）仍被当成"分析提供者"，
     结论可能来自废弃副本 —— 与"停用的插件不参与"直接矛盾。
实测：把两个 bundle 插件目录改名成 .off-* 后，findAnalyzerProvider() 仍然返回了 .off-unity-live2d-bundle。
```

### 要求

```
① 分派器跳过 . 开头的目录，与 registry.mjs 保持同一判据
② 加一条能自证红的断言：把提供者目录改名成 .off-xxx 后必须找不到（改前会失败）
③ 顺带检查：分派器是否也该跳过"清单存在但插件被禁用"的情况
   （项目里插件的启用/禁用机制以 registry.mjs 为准，不要另造一套）
```

