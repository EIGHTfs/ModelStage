# 名表 v2 设计方案：本地统一索引表（角色 ID + 多语言名称）

> 设计阶段文档。目标：角色名 / 头像映射不再依赖「每游戏一个转换器 + 外置头像目录」的过渡形态，
> 改为**项目本地维护的统一索引表**，任何新游戏接入只靠「加数据、不改代码」。
> 本方案讨论定稿后再实施（代码改动见各节「改动面」，实施另立任务）。

## 1. 设计目标与痛点

现状（过渡形态，见 `doc/handover.md` §4 标注的「待重设计」项）：

| # | 痛点 | 事实 |
|---|---|---|
| P1 | 主键脆弱：名表以资源目录名（多为拼音）为键 | 碧蓝 16 个未命中目录全是后缀变体（`_ii` / `_new` / 罗马数字），上游表无此键，界面回退显示拼音 |
| P2 | 中文名依赖上游数据 | `nameZh` 全部由上游 JSON 转出，上游缺则空 |
| P3 | 头像与资源仓绑定 | 头像目录被删 → 全破图（已发生两次）；头像源仓与资源仓分离 |
| P4 | 新游戏接入全靠手工写转换器 | 每游戏一个 `import-name-table-*.mjs`，现已 3 个（bd2 / dcg / azurlane） |
| P5 | 覆盖率无运行时记录 | 头像/名字命中数只在生成时算一次，运行时无感知 |

v2 核心思路（本地维护索引表）：

- **一个 `config/index/` 目录，本地手工维护**：每游戏一个索引文件，记录「资源键 → 角色 ID → 多语言名称 → 头像」。
- 角色 ID 用**各游戏原生稳定 ID**（棕尘 2 数字 ID、碧蓝 ship id、胜利女神 c 前缀 ID、蔚蓝 CH 代码），资源目录名降为「匹配线索」。
- 名称支持**多语言**（`nameZh` / `nameEn` / `nameJp` …，按游戏需要填充），**本地手工补的永远优先于上游**（不重跑覆盖）。
- 头像**本地化**进 `data/avatars/<game>/`（git 管或 .gitignore 两案，见 §5），运行期零外仓依赖。
- 上游数据（`data/upstream/`）只当**初始导入的原料**：导入工具把上游转成本地索引表，之后本地表是权威源。

## 2. 数据模型

```
config/index/
  <game>.index.json     # 每游戏一份，本地权威（角色/皮肤/多语言名/头像）
头像库（独立私有仓，见 §4 决策 D2）：
  各游戏头像 png，按 <游戏>/<角色ID>.png 组织，构建/部署时挂载到本机
```

**`config/index/<game>.index.json`（v2 索引表）**

```jsonc
{
  "_meta": {
    "v": 2,
    "game": "碧蓝航线",
    "idSemantics": "ship_id",          // 本游戏角色 ID 的语义（决策 D1：按游戏异构，接受）
    "roots": ["azurlane", "azurlane_spine"],   // 本索引服务的资源根
    "normalize": "strip-suffix:_ii,_new,_hx + roman-numerals",  // 归一化规则（按游戏可配）
    "updatedAt": "…"
  },
  "characters": {
    "62": {                            // 角色 ID（各游戏原生 ID 的字符串形式）
      "name": [                        // 角色名：数组；子字段为各语言名（决策 D3）
        { "lang": "zh", "text": "阿尔比恩" },
        { "lang": "en", "text": "Albion" }
      ],
      "costumes": {                   // 皮肤：皮肤 ID → 多语言名（同结构）
        "3": { "name": [ { "lang": "zh", "text": "晨光里的事故" } ] }
      },
      "avatar": "62.png",             // 头像文件名（相对头像库；无则省略）
      "tags": ["轻巡"]                // 可选，树内筛选用
    }
  },
  "byAsset": {                         // 资源键归一化 → { 角色ID, 皮肤ID? }
    "aerbien_3": { "char": "62", "costume": "3", "how": "upstream" },
    "dahuangfengii_2": { "char": "97", "costume": "2", "how": "manual" }
    // how: upstream（上游导入）| fuzzy（归一化命中）| manual（人工补）
  }
}
```

