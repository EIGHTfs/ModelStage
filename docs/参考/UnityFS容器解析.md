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

## 引用纪律

- 引用上游逻辑时，把**结论本身写进代码注释**（哪种情形走哪个分支、为什么），不要只写"参考了某某实现"——
  只写参考对象的话，后来的人还得再去翻上游才能知道到底怎么算的。
- 上游实现之间可能不一致（同一 flag 位在不同工具里语义不同），以**能通过全部真实样本双向对照**的那套为准。
