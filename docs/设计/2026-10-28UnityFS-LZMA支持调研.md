# UnityFS LZMA 支持调研（取证 + 解码器选型）

> 目的：搞清楚 64 个打不开的包到底卡在哪、LZMA 是哪一种、能不能用现成库。
> **本轮只调研，未改任何代码**；样本只读，临时文件全在 `/tmp`。
> 口径：插件按独立项目对待，可引 npm 依赖 / vendor 浏览器构建（不必自写解码器）。

## 一、64 个失败包按阶段分组（实测）

扫全部真实容器（`azurlane_bundle` 94 个 + `nikke_2` 29 个，共 123 个，走生产路径 `probeBundleBytes`）：

| 阶段 | 包数 | dataflags 压缩类型 | 原始错误码 | 代表样本 |
|---|---|---|---|---|
| A. 读头 / 容器头解析失败 | **0** | — | — | — |
| **B. blocksInfo 解压失败** | **4** | **LZMA**（flags=0xc1，csz=74~75，usz=91） | `ULB_ERR_CONTAINER_PARSE` | `live2d/longfeng_2`、`shengluyisi_3`、`wuqi_2`、`yichui_2` |
| **C. block 数据解压失败** | **57** | blocksInfo 用 **LZ4HC×50 / LZ4×1 / none×6**，但 **block 的 flags 全是 LZMA** | `ULB_ERR_CONTAINER_PARSE` | `live2d/aierdeliqi_5`、`ailunsamuna_2`、`aimierbeierding_2` |
| **D. 节点表越界** | **3** | **none**（flags=0x40，version=6，Unity 2017.4.28f1，csz==usz=91） | `ULB_ERR_CONTAINER_PARSE` | `live2d/aidang_2`、`banrenma_2`、`xianghe_2` |
| 合计失败 | **64** | | | |

### 结论：只补 LZMA 能救回 **61 个**（61/64 = 95.3%）

```
B 组 4 + C 组 57 = 61 个   ← 补 LZMA 后可直接打开
D 组 3 个                  ← 与 LZMA 无关，补了也打不开
```

### ⚠️ 纠正一处此前的推断

派单里怀疑「D 组 3 个越界是 blocksInfo 被 LZMA 压过、按明文解析读坏 ⇒ 与 B/C 同源」。
**实测不成立**：这 3 个包的 `dataflags` 压缩类型是 **none**（`0x40`，只置了 `BlocksAndDirectoryInfoCombined`），
且 `csz == usz == 91`（blocksInfo 就是未压缩的 91 字节）。它们共同特征是 **version 6 / Unity 2017.4.28f1**，
`offset=3` 更像是 version 6 的 blocksInfo 布局与我方 `readBlocksInfo` 的差异（另一处独立缺陷）。

### 顺带一个结构性发现：**Unity 允许 blocksInfo 与 block 用不同压缩**

C 组 57 个包里，`dataflags` 显示 blocksInfo 是 LZ4HC（50 个）/ LZ4（1 个）/ none（6 个），
但每个 block 的 `flags` 都是 LZMA。
⇒ 实现时**必须按 block 自己的 flags 判压缩类型**，不能只看 `dataflags`（现有代码已经是这样，这点没问题，但值得写进注释防回归）。

## 二、LZMA 变体：**5 字节 props + raw LZMA1 流**（无 8 字节长度）

这一步用真实样本取证（`python3 -c` 的 `lzma` 模块），三种格式全试过：

```
样本 live2d/longfeng_2  blocksInfo 段（文件尾 75B，声明解压 91B）
  段前 16 字节: 5d 00 00 08 00 00 00 6d fe 49 00 32 48 e7 40 bc

  props 解析（5 字节）: lc=3 lp=0 pb=2 dictSize=524288（512KB）
  ❌ FORMAT_ALONE（.lzma 容器，期望 13 字节头）→ Corrupt input data
  ❌ FORMAT_XZ（xz/LZMA2 容器）                 → Input format not supported
  ❌ FORMAT_RAW 但跳过 13 字节                  → Corrupt input data
  ✅ FORMAT_RAW + 跳过 **5** 字节（只有 props）  → 解出 91B，长度 == 声明 ✅
```

