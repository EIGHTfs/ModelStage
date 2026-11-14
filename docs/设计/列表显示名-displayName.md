# 设计 · 列表显示名（displayName）

> 目标：左侧列表的容器条目不再全部显示 `__data`。
> 原则：**名字是内容语义，归插件；核心只渲染、只缓存、不解析。**

---

## 一、现状（代码实查，不是推测）

| 问题 | 事实 | 位置 |
|---|---|---|
| 列表显示名怎么定 | `variantText()` 三级回落：`nameIndex.costume` > `srcDir` 末段 > `m.name` | `src/web/roster/list.js:217` |
| 容器条目的 `m.name` | `file.name`，即磁盘文件名 `__data` | `src/server/data/catalog.mjs:414` |
| 有没有 `displayName` | **没有**（代码里两处同名标识都无关：壁纸上传文件名、插件的错误消息参数） | — |
| `entry.display` 是什么 | `{ accent, provider, candidates }`：配色 / 归属提供者 / 候选插件，**不是名字** | `catalog.mjs` 末尾 `recompute()` |
| 条目何时更新 | 用户点选并装载后：`reportEntryResult` → `roster.setEntryState(id, …)` → 只重画那一行 | `src/web/app/entry-report.js:36` |
| 有没有批量更新通道 | 没有，只有单条目回写 | 同上 |

---

## 二、设计

### 2.1 名字由插件声明

`analyze(bytes)` 的返回里新增 `displayName: string | null`（契约 `插件.md` §1.3）。

```
插件决定：取哪个 TextAsset、多骨架怎么拼、要不要去前缀
核心决定：什么时候问、缓存到哪、拿不到怎么回落
```

核心**不认识** `.skel` / `.atlas` / moc3 这些名字的含义。

### 2.2 只对"被选中的条目"取

```
选中/装载该条目时，核心向 analyzer 取一次 displayName
⇒ 不批量、不后台预扫、不因列表滚动而触发
```

理由：与现有单条目回写通道（`setEntryState`）一致，不引入第二套更新机制。

### 2.3 缓存归核心（只按 key 存取）

```
位置  <数据根>/config/bundle-display-names.json
键    rootId + rel
值    { displayName, mtimeMs, size }
失效  mtimeMs 或 size 变化
```

缓存不归插件：插件被禁用/替换时，核心仍应读到上次结果；且"跨请求存取"属核心职责。

### 2.4 回落顺序

```
displayName（插件给的）
  ↓ 没有
costume（名表）
  ↓ 没有
srcDir 末段（字符目录名）
  ↓ 没有
文件名（`__data`）
```

---

## 三、成本（真实数据，181 个包的实测分布）

```
包数 181 ｜ 合计 7006MB ｜ 中位 22.0MB
分位 p25=14.9 / p50=22.0 / p75=29.6 / p95=93.8 / max=1297MB
>50MB 共 22 个，合计 3748MB
```

| 包大小 | 读盘 | 解压+解析 | 说明 |
|---|---|---|---|
| 15MB | 25ms | 253ms | — |
| 22MB（中位） | 160ms | 431ms | 单包约 0.6s |
| 97MB | 673ms | 1134ms | 单包约 1.8s |
| 1297MB | — | **不可行** | 全量解压需 4862MB，实测进程被 OOM 杀 |

**按需解压的收益**（决定名字所在位置才解压）：

```
容器头 + blocksInfo   只读头尾，10~14ms（≤97MB 样本）
CAB 对象表            解压前 8 块（约 1MB）即可，148ms（全量需 74MB）
TextAsset 名字        在对象记录的 dataOffset 处（实测直接可读）
⇒ 名字取"按需解压到 dataOffset"即可，不必全量解
```

---

## 四、内存准入（按契约 §2.2，核心不猜）

```
插件在 analyze 返回里声明 memory：{ decompressedBytes, rgbaBytes?, peakBytes? }
  · decompressedBytes 由 blocksInfo 求和得出，不需要真解压数据块
核心只做一次比较：声明峰值 vs 预算（预算来自 src/server/unpack/capacity.mjs）
  · 声明了 peakBytes 直接采信，不叠加安全垫
  · 什么都没声明 → 回落既有粗估（源文件大小 × 分段倍数）
  · 超预算 → 拒绝分析，条目进 warnings，显示名回落文件名
```

**核心侧不得出现 `>100MB` 这类阈值常量** —— 那等于用源文件大小猜内存代价（实测解释力 R² 0.695）。

---

## 五、失败与降级

| 情形 | 表现 |
|---|---|
| 未安装 analyzer / 被禁用 | 显示 `__data`（现状） |
| 分析抛错 | 显示 `__data` + 条目 warnings 记原因 |
| 声明峰值超预算 | 显示 `__data` +「超出内存预算未取名」 |
| 插件返回 null | 显示 `__data`，不留空 |

---

## 六、明确不做

```
· 核心侧出现"取 .skel 去后缀""拼大小 + hash"这类格式知识
· 批量预扫 / 后台取名任务（181 个包要 2~5 分钟，且大包会 OOM）
· 把 displayName 写进清单（清单是模型索引，显示名是展示态，混进去要 bump schema）
· 改 catalog 的 name 字段（它是文件名这一事实，不该被覆盖）
```

---

## 七、与既有机制的关系

| 机制 | 关系 |
|---|---|
| `setEntryState`（单条目回写） | **复用**：拿到 displayName 后走同一条通道重画那一行 |
| `entry.display`（配色/归属） | 独立字段，互不影响 |
| `entry-states` 的 `recompute()` | 不参与显示名（它是三字段的唯一产出点，别混） |
| 插件 `label`（角色标签） | 是"插件自己的显示名"，与条目名字无关 |
| 名表（`nameIndex`） | 保持现有优先级：`displayName` > costume > 目录名 > 文件名 |

---

## 八、验收判据（实施时用）

```
1 选中一个容器条目后，列表显示插件给的名字（实测 5 个包）
2 未选中过的条目保持 `__data`（证明"只对选中项取"）
3 插件返回 null / 分析失败 → 回落 `__data`，不留空、不报错
4 二次打开命中缓存 → 零分析（给证据：analyze 调用次数）
5 超大包（声明峰值超预算）→ 不取名 + warnings 说明
6 核心侧 grep 不到 `.skel` / `.atlas` 这类格式知识（判据：`grep -rn "skel" src/web src/server | grep -v 注释`）
```

---

## 九、待定

```
· 多骨架时显示哪个：由插件决定（本设计不规定），但插件 README 应写明自己的规则
· 同名冲突（不同包同一角色名）：本设计不处理，仍靠目录层级区分
· 是否把 displayName 一并写进 `/api/analyze` 的缓存：是（同一份文件，避免二次读盘）
```
