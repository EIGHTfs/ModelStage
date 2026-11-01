# 解包能力对比：Node 自研解析器 vs Python(UnityPy)

> 三个问题要正面回答：① 当初是不是本可以引开源 Node 解包？② 为什么 Python 能解、Node 解不了？③ 该怎么做。
> 所有数据来自本机实测（**62 个真实样本** × 三端，分层抽样），不是推测。临时脚本已删。

---

## 零、先说结论（与任务书里的假设有出入，先说清楚）

**"Node 解不了"的真相：解析与提取都没问题，失败发生在「分类判据」这一层 —— 3D 模型包被判成"美术依赖包"，于是被拒绝装载。**

（最初的假设是"Node 缺解析能力"。实测后这个假设被否定；用户随后补充的"当初 node 解你写的判定为美术包，不是模型"直接指出了真因，本节末尾给出复现证据。）

| 检验层 | Node 结果 | Python 结果 | 是否一致 |
|---|---|---|---|
| 容器解析（UnityFS 头/块/压缩） | 25/25 成功 | 25/25 成功 | ✅ 一致 |
| 对象枚举（数量 + 类型分布） | 25/25 | 25/25 | ✅ **对象数 0 差异、histogram 0 差异** |
| **资源提取**（spine 的 skel/atlas + 贴图） | **25/25 成功** | 25/25 成功 | ✅ 一致 |

⇒ **解析层与提取层 Node 都不落后**（同一批样本、同一份判据、零差异）。

**真正卡住的是下一层**：`src/shared/bundle-shape.mjs` 判断"这个包是不是模型包"时，
只认 2D 的模型定义类（`TextAsset` / `SkeletonDataAsset` / `AtlasAsset` / `CubismModel` / `CubismMoc`）。
3D 模型包（`Mesh` + `SkinnedMeshRenderer` + `Transform` 层级）**一个都不占**，而 `Mesh` 还被列进了
`PURE_ART_CLASSES` ⇒ 被判为"美术依赖包，不能单独装载" ⇒ 前端/服务端据此拒绝 ⇒ **用户看到的就是"Node 解不了"**。

复现（某 3D 模型包，1.47MB，含 3 Mesh + 3 SkinnedMeshRenderer）：

```
ok              = true
objectCount     = 546
histogram       = {Transform:262, GameObject:262, MonoScript:2, Animator:2, MonoBehaviour:3,
                   Mesh:3, Texture2D:5, AssetBundle:1, Material:1, ClusterID:…, Shader:1}
assetDependency = true          ← 关键
dependencyReason= 这是美术依赖包，不能单独装载：包内只有 Transform×262、GameObject×262、
                  Texture2D×5、MonoBehaviour×3、Mesh×3，没有任何骨架或模型定义
                  （spine 的 .skel/.atlas、Live2D 的 model3.json 都不在里面）
```

**注意文案本身是诚实的**——它明确说"没有任何骨架或模型定义（spine/Live2D 的）"。
判据没有说谎，只是**它的世界模型里只有 2D**。

---

## 一、实测：62 样本差异矩阵（分层抽样）

### 1.1 抽样方法（低负载），以及第一版的偏差

**先说结论：样本归属 = 蔚蓝档案（Blue Archive）mod 包。**
判定依据是**包内资产名**而不是目录名：`spinecharacters-tsubaki_spr` / `spinelobbies-eimi_home` /
`spinecharacters-shun_spr` / `spinelobbies-izumi_swimsuit_home` 等，`_mx` 是该游戏的内部代号；
`spinebackground-*` 是同批的背景包。**这条经验记下来：判断"这批资源属于哪个游戏"要看包内资产命名，不能看目录名。**

**第一版（25 个）的抽样有偏差**：`find | sort | awk 'NR%9==1' | head -25` 是"按文件名排序每 9 取 1、再取前 25"，
结果**几乎全部落在同一个源目录**（按名排序把该目录排在最前），三个 modder 目录基本没覆盖，大小也只覆盖到 1.7~3.5MB。

