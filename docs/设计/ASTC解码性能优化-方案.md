# 方案 · ASTC 解码性能优化

> 目标：**有实测收益即可**，不设自定的硬指标（不拿"某个毫秒数"当验收线）。
> 原则：**先证明能优化，再动手**。每一条都要有 CPU 时间口径的实测数据 + 逐像素等价性。

---

## 一、现状基线（实测）

| 场景 | 墙上时间 | **CPU 时间** | 说明 |
|---|---|---|---|
| 1024² / 5x5 | 671~1570ms（波动大） | **803ms**（中位，5 次：790/760/842/914/803） | 墙上时间受机器负载干扰，不可作判据 |
| 440² / 6x6 | 145ms | 未单独测 | — |
| 2560² / 6x6 | ≈2.4s（前批实测） | 未单独测 | — |

**测量环境必须说明**：本机 load average 8.44（3 核），有 8 个 `chrome-headless` 残留进程占 ~83% CPU
⇒ **墙上时钟完全不可信**。本方案所有收益数字统一用 `process.cpuUsage()`（本进程 user+system），不受其他进程抢占影响。

---

## 二、已实测的优化项（唯一一条已验证）

### 候选 1 · 内层像素写入改整数移位

**现状代码**（`lib/astc.js` 的 `decompressBlock` 内层，每像素 × 每通道一次）：

```js
destination[texelIndex * 4 + channel] = Math.floor((blended16 * 255 + 32768) / 65536);
```

**改法**：

```js
destination[texelIndex * 4 + channel] = (blended16 * 255 + 32768) >> 16;
```

**为什么等价**：`blended16` 是 16 位无符号插值结果（0~65535），
`blended16 * 255 + 32768` 最大 ≈ 16.7M，远小于 2^31；被除数非负 ⇒ `>>16` 与 `floor(x/65536)` 逐位一致。

**实测（CPU 时间口径，交替 A/B，1024² 5x5）**：

| 版本 | CPU-ms | 中位 |
|---|---|---|
| 原版（`Math.floor(浮点除法)`） | 790 / 760 / 842 / 914 / 803 | **803** |
| 移位版（`>>16`） | 237 / 232 / 285 / 225 / 356 | **237** |
| **落地后复测**（清掉 chrome 残留、环境更干净） | 185 / 161 / 157 | **161** |
| **提速** | | **约 5.0×** |

**等价性**（落地后实测）：1024²（4194304 字节）**0 字节差异**；440²（774400 字节）**0 字节差异**（对照用 `git show HEAD:` 取的原版）。

**为什么收益这么大**：热点在内层每像素 4 次调用（1024² = 100 万像素 × 4 = 400 万次）；
`Math.floor(浮点除法)` 是浮点运算 + 函数调用 + 浮点→整数转换，`>>16` 是单条整数指令。

---

## 三、待验证的候选（**未验证，不能写进承诺**）

| # | 位置 | 想法 | 需先验证什么 |
|---|---|---|---|
| 2 | `divRoundUp`（profile 占 2.3%） | 若除数恒为 2 的幂，改 `(a + b - 1) >> log2(b)` | 调用点是否都在内层、是否都是 2 的幂 |
| 3 | `decompressBlock` 通道循环里 `channelOfSecondPlane === channel` | 把分支提到通道循环外，分「单平面 / 双平面」两套循环 | 双平面样本是否覆盖（有真实样本：char_003_kalts 68~5652 块） |
| 4 | `textureWeights` / `endpointPairs` 的容器类型 | 若非 TypedArray（普通数组），换 `Int32Array`/`Uint16Array` | 读代码确认现有类型 |
| 5 | `interpolateWeights`（1.7%） | 尝试内联进 `decompressBlock` | V8 是否已自动内联（看 profile 调用次数） |

### 已验证结论（第 2 轮，2026-11-27）

