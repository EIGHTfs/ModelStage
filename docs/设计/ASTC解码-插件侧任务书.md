# 任务 · 插件侧实现 ASTC 纹理解码

## 一、目标

让纹理为 **ASTC** 的容器能正常出画。当前这类包一律渲染失败：`没有成功加载任何贴图文件`。

**本任务只改插件与测试，本体（`src/`）零改动。**

## 二、现场实测（已查明，不用重查）

```
明日方舟资源根（工作区/资源/明日方舟，75 个 .ab）
  容器解析   68 / 70 可解析（2 个失败：LZHAM 压缩未支持）
  骨架/atlas 正常读出
  纹理解码   ASTC 失败 ⇒ 零贴图 ⇒ 渲染失败
  仅 6 个包不含 ASTC；其中 char_1012_skadi2.ab 实测出画（stageReady=1）

决定性样本 chararts/char_010_chen.ab：
  atlas 需要 char_010_chen.png      → 包内 char_010_chen      = format 34 (ETC_RGB4)  ✅ 可解
  atlas 需要 build_char_010_chen.png → 包内 build_char_010_chen = format 50 (ASTC_RGBA) ❌ 不解
  char_010_chen_2b                                            = format 49（表里没有）  ❌
```

## 三、要改的文件（已核实）

| # | 文件 | 性质 | 改什么 |
|---|---|---|---|
| 1 | `plugins/unity-spine-bundle/lib/astc.js` | 新增 | ASTC 解码器本体 |
| 2 | `plugins/unity-live2d-bundle/lib/astc.js` | 新增 | 与 1 **逐字节相同** |
| 3 | `plugins/unity-spine-bundle/lib/texdecode.js` | 改 3 处 | `FORMATS` 加条目（含块边长）/ `expectedSize()` 支持可变块边长 / `DECODERS` 注册 |
| 4 | `plugins/unity-live2d-bundle/lib/texdecode.js` | 改同上 | 逐字节同步 |
| 5 | `plugins/unity-spine-bundle/plugin.json` | 改 1 行 | `files[]` 加 `lib/astc.js` |
| 6 | `plugins/unity-live2d-bundle/plugin.json` | 改 1 行 | 同上 |
| 7 | `test/astc-decode.test.mjs` | 新增 | 解码器单测（含红绿自证） |
| 8 | parity 比对相关 | 可能要动 | 让新文件也纳入"两份必须逐字节相同"的比对 |

## 四、必须先解决的两个技术点

### 4.1 `expectedSize()` 把块边长写死成 4

```js
// plugins/unity-spine-bundle/lib/texdecode.js:45-52 现状
function expectedSize(fmt, width, height) {
  const f = FORMATS[fmt];
  if (f.size === 1) return width * height * f.block;
  const bw = Math.ceil(width / 4);      // ← 写死 4
  const bh = Math.ceil(height / 4);     // ← 写死 4
  return bw * bh * f.block;
}
```

ASTC 块尺寸有 4x4 / 5x5 / 6x6 / 8x8 / 10x10 / 12x12。按 4 算长度会**算错**，
表现为抛 `ULB_ERR_TEX_DATA_SHORT`（数据长度不足）而不是正常解码。

要求：`FORMATS` 条目带块边长（如 `bw: 6, bh: 6`，缺省 4），`expectedSize` 用它。
ETC/BC 全是 4x4 ⇒ 走默认值，**现有格式零回归**。

### 4.2 格式号必须先核实（第一步就做，不确定就停下报告）

```
项目内既有口径：ASTC(50) / PVRTC(49)   ← 见 plugins/unitypy-bundle/README.md、
                                        src/server/unpack/plugin-runner.mjs:160/366
但代码里 48 被当作 ETC2_RGBA1（texdecode.js:31 与 DECODERS:139）
Unity 官方 TextureFormat 枚举里 48~53 是 ASTC 系列（4x4..12x12）
```

要求：用权威来源核实（UnityPy 的 TextureFormat 定义 / UnityEditor 枚举导出），给出
`format 号 → 名称 → 块边长` 完整对照表，并用真实包交叉验证。
**48 到底是 ETC2_RGBA1 还是 ASTC_4x4，必须在报告里给结论。** 核实不了就停下报告，不要硬接。

## 五、解码器实现的两条路（选一条并说明理由）

```
A 纯 JS 移植（参考 astcenc 的解码部分，Apache-2.0）
  优点：零依赖、与现有 etc2.js / dxt.js 同构、浏览器与服务端都能跑
  代价：代码量大（约 1000 行）、需要测试向量

B WASM（astcenc / astc-decode 编译）
  优点：快、代码量小
  代价：.wasm 随插件目录分发；浏览器与服务端都要能加载；许可证要审
```

**建议先交"最小可用"**：只覆盖真实样本里出现的块尺寸（先查清楚是哪些），
其余块尺寸明确报"未支持"，不要硬编一个全尺寸表然后测不过来。

## 六、验收判据

```
A ASTC 包出画：明日方舟 char_010_chen.ab、char_003_kalts.ab（stageReady=1）
B 零回归：BD2 抽 2 个 ETC/RGBA32 包、NIKKE 或碧蓝档案抽 1 个，仍能出画
C parity：两份 texdecode.js 与两份 astc.js 逐字节相同（md5 一致）
D 未支持格式仍给可读错误（带格式名与格式号），不静默、不花屏
E 新增断言先造红：未接解码器时必须失败，接上后变绿（把红/绿两次输出贴进报告）
F 相关 node 套件绿（不要跑 --all / --browser，全量归 Lead）
```

## 七、纪律

```
1 只改插件与测试；**src/ 一个字都不改**（本体不认识 ASTC）
2 不改版本号（package.json 的 version 不动，升版由 Lead 统一决定）
3 不写死路径 / 包名 / 真实角色名进代码与测试
4 不设超时；解码是 CPU 任务，用耗时预算衡量
5 只用 edit（不许 sed）；改完 node --check
6 可本地 commit（精确 paths），**不许 push**
7 注释只写事实与结论，不写规则号与对话残留
8 报告只贴关键证据（红绿输出、md5、出画判据），不贴大段日志
```

## 八、交付报告要求

```
· 格式号对照表（含 48 的结论）
· 选 A 还是 B，为什么
· 改动的文件与行数
· A~F 逐条证据
· 遗留（未覆盖的块尺寸 / 未验证的模式）
```
