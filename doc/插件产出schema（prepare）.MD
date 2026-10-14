# 插件产出 schema（`prepare()` / `open()` 返回结构）

> 面向对象：将要替换前端的实现者。
> 本文把「Live2D 资源包插件」交给舞台/前端的数据结构写清楚：字段名、类型、含义、样例、错误形态，以及**契约上应有但当前未实现**的字段。
> 真相以代码为准（`plugins/unity-live2d-bundle/index.js` 的 `open()` 与 `buildRenderableModel()`）；本文与之不一致时以代码为准并回来修本文。

---

## 一、产出总览

插件对外只暴露一个装载入口（宿主 `SpineViewerPlugins` 里注册的 `open(ctx)`），`await` 后得到：

| 顶层字段 | 类型 | 含义 |
|---|---|---|
| `report` | object | 素材报告：容器/对象表/抽取结果/纹理解码/动作与曲线统计。**只放数字摘要，不挂原始字节**（整包几十 MB，挂上去会把页面内存吃光） |
| `model` | object | 可直接交给 Live2D 舞台的模型描述（见第四节），内部是重建后的 `model3.json` + Blob URL |
| `model3` | object | 重建出来的 `model3.json` 原文对象（已序列化进 `model.modelUrl` 指向的 Blob） |
| `urls` | string[] | 本次创建的全部 Blob URL（由 `model.revoke()` 统一释放） |

> 返回的是 `open()` 的完整对象；`report` 里的 `model`/`model3` 字段是同一份对象的引用（便于一次拿到全部）。

---

## 二、`report` 字段

### 2.1 `report.kind`
- 类型：`string`，固定 `"live2d-bundle"`。

### 2.2 `report.container`
| 字段 | 类型 | 含义 |
|---|---|---|
| `signature` | string | 容器签名（UnityFS 魔数文本） |
| `version` | number | 容器格式版本 |
| `engine` | string | 打包引擎版本（如 `2020.3.48f1`） |
| `player` | string | player 版本串 |
| `nodes` | `{path,size,offset}[]` | 容器内节点表（`CAB-*` / `*.resS` 等） |
| `dataStart` | number | 数据段起始偏移 |
| `bytes` | number | 整个资源包字节数 |

### 2.3 `report.serialized`
| 字段 | 类型 | 含义 |
|---|---|---|
| `version` | number | SerializedFile 版本 |
| `unityVersion` | string | 资源内部记录的 Unity 版本 |
| `types` | number | 类型表条目数 |
| `objects` | number | 对象数 |
| `classStats` | object | 按类型统计的对象数（`typeStats()` 产出） |

### 2.4 `report.moc3` / `report.physics3`
- `moc3`：`{ bytes, magicOffset, pathID } | null`
- `physics3`：`{ bytes } | null`
- 含义：抽出的 Cubism 模型/物理字节数与定位信息；没有则为 `null`。

### 2.5 `report.nativeFiles`
- 类型：`{ name, bytes }[]` — 包内原生的 Cubism 文件（若本来就带 `motion3`/`model3`，这里能看到）。

### 2.6 `report.textures[]`
| 字段 | 类型 | 含义 |
|---|---|---|
| `name` | string | 纹理名 |
| `width` / `height` | number | 尺寸 |
| `format` | number | Unity `TextureFormat` 枚举值 |
| `formatName` | string | 格式名（如 `ETC2_RGBA8`、`DXT5`） |
| `source` | `"resS" \| "inline"` | 数据来自 `.resS` 还是内联 |
| `rgba` | `Uint8Array?` | 解码后的 RGBA（仅内存，**不要**序列化进日志/落盘） |
| `bytes` | number? | 压缩字节数 |
| `error` | string? | 单张解码失败的原因（失败不整体中断） |

**已支持的纹理格式**（`format` 枚举值 → 解码实现）：

