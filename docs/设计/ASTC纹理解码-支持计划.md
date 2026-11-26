# 计划 · ASTC 纹理解码支持

> 目标：让纹理为 **ASTC** 的容器能正常出画（当前一律渲染失败：没有成功加载任何贴图文件）。
> 本文件只定方案与步骤，不含代码改动。

---

## 一、问题（实测）

### 1.1 现场

明日方舟资源根（75 个 `.ab`，942MB）里，绝大多数点开出不来：

```
渲染失败：加载失败：没有成功加载任何贴图文件，无法渲染模型
```

### 1.2 三层实测结果

| 层 | 结果 |
|---|---|
| 容器解析 | **68 / 70 可解析**（2 个失败：`block[0] 使用 LZHAM 压缩，本插件尚未支持该分支`） |
| 骨架 / atlas | 正常读出（`char_010_chen.skel` / `.atlas` 等） |
| **纹理解码** | **失败** —— 关键纹理是 ASTC |

### 1.3 决定性证据（`chararts/char_010_chen.ab`）

atlas 引用的页名与包内纹理对照：

| atlas 引用的页 | 包内对应纹理 | format | 能否解码 |
|---|---|---|---|
| `char_010_chen.png` | `char_010_chen` ×2 | **34 ETC_RGB4** | ✅ |
| `build_char_010_chen.png` | `build_char_010_chen` | **50 ASTC_RGBA** | ❌ |
| — | `char_010_chen_2b` | 49（未知） | ❌ |

**每个包里通常有两套**：`char_xxx`（ETC / RGBA32，能解）与 `build_char_xxx`（ASTC，解不开）。
插件若选中 `build_` 那套，就得到"零贴图"。

### 1.4 只有 6 个包不含 ASTC

```
char_1012_skadi2.ab（9 纹理）    ← 实测出画（stageReady=1）
char_1019_siege2.ab（7 纹理）
char_003_kalts_boc#6.ab（23 纹理）
char_1012_skadi2_2.ab（13 纹理）
char_1014_nearl2_2.ab（32 纹理）
char_1023_ghost2_2.ab（31 纹理）
```

⇒ 剩下 64 个包要出画，**只能靠 ASTC 解码**（或改选 `char_` 那套，见 §六 备选）。

---

## 二、现状（代码级）

### 2.1 解码器是插拔式，接入点很小

```
plugins/unity-{spine,live2d}-bundle/lib/texdecode.js   190 行
  · FORMATS 表：format 号 → { name, block, size, compress }
  · DECODERS 表：format 号 → (data, w, h) => RGBA
  · decode()：查表 → 分发解码器 → 失败抛 ULB_ERR_TEX_FORMAT_UNSUPPORTED / ULB_ERR_TEX_DECODE
独立解码器模块：lib/etc2.js、lib/dxt.js
```

⇒ 新增 ASTC 只需 **3 处**：`lib/astc.js`（解码器本体）+ FORMATS 加条目 + DECODERS 注册。

### 2.2 已实现 / 未实现

```
已实现：ETC_RGB4(34) / ETC2_RGB(45) / ETC2_RGBA8(47) / ETC2_RGBA1(48)
        BC1(10) / BC3(12) / BC4(26) / BC5(27) / 未压缩（RGBA32 等直通）
未实现：ASTC(50 等) / PVRTC(49 等)
```

未实现时**抛可读错误**（带格式名与格式号），不静默 —— 这条要保留。

### 2.3 两条解包通路共用同一份实现

```
浏览器本地解包（plugin-host-unpack）与服务端解包（plugin-runner）
⇒ 都用 plugins/*/lib/texdecode.js，且两份 texdecode.js 必须逐字节相同（已有 parity 用例）
⇒ 改动必须同时改两份，否则 parity 用例会红
```

---

## 三、ASTC 是什么（决定工作量的关键）

```
块压缩：每个 block 固定 128 bit（16 字节），块尺寸可变：4×4 / 5×5 / 6×6 / 8×8 / 10×10 / 12×12
一个 block 内编码：权重网格（2~12 个权重点）+ 颜色端点（LDR/HDR 两种模式）
                                                    + 可选第二平面（双平面模式，用于法线/双通道）
解码需要：块模式解析 → 权重插值 → 端点插值 → 通道映射 → 输出 RGBA
```

**规模**：完整 ASTC 解码器参考实现（astcenc 的 `astc_decompress` 部分）约 1000~1500 行 C，
JS 移植后代码量相当。**不是"顺手补 50 行"那一档**。