⇒ **UnityFS 的 LZMA 块 = `[5 字节 props][raw LZMA1 流]`，没有 `.lzma` alone 那 8 字节未压缩长度**
（长度从容器头/块表已知：blocksInfo 用头的 `usz`，block 用 `block.uncompressedSize`）。

4 个 B 组样本的 props **完全一致**：`5d 00 00 08 00`（lc=3 / lp=0 / pb=2 / dict=512KB），即 LZMA 标准默认值。

### 关键技巧（它让选型极大简化）

既然 Unity 的头就是 `.lzma` alone 头的前 5 字节、缺的只是 8 字节长度，
**我们自己把那 8 字节拼上去**（用已知的 uncompressedSize，小端），就能喂给**任何支持标准 `.lzma` 的解码器**：

```js
// 5 props + 8 字节 size(LE) + raw 数据
const alone = new Uint8Array(13 + blob.length - 5);
alone.set(blob.subarray(0, 5), 0);
new DataView(alone.buffer).setBigUint64(5, BigInt(uncompressedSize), true);
alone.set(blob.subarray(5), 13);
```

**实测验证（4 + 2 全部通过）**：

```
B 组 blocksInfo（4/4）: 91B == 声明 ✅（hash 16B 全 0 + blockCount=1 + us/cs/flags，内容合理）
C 组 block 数据（2/2）:
  aierdeliqi_5   2213793B → 8677760B == 声明 ✅  尾部可见 "2017"（Unity 版本串）
  ailunsamuna_2  2055974B → 6506999B == 声明 ✅  尾部可见 "2018"
```

## 三、解码器选型

| 候选 | 支持 raw/alone + 自定义 props | IIFE/UMD 浏览器构建 | 体积 | 依赖链 | 许可 | vm 沙箱（classic script）实测 |
|---|---|---|---|---|---|---|
| **`lzma` 2.3.2**（nmrugg） | ✅ 标准 `.lzma` alone（用 §二 拼头技巧即可，无需 raw API） | ✅ **有现成 IIFE**：`src/lzma-d.js`（32K）/ **`src/lzma-d-min.js`（6956B）**，`var LZMA=(function(){…}()); this.LZMA=this.LZMA_WORKER=LZMA;`，**0 处 require/module.exports** | **6956B**（min） | **0** | MIT（需保留版权声明） | ✅ **全部样本通过**（4 blocksInfo + 2 block） |
| `xz-decompress` 0.2.3 | 待定 | `dist/package/xz-decompress.min.js`（20K）单文件 | 20K | 0 | MIT | ❌ **内含 WebAssembly 引用**（基于 xzwasm），不是纯 JS ⇒ 与 classic script + 零构建冲突 |
| `lzma-purejs` 0.9.3 | 待定 | ❌ `lib/` 多文件 **CommonJS**（需 require） | 708K | **amdefine + commander** | BSD | ❌ 需 `require`，classic script 用不了；且依赖链会把 commander 拖进来 |

### 推荐：**`lzma@2.3.2` 的 `src/lzma-d-min.js`（6956B）vendor 进 `lib/`**

理由（全部实测支撑）：
- 现成 IIFE，`this.LZMA = …` 挂全局 ⇒ **按 `plugin.json` 的 `files[]` 加载即可**，无需 bundler、不破坏"插件零构建"惯例
- 6956B 单文件、**零依赖**、MIT
- 已在 vm 沙箱（无 require/module）里实测解出全部 6 个真样本
- 只需 `decompress` 一个 API（`LZMA` 对象上实测只有 `decompress` 一个键）

## 四、最小实现路径

