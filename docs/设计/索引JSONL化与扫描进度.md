# 索引 JSONL 化与扫描进度（完整设计）

> 状态：**设计定稿（未实现）**。可直接按本文实现，不需要再讨论形状。
> 数据来源：本项目实测 + 工作区内两套既有实现（写侧 JSONL 存储 / 读侧流式索引读）的实测记录。

## 一、目标与边界

### 1.1 目标

```
G1 扫描期间可见：面板实时显示"已读取 N 条 / 已扫 M 个目录 / 当前路径"
G2 卡死可判：连续无进展超阈值 ⇒ 明确报"疑似卡住 + 卡在哪"，而不是让用户猜
G3 首条可见更早：不必等整份清单拼好才开始渲染
G4 索引可增量写：每扫到一条就能落盘一行（当前是一次性全量写）
```

### 1.2 不做

```
· 不改读路径的"提速"（实测 42.6ms，不是瓶颈）
· 不改失效判据的两道大门（generator 指纹 + dirStamps 目录签名）
· 不做"前端轮询文件大小"这类第二套进度判断（进度只来自事件）
· 不用总时长当作判死依据（大目录本来就慢）
```

### 1.3 一句话

**JSONL 是"让进度可以低成本落盘/传输"的载体；真正的目标是 G1/G2。**

## 二、现状（每条附代码位置）

| 事实 | 位置 |
|---|---|
| 扫描入口是同步递归：`scanRootServer(root, deps)` → `walk()` 递归，**无进度回调** | `src/server/data/spine.mjs:250` |
| 清单读取 + 重建：`getSpineModels(configFile, root, force, deps)`，先比 `generator` 再比 `dirStamps` | `src/server/data/spine.mjs:277` |
| 清单写入：`fs.writeFileSync(tmp)` + `renameSync`（原子替换，但**全量一次写**） | `src/server/data/spine.mjs:315` |
| 清单路径/失效：`config/models/<kind>.<rootId>.json` | `src/server/data/manifest-cache.mjs:20/25` |
| 目录签名：`dirSignature(rootPath)` 只收**根 + 第一层子目录**（`readdirSync` 非递归） | `src/server/data/manifest-stamp.mjs:29` |
| 接口：`GET /api/spine/models?root=&refresh=1` 一次返回完整 `models` 数组 | `src/server/routes/data.mjs:82` |
| SSE 先例：`text/event-stream` 已在两处使用 | `src/server/http/ready.mjs:126`、`src/server/unpack/routes.mjs:230` |
| 单飞先例：`inflight` Map 按指纹去重 | `src/server/unpack/plugin-store.mjs:239/516` |
| 本项目**清单扫描没有单飞** | 全仓 grep 无扫描层 inflight |

### 2.1 实测数据（本项目）

| 项 | 数值 |
|---|---|
| 最大清单 | 2.46MB / 2188 条 |
| 解析耗时 | **42.6ms**（`JSON.parse` 2.46MB） |
| 单根最大条数 | 2188（Live2D）；Spine 最大 431 |
| 传输体量 | `/api/spine/models` 最大约 2.4MB/次 |
| 扫描进度输出 | **无**（grep 无 progress 类字样） |

## 三、设计总览

```
第 1 段 产生进度：扫描器在 walk 过程中回调 onProgress（每 50 条 / 每目录 / 每 2s 心跳）
第 2 段 传输进度：GET /api/spine/models?stream=1 返回 NDJSON 帧（一帧一行）
第 3 段 展示与判死：前端状态行显示计数；无帧超 SCAN_STALL_MS ⇒ 疑似卡住
存储      P1 起：JSONL 追加写（meta 行 + 数据行 + complete 行），tmp → rename 原子替换
```

**为什么分层**：第 1 段与存储无关。**P0 只做第 1~3 段就能完整满足 G1/G2**；JSONL 是 P1 才引入的存储收益（G4、以及 G3 的"边写边读"）。

## 四、存储层设计（P1）

### 4.1 文件布局

```
config/models/<kind>.<rootId>.jsonl        当前有效清单（完整）
config/models/<kind>.<rootId>.jsonl.tmp    扫描中的半成品（成功后 rename 覆盖前者）
config/models/<kind>.<rootId>.json         历史格式（只读兼容，P2 删除）
```

命名与现有 `${kind}.${rootId}.json` 同构，靠扩展名区分；`manifest-cache.mjs` 的路径函数增加 `.jsonl` 变体，
`invalidateManifests` 同时删 `.jsonl` / `.jsonl.tmp` / `.json`。