---

## 四、方案选项

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A 纯 JS 解码器**（插件自带） | 移植 astcenc 解码部分到 `lib/astc.js` | 零依赖、与现有 etc2/dxt 同构、浏览器与服务端都能跑 | 代码量大（1000+ 行）、需要大量测试向量、性能中等 |
| **B WASM 解码器**（插件自带 .wasm） | 用 astcenc/astc-decode 编译 wasm，随插件分发 | 快、代码量小（只需胶水层） | 需构建产物入库或随包分发；浏览器与服务端都要能加载 wasm；许可证要审 |
| **C GPU 侧直接采样** | 用 `WEBGL_compressed_texture_astc` 扩展把原始块直接喂给 WebGL | 零解码成本 | 现架构是"CPU 解码成 RGBA → 编 PNG → VirtualFS"；改这条路要改渲染链路，影响面远大于解码器 |
| **D 只服务端解码** | 服务端用 WASM 解码 | 改动小 | 浏览器本地解包仍失败；且与"两条通路共用一份实现"的约定冲突 |

**倾向：A 或 B，且必须落在插件内**（契约 §2.4 允许插件带依赖；主项目零依赖红线不受影响）。
C 会动渲染链路，不在本计划范围。

---

## 五、分步计划

### T1 · 核实格式号（先做，不确定就停）

```
现状：项目内既有口径是 ASTC(50) / PVRTC(49)，见
     plugins/unitypy-bundle/README.md、src/server/unpack/plugin-runner.mjs:160/366
但 Unity 官方 TextureFormat 枚举里 48~53 是 ASTC 系列（4x4..12x12），
而本项目把 48 当作 ETC2_RGBA1（plugins/unity-spine-bundle/lib/texdecode.js:31、DECODERS:139）

⇒ 必须用**权威来源**核实一遍：UnityPy 的 TextureFormat、或 UnityEditor 枚举导出。
判据：给出 format 号 → 名称 → 块尺寸的完整对照表，并与 3 个真实包实测交叉验证。
冲突点（48 是 ETC2_RGBA1 还是 ASTC_4x4）必须在表里写清结论。
```

### T2 · 选解码器来源 + 许可证审查

```
A（JS 自研/移植）：确认参考实现许可证（astcenc 是 Apache-2.0，可移植但要保留声明）
B（WASM）：确认产物许可证与分发方式（.wasm 随插件目录，不进主项目 files[]）
产物：一份"来源 + 许可证 + 分发位置"的记录
```

### T3 · 实现解码器 + 单元测试

```
· lib/astc.js：decodeAstc(data, width, height, blockW, blockH) => Uint8Array RGBA
· 单元测试必须能自证红：先造"未实现时抛错"的用例，再接实现
· 测试向量来源优先级：官方 astcenc 测试图 → 自己用 astcenc 编码生成 → 手工构造块
· 覆盖块尺寸：4x4 / 5x5 / 6x6 / 8x8（明日方舟实测只用其中几种，但表要全）
· 覆盖模式：LDR 单平面、双平面；HDR 若不在样本里，明确标注"未验证/不支持"
```

### T4 · 接入 texdecode（3 处）

```
① FORMATS 加 ASTC 系列条目（block=16，size 按块边长）
② DECODERS 注册到 NS.astc.decode*
③ 两个插件（unity-spine-bundle / unity-live2d-bundle）各改一份，保持逐字节相同
报错路径保留：仍未支持的格式继续抛 ULB_ERR_TEX_FORMAT_UNSUPPORTED（带格式名+号）
```

### T5 · 真实包验证

```
· 明日方舟：char_010_chen / char_003_kalts / char_1001_amiya2*（ASTC 包）→ 出画
· 回归：BD2 的 ETC/RGBA32 包、NIKKE、碧蓝档案 的既有包零变化
· 两个 LZHAM 包：仍应报"LZHAM 未支持"，不能变成别的错误
```

### T6 · 性能与内存预算

```
· 单张 2048×2048 ASTC 解码耗时（目标：< 300ms）
· 峰值内存：解码后 RGBA = w×h×4（2048² = 16MB），要计入解包峰值预算
· 大包（30MB / 多张 2048²）：给出实测，若超预算按契约 §2.2 由插件声明 peakBytes
```

---

## 六、备选（不替代 B，但可作为过渡）