**第二版（62 个）改成按源目录分层 + 大小分位**：

```
四个源目录的规模：
  .AssetBundls          149 个 bundle，353 KB ~ 47 MB（p10 1.4MB / p50 1.8MB / p90 8.8MB）
  [Yukinwo]               7 个，1.4 ~ 8.0 MB
  [林大大]               10 个，6.9 ~ 9.8 MB
  [离弦]                 71 个，0.8 ~ 16.9 MB

抽样：
  .AssetBundls   取 30 个（排序后**均匀跨分位**取中位，不偏向小文件）
  [Yukinwo]      7 个全取（本来就少）
  [林大大]       10 个全取
  [离弦]         取 13 个（均匀跨分位）
  再额外补 2 个**全库最大**的（45 MB / 27 MB），验证大包

最终 62 个，覆盖：4/4 个源目录、497 KB ~ 45 MB（p50 1.76 MB）、p25~p75 跨 1.4~7.4 MB
执行：三端**各自串行**跑完 62 个，无并发，总耗时约 20 秒
```

### 1.2 差异矩阵

| 分组 | 样本数（62） |
|---|---|
| Node probe 成功 | **62** |
| Node 资源提取成功 | **62**（修正实验脚本的节点判据后，见 §1.4） |
| Python(UnityPy) 成功 | **62** |
| 双端都失败 | 0 |
| **对象数不一致** | **0** |

**62/62 三端全部成功，零差异。**

关键分布（说明覆盖不是"专挑好啃的"）：

```
含 .skel 的样本      59 / 62   （另外 3 个是背景/场景包，本来就没有骨架）
含 .atlas 的样本     59 / 62
含 Texture2D 的样本  62 / 62
assetDependency=true  3 / 62   ← 这 3 个是真正的纯美术依赖包（无 skel/atlas），判据在这 3 个上是对的
```

### 1.3 资源提取层（这才是"能不能用"的真正判据）

不只列对象，直接把 spine 资产取出来（62 个样本）：

| 指标 | 结果 |
|---|---|
| 提取成功 | **62 / 62** |
| 含 `.skel`（TextAsset） | 59 / 62（余 3 个是背景包，无骨架属正常） |
| 含 `.atlas` | 59 / 62 |
| 含 `Texture2D` | 62 / 62 |

单个样本的实证（3.5 MB 的角色包）：

```
CAB-5c5918d27d2cf51e6d34235c07ca929c  objects=36
  textAssets: {角色}.skel (50768 B) / {角色}.atlas (3395 B)
  textures  : {角色} 2048×1024
```

⇒ **Node 侧能拿到可直接喂给 spine 运行时的三件套**（skel + atlas + png），不是"只能列对象"。

### 1.4 两个"失败"都是实验脚本的 bug —— 但暴露了一个真实的判据缺口

62 个样本跑下来，先后出现过 2 次"提取失败"，**都不是解析器缺陷**，而是我的实验脚本
把**非 serialized file 的节点**也喂给了 `serialized.parse`：

| 节点类型 | 头 4 字节 | 它是什么 | 误喂的后果 |
|---|---|---|---|
| `CAB-xxx.resS` | — | 裸资源流（贴图/音频字节池） | 报 `dataOffset` 精度溢出 |
| `CAB-xxx.resource` | `46 53 42 35` = **"FSB5"** | **FMOD 音频银行** | 报 `fileSize` 精度溢出（读到 2^60） |

修正判据（**只有 `CAB-<32位hex>` 这种无后缀节点才是 serialized file**）后：**62/62 成功**。

> 教训：报告"某层失败"之前，先确认自己没把 A 类型的数据喂给 B 类型的解析器。这条本轮踩了两次。

**顺带发现一个真实的潜在缺口（当前样本没触发，但值得改）**：