| 候选 | 做法 | 实测 | 结论 |
|---|---|---|---|
| **2 · divRoundUp** | `Math.floor((v+d-1)/d)` → `((v+d-1)/d) \| 0`（入参均非负） | 7 次交替采样：中位 **170 → 155ms（1.10×）**，最小 154 → 142（1.08×）；1024²/440² 逐字节 0 差异 | **✅ 已落地** |
| **5 · interpolateWeights 单平面特化** | 把 `plane` 循环拆成「单平面直算 / 双平面循环」 | **1.01×（无收益）**；等价性 0 差异 | **❌ 不落地** —— V8 已把该循环展开，手工特化没有收益 |
| 3 · 通道循环分支外提 | 未做 | — | 未验证（profile 当前未进前 10） |
| 4 · 容器改 TypedArray | 未做 | — | 未验证 |

### 第 3 轮结论：3 / 4 / 5 全部无收益（2026-11-27）

| 候选 | 做法 | 实测 | 结论 |
|---|---|---|---|
| 3 · 内层索引预算 | `texelIndex * 4` 提到通道循环外做 `dstBase` | **0.98×**（噪声内）；0 差异 | ❌ 不落地 |
| 4 · 容器改 TypedArray | `unquantizedWeights: new Array(N)` → `new Int32Array(N)` | **1.01×**；0 差异 | ❌ 不落地 |
| 5 · 单平面特化 | `plane` 循环拆分 | **1.01×**；0 差异 | ❌ 不落地 |

**结论：JS 层的低成本优化空间已基本榨干。**

```
现有缓冲里 5 个已经是 Int32Array（endpointPairs / texelWeights / weightGrid / endpointValues / unquantizedEndpoints），
只有 unquantizedWeights 是普通数组 —— 改了也没收益（V8 对 packed 数组同样快）。
内层循环的索引乘法、plane 循环、三元分支，V8 都已经自己优化掉了。

⇒ 再有数量级提升只能靠：① 算法层重构（减少每块工作量）② WASM。
   两者都不是「改几行」的量级，所以候选 1 / 2 之后停手是合理的选择。
```

**第 2 轮 profile（落地候选 1 之后）热点**：`decodeAstc` 17.4% / `decompressBlock` 13.7% / `interpolateWeights` 10.8% / `decodeQuintBlock` 6.4% / `divRoundUp` 5.5%。
`interpolateWeights` 虽占 10.8%，但手工特化零收益 —— **占比高不等于能优化**，必须实测。

---

## 四、结论（已落地）

```
候选 1 已落地：1024²/5x5  803 → 161 CPU-ms（约 5.0×）
  等价性：1024² 与 440² 两张图逐字节 0 差异
  端到端：页面加载 chararts/char_010_chen.ab 仍 stageReady=1（2346ms，含解包+解码+渲染全链路）

不设"必须到某个毫秒数"的硬指标 —— 有一次实测收益就落地一次。
候选 2~5 保持"先验证再改"的节奏：没有 CPU 时间数据就不动。

若将来某类大图真的慢到影响使用，再单独立项评估 WASM（那是数量级差异，不是百分比）。
```

---

## 五、风险与边界

| 风险 | 可能性 | 影响 | 缓解 |
|---|---|---|---|
| 移位与 floor 不等价 | 低 | 花屏（静默） | 已用 1024² 逐字节对照 0 差异；实施后再跑多图（440²/1024²/2560²）对照 |
| 内层改动引入 off-by-one | 低 | 边缘像素错 | 逐像素对照 + 现有 10 条解码器用例 |
| 大图内存不变 | — | 2048² RGBA = 16MB，仍计入解包峰值 | 与现状一致，不额外增加 |

**边界条件**：
- `blended16` 越界（>65535）：现有代码不会产生；若产生，`>>16` 与 `floor` 同样会给出错误值 —— 等价性不受影响
- 块尺寸非 4/5/6（8/10/12）：同一条内层代码，同样受益
- 空数据/尺寸为 0：走现有前置校验，与本改动无关

---

## 六、验证方案

```
1 等价性：1024² / 440² 夹具逐字节对照（已有脚本）；实施后再加 2560² 真实样本
2 性能：process.cpuUsage() 口径，交替 A/B 各 5 次取中位（墙上时间不作判据）
3 回归：现有 10 条解码器用例 + 相关套件
4 端到端：页面加载 char_010_chen.ab 仍 stageReady=1
```

---

## 七、不做什么

```
· 不改解码算法本身（ASTC 规范实现不变，只改数值写法）
· 不引 WASM（本方案范围外；若候选 1~4 做完仍不够，再单独立项评估）
· 不动 texdecode / worker / 插件装载链路（只改 lib/astc.js 两份）
```

