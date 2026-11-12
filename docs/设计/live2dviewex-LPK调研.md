# live2dviewex LPK 包能否被本项目支持（调研）

> 结论：**当前不能直接支持**。LPK 是 Live2DViewerEX 的**私有加密容器（STM_1_0）**，
> 14 个样本的元数据全部声明 `encrypt: "true"`，模型主体（moc3 / model3.json 等）被加密。
> 按任务纪律第 7 条（发现加密即停下报告、不尝试破解），本次调研在此停止。
>
> 未来要走这条路，只有两个合法前提：**① 官方导出非加密模型 ② 官方文档给出 STM_1_0 格式说明**。
> 不含"解密现有包"。

## 一、结论摘要

| 项 | 事实 |
|---|---|
| LPK 容器 | 标准 ZIP（头 `50 4b 03 04`），**全部 STORED（不压缩）** |
| 内部文件名 | 全部形如 `<32位hex>.bin`，**哈希化**，无可读名 |
| 格式标识 | 内嵌元数据 JSON 的 `type: "STM_1_0"` |
| 加密 | 内嵌元数据 JSON 的 **`encrypt: "true"`**，且 803 个 binary entry 内容高熵（前 4096 字节 256/256 唯一值） |
| 明文部分 | 每个 LPK 里**有 PNG 纹理**（14 个）与**元数据 JSON**（21 个）是明文，可作为证据 |
| 覆盖 | 14 个目录有 lpk，**14/14 全部 `encrypt: "true"`**；另有 1 个目录只有 mp4（无 lpk） |

⇒ **模型主体不可读**，无法判断里面是 Cubism 4 / Cubism 2 / Spine，也无法验证扫描器能否吃。

## 二、LPK 内部结构（实测）

### 2.1 ZIP 层

```
样本 1624692097.lpk   5,696,622 B   25 entries
样本 1634736052.lpk   7,732,943 B   32 entries
样本 1904090561722925675.lpk  2,681,781 B  50 entries

全部 14 个 lpk 共 838 个 entry：
  ZIP 压缩方式分布：{0: 838}   ← 0 = STORED，一个 DEFLATE 都没有
  entry 类型分布：{binary-unknown: 803, PNG: 14, JSON: 21}
```

**为什么"全 STORED"很关键**：如果内容是普通资源，ZIP 通常会 DEFLATE 压缩；全 STORED 说明
内容已经是高熵（加密或已压缩），压不动 —— 与 `encrypt: true` 互相印证。

### 2.2 内嵌元数据 JSON（明文，272 B）

```json
{
 "type": "STM_1_0",
 "name": "天命之子老板娘(18R)",
 "id": "1547827623804",
 "encrypt": "true",
 "version": "1.0",
 "list": [
  {
   "id": "",
   "character": "character",
   "avatar": "4a301072dec6b6a49050e5b294cd7983",
   "costume": [
    { "name": "costume", "path": "40248fd01f93cec147cbd6c90f8a0d24.bin" }
   ]
  }
 ]
}
```

要点：

- `encrypt: "true"` —— **官方元数据自己声明加密**
- `type: "STM_1_0"` —— Live2DViewerEX 的私有格式标识
- `avatar` 字段是无扩展名的 32 位 hex（指向某个 entry），`costume[].path` 指向 `.bin`
- **没有 `model3.json` / `moc3` / `.atlas` 之类的结构描述** —— 说明模型描述文件本身也在密文里

### 2.3 密文 entry 的特征

```
首个 entry 前 32 字节: 07500cf1d08e5fcf51b8d8cfe5eb617e34d34446a593d44ea6987507c20a3cc1
前 4096 字节唯一字节值数: 256/256
```

满熵、无任何已知魔数（不是 MOC3 / moc / PNG / JSON）。**结论：加密或私有编码，无法按文件头识别类型。**

## 三、覆盖的模型类型分布

**无法判定。** 因为模型描述与主体都在密文里。

可确定的只有：14 个样本全部是 `STM_1_0` + `encrypt: "true"`：

**15 个目录全量口径**：14 个有 lpk 且全部 `encrypt=true`；1 个只有 png + config.json + mp4 ⇒ **非模型包**
（`type:6`、`lpkFile` 为空，内容是 47MB 的 `ftypmp42` 视频）。

```
目录                     type         encrypt   备注
1624692097               STM_1_0      true      25 entries
1634736052               STM_1_0      true      32 entries
1904090561722925675      STM_1_0      true      50 entries
1936614891               无 lpk        -        只有 png + config.json + mp4
2042115087               STM_1_0      true      32 entries
2100715347               STM_1_0      true      109 entries
2108430225               STM_1_0      true      169 entries
2232393788               STM_1_0      true      32 entries
3801536705               STM_1_0      true      90 entries
3806682983               STM_1_0      true      42 entries
3807835567               STM_1_0      true      36 entries
3810081044               STM_1_0      true      90 entries
3828907139               STM_1_0      true      54 entries
3833562824               STM_1_0      true      71 entries
3836619503               STM_1_0      true      6 entries

encrypt=true: 14/14
```

**注意**：`config.json` 里的标题显示这批资源横跨多个游戏（天命之子 / 碧蓝航线 / 棕色尘埃2 /
樱境物语 / 冻京necro 等），但**这只是标题文本**，不能据此判断模型格式。

## 四、与现有扫描器的差距

现有两个扫描器的判据（读代码确认）：

```
Live2D 扫描器（src/server/data/live2d.mjs modelsInDir）：
  目录里需 *.model3.json 或 *.model.json（作 defFile），同目录有纹理、moc/moc3
Spine 扫描器（src/server/data/spine.mjs groupModelsInDir）：
  目录里需同 base 名的 *.skel/*.json + *.atlas，纹理可散在其他目录
```