```
`probeBundleBytes` 取 CAB 节点用的是 `find(n => /^CAB-/.test(n.path))` —— **只取第一个匹配**。
而 62/62 个样本里**都有**带后缀的节点（.resS / .resource），只是因为 Unity 的节点顺序惯例是
"主 CAB 在前、.resS/.resource 在后"，所以从来没踩到。

实测：62 个样本中"第一个 CAB 节点带后缀"的有 **0 个**。
⇒ 现状安全，但**是靠惯例而不是靠判据**。若某个包顺序不同，probe 会解析错节点并给出误导性结论
   （表现为"这个包坏了"，而不是"我解析错了"）。
建议：把 probe 的判据也收紧成"无后缀"，与新写的提取逻辑用同一条规则（一行改动）。
```

## 二、开源调研：当初有没有可用的 Node 轮子

### 2.1 我搜了什么（方法与局限，先说清）

```
· npm 搜索："unity assetbundle unityfs parser extract" → 返回的全是无关包
  （error-stack-parser / extract-zip / @babel/parser / range-parser …），**0 个相关**
· GitHub 搜索："UnityFS" → 10 条，逐条看语言与用途，**0 个 JS/TS**
· GitHub 搜索："UnityFS assetbundle javascript typescript parser extract" → **无结果**
局限：关键词搜索不能证明"绝对不存在"，只能说明"不在显眼位置、没有生态"。
```

### 2.2 候选逐个核对

| 项目 | 语言 | ⭐ | 最后推送 | 许可证 | 能力 | 能否直接用 |
|---|---|---|---|---|---|---|
| `gameltb/io_unity` | **Rust** | 18 | 2023-04-17 | MIT | 读 Unity 资产，支持 UnityFS + serialized file | ❌ 需 Rust 工具链/FFI |
| `tirr-c/unityfs` | **Rust** | 7 | 2020-04-24 | MIT | 解析 UnityFS（从 UnityPack 移植） | ❌ 同上，且已 5 年未更新 |
| `HearthCode/Gext` | (工具) | 3 | — | — | UnityFS tools | ❌ 非库 |
| UnityPy | Python | — | 活跃 | MIT | **完整**：容器 + typetree + Mesh/贴图/动画 | ❌ 非 JS（但可子进程调用） |
| AssetStudio / AssetRipper | C# | — | 活跃 | MIT | 完整，含 3D | ❌ 需 .NET |
| **npm 上的 JS 包** | — | — | — | — | **不存在** | — |

### 2.3 结论：**被迫自研**，不是"选错"

```
· JS/TS 生态里**没有**成熟的 UnityFS/AssetBundle 解析库（npm 0 个，GitHub 0 个 JS 项目）
· 已有的成熟实现全在别的语言栈：Python(UnityPy) / C#(AssetStudio, AssetRipper) / Rust(2 个，其中一个停更)
· 而本项目的前端/服务端是 Node ⇒ 要么自研，要么把解包做成"外部进程 + 协议"（当时选了自研）
```

**但"被迫"不等于"最优"** —— 自研的代价在 §三的方案里量化。

---

## 三、能力边界对照（自研 Node vs UnityPy）

实测 + 读代码得出的真实边界：

| 能力 | 自研 Node（`plugins/unity-spine-bundle/lib/`） | UnityPy | 差距 |
|---|---|---|---|
| UnityFS 容器（版本/块/LZ4/LZMA） | ✅ 支持（含 `lzma-d-min`） | ✅ | 无 |
| serialized file 对象表 | ✅ | ✅ | 无 |
| TextAsset（skel/atlas/文本） | ✅ | ✅ | 无 |
| Texture2D 解码 | ✅ **自己实现了 DXT + ETC2 + PNG 编码** | ✅（靠 Pillow） | 无（Node 侧反而少一个依赖） |
| MonoBehaviour 任意字段（typetree） | ⚠️ 只取 `m_Name`/`m_Script` 等少数 | ✅ 完整 typetree | **有差距** |
| Mesh（顶点/索引/UV/骨骼权重/bindpose） | ❌ 未实现 | ✅ | **有差距** |
| SkinnedMeshRenderer / Transform 层级 | ❌ | ✅ | 有差距 |
| AnimationClip / Avatar | ❌ | ✅ | 有差距 |
| 加密（UnityCN / 自定义 XOR） | ❌ | 部分（需插件脚本） | 都有缺口 |