### 4.2 记录格式（三种行）

```jsonl
{"_":"meta","v":1,"kind":"spine","rootId":"azurlane_spine","ts":1793991336537,"generator":"642803b7","dirStamps":{"root":1793370056514,"dirs":{"A":1,"B":2}},"complete":false}
{"t":"m","k":"azurlane_spine/chara/xxx/xxx.skel","v":{"id":"…","name":"…","kind":"spine","meta":{"motions":[]}}}
{"t":"m","k":"azurlane_spine/chara/yyy/yyy.skel","v":{…}}
{"t":"meta","k":"complete","v":{"count":2188,"ts":1793991352000}}
```

| 行 | 必需 | 字段 | 说明 |
|---|---|---|---|
| meta（首行） | 是 | `_`="meta"、`v`（格式版本，从 1 起）、`kind`、`rootId`、`ts`、`generator`、`dirStamps`、`complete` | 恰好一行；`complete:false` 起始 |
| 数据行 | 是 | `t`="m"、`k`（模型 key）、`v`（模型对象，形状与现有 `models[i]` **逐字段一致**） | 一条模型一行 |
| complete（末行） | 是（成功时） | `t`="meta"、`k`="complete"、`v`={count,ts} | last-wins 覆盖首行的 `complete` |

**key 规则**：`k` = 现有模型 `id`（已含 root 内相对路径，天然避免"不同子目录同名文件"冲突）。
同一 key 重复出现 ⇒ **后写覆盖先写**（重扫时不必先删旧行，直接追加即可）。

### 4.3 写入协议（含 CIFS 约束）

```js
openManifestWriter(base) => {
  append(model),      // 追加一行数据（字符串化后 write + '\n'）；返回 void
  finish(count),      // 追加 complete 行 → 关句柄 → rename(tmp → final)
  abort(),            // 关句柄；保留 tmp（下次覆盖；final 不变）
  bytesWritten        // 已写字节数（诊断用）
}
```

**必须遵守的四条**（每条都对应一个已验证的坑）：

```
① 句柄变量声明在**能执行到的外层作用域**，abort/finish 里都要关
   —— 已验证的踩坑形态：声明在 try 内、catch/finally 里访问不到 ⇒ 从未关闭 ⇒ 遍历大目录后句柄耗尽，
      且 rename 时目标有未关闭读句柄 ⇒ CIFS 上 EACCES
② rename 前必须已关句柄；**不要改用 copyFile 绕开**（覆盖已存在文件 ⇒ CIFS 上 EPERM，且丢原子性）
③ 写入用 appendFileSync 或"打开一次 + writeSync 多次"，不要每条都 open/close
④ 失败路径只 abort，不动 final —— .jsonl 始终是上一次的完整版本
```

**原子性时序**：

```
1) 删除残留 tmp（若存在）
2) 打开 tmp（'w'），写 meta 行
3) 每扫到一条：append 一行
4) 成功：append complete 行 → fsyncSync（可选）→ closeSync → renameSync(tmp, final)
5) 失败：closeSync → 保留 tmp（供排查），final 不变
```

### 4.4 读取协议

```js
readManifest(base) => {
  format: 'jsonl' | 'json' | 'none',
  meta: {kind,rootId,ts,generator,dirStamps,complete},
  models: [...],       // 按文件顺序，last-wins 之后再返回
  complete: boolean,
  badLines: number,
  bytes: number
}
```

```
读取顺序：先试 .jsonl → 不存在再试 .json（历史格式）
.jsonl 不存在且 .json 存在 ⇒ 视为 complete=true（历史文件都是完整写出的）——**兼容关键**
解析容错：坏行跳过并计 badLines；坏行过多（> 总行数 1%）⇒ 判为损坏，走重建并记 warn
complete !== true ⇒ 调用方**不得**把 models 当最终结果：
  · 走重建（默认）
  · 或先展示已读 + 明确标注"仍在扫描"（P1 先不做，避免两套语义）
```

### 4.5 失效判据（不变，只是搬家）

```
现有两道门原样保留，只是从 .json 头部搬到 .jsonl 的 meta 行：
  ① generator !== 当前指纹 ⇒ 重建
  ② !signatureMatches(meta.dirStamps, root.path) ⇒ 重建
另有新增一道：
  ③ meta.complete !== true ⇒ 重建（半成品不当结果）
```

### 4.6 并发与单飞（P0 就要有，P1 复用）

