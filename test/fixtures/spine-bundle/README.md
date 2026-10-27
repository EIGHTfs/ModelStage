# Spine 资源包 fixture（unity-spine-bundle 插件）

## 这里有什么

只有本 README。**二进制样本不入库** —— NIKKE 单个包 5.6~6.6MB，三个就把仓库撑大 19MB，
而它们是外部资源的衍生物（随时可从源目录重新获得）。做法与 `test/unpack-filesview.test.mjs`
引用 `../live2d` 资源根同口径：**测试脚本按路径引用外部样本，样本不在本机时整条用例 skip**。

```
test/spine-bundle-plugin.test.mjs   三条 fixture 用例 + 内存声明用例
  ├── 正例         ../NIKKE/Rupee - 露菲/<任意一个包>       （spine：UnityFS + .skel）
  ├── 互斥反例     ../live2d/<任意一个包>                    （live2d：UnityFS + moc3）
  └── 坏包        由正例样本**截断**得到，不单独存文件
```

## 三条 fixture 各自的断言要点

| fixture | 期望 |
|---|---|
| 正例 | `canHandle === true`；`resolve` 产出 `entry.json` + 1×`.skel` + 1×`.atlas` + N×`.png`；atlas 首行页名 == 落盘 png 名；png 尺寸 2048×2048；skel 头部含 Spine 版本串 |
| 互斥反例 | `spine.canHandle === false` 且 `live2d.canHandle === true`（两个插件必须互不认领：宿主只取第一个 true，错认领的一方会在 resolve 阶段报"找不到 moc3/skel"） |
| 坏包 | **必须抛 `SPI_ERR_*` 且不得返回半成品**。截断包实际抛 `SPI_ERR_CONTAINER_PARSE`（块表读不到），随机字节抛 `SPI_ERR_NOT_UNITYFS`。契约 §五.8 禁止"解析失败返回缺字段资产"，静默返回空 Map 会让宿主误判成功 |

## ⚠️ 踩过的坑：自测必须复刻真实宿主的 zlib 注入

PNG 编码走 `lib/png.js` 的 `encodePngAsync`，它的压缩实现有**三条回落**（`png.js:181-195`）：

```
① deflateStreamImpl（宿主注入的流式 deflate）   ← 真实宿主用这条
② 浏览器 CompressionStream
③ 兜底：stored（**不压缩**）
```

**只注入 `setDeflate` 不注入 `setDeflateStream` 时，③ 会生效**：2048×2048 的 PNG 会产出
**16.8MB** 的假大文件（正常应 3.5~3.9MB）。我第一次自测就踩了这个坑，误以为编码正常。

生产路径的注入在 `src/server/unpack/plugin-runner.mjs:132-154`（sha256 / inflate / deflate /
deflateStream 四件）。**因此本测试一律通过 `ensurePlugin()` 装载插件**，而不是自己搭 vm 沙盒 ——
既不重复实现装载逻辑（交付纪律第二条），测的又正好是生产同一条路径。

## 跑法

```bash
node --test test/spine-bundle-plugin.test.mjs
```

样本缺失时用例会 skip（不会假装通过）：`if (!fs.existsSync(abs)) return;`