**⇒ 分界线很清晰：**
- **2D（Spine / Live2D）**：Node **完全够**（实测 25/25）
- **3D（Mesh/骨骼/动画）**：Node **没有**，UnityPy **有** —— 若将来要支持 3D，应由 python 侧负责（走外部 python 运行时），Node 只保留 2D

---

## 四、根因（已确认）与仍需确认的部分

### 4.1 已确认：分类判据只认 2D

| 事实 | 证据 |
|---|---|
| 判据位置 | `src/shared/bundle-shape.mjs` 的 `MODEL_DEFINING_CLASSES` / `isAssetDependencyHistogram`（前后端**共用一份**，这点做对了） |
| 只认 2D 定义类 | `TextAsset`、`SkeletonDataAsset`、`AtlasAsset`、`CubismModel`、`CubismMoc` |
| 3D 的"模型定义"不在名单 | `Mesh` 反而在 `PURE_ART_CLASSES`（纯美术类）里 |
| 后果 | 3D 模型包 `assetDependency=true` ⇒ 前后端都按"依赖包"处理 ⇒ 拒绝装载 |
| 影响面 | 前端 `src/web/infra/plugin-host-unpack.mjs:334` + 服务端 `src/server/data/entry-states.mjs`（状态与文案） |

**这解释了完整现象链**：Python（UnityPy）不读这个判据，直接读 Mesh/SMR ⇒ 能出模型；
Node 链路先过判据 ⇒ 在"能不能装载"这一步就被拦下 ⇒ 表现为"解不了"。
**不是能力差异，是分类口径差异。**

### 4.2 修法（属于下一步实现，本轮不改代码）

```
方案：给 MODEL_DEFINING_CLASSES 补 3D 的判据（最小改动）
  加 'SkinnedMeshRenderer'  —— 蒙皮渲染器是"这是角色/生物模型"的强信号
  可选 'MeshFilter'（静态网格）—— 但要配 Mesh>0 才有意义，单独出现可能只是道具/特效

为什么选 SkinnedMeshRenderer 而不是 Mesh：
  · Mesh 在 2D 包里也可能出现（spine 包的背景可能带 MeshFilter），单独出现不足以判定"模型包"
  · SkinnedMeshRenderer 表示"这个网格要按骨骼蒙皮渲染" —— 只有角色/生物模型才需要
安全性实测：62 个真实 2D 样本里**含 SkinnedMeshRenderer 的有 0 个**
  （含 MeshFilter 的 1 个是背景包）⇒ 加这条对现有 2D 判定**零影响**

工作量：判据约 3~10 行 + 受影响的两处文案/状态 + 一批回归样本（2D 不能回归成"模型包"）
```

### 4.3 澄清：3D 判据缺口与 BA mod 无关（两个不同的资源目录）

这一点要写清，避免混读：

| | 蔚蓝档案 mod 包（62 个样本） | 3D 模型包（来自另一个资源目录） |
|---|---|---|
| 资产类型 | 2D spine（skel + atlas + png） | 3D（Mesh + SkinnedMeshRenderer + 骨骼） |
| Node 解析 | ✅ 62/62 | ✅（容器与对象表都能列，实测 `objectCount=546`） |
| Node 提取 | ✅ 62/62（skel/atlas/png 都出得来） | ❌ **没有 Mesh/骨骼提取能力** |
| 判据 | ✅ 正确（59 有骨架判为模型包、3 个纯美术判为依赖包） | ❌ **被判成"美术依赖包"** |
| 结论 | **完全可用，无需改动** | 需要补 3D 判据（3~10 行）+ 3D 预览走 UnityPy |