| 枚举 | 名称 | 解码位置 | 说明 |
|---|---|---|---|
| 47 | `ETC2_RGBA8` | `lib/etc2.js` | 移动端最常见（当前 20 个真实资源包 100% 是它） |
| 45 / 48 | `ETC2_RGB` / `ETC2_RGBA1` | `lib/etc2.js` | |
| 34 | `ETC_RGB4` | `lib/etc2.js` | ETC1 |
| 10 | `DXT1` | `lib/dxt.js` | PC/主机常用；含 1bit 透明模式 |
| 12 | `DXT5` | `lib/dxt.js` | BC3：alpha 块 + 颜色块 |
| 26 / 27 | `BC4` / `BC5` | `lib/dxt.js` | 单/双通道（法线/遮罩类贴图） |
| 1 / 3 / 4 / 5 / 7 | `Alpha8` / `RGB24` / `RGBA32` / `ARGB32` / `RGB565` | `lib/texdecode.js` | 未压缩直通 |

**暂未实现**（会抛带格式号的可读错误，不会静默产出坏图）：`ASTC`（50 系列）、`PVRTC`（30/31）、`BC6H`（24）、`BC7`（25）。
其中 ASTC 是完整块解码器（多块尺寸 × LDR/HDR × 多种解压模式），实现量远大于 BC 家族；当前真实资源里尚未出现，故按"先做真实数据需要"的顺序暂缓。

### 2.7 `report.motions[]`
每个动作一条元数据：

| 字段 | 类型 | 含义 |
|---|---|---|
| `name` | string | 动作名（来自 AnimationClip） |
| `duration` | number | 时长（秒） |
| `loop` | boolean | 是否循环（按 profile 规则判定） |
| `curves` / `points` / `segments` | number | 曲线数 / 总点数 / 总段数（与 `model3.Meta` 一致） |
| `group` | string | 归入的 motion3 分组（`idle` / `touch_head` …） |
| `skippedUnknownBinding` | number | 路径哈希反查不到名字、被跳过的绑定数 |
| `skippedNotParameter` | number | 反查到名字但不在 moc3 参数表、被跳过的绑定数 |

### 2.8 `report.curveStats`
| 字段 | 类型 | 含义 |
|---|---|---|
| `total` | number | 绑定总条数（= 曲线数分母，含被丢弃动作里的绑定） |
| `emitted` | number | 实际写进 motion3 的曲线数 |
| `skippedUnknownBinding` / `skippedNotParameter` / `skippedEmpty` | number | 三类跳过计数 |
| `expandedSinglePoint` | number | 单点曲线补成两点的数量（否则运行时求值每帧抛错） |
| `invalidSegments` | number | 按运行时消费规则会越界的曲线数（**必须为 0**） |
| `unknownHashCount` / `notParameterIdCount` | number | 去重后的未知名哈希数 / 非参数 Id 数 |
| `sampleUnknownHashes` / `sampleNotParameterIds` | `(number\|string)[]` | 各取最多 6 个样例 |
| `motionsTotal` / `motionsEmitted` / `motionsDroppedEmpty` | number | 动作口径：clips 总数 / 产出数 / 因过滤后无曲线而丢弃数 |
| `droppedMotions` | `string[]` | 被丢弃的动作及原因摘要 |
| `skipByMotion` | `string[]` | 跳过量最多的前 5 个动作（`名 跳过/总数`） |
| `skipTop5Share` | number | 前 5 个动作占总跳过量的百分比（集中 ⇒ 少数动作在"借不到"参数） |
| `whitelistApplied` / `whitelistCount` | boolean / number | 是否启用 moc3 参数表白名单及其条目数 |

### 2.9 `report.paramTable`
- `{ count, partCount, hasTypes } | null` — moc3 参数表（白名单来源）；取不到时为 `null`（此时不做白名单校验）。

### 2.10 其余
| 字段 | 类型 | 含义 |
|---|---|---|
| `containerPaths` | string[] | 容器内与 Cubism 资产相关的路径 |
| `profile` | string\|null | 命中的游戏 profile id |
| `motionGroups` | string[] | 重建后 `model3` 的 motion 分组名 |
| `raw` | `{moc3Bytes, physics3Bytes, serializedVersion, objects}` | 纯数字摘要（供快速判断"读到多少"） |
| `urls` | number | Blob URL 个数 |