**多语言名称约定（决策 D3，已定稿）**：

- 角色名与皮肤名统一用 `name` **数组**表达，每个元素 `{ lang, text }`；
- 语言字段**可缺**（某语言没有就不写该元素），但**至少一个**——
  导入工具与 `check` 子命令对「空数组」报错拦截；
- 界面显示顺序：当前界面语言 → 中文 → 数组第一个元素；全部缺失才回退资源目录名。

要点：

- **一张文件管全部**：角色、皮肤、多语言名、头像文件名、资源键匹配全在这份 JSON 里，界面/服务端只读它，不再拼名表 + 匹配表 + icons.dir 三件。
- `byAsset` 的键是**归一化后的资源键**：规则写在 `_meta.normalize`（按游戏可配，如碧蓝去 `_ii/_new/_hx` 及罗马数字尾缀；胜利女神按下划线取前段做角色 ID）。
- **v1 兼容**：`config/names/*.json`（v1 名表）保留只读；服务端读索引表失败时回退 v1，迁移期间双轨。
- **本地优先**：导入工具（`tool/import-index-*.mjs`）只做「上游 JSON → 索引表初稿」，重跑前必须与现表合并（按 `how` 保留 manual 条目，不冲手工数据）。

## 3. 已克隆游戏资源清单（本机实测，2026-10-04）

调查对象：`/volume1/VirtualDSM/DeepSeekHarness/工作区/` 下全部克隆仓。
（机器相关路径，迁移后需重新实测。）

### 资源仓（7 个游戏资源）

| 仓 | 游戏 | 引擎 | 资源根 | 规模 | 目录命名形态 | 自带头像 | 本地名源 |
|---|---|---|---|---|---|---|---|
| `BD2-L2D-Viewer` | 棕色尘埃2 | Spine 4.x | `src/assets/spines/<charID>/` | 227 数字 ID 名源 / 214 角色目录 | 数字 ID `char100101` | ✅ `src/assets/char_icons/` 203 张 `icon_<资源名>.png` | ✅ `src/utils/character_list.ts`：`{"100101": {charName, costumeName, spine, cutscene…}}` |
| `NikkeSpine` | 胜利女神 | Spine | `assets/spine/*.atlas` | 246 atlas / 24 角色 | 前缀 ID `c010_00` / `c010_aim_00` / `c010_cover_00` / `c010_skillcut`（角色号_变体） | ❌ | ⚠️ `assets/names.json` 80 条 `{"c010": {name:"拉毗", skel:["00"]}}`，仓 README 自注「角色名称不全」 |
| `azurlane_spinepainting` | 碧蓝 Spine | Spine 3.8 | `docs/<base>/<skin>/` | 128 目录 / 194 模型 | 拼音 `abeikelongbi_3` | ❌ | ❌ 仓内无（名/头像靠 AzurLaneData 上游 + shipmodels 仓） |
| `AzurLane-Live2D-Viewer-full`（Chaoray） | 碧蓝 Live2D | Cubism 4 | `live2d/<painting>/` | 119 模型 | 拼音 | ✅ `shipmodels/` 目录仓内确认存在（拉取中断未落全，待重拉补） | ❌ 仓内无 |
| `DestinyChildLive2D` | 天命之子 | Cubism 2 | `assets/live2d/<dir>/` | 拉取中（旧数据 2185 条目） | 拼音 | ✅ 各目录自带 `icon.png` | ✅ 仓内 `childs.json`（已留档 `data/upstream/destinychild/`） |
| `blue-archive-viewer` | 蔚蓝档案 | Live2D | `public/data/{jp,en}/…/<角色代码>_<皮肤>/` | 240 atlas（jp+en 双语言） | 角色代码 `CH0996_home` / `Airi_home`（仓 README 记录 `ibuki_home → CH0077` 重命名规则） | ❌ | ⚠️ `public/data/*/Preload/TableBundles/Excel/LocalizeCharProfileExcelTable.json` 等游戏内表格（多语言本地化表，可当名字源初稿） |
| `AzurLane-Live2D-Viewer`（kka-aris） | 碧蓝 Live2D（精简） | Cubism 4 | `assets/<painting>/` | 22 模型 | 拼音 | ❌（仓内无 shipmodels，tarball 实测确认） | ❌ 与全量仓重复，保留作对照 |