```
让 resolve 优先选"贴图格式受支持"的那套骨架/atlas（跳过 build_ 前缀那套）。
· 改动小，能让一部分包立刻出画
· 但治标：只对"包里同时有两种格式"的有效；纯 ASTC 包仍然失败
· 与 B 不冲突，可先做再等 B
```

---

## 七、验收判据

```
1 明日方舟 ASTC 包出画（至少 char_010_chen、char_003_kalts 两个）
2 现有 ETC/BC/未压缩包零回归（BD2 / NIKKE / 碧蓝档案 抽 3 个包出画）
3 两份 texdecode.js 逐字节相同（parity 用例绿）
4 未支持的格式仍给可读错误（不静默、不花屏）
5 新增断言先造红（未接解码器时必须失败）
6 性能：单张 2048² < 300ms；解包峰值不超既有预算
```

---

## 八、风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| **格式号映射本身可能有错** | 项目把 48 当 ETC2_RGBA1，与 Unity 官方枚举可能冲突 | T1 先核实；若确属错映射，单独修并加断言 |
| ASTC 变体多 | 块尺寸 6 种 × LDR/HDR × 单/双平面 | 按真实样本覆盖，未覆盖的明确报"未支持" |
| 解码正确性难验证 | 错一个位序就花屏，且不易察觉 | 用官方测试向量 + 与参考实现逐字节比对 |
| 代码量 | JS 解码器 1000+ 行 | 优先评估 WASM 方案 B |
| 性能 | 大纹理解码可能几百 ms | T6 实测；超预算考虑分帧或 WASM |

---

## 九、明确不做

```
· 不做 GPU 侧 ASTC 直采（方案 C，动渲染链路）
· 不做 PVRTC 解码（另一套格式，且当前样本里没有）
· 不为 ASTC 引入主项目依赖（解码器留在插件内）
· 不设解码超时（CPU 密集任务用耗时预算衡量，不用超时兜底）
```

---

## 十、与既有约定的关系

```
· 插件与本体解耦：本体不认识 ASTC；格式表与解码器都在插件 lib 内
· 零依赖：主项目不引第三方；插件按独立项目对待（契约 §2.4，可带依赖但版本精确）
· parity：两份 texdecode.js 必须逐字节相同（已有用例钉住）
· 可读错误：不支持格式必须抛带格式名与号的错误，不许静默或花屏
```

---

## 十一、后续优化清单（实施后实测遗留）

| # | 项 | 现状 | 建议 |
|---|---|---|---|
| 1 | **ASTC 解码性能** | 440²/6x6 ≈136~230ms；1024²/5x5 ≈449~572ms；**2560²/6x6 ≈2.4s**（T6 目标 2048² < 300ms） | 已做过一轮 profile 优化（取位降到不足一成、块模式与 ISE 参数缓存、临时缓冲复用），吞吐约 2×；再往下需重写 ISE 热循环（去掉全部函数调用）或改 WASM |
| 2 | 产物文件数 | 当前 8 文件/包（6 文本 + 1 贴图 + entry），每包多存约 300KB | 可改「只存选中那套 + entry 带 pathID」降为 4 文件；entry 仍可自证 |
| 3 | live2d 侧同名资源 | 已加冲突检测（同名不同内容抛 `ULB_ERR_MODEL_BUILD`），但抽查 19 个包**无命中** | 真实样本缺失，等遇到再验；已加「files.set 只许 1 处」源码契约断言防未来绕过 |
| 4 | ~~`chararts/char_003_kalts.ab` 未进角色树~~ **已查清：不是缺陷** | 4 个变体都在列表里（实测 `variantRows: 4`）。真正原因是 `displayName` 把文件名替换成了骨架名：<br>`chararts/char_003_kalts.ab` → 显示为 `build_char_003_kalts`<br>`skinpack/char_003_kalts.ab` → 显示为 `build_char_003_kalts_boc#6`<br>⇒ 按文件名找就找不到。搜索仍能命中（搜 `char_003_kalts` 返回 4 行） | 不改。这是 `displayName` 设计意图（显示可读名而非文件名）的预期结果。<br>若要"按文件名回溯"，可在变体行加 tooltip/灰色小字；本条留作已知行为记录 |
| 5 | 格式表测试覆盖 | 46/48/49/50 有真实样本交叉验证；51~59（8x8/10x10/12x12、ASTC_RGBA 系列）**只有公式，无样本** | 遇到对应块尺寸的包时补样本验证 |
