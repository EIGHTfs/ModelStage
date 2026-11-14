# 调研 · names 映射能否收进条目工厂

## 一、现状（代码实查）

| 环节 | 现状 | 位置 |
|---|---|---|
| 服务端 | `/api/names?root=` 把 `config/names/<id>.json` **原样**返回 `{byAsset, characters}` | `routes/data.mjs:158` → `data/names.mjs` |
| 服务端立场 | **刻意不认识名表结构**：不做解析、不归一化、不校验业务字段 | `names.mjs:3-9` 原文 |
| 前端取表 | 按根取、跨根合并进 `nameIndex` | `roster/load.js:308 mergeNameTable` |
| 前端匹配 | `lookupName` + `assetCandidates`（原样 → 剥 `_hx` → 剥尾部 `_N`） | `roster/list.js:47 / :85` |
| 前端归并 | `buildChars`：`groupName = nm ? nm.name : charKeyOf(m.name)`，`title = groupName`，变体文本用 `nm.costume` | `roster/list.js:231` |
| 工厂 | **完全不参与** names；`displayName` 是唯一进工厂的展示态名字 | `entry-states.recompute` |

## 二、为什么 displayName 能进工厂、names 不能直接照搬

```
displayName：语义在**插件**（插件解析容器，知道哪个名字是角色名）
            ⇒ 工厂只搬运插件给的字符串，核心不认识格式 —— 边界干净

names     ：匹配规则在**前端**（charKeyOf / assetCandidates / pickName）
            服务端按既有设计**故意不懂名表结构**
            ⇒ 收进工厂 = 把三条业务规则搬到服务端，
              与 names.mjs 的"文件搬运工"原则**直接冲突**
```

## 三、三个方案

| 方案 | 做法 | 代价 | 风险 |
|---|---|---|---|
| **A 维持现状** | 前端匹配不变；工厂只产 `displayName` | 0 | 前端继续持有映射规则（与"工厂统一产出"目标不一致） |
| **B 工厂实现匹配**（若必须收） | 把 `charKeyOf` / `assetCandidates` / `pickName` 三个纯函数搬到服务端；工厂产出 `charName` + `costume`；前端只读字段 | 三个函数 ~40 行 + 工厂字段 ~20 行 + 前端改读 ~30 行（净删 ~40 行）+ 等价性测试 ~80 行 ≈ **150 行 / 1 天** | **归并键迁移**：任一处不等价 ⇒ 现有分组、排序、变体归并全部变化（用户可见） |
| **C 规则声明化** | 把 `charKeyOf` 的正则与 `assetCandidates` 的放宽级数写进名表 `_meta`，工厂按声明执行 | 更大 | 要改名表 schema；旧名表需补字段 |

## 四、方案 B 的等价性怎么证明（关键）

```
对全部 9 个资源根的每个条目，分别算：
  前端现状：charKey / title / 变体归并结果
  工厂新增：charName / costume（同一套规则）
判据：逐条目完全相同（集合 + 顺序都一致），否则不合并
样本量：2322 条目 / 1023 容器（基线已存在 runtime/baseline-displayname.json）
```

必须先有这个对比脚本，再动代码 —— 否则只能靠"看起来对"。

## 五、建议

```
若目标只是"名字由工厂统一产出" → B 可行，但**先写对比脚本**，等价后再切换
若目标是"减少前端代码" → 收益有限（三条规则共 ~40 行），风险却不小
若名表结构以后还要演进 → C 更彻底，但要一起改名表 schema 与校验工具
```

## 六、附带：displayName 引起的分组更新不及时（独立缺陷）

```
现象：加上 displayName 后，分组本身更新不及时，刷新浏览器才正确
根因：charKey 在 buildChars 时按 charKeyOf(m.name) 算（容器条目 m.name = `__data`），
     displayName 后到；paintDisplayName 只改 DOM 文本（.tree-char-title / .tree-variant-text），
     **不改 charKey、不重新分组**
     ⇒ 两个不同角色的包若都叫 `__data`，会被归进同一个 char；
        取到名字后标题变了，但仍在一个组里；刷新后按新名重新归并才正确

修法候选：
  a) 取到名字后**重建该组 chars**，并迁移展开态与选中项（推荐，一次性对齐）
  b) 增量：把该变体从旧 char 移到新 char（省重建，但要处理空组回收与排序）
  c) 不重算分组，只显示名字（现状，用户已明确不满意）

工作量：a ≈ 60~80 行（display-name.js + store 的重建入口 + 展开态映射）
```