**⇒ "BA 有些包解不了"不成立**；"3D 模型包被判成美术包"成立，但那是另一个目录的事。

### 4.4 还需要用户提供的材料

| 需要什么 | 为什么 |
|---|---|
| **暂时不需要** | 62 个 BA 样本已覆盖四个来源目录与 497KB~45MB 全区间，结论已稳 |

（上一版文档里"需要提供 BA bundle 路径"的结论**已作废** —— 当时的 25 个样本本身就是 BA 包，
是我按目录名误判了归属，不是样本缺失。）

## 五、三个方案（量化）

### 方案 A（修正版）：只补「分类判据」，不补解析器

**这是本轮真正的推荐**（原方案 A 的"补 Mesh/动画解析器"已被实测否定 —— Node 的解析与提取都能跑）：

| 改动 | 工作量 |
|---|---|
| `MODEL_DEFINING_CLASSES` 加 `SkinnedMeshRenderer`（+ 可选 `MeshFilter`+`Mesh` 组合） | **约 3~10 行** |
| 受影响的两处：前端 `plugin-host-unpack.mjs` 的提示文案、服务端 `entry-states.mjs` 的状态 | 小（文案要区分"2D 依赖包"与"3D 模型包"） |
| 回归：25 个真实 2D 样本必须**仍判为模型包**（不能因为加判据把它们归错） | 用本轮已跑通的 25 样本清单即可 |
| 若要做 3D 预览：仍需 UnityPy（走外部 python 运行时） | 已有 |

**⇒ 从"1~2 周补解析器"降到"半天补判据 + 回归"** —— 这是本轮最有价值的发现。

---

### 原方案 A（已被实测否定，保留作为记录）：补齐自研 Node 解析器

| 缺口 | 工作量 | 说明 |
|---|---|---|
| MonoBehaviour 完整 typetree | **中（3~5 天）** | 需要按 Unity 的类型树规则反序列化任意 monobehaviour；本质是"再写一遍 Unity 的序列化格式" |
| Mesh（顶点/索引/UV/法线/切线/骨骼权重/bindpose） | **大（1~2 周）** | 涉及 `m_VertexData` 的 packed 流解析（Unity 2021+ 的格式与老版不同） |
| Transform 层级 + SkinnedMeshRenderer | **中（3~5 天）** | 相对简单，但依赖上一条 |
| AnimationClip（curve 压缩格式） | **大（1~2 周）** | 最难的一块，Unity 有 5 种压缩曲线格式 |
| glTF 导出 | 中（3~5 天） | 已有 python 版可对照 |

- **改动面**：`plugins/unity-spine-bundle/lib/` 新增 3~5 个模块（都是浏览器风格脚本，需在沙箱里跑）
- **风险**：**高**。3D 的坑（顶点格式、动画压缩）在 Python 侧已经被 UnityPy 踩平了，自研等于重踩一遍；而且这套代码是"手写二进制解析"，出错表现为"数字看起来对但模型是歪的"，极难测。
- **对 2D 的影响**：无（不动现有链路）

### 方案 B：能力路由（能 Node 就 Node，不行转 Python）

| 项 | 评估 |
|---|---|
| 路由判据 | **这是致命问题**：要"不先试一遍失败"就判断能不能解，就需要一个**可靠的预判**。可用的信号只有"包里有 Mesh 吗"（要看对象表才知道）⇒ **必须先解析**。而"能列对象"≠"能取到可用资源"（你这轮的预判完全正确） |
| 失败回退代价 | 一个包最坏被解析两遍（Node 失败 → Python 重来），3.5MB 的包约 +0.5~1s |
| **结论不一致风险** | **高**：同一份数据两套解析，一旦两边对某个字段理解不同（比如贴图通道顺序、Transform 父子关系），就会出现"同一个包今天显示正常、明天换个入口就不对"——正是我们一路在消灭的漂移 |
| 工作量 | 中（3~5 天），但**维护成本是长期的** |