---

## 三、样例产出（实测：`azurlane_bundle/adaerbote_3`）

> 数值取自页面实际装载（`__DIAG__` 的 `bundle.parse` 事件与 `report` 同源）；省略了体积大的 `rgba`。

```jsonc
{
  "kind": "live2d-bundle",
  "container": {
    "signature": "UnityFS", "version": 8, "engine": "2020.3.48f1", "player": "2020.3.48f1",
    "nodes": [{ "path": "CAB-xxxx", "size": 0, "offset": 0 }, { "path": "CAB-xxxx.resS", "size": 0, "offset": 0 }],
    "dataStart": 0, "bytes": 0
  },
  "serialized": { "version": 21, "unityVersion": "2020.3.48f1", "types": 0, "objects": 6208, "classStats": {} },
  "moc3": { "bytes": 3225600, "magicOffset": 0, "pathID": 0 },
  "physics3": { "bytes": 49206 },
  "textures": [
    { "name": "texture_00", "width": 4096, "height": 4096, "formatName": "ETC2_RGBA8", "source": "resS", "bytes": 0 },
    { "name": "texture_01", "width": 2048, "height": 2048, "formatName": "ETC2_RGBA8", "source": "resS", "bytes": 0 }
  ],
  "motions": [{ "name": "idle", "duration": 6.667, "loop": true, "curves": 0, "points": 0, "segments": 0, "group": "idle", "skippedUnknownBinding": 0, "skippedNotParameter": 0 }],
  "curveStats": {
    "total": 15376, "emitted": 15032,
    "skippedUnknownBinding": 0, "skippedNotParameter": 0, "skippedEmpty": 0,
    "expandedSinglePoint": 11307, "invalidSegments": 0,
    "motionsTotal": 34, "motionsEmitted": 34, "motionsDroppedEmpty": 0,
    "skipTop5Share": 0, "whitelistApplied": true, "whitelistCount": 467
  },
  "paramTable": { "count": 467, "partCount": 0, "hasTypes": false },
  "motionGroups": ["complete", "effect", "home", "idle", "login", "touch_head"],
  "raw": { "moc3Bytes": 3225600, "physics3Bytes": 49206, "serializedVersion": 21, "objects": 6208 },
  "urls": 39
}
```

---

## 四、`model` 字段（交给舞台的契约）

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | string | `bundle:<rootId>:<rel>`（稳定标识，可直接当模型 key） |
| `name` | string | 展示名（资源包名） |
| `kind` | string | 固定 `"live2d"` |
| `cubism` | number | 固定 `4`（重建的 model3 走 Cubism 4 语义） |
| `modelUrl` | string | 重建 `model3.json` 的 Blob URL |
| `motions` | `{ [group]: {name,file,loop,duration}[] }` | 舞台按 (组, 下标) 播放，**顺序与 model3 一致** |
| `expressions` | array | 当前恒为空数组（资源包内未抽取表情） |
| `textureFiles` | `{name,url}[]` | 纹理 Blob URL |
| `bundleProfile` | string\|null | 命中的 profile |
| `bundleSource` | `{rootId,rel,size}` | 来源定位（可据此反查原始文件） |
| `designSize` | `{width,height,originX,originY,pixelsPerUnit,source} \| null` | 画布尺寸（moc3 CanvasInfo），见第五节 |
| `bbox` | `{x,y,width,height,unit,pose,vertexCount,pixels?} \| null` | rest pose 顶点包围盒（模型单位），见第五节 |
| `meta` | object \| null | 能力层元数据整体（`designSize` + `bbox` + 结构计数），与 `report.modelMeta` 同一份 |
| `prepare()` | `() => Promise` | 舞台在取模型资产前 `await` 它，用于把内存资源通道准备好 |
| `revoke()` | `() => void` | 释放本模型全部 Blob URL；切换模型时必须调用，否则几十 MB 贴图会滞留 |

---

## 五、能力层元数据：`designSize` / `bbox` / 结构计数（**已实现**）