```
改 1 处（unityfs.js，两个插件各一份、需同步）：
  decompress(bytes, uncompressedSize, flags, where, target, targetOffset)
    现有：none → 直通 / LZ4|LZ4HC → lz4Decompress / 其余 → 抛错
    新增：LZMA 分支
      · 拼 13 字节头（§二 技巧）→ LZMA.decompress(...)
      · 返回值是**普通 Array**（跨 realm 且非 Uint8Array）⇒ 需转 Uint8Array
      · **必须自己校验 out.length === uncompressedSize**，不符则抛错
        （实测：size 给错时解码器**不报错**，静默解出截断数据 —— 见 §五风险 3）
      · 有 target 时写入 target 区间（与 lz4Decompress 同签名）

两处自动受益（同一个 decompress）：
  · readHeader() 里解 blocksInfo  → 救 B 组 4 个
  · parse() 里解 block 数据        → 救 C 组 57 个

错误码：现有"尚未支持该分支"文案不再出现；建议新增 ULB_ERR_LZMA_FAIL（解压失败/长度不符），
        与 ULB_ERR_CONTAINER_PARSE 区分开，便于排障时一眼看出是压缩层问题。
```

### fixture 方案（样本不入库，只记指纹）

```
样本 1（B 组，blocksInfo LZMA）  资源根 azurlane_bundle 下 live2d/longfeng_2
  文件 2757749B  sha256=f09cfeaa128b884d9193df38c2389d29a13136a55c65f4a02c71d45c4aa23a47
  头 flags=0xc1 csz=75 usz=91
  期望 blocksInfo 解压 91B  sha256=a1d8ed8d55f24a5995077fae2153edc8eb92c129c21c12b94b2d1bd43c607f02
  （前 32B: 00000000000000000000000000000000 00000001 00a4476b 002a13f8 0001 …）

样本 2（C 组，block LZMA）      资源根 azurlane_bundle 下 live2d/aierdeliqi_5
  文件 2213909B  sha256=ab8d0f192abfa7096c53d2ff67c2833671eee9f1d5b6ab0f6d050581f6978117
  头 flags=0x43（blocksInfo=LZ4HC）csz=66 usz=91；block[0] us=8677760 cs=2213793
  期望 block[0] 解压 8677760B  sha256=1b78de4e343f433551ea0558be3370674214130d97f310dbb7f0f399f9d24ff9
```

## 五、风险（都有实测数字）

**1. 性能：比 LZ4 慢 20~30 倍，且是同步阻塞**

```
LZMA：2.21MB → 8.68MB  耗时 3594ms（min 版 3515ms）
对照 LZ4：42MB  → 42MB  约 150ms（历史实测，量级对比用）
⇒ 单个 LZMA 包解压要 3.5~4.4 秒
```

**2. 内存：解 8.68MB 数据吃掉 ~241MB 堆（28 倍膨胀）**

```
实测 aierdeliqi_5：rss +344MB，heapUsed +241MB
原因：LZMA.decompress 返回**普通 Array**（8677760 个元素，V8 里 double array 约 8B/元素 ≈ 69MB），
      再 Uint8Array.from 复制一份 ⇒ 两份 + 解压内部缓冲
影响：插件的 estimateMemory 需要为 LZMA 包单独放宽峰值，否则会被内存准入直接拒掉
```

**3. 解码器不校验长度（必须自己校验）**

实测：把 `uncompressedSize` 传成 93（错值）时，`LZMA.decompress` **不报错**，静默解出 93B 就返回。
⇒ 实现里必须 `if (out.length !== uncompressedSize) throw`，否则会产出截断数据被下游当"模型损坏"。

**4. 浏览器侧：必须放 worker，不能同步解**

3.5~4.4 秒的同步解压放在主线程 = 页面完全卡死。
建议：浏览器侧走 worker（`lzma_worker.js` 正是为此设计的，nmrugg 包里就有），
或至少按块分片 + 让出主线程；服务端（node）侧可同步（现有 `plugin-runner` 已是串行队列）。

**5. 两份副本同步**：`unityfs.js` 在 live2d 与 spine 两个插件各一份（当前逐字节相同），改完必须 md5 一致。

## 六、对"要不要做"的一句话判断

```
收益：64 个失败包里的 61 个（95%）从"完全打不开"变成"可开"
代价：vendor 6956B 单文件（MIT，零依赖、现成 IIFE、无需构建）+ 约 30 行改动
      + 每包 3.5~4.4s 解压 + 约 241MB 峰值内存 + 浏览器侧需 worker
结论：值得做，但**必须**和「worker / 内存准入放宽」一起做，否则会从"打不开"变成"卡死"。
      剩余 3 个 version 6 越界包是另一个独立缺陷，不在本轮范围。
```