**⇒ 不推荐**。判据写不稳 + 双解析漂移风险，收益（省一次子进程）远小于代价。

### 方案 C：统一走 Python，Node 只做轻量预检

| 项 | 评估 |
|---|---|
| 改动面 | 把 2D 解包也迁到 `unitypy-bundle`（exec 运行时）；Node 侧保留 `probeBundleBytes`（判定"这是什么类型的包 / 是不是依赖包"，无需子进程，毫秒级） |
| 工作量 | **中（5~7 天）**：主要是把现有 Node 提取链路的能力在 Python 侧对齐（TextAsset/贴图解码 UnityPy 都有），再做一次前端切换 |
| 风险 | **中**：①每个包要起子进程（worker 池已有，但 2D 解包频次比 3D 高）②现有 `unitypy-bundle` 的依赖目录需要装 PIL/numpy（已有） |
| 对 2D 链路影响 | **直接相关**：现在 Node 解 2D 是**同步、零子进程**，迁到 Python 后变成异步 + 进程间协议，首屏可能变慢 |

**⇒ 不推荐立刻做**。Node 的 2D 能力实测完全够用（25/25），为了"统一"去换掉一个能跑的实现，收益不明。

### 推荐：**方案 A′（按资产类型分工，而不是按"能不能解"分工）**

```
维持现状的边界，只把"3D"这一条明确划给 Python：

  Spine / Live2D（2D）  → 自研 Node（同步、零子进程、实测 25/25）
  3D（Mesh/骨骼/动画）  → UnityPy（走外部 python 运行时）
  预检 / 类型判定       → 自研 Node 的 probeBundleBytes（不需要子进程）

为什么这个分工比"能力路由"好：
  它按**资产类型**切，而资产类型在**入口处就已经知道**（用户点的是 spine 模型还是 3D 模型，
  前端看文件/插件就能定），**不需要"先试一遍"** —— 这正是方案 B 判据写不稳的根源。
```

**一句话理由**：**Node 在 2D 上实测不落后（25/25），3D 卡住的不是解析而是分类判据（3~10 行可补）—— 所以既不需要"能力路由"，也不需要重写解析器，只需要把判据认全 + 把"哪种资产用哪条链"按类型固定。**

**建议的执行顺序**（都不大）：
```
① 补 3D 判据（SkinnedImage… 即 SkinnedMeshRenderer）+ 回归 25 样本  ← 半天
② 3D 预览由 python 侧产出资产、前端另行消费                            ← 未排期）
③ "能力路由"不做；缺失样本到手后再判是"判据缺口"还是"解析缺口"
```

---

## 六、遗留

1. ~~"Node 解不了"的具体所指~~ **已澄清并复现**：3D 分类判据只认 2D（§4.1），与本批 BA 样本无关。
2. ~~样本缺失~~ **已作废**：25 个（现 62 个）样本本身就是蔚蓝档案 mod 包，Node 侧 62/62 可用。
3. **`probeBundleBytes` 的 CAB 节点判据靠"主 CAB 在前"的惯例**（§1.4 末），建议收紧成"无后缀"——一行改动，属于下一步。
4. **本轮没测加密包**：62 个样本里没有 UnityCN/自定义 XOR 的包，那条能力边界（Node ❌ / UnityPy 部分）是**读代码+常识**得出的，未实测。
5. **本轮没测"被 modder 重新打包过"的特殊包**：62 个里没有明显的重打包痕迹（都是标准 UnityFS v7/v8 + LZ4）。
   如果用户的某个 mod 是自己重新打包的（换了压缩或加了头），需要单独给样本。
