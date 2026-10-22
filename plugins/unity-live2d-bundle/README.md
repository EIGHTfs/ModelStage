# unity-live2d-bundle

把 **UnityFS 容器**（Unity AssetBundle）里的 Live2D 资产还原成标准 Live2D 模型文件集，交给核心装进 VirtualFS 渲染。

- 角色：`provides: ["asset-provider"]`
- 接管条目：`fileKinds: ["bundle"]`（无扩展名的单文件资源包）
- 产物类型：`produces.kind: "live2d"`

## 目录结构

```
plugin.json          清单（provides / fileKinds / produces / assets / errorCodes）
index.js             入口：canHandle + resolve（注册到 window.SpineViewerPlugins）
lib/unityfs.js       UnityFS 容器解析（头部字段、blocksInfo 两种布局、LZ4 块解压）
lib/bytes.js         字节读写工具
lib/serialized.js    SerializedFile 解析
lib/typetree.js      类型树
lib/errors.js        错误码与 fail()
lib/common-strings.js
profiles/            容器族规则（按容器类型命名，不绑定具体游戏）
self-test.mjs        自检脚本（node 直接跑，覆盖解析与产物形态）
```

## 契约要点（照这些实现，不要自创）

**`canHandle(file)` 必须是纯判定**
- 只允许读 `file` 的字段（含 `file.bytes`）做容器魔数判定
- 禁止任何 I/O、禁止修改外部状态、禁止把异常抛给宿主
- 没有 `file.bytes` 时**返回 `true`**（保守放行）——判 `false` 会让无扩展名的包永远选不中
- 内部 try/catch 允许，但 catch 后 `return false` 时**必须记一条 debug 日志**（`host.log` 不可用时降级 `console.debug`）

**`resolve(file)` 成功只返回三键**
```js
{ prefix, files, entry }
```
- `prefix` 格式：`vfs://<providerId>/<rootId>/<相对目录>/`，全局唯一、恒以 `/` 结尾
- `files`：`relPath → Uint8Array | string`，`relPath` 用 `/` 分隔、允许子目录；`string` 按 UTF-8 读回（model3/motion3/physics3 用 JSON 文本）
- `entry`：包内**实际存在**的 `*.model3.json` 相对路径
- 不返回 `report` 之类的附加字段；诊断信息走 `host.log`

**取字节通道**：优先 `file.bytes`；缺失时用 `host.fetchFile(rootId, rel) → Promise<Uint8Array>`
（注意：直接返回 `Uint8Array`，不是 `{ bytes }`；`host` 不可用则抛 `ULB_ERR_NO_HOST`）

**没有 prepare / revoke 钩子**。渲染前要做的事（重建 model3、解纹理并编码 PNG、把 AnimationClip 转成 motion3）**全部在 `resolve()` 内完成**，`files` 就是最终产物；资源释放由核心按 `prefix` 调 `VirtualFS.revoke()`。

**失败一律抛带 `code` 的 Error**，码表见 `plugin.json` 的 `errorCodes`，核心按 `code` 决定提示文案。

## 容器解析支持范围

UnityFS 的 `blocksInfo` 有两种布局，**必须都支持**（这是踩过的坑）：

```
(flags & 0x80) == 0    blocksInfo 内联在头部
                       数据起点 = blocksInfoStart + blocksInfoCompressedSize
                       （该段按"声明长度"占位，声明长度 > 表内容长度时差额是表尾对齐填充，必须跳过）

(flags & 0x80) != 0    blocksInfo 在文件尾
                       先存 position → 跳到 Length - compressedSize 读表 → seek 回保存值
                       回来后就是 header 结束、数据块开始的位置，**不能再加 compressedSize**
```

> 真实事故：旧实现只写了第一种，对第二种的包也加了 `compressedSize`，把数据起点整体推后
> （`aijier_3`，Unity 2018.4 / version 6 / LZ4 / `dataflags 0xC2`，推后 101 字节）→ 数据块错位
> → LZ4 解出垃圾 → 报「LZ4 数据损坏：匹配位置越界」，**报错位置与真实根因相距极远**。
>
> 另一个坑：`ArchiveFlags` 里 `0x40` 名义上叫 `BlocksAndDirectoryInfoCombined`，但**实现的判断链里
> 从不读它**（正常包 `dataflags 0x240` 也带这一位）。拿它当"不支持该布局"的依据会把全部正常包一起拒掉。

**不要相信"解压成功"**：LZ4 块解压通常只校验"输出长度 == expectedSize"，错位数据可能恰好自洽解出。
必须用结构自洽交叉验证（各段长度相加等于段起点、`bundleSize` 等于实际文件长度、node size 之和等于 block unc 之和等）。

## profile 机制

游戏/容器族的差异走 `profiles/<profile>.json`，**代码里不写死任何游戏名**：

- 资源根配置透传 `profile` 字段 → `resolve` 读到 `ctx.profile` → 自读 `profiles/<profile>.json`
- 缺 `profile` 或文件不存在 ⇒ 走默认规则，**不报错**
- profile 按**容器类型/容器族**命名，不要按单一游戏命名（会让"只支持某游戏"的错觉传下去）

## 自检

```bash
node plugins/unity-live2d-bundle/self-test.mjs
```

覆盖：容器魔数判定、两种 `blocksInfo` 布局、结构自洽、产物三键形状、错误码路径。

## 边界

- 不读 `src/web/engine`、不假设渲染层细节；产物只按契约三键交付
- 不做 Blob URL 装载、不安装运行时适配器（那些属于旧宿主通道，已删除）
- 不设单包体积上限（峰值由核心 `revoke` 控住）

## 旧端兼容

`probe(ctx)` / `open(ctx)` / `plugin.json` 的 `produces.legacyEntry` **已删除**，只保留新契约 `canHandle` / `resolve`。
旧端（8803 的 `legacy/patches/plugin-host.js`）的 bundle 功能因此失效——旧端待下线，不再保留兼容层。
