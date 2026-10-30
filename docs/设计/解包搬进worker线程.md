# 设计 · 服务端解包搬进 worker_threads

> 解决一件事：**一次长解包会把整个 HTTP 服务卡住**，导致所有并发请求超时。
> 本文只讲"不阻塞事件循环"；**不追求内存隔离**（见 §五）。

---

## 一、问题（2026-10-29 由一份调试日志暴露）

一份 500 条的浏览器调试日志里，**28 个 error + 15 个 warn 全是超时**，而模型实际都能加载：

```
POST /api/ready                    15 次超时
GET  /api/unpack/capacity          11 次超时（含 ?rootId&rel 与无参两种）
GET  /api/backgrounds(+ /solids)    超时
POST /api/unpack/resolve            超时
blob:http://…  network error        2 次
```

### 根因链

```
src/server/ 里没有任何 worker_threads        ⇒ 解包跑在主线程
plugin-store.mjs 的 enqueue 是串行队列        ⇒ 一次只解一个
33.4MB LZMA 包解压实测 11.8~12.9s             ⇒ 这 12 秒 Node 事件循环被占死
⇒ 期间所有并发请求排队等不到响应 ⇒ 一起超时
```

### 为什么"超时了却还能加载"

```
/api/unpack/resolve 超时（默认 8500ms < 12900ms）
  → 前端 retries:2 再试 → 仍超时
  → 回落到前端 worker 解包（cb93027 之后 LZMA 直接交 worker）
  → 模型正常显示
```

代价：服务端 12.9s 的 CPU 白烧、前端多等两轮重试、服务端缓存与预热的收益被抵消。

### 顺带暴露的超时参数错配（本批一并修）

| 请求 | 现值 | 与实测的关系 |
|---|---|---|
| `POST /api/unpack/resolve` | 8500ms（`api.js` 默认）| 33.4MB 包要 12.9s ⇒ **必然超时** |
| `GET /api/unpack/capacity` | 1500ms（`plugin-host.js:614`）| 服务端一忙就死 |
| `POST /api/ready` | 5000ms（卸载前）/ 3000ms（重试）| 同上 |
| `GET /api/backgrounds` | 8000ms | 同上 |

> 只改这些数字能让日志安静，但**治不了根因** —— 只要解包还在主线程，任何长解包都会连累所有接口。

---

## 二、目标与不做的事

**目标**：解包期间 HTTP 服务**仍能响应**（`/api/ready`、`/api/backgrounds`、`/api/unpack/capacity` 不超时）。

**不做**：

```
· 不做内存隔离（worker_threads 共享进程内存，见 §五）
· 不改解包产物格式、不改缓存目录结构、不改指纹算法
· 不因为"搬进 worker"就并行解多个包 —— 串行语义保持不变（并行会加剧内存峰值）
· 不改前端回落逻辑（前端 worker 解包那条路继续存在，作为服务端不可用时的兜底）
```

---

## 三、结构

### 3.1 搬什么

`src/server/unpack/plugin-runner.mjs` 的 **`unpackFile({rootId, rel, absPath})`** 是 CPU 密集入口，
它内部通过 runtime 适配器（`runtime/node-vm.mjs`）把插件代码装进 vm 沙盒再调 `resolve`。

**搬进 worker 的是这一整段**（含 vm 沙盒装载）：

```
主线程                                   worker 线程
────────────────────────────────────     ──────────────────────────────────
plugin-store.resolve()
  ├─ 指纹 / 缓存命中判断（轻）
  ├─ memoryDeclaration()（轻，只读块表）
  ├─ checkUnpackMemory()（轻）
  └─ enqueue(task) ─────────────────►    unpack-worker.mjs
                                            ├─ 复用 runtime 适配器装载插件
                                            ├─ plugin.resolve(absPath)  ← 真正的 CPU 活
                                            ├─ 落盘 data/unpacked/<fp>/files/
                                            └─ postMessage({ok, manifest})
       ◄─────────────────────────────────
  ├─ 更新 index.json / counters
  └─ 返回给 HTTP 调用方
```

**关键取舍：落盘放 worker 里做**（而不是把 files map 传回主线程）。

理由：`files` 可能是几十 MB 的多个 Buffer，`postMessage` 即使可 transfer 也要逐个处理底层
`ArrayBuffer`；而产物本来就要写进 `data/unpacked/<fp>/files/`，让 worker 直接写、只回传
**清单**（相对路径 + 字节数 + 指纹）最省事、也不会有两份大对象同时存活。

### 3.2 worker 的生命周期

```
· 常驻复用（不是每次解包新建）：Node 起 worker 有几十 ms 开销，而解包本身秒级，
  每次新建会把开销叠上去；且 vm 沙盒装载也可以复用
· 大小：**1 个**（与现有串行队列一致）
· 卡死处理：主线程对 worker 设硬超时（解包耗时上限），超时 worker.terminate() 并重建，
  本次请求返回可读失败原因 —— 不能让 worker 卡死把队列永久堵住
```

### 3.3 串行语义保持

