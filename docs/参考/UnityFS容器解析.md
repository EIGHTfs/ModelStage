# 参考 · UnityFS 容器解析

外部权威实现的**来源与结论**（只落结论，不落源码），用于给本项目的解析/渲染实现提供依据。

**为什么不把上游源码放进仓库**：第三方源码有体积与许可证问题，且本仓库需要的是"依据哪条逻辑、得出什么结论"，
而不是一份会随上游漂移的副本。所以本目录只写**可直接对照实现的结论**，源码本身按需临时获取。

---

## 1. UnityPy / AssetStudio —— UnityFS 容器解析

**来源**：AssetStudio（Perfare）的 `BundleFile.cs`，方法 `ReadBlocksInfoAndDirectory` / `ReadBlocksInfo`，commit `d158e86`。

**结论一：`ArchiveFlags.BlocksAndDirectoryInfoCombined = 0x40` 不参与解析判断**

该位在枚举里名义上表示"blocks 与 directoryInfo 合并为一段"，但在上述实现的判断链里**从未被读取**，
实际只按 `0x80`（`BlockInfoAtEnd`）区分两种布局。因此**不能**拿 `0x40` 置位作为"不支持该布局"的依据。

> 实测教训：正常样本 `dataflags = 0x240`，而 `0x240 & 0x40 = 0x40` 为真 —— 一旦按 `0x40` 拒绝，
> 会把**全部正常包**一起拒掉（19/19 全红）。名义语义与实现语义不一致时，以实现的判断链为准。

**结论二：`blocksInfo` 有两种布局，数据区起点算法不同**

```
若 (flags & 0x80) == 0        // blocksInfo 内联在 header 里
    position = blocksInfoStart + blocksInfoCompressedSize   // 该段按"声明长度"占位，
                                                            // 声明长度可能大于表内容长度，
                                                            // 差额是表尾对齐填充，必须跳过
否则                          // blocksInfo 在文件尾
    position = 读完 header 之后的位置                        // 数据块紧接 header 开始，
                                                            // 不能再加 compressedSize
```

关键是：读文件尾的 blocksInfo 之前要**保存当前 position**，读完后**seek 回保存值**，
回来后那个位置就是 header 结束、数据块开始的位置。

> 实测教训（`aijier_3`，Unity 2018.4 / version 6 / LZ4 / `dataflags 0xC2`）：
> 早期实现只有「内联头部」一套逻辑，对"在文件尾"的包也算 `blocksInfoStart + compressedSize`，
> 把数据起点整体推后 `compressedSize`（本样本 101 字节）→ 数据块错位 → LZ4 解出垃圾
> → 报「LZ4 数据损坏：匹配位置越界」。**报错位置与真实根因相距极远**。

**结论三：LZ4 块解压的自洽检查很弱**

块解压通常只校验"输出长度 == expectedSize"。错位数据**可能恰好自洽解出**（本样本解出 163 字节，
但其中的 `blockCount` / `nodeCount` 是垃圾值），错误会一路带到后续结构读取才爆。
所以拿到"解压成功"不能当作"偏移正确"的证据 —— 必须用**结构自洽**（各段长度相加等于段起点、
`bundleSize` 等于实际文件长度等）交叉验证。

---

## 2. 多插件并存：「说能解」不等于「解出来能用」

同一个 UnityFS 包会被多个 bundle 插件同时判成"我能处理"——它们的判定只看包结构（压缩块、资源表），
**不看解出来的东西是否自洽**。所以"第一个返回成功的候选"这条策略是错的。

实测样本（NIKKE 的 spine 资源包 `c810_00_aim_假面紫罗兰_2B`，UnityFS 5.x）：

| | 前端 `unity-live2d-bundle` | 前端 `unity-spine-bundle` | 服务端（同一个包） |
|---|---|---|---|
| 判定 | 抢先返回 ok（**错**） | 能正确解 | 选中 spine 插件 |
| 入口 | `model3.json` | `entry.json` | `entry.json` |
| 产物 | 3 个文件 | skel + atlas + png + entry.json | 同左 |

Live2D 那份产物**看起来完全合法**：`model3.json` 是结构正确的 JSON（`{"Version":3,"FileReferences":{...}}`）、
纹理 683609 字节是真 PNG。但它的 `FileReferences.Moc` 指向 `moc3.moc3`，而该文件内容只有 4 字节、
字面量是字符串 `null` —— 包里根本没有 moc3，纹理还是借 spine 的 png 顶上去的。

后果：按 live2d 装载必然失败，而前端"第一个 ok 就用"⇒ 真正能解的 spine 插件永远轮不到。
错误被推迟到装载阶段，界面上只剩一句 `Network error.`，从日志完全看不出根因。

**判据（对所有 kind 通用，不认包名）**——产物必须通过自洽校验才算数：

1. `entry` 必须真实存在于产物文件清单里；
2. `entry` 是 JSON 时，它引用的每个文件也必须存在，且内容不是空/占位（`<= 8` 字节即判占位）；
   - Spine 的 `entry.json`：`skeletonFile` / `atlasFile` / `textureFiles[]`
   - Live2D 的 `model3.json`：`FileReferences.Moc` / `.Textures[]` / `.Physics`
3. 校验自身出错一律放行（宁可放过，不可错杀可用产物）。

校验不过就**换下一个候选**，并留一条 `unpack.candidate-reject`（带 provider 与原因），
错误在解包阶段就暴露，不再拖到装载阶段变成无信息的 Network error。

## 3. 前端解包与后端解包必须同口径

同一个包，前端与服务端可能选中不同插件（候选顺序、判定细节都不同）。上面的样本里
服务端选对了 spine、前端选错了 live2d，于是出现"点一次不出画、再点一次才出来"——
第二次是服务端预热已落盘、走命中路径拿到**正确产物**。

两条结论：
- 插件选择与产物校验的判据，前端与后端要一致；前端是首屏那条路，不能只靠后端兜底。
- 两个通道的耗时特性不同（前端 worker 解 5MB 约 1.3s；服务端在 vm 沙箱里解同一个包要数秒到数十秒），
  所以命中查询与本地解包应当**并行竞速**：谁先出结果用谁，前端解完就先显示，
  服务端解完只负责落盘给下次命中。串行"先问后端、miss 再本地解"会让服务端一忙就把首屏拖死。

---

## 引用纪律

- 引用上游逻辑时，把**结论本身写进代码注释**（哪种情形走哪个分支、为什么），不要只写"参考了某某实现"——
  只写参考对象的话，后来的人还得再去翻上游才能知道到底怎么算的。
- 上游实现之间可能不一致（同一 flag 位在不同工具里语义不同），以**能通过全部真实样本双向对照**的那套为准。
