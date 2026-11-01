# 解包能力对比：Node 自研解析器 vs Python(UnityPy)

> 三个问题要正面回答：① 当初是不是本可以引开源 Node 解包？② 为什么 Python 能解、Node 解不了？③ 该怎么做。
> 所有数据来自本机实测（25 个真实样本 × 双端），不是推测。临时脚本已删。

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

## 一、实测：25 样本差异矩阵

### 1.1 抽样方法（低负载）

```
源：样本目录（997MB / 707 文件，其中 237 个 .bundle，多个来源子目录）
抽样：find 全部 .bundle → 按文件名排序 → 每 9 个取 1 个 → 取前 25 个
     （覆盖 1.7MB ~ 3.5MB，三个 modder 目录都有样本）
执行：Node / Python 各自**串行**跑完 25 个，无并发；
```

### 1.2 差异矩阵

| 分组 | 样本数 |
|---|---|
| 双端都 ok | **25** |
| 只有 Node 失败 | 0 |
| 只有 Python 失败 | 0 |
| 双端都失败 | 0 |
| 对象数不一致 | **0** |
| 类型分布(histogram)不一致 | **0 / 25** |

**没有一个样本能复现"Node 解不了"**。

### 1.3 资源提取层（这才是"能不能用"的真正判据）

不只列对象，直接把 spine 资产取出来：

| 指标 | 结果 |
|---|---|
| 提取成功 | **25 / 25** |
| 含 `.skel`（TextAsset） | 24 / 25（那 1 个是背景包，没有 skel 属正常） |
| 含 `Texture2D` | 25 / 25 |

单个样本的实证（`ch0092_spr`，3,507,425 字节）：

```
CAB-5c5918d27d2cf51e6d34235c07ca929c  objects=36
  textAssets: CH0092_spr.skel (50768 B) / CH0092_spr.atlas (3395 B)
  textures  : CH0092_spr 2048×1024
```

⇒ **Node 侧能拿到可直接喂给 spine 运行时的三件套**（skel + atlas + png），不是"只能列对象"。

### 1.4 过程中唯一的"失败"，以及它为什么不是缺陷

第一次跑提取时出现过这一条：

```
CAB-...resS  ok=false
  错误：64 位整数超出安全范围（dataOffset）：-2231498347519148032，本插件按 Number 处理会丢精度
```

**定位**：`.resS` 是 **UnityFS 的裸资源流节点**（贴图/音频的原始字节池），**不是 serialized file**。
把它当 serialized file 去 parse，当然会读到"看起来像 dataOffset 的字节"并报精度错误。
**是我实验脚本自己的 bug**（对所有 `CAB-*` 节点一律 parse），不是解析器的缺陷 ——
正常链路（`probeBundleBytes`）只 parse `CAB-xxx`（不含 `.resS`），从不踩这个错。
修掉这一处误用后：**25/25 成功**。

> 这条值得记下来：**报告"某层失败"之前，先确认自己没把 A 类型的数据喂给 B 类型的解析器**。

---

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
安全性实测：25 个真实 Spine 样本里**含 SkinnedMeshRenderer 的有 0 个**
  （含 MeshFilter 的 1 个是背景包）⇒ 加这条对现有 2D 判定**零影响**

工作量：判据约 3~10 行 + 受影响的两处文案/状态 + 一批回归样本（2D 不能回归成"模型包"）
```

### 4.3 仍需用户确认

| 待确认 | 为什么重要 |
|---|---|
| **另一类资源的 bundle 样本路径** | 现有工具目录里只有可执行文件与 UI 图片，**没有任何 .bundle/.dat/.ab**；`资源/` 与 `<下载目录>` 深度 4 也没搜到。**需要用户提供路径**，否则"BA mod 能不能解"无法回答 |
| 那类包是"判据误判"还是"真解不了" | 如果它也是 3D 资源 → 同一条判据缺口；如果是 2D 但用了别家格式 → 可能是解析缺口。**样本决定结论** |

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

## 六、遗留 / 需要用户确认

1. ~~"Node 解不了"的具体所指~~ **已澄清（用户指出）+ 已复现（§4.1）**：分类判据只认 2D。剩下的是**要不要现在改判据**。
2. **另一类资源的 bundle 样本**：现有工具目录里没有（只有可执行文件与 UI 图片），样本目录 与 `<下载目录>` 深度 4 也没搜到。**需要用户提供路径**，否则"BA mod 能不能解"无法回答。
3. **本轮没测"加密包"**：样本里没有 UnityCN/自定义 XOR 的包，这条能力边界（Node ❌ / UnityPy 部分）是**读代码+常识**得出的，未实测。
4. **没测大包**（>50MB）：25 个样本最大 3.5MB，Node 侧的内存/性能在大包上的表现未验证。