### 查看器仓（4 个，无游戏资源，价值在运行时资产）

| 仓 | 价值 |
|---|---|
| `spive2d` | Cubism 4 运行时全套：`static/lib/live2dcubismcore/framework.min.js` + `pixi.min.js` 8.19（已知 Cubism 4 挂起组合，`resolve-live2d-runtimes` 的 PIXI6 优先规则即源于此） |
| `ShinySpineViewer` | `pixi-spine.js` + `pixi.min.js`（Spine 4 渲染参考） |
| `spine-viewer-webgl` | 纯前端查看器，运行时走 CDN，无本地资产 |
| `live2d-viewer-web` | 同上 |

### 对 v2 设计的关键结论

1. **棕尘 2 名源即 v2 索引表的现成样板**：数字 ID 主键 + 皮肤多态（`spine` / `cutscene` / `dating` 三个资源位），`idSemantics` 可直接照搬。
2. **名字源形态三种**：仓内集中 JSON（Nikke `names.json` / 天命 `childs.json`）、仓内表格（蔚蓝 `Excel` 本地化表）、仓内无（碧蓝靠上游 `data/upstream/`）——索引表把三者统一成同一 schema，来源差异只体现在导入工具里。
3. **目录命名四形态**：数字 ID（BD2）、拼音（碧蓝/天命）、前缀 ID_变体（Nikke `c010_aim_00`）、角色代码_皮肤（蔚蓝 `Airi_home`）——`byAsset` 归一化规则必须**按游戏可配**（`_meta.normalize` 字段，如「下划线切分取前段做角色 ID」），不能全局一刀切。
4. **头像三形态**：根内外置目录（BD2 `char_icons/`）、仓内同名目录（碧蓝 `shipmodels/`）、目录自带 `icon.png`（天命）——§4 的本地化提取器需覆盖三条路。
5. **蔚蓝档案是双语言先例**：`public/data/jp` 与 `public/data/en` 各一套资源 → `roots` 字段支持一个索引服务多根（jp / en 各算一根，`_meta.roots` 已预留）。

## 4. 头像本地化（独立私有仓暂存，决策 D2 已定稿）

- 组织：`<游戏>/<角色ID>.png`（皮肤级头像 `<角色ID>_<皮肤ID>.png`，可选）。
- 暂存形态：**单独一个私有仓**（如 `EIGHTfs/spine-multi-viewer-avatars`）存全部游戏头像，
  不进主项目仓（主仓保持轻量，clone 快）。本机部署时拉到固定位置，
  `resources.json` 的头像根指向它（或主仓 `.gitignore` 掉 `data/avatars/`，
  该目录是「私有仓的本机克隆」，README 写清来源仓与拉取命令）。
- 三条提取路（一次性工具，`tool/extract-avatars/<game>.mjs`，提取后可删）：
  1. 资源目录自带 `icon.png`（天命）→ 首扫时拷入。
  2. 仓内头像目录（碧蓝 `shipmodels/`、棕尘 `char_icons/`）→ 全量拷入并按索引表重命名为 `<角色ID>.png`。
  3. 无源 → 占位图（界面兜底，不阻塞）。
- 仓库拆分后的纪律：头像仓只进 png 与清单 json（每游戏一份 `<角色ID>→文件名` 映射），
  不混入代码；主仓的 index.json `avatar` 字段与清单键一致。