```
key = `${kind}:${rootId}`
单飞表：Map<key, { promise, emitter, progress }>
  · 第一个请求：创建扫描任务，开始广播事件
  · 后续请求：不新建任务，直接挂到同一 emitter 上，**立刻收到一条 progress 快照**（当前计数）
  · 扫描结束：promise resolve；emitter 保留 5s 供迟到订阅者拿到 done 后再销毁
  · 同一 key 第二次 force=1：不启动第二个扫描；若正在扫描则复用（用户在 UI 上重复点重试不会造成双重扫描）
```

## 五、进度事件设计（P0）

### 5.1 产出点

```
spine.mjs:  scanRootServer(root, deps) 内 walk() 每完成一个目录 + 每累计 50 条模型，调用 deps.onProgress?.(snap)
live2d.mjs: scanLive2DRootServer(root) 同样处理
snap = { kind, rootId, scanned, dirs, currentPath, elapsedMs, phase: 'scan' }
```

```
节流：以下三者先到先发
  · 每 50 条模型
  · 每完成一个目录
  · 心跳 2000ms（即使一条没新增也要发，用来证明"还活着"）
```

### 5.2 事件帧（NDJSON，一帧一行）

| type | 字段 | 何时发 |
|---|---|---|
| `start` | `kind, rootId, rootPath, startedAt` | 扫描真正开始（缓存未命中） |
| `progress` | `scanned, dirs, currentPath, elapsedMs` | 按 5.1 节流 |
| `done` | `count, cached:false, elapsedMs` | 扫描成功且已落盘 |
| `cached` | `count, ts` | 直接命中缓存（无扫描） |
| `error` | `message, scanned, currentPath` | 扫描抛错 |

### 5.3 不变量

```
· start 最多一帧，且必在 progress 之前
· scanned 单调不减
· done/cached/error 之后不再有 progress（连接随即结束）
· done.count === 最终写入的 count（便于前端做一致性自检）
```

## 六、传输层设计（P0）

### 6.1 端点与参数

```
GET /api/spine/models?root=<id>[&refresh=1][&stream=1]
GET /api/live2d/models?root=<id>[&refresh=1][&stream=1]

不带 stream：行为与现在**逐字节一致**（JSON：{root,count,cached,scannedAt,models}）
带 stream=1：Content-Type: application/x-ndjson，逐帧写出，结束后关闭
```

**为什么用 NDJSON 而不是 SSE**：一次性、单向、有明确结束；前端读 `fetch().body.getReader()` 即可，
不需要 EventSource 的重连语义（重连反而会重复触发扫描）。SSE 只用于"长连接持续推送"的场景（项目里已有）。

### 6.2 帧写出与背压

```
每帧 JSON.stringify + '\n' 写出；写失败（客户端断开）⇒ 停止写、**不取消扫描**（扫描继续跑完并落盘）
禁止把整份 models 缓存在服务端内存后再一次性发（会丢掉流式意义）
done 帧写出后 res.end()
```

### 6.3 缓存命中路径

```
命中缓存：一条 cached 帧 + 结束（不逐条发）；前端据此直接用本地已有的全量结果（P0 仍走原 JSON 加载）
未命中：start → progress… → done，随后前端再按现有方式取一次 JSON（或把 done 帧里的 count 与随后 JSON 对账）
```

> P0 刻意不做"流式直接喂数据行"——那需要在传输里同时发模型数据，与"索引格式"耦合太深。
> P0 只发**进度**，模型数据仍走原 JSON；P1 起才考虑 `t:"m"` 帧。

### 6.4 断线与重试

```
客户端 abort ⇒ 服务端停止写帧（扫描继续）
用户点"重试" ⇒ 新请求；单飞命中 ⇒ 立刻收到当前 progress 快照（不重启扫描）
```

### 6.5 服务端不做总时长上限

```
服务端不设扫描总时长；卡死由客户端按"无帧"判（见第七节）
理由：大目录在 CIFS 上本来就要几十秒，服务端超时会把正常扫描杀掉并留下半成品
```

## 七、前端设计（P0）

### 7.1 状态机

```
idle ──首次展开某游戏──▶ scanning(scanned, dirs, lastFrameAt)
scanning ──收到 done/cached──▶ loaded
scanning ──无帧超过 STALL_MS──▶ stalled(scanned, currentPath, stalledFor)
stalled ──点重试──▶ scanning（单飞：立刻收到快照）
stalled ──帧恢复──▶ scanning（自动回到正常）
任意 ──error 帧/请求失败──▶ failed(message, retryable=true)
```

### 7.2 文案与位置

