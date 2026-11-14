# 设计 · 列表显示名（displayName）

> 目标：左侧列表的容器条目不再全部显示 `__data`。
> 原则：**名字是内容语义，归插件；工厂产出（与 support/kind 同源）；前端只渲染。**

---

## 一、现状（代码实查）

### 1.1 条目工厂在哪

| 环节 | 位置 | 产出 |
|---|---|---|
| ① 装配静态事实 | `catalog.mjs` 的 `toBundleEntry` / `toSpineEntry` / `toLive2DEntry` | `id / name / rel / size / kind / container / candidates` |
| ② 算三字段 | `entry-states.mjs:170 recompute()` —— **唯一产出点** | `display`（归属+配色）/ `support`（能否加载）/ `loadResult`（上次装载结果） |
| ③ 接到条目上 | `catalog.mjs:914 computeEntryStateFor()` | 条目带三字段 |
| ④ 前端渲染 | `rows.js` / `list.js` | 只渲染，不重算 |

### 1.2 显示名现状

| 问题 | 事实 | 位置 |
|---|---|---|
| 条目 `name` | `file.name` = 磁盘文件名 `__data` | `catalog.mjs:414` |
| 角色分组键 | `charKeyOf(m.name)` ⇒ `__data` | `list.js:245` |
| 角色节点标题 | `title: groupName` ⇒ `__data` | `list.js:252` |
| 变体行文本 | `variantText` = `nm.costume \|\| dirName \|\| m.name` ⇒ `__data` | `list.js:217` |
| 有没有 `displayName` | **没有** | — |
| `entry.display` | `{ accent, provider, candidates }`，**不是名字** | — |

**结论**：显示名有两处要改（角色节点标题 + 变体行文本），且**目前不在工厂里**，是前端现算的。

---

## 二、设计：displayName 作为工厂的第四字段

```
工厂产出四字段：display / support / loadResult / **displayName**
```

### 2.1 数据流

```
插件 analyze() 返回 displayName（可缺省）
        ↓
服务端取到后写缓存 config/bundle-display-names.json
        ↓
工厂 recompute() 读缓存 → 产出 displayName（没有 ⇒ null）
        ↓
catalog 把 displayName 挂到条目
        ↓
前端 variantText / buildChars 只读 m.displayName；null ⇒ 回落旧规则
```

### 2.2 插件侧：**可缺省**

```ts
analyze(bytes) => {
  displayName?: string | null   // 缺省即不声明；给了就是权威
}
```

```
· 插件不给 ⇒ 工厂产出 null ⇒ 前端回落 `costume > 目录名 > 文件名`（**与现状完全一致**）
· 插件给了 ⇒ 用它
· 给空串 / 只有空白 ⇒ 视为未给（不要用空串表达"没有"）
```

**为什么允许缺省**：目录型条目（`spine-dir` / `live2d-dir`）的名字本来就来自目录名，可读；
内置提供者 `builtin-spine` / `builtin-live2d` 是**纯声明、没有代码**（`builtin-providers.json`），
没有地方可挂 `analyze`。所以缺省必须是合法状态，而不是待办。

### 2.3 核心侧三条约束

```
① 只渲染，不解析：核心把 displayName 原样当文本，不截断、不加前后缀、不猜语义
② 只在"该条目被选中/装载"时取：不批量、不后台预扫
③ 未给则回落旧规则 —— 缺省路径不得改变任何现有显示
```

### 2.4 缓存（归核心，只按 key 存取）

```
位置  <数据根>/config/bundle-display-names.json
键    rootId + rel
值    { displayName, mtimeMs, size }
失效  mtimeMs 或 size 变化
```

缓存不归插件：插件可能被禁用/替换（核心仍要能读到上次结果），且"跨请求存取"属核心职责。

### 2.5 前端回落顺序

```
m.displayName（工厂给的）
  ↓ null
nameIndex.costume（名表）
  ↓ 没有
srcDir 末段（字符目录名）
  ↓ 没有
m.name（文件名，`__data`）
```

### 2.6 角色节点标题的更新

`char` 是加载时归并出来的，`displayName` 可能后到：