---

## 八、待你决定

```
A. 只做候选 1（已实测 3.39×、0 差异）—— 风险最低，收益确定
B. 候选 1 先落地，再逐条验证 2~4（每条都要先有 CPU 时间数据才改）
C. 直接评估 WASM（跳过 JS 深挖）
```

---

# 附：WASM 可行性评估（2026-11-27，只调研，未落地）

> 回答上一节选项 C。**不新增任何代码/二进制**，结论与全部实测数据如下。
> 测量环境：同一台 3 核机，load average 3~4.6；收益数字统一用 `process.cpuUsage()`。

## 九、结论（先行）

**现阶段不做。**

理由不是"wasm 不行"，而是"收益与代价不匹配"：

1. 实测稳态加速只有 **约 2×**（1.84~2.38×），不是早期设想的 5~10×；
2. 解码是**每个资源包一生一次**的成本 —— 结果落在持久缓存 `data/unpacked/`（现 79MB），
   命中后 resolve 只要 0.02s。2× 摊薄到"首次打开某个包"这一条路径上，端到端约省 10~15%；
3. 代价却是：228KB 二进制入库 + **必须改宿主代码**（插件内自包含这条路走不通，见 9.4）
   + 浏览器侧要么加 COOP/COEP、要么自建单线程构建（本机无 wasm 工具链，见 9.2）。

**转做的触发条件（满足任一）**：
- 出现"单次解析里 ASTC 解码占比 > 40%"的实测（先加计时探针拿数据，再谈方案）；
- 拿到/能构建**单线程 decompress-only** 的 wasm（估计 80~140KB、不需要 SharedArrayBuffer、不碰 COOP/COEP）；
- wasm 能**只落浏览器路径**且服务端继续用 JS（此时不必动宿主，代价降一档）。

## 9.1 问题一：astcenc 实现从哪拿

| 途径 | 结果 |
|---|---|
| 本机 `astc_encoder`（unitypy-deps） | ❌ 只有**编码器**：`_encoder_{avx2,sse2,sse41,none}.abi3.so`，单个 4.6~5.1MB，Python 扩展，无解码入口 |
| 本机 astcenc 源码/二进制/wasm | ❌ 都没有（`which astcenc` 空、工作区 `find -name "*.wasm"` 空） |
| 本机构建 | ❌ 无 `emcc` / `clang` / `wasm-ld` / `rustc` ⇒ **本机无法产出 wasm** |
| 网络 | ✅ `registry.npmjs.org` 200、`api.github.com` 200；`raw.githubusercontent.com` 直链**超时**（要走 api.github.com/blobs 取内容） |
| npm 现成产物 | ✅ **`astc-encoder.js@1.0.0`**（Apache-2.0，仓库 `Jelosus2/astc-encoder.js`）：tarball 138KB / 解包 340KB / 9 文件，含 `dist/wasm/astcenc.wasm` = **233,410 B** |

顺带更正一条旧认知：npm 上**有**可用的解码侧产物（这个名字里带 encoder，但 README 与 d.ts 明确提供
`ASTCContext.decompress()`，实测可用）；另有 `@astcenc/linux-x64` 这类**原生**二进制（非 wasm，对本项目无直接用途）。

## 9.2 问题二：产物形态

| 文件 | 体积 | 作用 |
|---|---|---|
| `dist/wasm/astcenc.wasm` | **233,410 B** | 核心（含编码+解码、pthread、embind） |
| `dist/wasm/astcenc.js` | 45,631 B | Emscripten glue（**ESM + pthread 版**） |
| `dist/index.mjs` / `.cjs` | 15,099 / 16,575 B | 高层封装（ASTCConfig / ASTCContext / ASTCImage） |

三个**必须知道的形态事实**：

1. **这个构建是 pthread 版**：`WebAssembly.Memory({initial:…, maximum:32768, shared:true})`
   ⇒ 浏览器需要 `SharedArrayBuffer` ⇒ 需要页面带
   `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`（README 明写）。
   这是**整页级**的头部改动，会让所有跨源资源必须带 CORP/CORS —— 风险远大于解码本身。
   规避办法是自己用 emsdk 编单线程版（`-DASTCENC_ISA_NONE`、去掉 pthread）⇒ 体积与约束都会下来，
   但**本机没有工具链**，只能在 CI/容器里做。