```
放在名册里该游戏的现有状态行位置（不新增面板、不弹 toast）：
  scanning：扫描中 · 已读取 1234 条 / 87 个目录
  stalled ：疑似卡住 · 已读取 1234 条 · 12 秒无进展 · 当前 …/chara/xxx · 〔重试〕
  failed  ：扫描失败 · <message> · 〔重试〕
  loaded  ：（恢复正常行显示，不额外提示）
```

### 7.3 判死定时器

```
常量：SCAN_STALL_MS = 10000（环境变量 MODELSTAGE_SCAN_STALL_MS 可覆盖；前端从 /api/web-config 取，不写死两份）
重置条件：收到任意一帧（start/progress/done/cached/error）
触发后：只改状态与文案，**不自动取消请求**（让用户决定是否重试）
```

### 7.4 重试按钮

```
点击 ⇒ 关闭当前流（AbortController）→ 重新以 stream=1 请求
单飞保证不会重复扫描；若服务端已在扫描，立刻收到 progress 快照，状态回到 scanning
```

## 八、判死与"不冒充完成"两条硬规则

```
R1 无进展 ≠ 失败：只有连续无帧超阈值才叫"疑似卡住"，且必须带"已读 N 条 + 当前路径"（可归因）
R2 半成品 ≠ 结果：complete!==true 的索引不得当作最终清单展示
   —— 宁可显示"仍在扫描"，也不能显示一个看起来完整的残缺列表
```

## 九、迁移与兼容

### P0（只加通道，不动存储）

```
改动：scanRootServer / scanLive2DRootServer 增加 deps.onProgress；routes/data.mjs 增加 stream=1 分支；
      扫描单飞表；前端状态行与判死定时器
不改：清单文件名、格式、写入时机
验收：大根扫描能看到计数增长；人为卡住能报"疑似卡住 + 路径"；不带 stream 的响应逐字节不变
```

### P1（JSONL + complete + 双读 + 迁移）

```
新增：manifest-jsonl.mjs（openManifestWriter / readManifest / migrateManifestFile）
改动：spine/live2d 的读取分支改为 readManifest()；写入改为 openManifestWriter（边扫边写）
兼容：.json 仍可读（视为 complete）；写只写 .jsonl
迁移：不主动迁移历史文件；首次扫描该根时自然写成 .jsonl 并保留 .json（P2 再删）
验收：同数据下 JSON 与 JSONL 解析出的 models 逐条一致（见 10.1）
```

### P2（清理）

```
删除：.json 写入路径、双读分支、（可选）历史 .json 文件
前置：P1 上线后至少一次真实重扫 + 一次重启验证
```

### 回退

```
P1 引入 env MODELSTAGE_MANIFEST_FORMAT=json|jsonl（默认 jsonl）
  切回 json ⇒ 只写 .json，读优先 .jsonl（存在则用）→ 便于线上快速回退
```

## 十、验收

### 10.1 等价性（P1 必做）

```
同代码 + 同数据，只切 MODELSTAGE_MANIFEST_FORMAT：
  · count 相等
  · models 按 id 排序后，逐条 JSON.stringify 的 sha256 相等
  · dirStamps 的 root 与每个目录 mtime 相等
```

### 10.2 进度真实性（P0 必做）

```
· 扫描大根时，progress.scanned 单调不减，且最后一帧 done.count === 实际 models.length
· 心跳：人为让扫描卡在某个目录（在 CIFS 上访问一个慢目录或注入 sleep）⇒ 2s 内仍能收到心跳帧
```

### 10.3 判死准确性（P0 必做）

```
· 正常慢扫描（大根，> 30s）：**不得**误报"疑似卡住"（因为每 2s 有心跳）
· 真卡住（人为阻塞 > STALL_MS）：必须报出 stalled，且带当前路径
· 重试：点重试后不产生第二次扫描（单飞命中，服务端扫描计数只增一次）
```

### 10.4 大根实测（每阶段都记）

```
记录：条数、扫描总耗时、首帧延迟、progress 帧数、done 与 JSON 取回的 count 是否一致
基线（当前）：条数 2188 / 解析 42.6ms / 扫描耗时未测（本轮无进度输出，无法测中途）
```

## 十一、测试计划（按测试分级）