```
现有 enqueue 是串行队列 ⇒ 搬 worker 后仍串行（1 个 worker 天然串行）
不要因为"有 worker 了"就开并发 —— 两个 33MB 包同时解会把进程内存顶穿
```

---

## 四、内存测量口径：**不变**

`plugin-store.mjs` 现在读 `/proc/self/status` 的 `VmRSS` / `VmHWM`（内核记录的峰值），
理由是"解包峰值是瞬时的，300ms 轮询会系统性漏掉（实测采样 171MB vs 内核 VmHWM 491MB，差 2.9 倍）"。

**worker_threads 里 `/proc/self` 指向同一个进程** ⇒ 该口径继续有效，不需要改测量代码。

但要注意两点：

```
① VmHWM 是进程级、只增不减 ⇒ 它仍是"本次把峰值顶高了多少 + 当时进程已占多少"，
   语义与现在完全一致（现有注释已写明这个陷阱）
② 在 worker 里读 /proc/self 与在主线程读，得到的是同一组数字 —— 别以为搬了线程就换了口径
```

---

## 五、明确不做的：内存隔离（这是另一个决定）

```
worker_threads：同一进程、独立 V8 isolate 与事件循环
  ✓ 不阻塞事件循环（本批目标）
  ✓ /proc/self 仍是同一进程，测量口径不变
  ✗ 不隔离内存：worker 的分配计入同一进程 RSS，OOM 仍会带走整个服务
  ✗ VmHWM 仍单调不降（高水位不还系统那条性质不变）

child_process：独立进程、独立 RSS
  ✓ 真正隔离内存，OOM 只死子进程
  ✗ IPC 传大文件、启动成本、僵尸回收都要另做
```

**本批选 worker_threads**，因为目标是"别卡住 HTTP 服务"，不是"隔离内存"。
若将来要解决"多进程高水位叠加"（见 `docs/待办.md` §四），那是 child_process 或独立解包服务，
**单独一批**，不在本文范围。

---

## 六、超时参数（同批修正）

```
① POST /api/unpack/resolve   8500ms → ≥ 30000ms
   理由：33.4MB LZMA 实测 12.9s ⇒ 需覆盖"最慢的合法解包"并留余量
   注释里要写"这个数字来自实测，不是拍的"
② GET /api/unpack/capacity   1500ms → 5000ms
   它是轻请求，但服务端忙时排队时间不可控
③ /api/ready 与 /api/backgrounds 保持现值，观察搬 worker 后是否还超时
   —— 若仍超时，说明还有别的阻塞源，那时再查（不要先改数字掩盖）
```

---

## 七、验收判据

| 项 | 判据 |
|---|---|
| **事件循环不再被占** | 解一个 33.4MB LZMA 包**期间**，并发打 `/api/ready`、`/api/backgrounds`、`/api/unpack/capacity`：**全部 200 且延迟 < 500ms**（改前这些会超时）|
| resolve 不超时 | 同一包 `POST /api/unpack/resolve` 在 30s 内返回 `ok:true`（改前 8.5s 必超时）|
| 产物逐字节一致 | 同一包，改前/改后 `data/unpacked/<fp>/files/` 下所有文件**逐字节相同** |
| 指纹与缓存不变 | 同一包的 `<fp>` 不变；第二次请求 `hit:true` |
| 串行保持 | 同时发两个解包请求，第二个**排队等第一个完成**（不并发）|
| 卡死可恢复 | 人为让 worker 卡住（注入死循环），主线程超时后 terminate + 重建，后续请求正常 |
| 内存数字仍对 | 同一包 `probe.json` 里的 `measuredPeakBytes` 与改前同量级（口径未变）|
| 无回归 | 全量 node-test 16 套 + 浏览器 10 套绿 |

---

## 八、风险与对策

| 风险 | 对策 |
|---|---|
| worker 里 vm 沙盒行为与主线程不一致 | 复用**同一个** runtime 适配器（`runtime/index.mjs` 的 `loadWithRuntime`），不另写一份装载逻辑 |
| 落盘在 worker 里，主线程的 `writeResult` 原子写/回收站逻辑被绕开 | 把 `writeResult` 那套（临时目录 rename + fsync + 权限）**一起搬进 worker**，不要在主线程再写一次 |
| worker 崩溃导致队列永久阻塞 | 硬超时 + `terminate()` + 重建 + 本次请求返回可读原因 |
| 大 payload 复制两份 | worker 直接落盘，只回传清单（见 §3.1）|
| 并发请求排队仍超时 | 搬完后先测一遍（§七 第一条）；若仍超时说明另有阻塞源，单独查 |

---

## 修改记录

- 建立本文。起因：一份 500 条调试日志里 28 error / 15 warn 全是超时，而模型实际能加载；
  根因是服务端解包在主线程占死事件循环（33.4MB LZMA 包解压 11.8~12.9s），
  连带 `resolve` 自身（8500ms 默认超时）与所有并发请求一起超时。
- 明确不做内存隔离：worker_threads 共享进程 RSS，本批只解决"不阻塞事件循环"。