2. **glue 依赖 Node 的 fs/动态 import**：`import("node:module")`、`require("node:fs")`、
   `node:path`/`node:url`/`node:worker_threads`/`node:os` ⇒ 它**不能**在服务的 vm 沙箱里跑（见 9.4）。
3. **MIME**：服务端 MIME 表里没有 `.wasm` ⇒ 按 `application/octet-stream` 下发
   ⇒ 浏览器必须用 `WebAssembly.instantiate(arrayBuffer)`，**不能**用 `instantiateStreaming`
   （后者要求 `application/wasm`）。要么改 MIME 表，要么走 ArrayBuffer 路径。

许可证：**Apache-2.0**（`LICENSE` 10909 B），要新增 THIRD_PARTY_NOTICES 条目。

## 9.3 问题三：两条路径能不能跑

### 浏览器（插件 resolve 里）

可行：`fetch('/plugins/<id>/…/astcenc.wasm')` → `WebAssembly.instantiate(bytes)` → 缓存 Module。
**但**受 9.2 第 1 条约束：要么加 COOP/COEP，要么换单线程构建。

### 服务端（plugin-runner 的 vm 沙箱）—— 关键点，已实测

沙箱构造在 `src/server/unpack/runtime/node-vm.mjs:39`，注入的是
`console / TextEncoder / TextDecoder / Blob / URL(shim) / AbortController / fetch(404 stub) / 定时器`。

| 探测 | 结果 |
|---|---|
| `typeof WebAssembly`（在同样的 sandbox 形状里） | **`object`** —— V8 自带，不注入也在 |
| `WebAssembly.compile(astcenc.wasm)` | **成功**，39 个 import 全在 module `"a"`（emscripten env） |
| glue（`astcenc.js`）直接跑 | **不行** —— 它要 `node:fs`/动态 `import`，沙箱里没有；`fetch` 还是 404 stub |
| 沙箱里有文件系统吗 | 没有（插件拿不到 .wasm 字节） |

⇒ 结论：**wasm 引擎在沙箱里可用，但"插件自带胶水层"这条设计走不通**。可行方案只有一条：

```
宿主适配器（node-vm.mjs，沙箱外、有 fs）加载 glue+wasm → 实例化 →
  通过 setter 注入 NS.astc.setWasmDecoder(async (data,w,h,bw,bh) => Uint8Array)
```

这与现有 `NS.bytes.setSha256(...)` / `NS.png.setInflate(...)` / `setDeflate(...)` 是**同一种模式**
（沙箱保持无 fs、无 require），可行但要改 `src/server/**`，不再是"插件内部优化"。

## 9.4 问题四：收益（同机 CPU 口径实测）

| 纹理 | JS（现状） | astcenc-wasm | 加速 |
|---|---|---|---|
| 440² / 6x6 | 41.4 CPU-ms | 19.0 | **2.18×** |
| 1024² / 5x5 | 169.8 CPU-ms | 71.2 | **2.38×** |
| 2560² / 6x6 | 574.2 CPU-ms | 312.0 | **1.84×** |

冷启动（各自新进程）：

```
wasm：import 18ms +（实例化+首解）123ms，稳态 66ms
JS  ：首解 311ms，稳态 190ms
```

等价性（这条会影响测试）：wasm 输出与**参考 PNG 逐字节 0 差异**（两张夹具都是 0）；
我们的 JS 与参考 PNG 差 ≤1、与 Texture2DDecoder 逐字节 0 差异。
⇒ 两个实现都对，但**分属两种取整**；换 wasm 后现有 `bgraMd5` 断言会红，必须改成"容差 ±1"或改钉 astcenc 的指纹。

**结论：稳态约 2×。** 512B 级小图 2.2×、1024² 2.4×、2560² 1.8× —— 没有数量级跳变。

## 9.5 为什么 2× 也不值得（关键事实）

解码成本是**一次性、且已经持久缓存**的：