LPK 与这两套判据的差距**不是一个层级的问题**：

| 层级 | 现状 | 差距 |
|---|---|---|
| 容器 | `.lpk` 是 ZIP | 现有扫描器把 `.lpk` 当普通文件，不认作目录 —— **需要"解包"这一步** |
| 解包后命名 | 全部 `<hex>.bin` | **无法靠文件名识别** defFile / moc / 纹理 |
| 内容 | 加密（`encrypt: true`） | **无法读取模型描述与主体** |

⇒ **即便加上"解 lpk"这一步，仍然拿不到可用的模型数据。** 差距的根在加密，不在容器格式。

## 五、结论与工作量

### 5.1 三条路子

| # | 方案 | 可行性 | 说明 |
|---|---|---|---|
| ① | 直接可用 | ❌ | 加密挡住，无解 |
| ② | 写插件（node/exec runtime） | ❌ | 插件解决的是"怎么解包、怎么解析"，解决不了"内容加密" |
| ③ | 产品改动（改扫描器判据） | ❌ | 同上，扫描器还没到能读数据的阶段 |

**真正的前置条件是"解密"，而那是另一件事**（且涉及第三方私有格式）：
本次按纪律 7 未做任何破解尝试。

### 5.2 未来要支持，只有两个合法前提

```
① 拿到官方导出的**非加密**模型（不是解开现有加密包，而是官方提供明文导出）
② 官方文档给出 STM_1_0 格式说明（容器布局、命名规则、资源类型）
```

**两者缺一不可，且都不包含"解密现有包"这条路** —— 那是绕过第三方私有保护，不做。

满足了前提之后才谈得上判断格式：

| 解出来是 | 现有扫描器能否直接吃 |
|---|---|
| Cubism 4（moc3 + model3.json + 纹理） | 大概率能（需确认 `FileReferences` 的路径形态） |
| Cubism 2（moc） | 需确认：`modelsInDir` 只认 `*.model3.json` / `*.model.json` 作 defFile |
| Spine（skel + atlas + 散图） | 大概率能（与 `groupModelsInDir` 的判据一致） |

容器层另外需要：lpk 解包（ZIP 解压 + 按元数据还原命名）≈ 1~2 天。

**工作量估**（**前提是加密问题已解决**）：

| 工作 | 估时 |
|---|---|
| lpk 解包（ZIP → 目录 + 按元数据还原命名） | 1~2 天 |
| 若解出 Cubism 4 / Spine：接入现有扫描器 | 0.5~1 天（多半只需"解包产物落到资源根下"） |
| 若解出 Cubism 2 且扫描器不支持：补 moc 分支 | 2~3 天 |
| 对外契约（清单里体现"来自 lpk"、预览图复用 config.json） | 1 天 |

**加密解决之前，以上都不成立。**

## 六、可以复用的东西（与加密无关）

`config.json`（外置，明文）含本项目清单可直接用的字段：

```json
{ "lpkFile": "1624692097.lpk", "previewFile": "20190119000703.png",
  "fileId": "1624692097", "title": "天命之子老板娘(18R)",
  "author": "天真的萝莉控", "description": "", "metaData": "b13cf49f-…" }
```

| 字段 | 本项目对应 |
|---|---|
| `title` | 模型显示名（现有清单的 `name`） |
| `author` | 现有清单没有对应字段，可作为 extras |
| `previewFile` | 现有清单的 `iconUrl`（预览图） |
| `lpkFile` | 资源定位（若将来支持 lpk） |

另：每个 LPK **内部有一张明文 PNG**（14 个），若将来解密后这张也可作为贴图来源之一 ——
但当前无法确认它的用途（纹理 / 缩略图 / 其他）。

## 七、未验证项

```
1. 解密后到底是什么格式（Cubism 4 / Cubism 2 / Spine）—— 加密挡住，无法判定
2. 803 个密文 entry 里哪些是 moc3、哪些是 model3.json、哪些是音频/其他 —— 同样无法判定
3. 14 个明文 PNG 的用途（是模型纹理还是预览缩略图）—— 尺寸与数量对不上"每个模型 2~3 张纹理"的典型结构
4. 是否有部分样本使用不同密钥（本次未做密钥探测，按纪律不做）
5. 那 1 个只有 mp4 的目录（1936614891）**已判定为视频类资源**：`config.json` 的 `lpkFile` 为空、
   `type:6`，内含 `marry_balanceboul_3DL.mp4`（47MB，头部 `ftypmp42`）⇒ 本来就没有模型数据，
   不是下载不完整
```

## 八、纪律遵守情况

| # | 纪律 | 遵守 |
|---|---|---|
| 1 | 只读优先、不动 资源/ | ✅ 全程 `zipfile` 只读打开，未解压到磁盘、未改原文件 |
| 2 | 用完清理 | ✅ 临时目录 `/tmp/lpk-probe-*` 已删 |
| 3 | 不写死本机配置 | ✅ 目录用 `os.listdir` 遍历，未把任何 id 写进脚本 |
| 4 | 不碰 8804 / 不跑 --all / 不跑 --browser | ✅ 全程未启动服务 |
| 5 | 不 commit | ✅ 未提交 |
| 6 | 注释不写"用户/规则号/CIFS/文件大小" | ✅ 本文只写事实与结论 |
| 7 | 加密即停下、不破解 | ✅ **发现 `encrypt: true` 后停止，未做任何解密尝试** |
| 8 | 单线程 | ✅ 串行执行 |