产出位置：`open()` 返回对象顶层 `modelMeta`，以及 `model.designSize` / `model.bbox` / `model.meta`（同一份引用）。由 Cubism Core 在解析 moc3 的**同一趟**里产出，前端不必重算。

### 5.1 `designSize`
| 字段 | 类型 | 含义 |
|---|---|---|
| `width` / `height` | number | moc3 `CanvasInfo` 的 `CanvasWidth/CanvasHeight`：Cubism 原始画布像素尺寸 |
| `originX` / `originY` | number | 画布原点（Cubism 在画布中心，通常 = 宽/2、高/2） |
| `pixelsPerUnit` | number | 模型单位 → 像素的换算系数 |
| `source` | string | 固定 `"moc3.CanvasInfo"`（标明来源，便于将来换口径） |

### 5.2 `bbox`
| 字段 | 类型 | 含义 |
|---|---|---|
| `x` / `y` | number | 包围盒左下角，**模型单位** |
| `width` / `height` | number | 包围盒尺寸，**模型单位** |
| `unit` | string | 固定 `"model"` |
| `pose` | string | 固定 `"rest"`（见下方限制） |
| `vertexCount` | number | 参与统计的顶点数（用于判断是否读到了数据） |
| `pixels` | `{width,height}?` | 按 `pixelsPerUnit` 换算的像素尺寸（仅在顶点与画布同尺度时有意义，见 5.4） |

**口径与限制（务必照此理解）**：
- 这是 **rest pose（默认参数）** 下所有绘制对象顶点的 min/max，**不含**物理、动作、表情造成的变形。需要"动作全程包围盒"的调用方要自己采样动画帧。
- 读顶点前会调一次 `model.update()`（部分运行时版本未 update 时顶点可能为空；本机 Core 4.2.0 实测 update 前后一致，调用无副作用）。

### 5.3 结构计数（`modelMeta` 里）
| 字段 | 含义 |
|---|---|
| `drawableCount` | 绘制对象数 |
| `partCount` | 部件数 |
| `parameterCount` | 参数数 |
| `maskGroupCount` | **被引用的不同遮罩绘制对象数**（同一遮罩可被多个对象引用；这是"遮罩组"的一种定义，与渲染层的 clipping context 数可能不同） |

### 5.4 实测值（交叉校验用）

| 项 | `adaerbote_3`（bundle） | `aimierbeierding_3`（目录版，Core 直读） |
|---|---|---|
| `designSize` | **8000×8000**（origin 4000/4000，ppu 298.893） | **6200×5600**（origin 3100/2800，ppu 311.111）✅ 与此前独立测量一致 |
| `bbox`（模型单位） | 166.578×146.912 @(-55.374,-91.534)，18818 顶点 | 17.826×13.744 @(-8.875,-7.383)，10603 顶点 |
| `bbox`（换算像素） | 49789×43911 | 5546×4276 |
| `drawableCount` | 685 | 532 |
| `partCount` | 147 | 120 |
| `parameterCount` | 467 | 264 |
| `maskGroupCount` | 5 | 10 |

> ⚠️ **尺度不一致的已知情况**：`adaerbote_3` 的顶点坐标跨度（166 单位）约为其画布（8000/298.893 ≈ 26.8 单位）的 **6.2 倍**，因此它的 `bbox.pixels` 会超出画布；`aimierbeierding_3` 则是正常的（5546×4276 落在 6200×5600 内）。
> 结论：**`bbox` 的模型单位值是原始真相；`pixels` 只是按 ppu 的换算，跨模型比较时不要假设它落在画布内**。前端若要做"内容占画布多少"这类判断，请以模型单位自行换算或直接看 `designSize`。

### 5.5 Spine 模型
插件**解析不了** Spine 的 `.skel/.json`，因此**不会**为 Spine 模型产出这两个字段。Spine 模型请由前端读 `skeleton.data.width/height`（Spine 运行时自带），不要期待插件给。

---

## 六、错误码（稳定、可程序区分）