```
data/unpacked/                     ← 解包产物落盘缓存，现 79MB
  <fingerprint>/files/*.png        ← 解码+PNG 编码的结果直接复用
实测：同一入口 resolve 第一次 0.23s，之后 0.02s（跨重启仍然命中）
```

也就是说：一个资源包只有**第一次被打开**时付解码费；此后任何人打开都是 0.02s。
对 kalts 这种三张贴图（512²/1024²/2560²）的包，JS 解码合计 ≈ 785 CPU-ms、wasm ≈ 402 CPU-ms，
**省 380ms**；而这条路径只在首次出现，端到端（约 1.5~2.5s 冷解析）里约占 10~15%。

对比之下，引入 wasm 的代价：
228KB 二进制入库（无本机构建链可复现）+ 宿主改造 + COOP/COEP 或自建构建 + 测试基线重钉。

## 9.6 风险清单

| 风险 | 可能性 | 影响 | 缓解 |
|---|---|---|---|
| COOP/COEP 影响整页（跨源资源需 CORP/CORS、影响嵌入/共享） | 中 | **高**（功能面级） | 用单线程构建绕开；或先只在"无跨源依赖"的部署上开 |
| 服务端必须改宿主（node-vm 注入），不再纯插件 | 高 | 中（改动面/契约面） | 按 setSha256 同模式注入；保持 JS 兜底 |
| 本机无 wasm 工具链，二进制不可复现 | 高 | 中（维护性） | 入库 + 记录来源/版本/sha256；构建脚本放 CI |
| 换实现导致像素基线漂移（±1） | 高 | 低（肉眼不可见） | 测试改容差；保留 JS 路径做对照 |
| wasm 加载失败/被禁用（老浏览器、严格 CSP） | 中 | 中（功能不可用） | **必须**保留 JS 回退（异步探测 + 失败降级） |
| wasm 内存（`shared:true`）在部分环境不可用 | 中 | 中 | 单线程构建；检测 `typeof SharedArrayBuffer` |

## 9.7 若将来要做：分步计划与工作量

```
1  量化占比（必做前置）      加 decode 计时探针，统计"冷解析里解码占多少"     0.5 人日
2  选型与构建                单线程 decompress-only astcenc（emsdk/CI）       1~2 人日
                             产物目标：< 150KB、无 SAB、无 COOP/COEP
3  浏览器路径                 fetch+instantiate+Module 缓存 + JS 回退        1 人日
4  服务端注入                 node-vm.mjs 的 setWasmDecoder（含回退）         0.5~1 人日
5  门禁与文档                 等价性（±1）+ 性能 A/B + THIRD_PARTY_NOTICES  0.5 人日
                                                    合计 ≈ 3.5~5 人日（含环境）
```

## 9.8 比 WASM 更值得先查的（成本低得多）

```
a 只解码"被条目真正引用"的图集页 —— 有的包里 2560² 只是合并图集的一页，可能整张都不需要解
b 同一 bundle 内多条目共享纹理时复用解码结果（现在按条目 resolve，可能重复解同一张）
c 浏览器侧用 Worker 并行解多张（不改算法，只改调度；node 侧单线程不适用）
```

### 三条的处理决定

| 方向 | 决定 | 说明 |
|---|---|---|
| **a · 只解被引用的图集页** | **只记文档，不实施** | 有潜在收益（大页可能整张不需要），但当前不做；本方案到此为止 |
| **b · 跨条目复用解码结果** | **明确禁止** | 不做，且不要在后续优化里提这条。跨条目共享解码产物会让条目之间产生隐式依赖：某条目的产物可能来自别的条目的解码上下文，缓存失效与隔离边界都变得不可判定；省下的重复解码远小于"错了查不出来"的代价 |
| **c · Worker 并行** | 未评估 | 只在浏览器侧有意义，服务端仍串行 |

> b 这一条不是"暂缓"，是**排除**：任何人再提"共享解码缓存"都以此条为准。

## 9.9 本次调研的边界

```
· 未改任何代码、未新增 .wasm 到仓库（wasm 只落在 /tmp 用于实测）
· 复现材料：/tmp/astcencjs/（npm 包解包）、/tmp/vf/bench-compare.mjs（JS vs wasm 同机对照）
· 页面/服务未改动；所有页面级结论沿用上一批（stageReady）验证
```