| 级别 | 用例 |
|---|---|
| 纯逻辑（node --test） | JSONL 解析：正常/坏行/缺 complete/last-wins/空文件；写入器：finish 后文件可读且 complete；abort 后 final 不变 |
| HTTP 契约（node --test + 临时服务） | `stream=1` 返回 NDJSON 且帧序合法；不带 stream 响应与旧版逐字节一致；扫描失败时 error 帧 + 连接正常结束 |
| 浏览器（仅 3 类） | ① 渲染：状态行出现计数并递增；② 事件链路：点重试后回到 scanning；③ 时序：stalled 出现后帧恢复能自动回 scanning |
| 不做浏览器测试的 | JSONL 解析、单飞、帧序、等价性 —— 全部走 node |

## 十二、风险与失败模式

| 失败模式 | 触发条件 | 表现 | 对策 |
|---|---|---|---|
| 半成品被当结果 | 扫描中断、complete 未写 | 清单看起来正常但条目偏少 | R2：complete 校验；未完成走重建 |
| rename EACCES | 有读句柄未关 | 扫描白跑 | 4.3 的四条约束；写前关句柄 |
| copyFile 丢原子性 | 为绕 EACCES 改 copyFile | EPERM / 半截文件 | 明确禁止 |
| 双重扫描 | 用户连点重试 | CPU/IO 翻倍 | 单飞表 |
| 进度帧刷屏 | 每条都发 | 前端抖动 | 50 条/目录/2s 三重节流 |
| 假卡死 | 阈值太小 + CIFS 单目录慢 | 正常扫描被判死 | 默认 10s + 2s 心跳；阈值可配 |
| 缓存陈旧 | 目录内容变了但签名没变 | 旧清单 | 保留 generator + dirStamps；见第十三节已知缺陷 |
| 前端两套判据 | 有人又去轮询文件大小 | 结论不一致 | R1：进度只来自事件 |

## 十三、已知缺陷（本设计不修，需单列）

```
dirSignature 只覆盖「根 + 第一层子目录」（readdirSync 非递归）
⇒ 模型文件若位于二级及更深子目录，增删不会让清单失效（只能靠 ?refresh=1 或 generator 变化）
影响：JSONL 化后依然存在。是否改成递归签名需单独评估（递归在大根上会显著增加 stat 次数）。
```

## 十四、常量与配置

| 名称 | 默认 | 说明 |
|---|---|---|
| `SCAN_STALL_MS` | 10000 | 前端判死阈值；env `MODELSTAGE_SCAN_STALL_MS` |
| `SCAN_PROGRESS_EVERY` | 50 | 每 N 条发一帧 |
| `SCAN_HEARTBEAT_MS` | 2000 | 无新增也发心跳 |
| `MANIFEST_FORMAT` | `jsonl`（P1 起） | env `MODELSTAGE_MANIFEST_FORMAT=json|jsonl` |
| `MANIFEST_BADLINE_LIMIT` | 1% | 坏行超过比例 ⇒ 判损坏重建 |

## 十五、实施顺序（含依赖）

```
1 存储层无关的进度通道（P0）：onProgress → 单飞 → stream=1 → 前端状态行 → 判死
2 验收 P0（10.2 / 10.3）
3 存储层（P1）：openManifestWriter → readManifest → 双读 → 等价性（10.1）
4 验收 P1（10.4 大根实测 + 一次重启）
5 清理（P2）
```

## 十六、实施记录（P0 已完成）

```
P0-a（进度通道）首版完成后，验收发现一个致命事实：
  433 帧全部在扫描结束后的 2ms 内到达（首帧 @24709ms）——「写了 res.write」≠「客户端收到了」
  根因：扫描是同步递归（readdirSync），事件循环被占满，res.write 只进内核缓冲
  ⇒ 同步实现下"进度可见"不成立；单飞表也因此从未真正生效（并发请求只是被阻塞）

P0-a2 修法（已落地）：
  · indexRootFiles / scanRootServer / scanLive2DRootServer 皆改 async，每 20 目录或 50ms await setImmediate
  · onStart 之后**立刻 await 一次 setImmediate**（否则 start 帧同样被后续同步块压在缓冲里）
  · async 级联：getSpineModels / getLive2DModels / catalog 的 listCatalog / routes 的 handleData / serve 的 dispatch
  · 5 个测试补 await/async 适配

实测（改后，bd2 431 条）：
  首帧 0s ｜ progress 分布在 8s→31s ｜ done 32s ｜ 并发两连接扫描次数 = 1 且 B 收到 progress
  不带 stream 的响应：字段与顺序一致，字节数完全相同（时间戳字段除外的既有差异）

已知代价：
  · catalog-route 单套从几十秒涨到 ~116s（12 个用例都真实扫目录 + 让出）
  · 单飞表在 async 之后才真正开始生效（之前靠事件循环阻塞"碰巧"只扫一次）