装载失败一律抛**带码错误**（不会产出"坏模型"）。错误对象形状：

```
err.code    // 稳定码，见下表（大写蛇形 + ULB_ERR_ 前缀）
err.message // 中文可读说明（可原样展示给用户）
err.ulb     // true（标记为本插件产出，便于跨层识别）
err.*       // 可能带附加上下文（如 texture、motion 名）
```

**稳定性约定**：码按「失败类别」定义，**不按行号/临时条件生成**；同一失败原因永远同一码；已发布的码**不删不改**，需要区分新情况时新增码。
取码方式：`window.__ULB__.errors.codeOf(err)`（非本插件错误返回 `null`）。

| 码 | 触发条件 | 新前端建议处置 |
|---|---|---|
| `ULB_ERR_BAD_ARGS` | 调用参数缺失/非法（如缺 `rootId`/`rel`） | 修调用；不要重试 |
| `ULB_ERR_IO` | 读取资源失败：宿主取文件失败、HTTP 非 2xx、**请求超时**（15s） | 可重试 1~2 次；仍失败则提示网络 |
| `ULB_ERR_NO_FILE` | 目标文件不存在或内容为空（路径合法但文件没有） | 跳过；不要重试 |
| `ULB_ERR_NOT_UNITYFS` | 文件不是 UnityFS 容器（签名不符） | 跳过该文件（不是资源包） |
| `ULB_ERR_NO_CAB` | 容器里没有 `CAB-*` 节点 | 跳过（不是资产包） |
| `ULB_ERR_CONTAINER_PARSE` | 容器/序列化/类型树解析失败（布局不符该版本、文件损坏） | 跳过 + 上报（带上文件路径） |
| `ULB_ERR_EXTRACT` | 从对象表抽取资产失败（缺 `.resS`、流数据越界、纹理无数据） | 跳过 + 上报 |
| `ULB_ERR_TEX_FORMAT_UNSUPPORTED` | 纹理格式未实现（ASTC/PVRTC/BC6H/BC7） | 提示"该资源用了未支持的压缩格式"，等能力层升级；不要重试 |
| `ULB_ERR_TEX_DATA_SHORT` | 纹理压缩数据不足（截断/尺寸与格式不符） | 跳过该纹理；可上报 |
| `ULB_ERR_TEX_DECODE` | 纹理解码失败（PNG 签名/位深/颜色类型、分发缺分支等） | 跳过该纹理 + 上报 |
| `ULB_ERR_CURVE_BINDING_MISMATCH` | 动画曲线数与绑定数不一致（数据布局不符） | 跳过该模型的动画转换 + 上报 |
| `ULB_ERR_STREAMED_CLIP_INVALID` | StreamedClip 结构异常（帧数/关键帧数/数据截断） | 跳过 + 上报 |
| `ULB_ERR_MODEL_BUILD` | 拼装可渲染模型失败（缺 moc3/贴图等必需素材） | 跳过 + 上报 |

**自检覆盖**：`self-test.mjs` 里有 15 条错误码断言——码表格式与唯一性、`fail()` 的 `code/ulb/message` 语义，以及**可由 lib 层触发**的 6 个码（纹理格式未实现、纹理数据不足 ×2、PNG 解码失败、容器解析失败、读取越界）都能真的被触发到；插件层的 `BAD_ARGS`/`IO`/`NOT_UNITYFS`/`NO_CAB` 由页面级用例覆盖。

---

## 七、新前端最小消费流程

```
1. GET /api/plugins            → 拿到插件清单（含 fileKinds）
2. 选择模型条目（bundle 类）    → { rootId, rel }
3. await SpineViewerPlugins 里该插件的 open({rootId, rel, name, profile})
4. 拿到 { model, report }
   · 舞台按 model.modelUrl / motions / textureFiles 装载
   · 装载前 await model.prepare()；切换模型时调 model.revoke()
   · 需要"读到了什么"时用 report（数字摘要，可直接展示/上报）
5. 需要提示"画布比视口大"时 → 等 `bbox` / `designSize` 落地（见第五节），不要在前端重算
```