```
取到名字后：就地改该 char 的 title + 只重画那一组（不重建 chars，保留展开态与滚动位置）
重建 chars 会丢展开态/滚动位置，且会打乱当前选中项 —— 不采用
```

---

## 三、成本（真实数据，181 个包）

```
包数 181 ｜ 合计 7006MB ｜ 中位 22.0MB
分位 p25=14.9 / p50=22.0 / p75=29.6 / p95=93.8 / max=1297MB
>50MB 共 22 个，合计 3748MB
```

| 包大小 | 读盘 | 解压+解析 | 单包合计 |
|---|---|---|---|
| 15MB | 25ms | 253ms | ~0.28s |
| 22MB（中位） | 160ms | 431ms | ~0.59s |
| 97MB | 673ms | 1134ms | ~1.8s |
| 1297MB | — | **不可行** | 全量解压需 4862MB，实测进程被 OOM 杀 |

**按需解压的收益**：

```
容器头 + blocksInfo   只读头尾，10~14ms
CAB 对象表            解压前 8 块（约 1MB），148ms（全量需 74MB）
TextAsset 名字        在对象记录 dataOffset 处（实测可直接读）
```

---

## 四、内存准入（按契约 §2.2，核心不猜）

```
插件声明 memory：{ decompressedBytes, rgbaBytes?, peakBytes? }
  · decompressedBytes 由 blocksInfo 求和得出，不需要真解压数据块
核心只做一次比较：声明峰值 vs 预算（预算来自 src/server/unpack/capacity.mjs）
  · 声明 peakBytes → 直接采信，不叠加安全垫
  · 未声明 → 回落既有粗估（源文件大小 × 分段倍数）
  · 超预算 → 不取名，条目 warnings 说明，显示回落文件名
```

**核心侧不得出现 `>100MB` 这类阈值常量** —— 那是用源文件大小猜内存代价（实测 R² 0.695）。

---

## 五、失败与降级

| 情形 | 表现 |
|---|---|
| 未安装 analyzer / 被禁用 | 显示文件名（旧行为） |
| 插件未声明 displayName | 显示文件名（旧行为） |
| 分析抛错 | 显示文件名 + 条目 warnings 记原因 |
| 声明峰值超预算 | 显示文件名 +「超出内存预算未取名」 |
| 插件返回空串/null | 显示文件名，不留空、不显示占位符 |

---

## 六、明确不做

```
· 核心侧出现"取 .skel 去后缀""拼大小 + hash"这类格式知识
· 批量预扫 / 后台取名任务（181 个包 2~5 分钟，且大包会 OOM）
· 把 displayName 写进清单（清单是模型索引，显示名是展示态）
· 改 catalog 的 name 字段（它是文件名这一事实，不该被覆盖）
```

---

## 七、与既有机制的关系

| 机制 | 关系 |
|---|---|
| `support`（能否加载） | 同源：都在 `recompute()` 里产出 |
| `kind`（内容类型） | 独立字段；`displayName` 不参与类型判定 |
| `entry.display`（配色/归属） | 独立字段，互不影响 |
| `setEntryState`（单条目回写） | 取到名字后用它重画那一行（或扩展一个同形入口） |
| 名表（`nameIndex`） | 回落链的一环，优先级低于 `displayName` |

---

## 八、验收判据

```
1 插件给了名字的条目：选中后列表显示真名（实测 5 个容器包）
2 未选中过的条目：保持文件名（证明"只对选中项取"）
3 插件未声明 / 返回 null：显示文件名，不留空、不报错（旧行为不变）
4 二次打开命中缓存：零分析（给证据：analyze 调用次数）
5 超大包（声明峰值超预算）：不取名 + warnings 说明
6 核心侧 grep 不到 `.skel` / `.atlas` 这类格式知识
7 角色节点标题与变体行文本**同时**更新（不能只改一处）
```

---

## 九、待定

```
· 多骨架时显示哪个：插件决定（本设计不规定），插件 README 应写明规则
· 同名冲突（不同包同一角色名）：本设计不处理
· 是否把 displayName 一并写进 /api/analyze 的返回缓存：是（同一份文件，避免二次读盘）
```