## 5. 决策记录（2026-10-04 讨论定稿）

- **D1 角色 ID 语义按游戏异构：接受**。`_meta.idSemantics` 写明每游戏 ID 语义
  （ship_id / charID / c 前缀 / CH 代码），界面只显示名字不显示 ID，异构无碍使用。
- **D2 头像不入主仓，入单独私有仓暂存**。组织与纪律见 §4；主仓 index.json 只存
  `avatar` 文件名，文件本体在头像仓。
- **D3 多语言名用 `name` 数组**（元素 `{ lang, text }`）：子字段（语言）可缺，
  但数组不能为空（`check` 拦截空数组）。蔚蓝档案 `jp` 资源后续加 `jp` 元素即可，结构不变。
- **D4 界面补录：以后再讨论**。本期只做「未命中红点提示 + 手工改 index.json」，
  不做写回端点。
- **D5 蔚蓝档案的 Excel 本地化表可以导入**：写该仓的导入工具，
  从 `public/data/*/Preload/TableBundles/Excel/LocalizeCharProfileExcelTable.json`
  抽角色名/多语言名作 index 初稿（`how: upstream`），人工再补。

## 6. 扩展新游戏的最小步骤（v2 生效后）

1. 克隆资源仓到本机（资源仓与项目仓分离，资源不进项目 git）。
2. 写 `config/index/<game>.index.json` 初稿：`_meta`（idSemantics / roots / normalize 规则）+ 名字源（仓内表 / 上游 JSON / 手工）。
3. 头像：跑对应提取器进头像仓的 `<game>/`（或置空占位），头像仓推送、本机拉取。
4. `resources.json` 加根，`names` 字段改指新 index（v2 读 index、缺则回退 v1 名表）。
5. 界面跑通：`byAsset` 命中项正常聚合，未命中项红点提示 → 手工补 `byAsset`（`how: manual`）。

## 7. 改动面（实施时，设计阶段不写代码）

| 子系统 | 改动 | 说明 |
|---|---|---|
| `tool/name-table-spec.mjs` | 升 v2 schema + v1 迁移函数 | 旧 `config/names/*.json` 自动转 index 初稿；`check` 拦空 `name` 数组 |
| 新建头像仓 `EIGHTfs/spine-multi-viewer-avatars`（私有） | 各游戏 png + 清单 json | 本机部署时克隆；主仓 `.gitignore` 掉 `data/avatars/` |
| `server.mjs` | 只改两块：名表读取（index 优先、v1 兜底）+ `resolveIconUrl`（头像仓目录优先） | 不扩大改动面，改完过 `tool/verify.mjs` |
| `public/char-tree.js` | 聚合键改「资源键 → 归一 → byAsset → 角色 ID」 | 未命中红点 + `how` 提示 |
| 导入工具 | 每游戏一个 `tool/import-index-<game>.mjs`（替代 import-name-table-*） | 只产出 index 初稿，合并时保留 manual；蔚蓝用 Excel 表（D5） |
| `resources.json` | 碧蓝两根 path 切全量仓 `live2d/`；`icons.dir` v2 下弃用 | 天命 icon.png 自动拷入机制生效 |
| 文档 | `doc/handover.md` §4 / `README` 名表章节 / `data/upstream/README`「待重设计」节关闭 | 随实施提交 |

## 8. 验证标准（实施后）

1. 各游戏 index.json 全过 `node tool/name-table-spec.mjs check`（v2 校验，新增子命令；空 `name` 数组报错）。
2. 碧蓝 16 个未命中目录清零（normalize 规则覆盖 `_ii` / `_new` / 罗马数字后缀）。
3. 断源测试：删掉全部资源仓，头像仓 + index.json 仍能显示名字与头像。
4. 回归：`showSeq` 守卫、跨格式聚合（阿尔比恩同挂 Live2D + Spine）行为不变，无头渲染自检通过。
