# ModelStage · 新前端（`src/web/`）

纯 HTML + 原生 ES 模块 + 手写 CSS 的前端实现，与旧前端（`src/app-shell.html` + `src/js/**` + `public/**`）
**双栈并行**：旧前端继续跑在 8803 作对照端，新前端跑在 8804，逐块替换、逐块比对。

设计依据：`doc/前端重写路线图.MD`（功能 8 块 / L1 视觉 + L2 结构 + L3 行为三层判据 / M1~M8 里程碑）、
进度看板：`doc/任务-前端重写.md`。

## 一、目录结构

```
src/web/
├── index.html        五区域骨架：顶栏 / 左栏（角色库）/ 舞台 / 右栏 / 底栏
├── style.css         变量 + 基础重置 + 舞台 + 五区域容器几何（尺寸对齐旧前端实测 rect）
├── components.css    控件外观：品牌、按钮、搜索框、三级树行、右栏分组行、底栏分组、错误横幅
├── main.js           入口：品牌、面板开关、资源根加载、名册挂载、错误兜底、window.__WEB__ 调试出口
├── api.js            同源 JSON 请求封装（统一错误口径）
├── roster.js         名册数据层：按根取模型清单 + 名表合并 + 角色归并（规则照 public/char-tree.js）
├── roster-view.js    名册视图层：状态、事件、懒加载、搜索过滤、选中态、持久化
├── roster-rows.js    三级树的行渲染（纯 DOM 工厂，无状态）
└── dev-server.mjs    零依赖开发服务：静态托管 src/web + 反代 /api 到上游
```

CSS 拆两个文件、行渲染单独成文件，都是为把单文件控制在 400 行内；职责见各文件头注释。

后续里程碑在同目录追加：`panel.js` + `transport.js`（M3 面板与播放条）、`stage.js`（M4 舞台渲染）、
`store.js`（M7 持久化）。单文件上限 400 行。

## 二、怎么起

```bash
# 前提：旧前端已在 8803 运行（提供 /api/* 数据）
bash server.sh status

# 启动新前端（8804）
cd <项目根>
PORT=8804 UPSTREAM=http://127.0.0.1:8803 node src/web/dev-server.mjs
```

后台启停用项目根的脚本（**不要用 nohup**，PID/日志由脚本统一管理）：

```bash
bash web.sh start|stop|restart|status     # 默认 8804，上游 8803
```

> 注意：`bash web.sh restart` 目前在脚本内部用 `"$0"` 调用自身，`$0` 为相对名 `web.sh` 时会报
> `web.sh: command not found`；请用 `bash web.sh stop && bash web.sh start` 两步重启（脚本属 Lead 维护范围，未改）。

打开：`http://<本机IP>:8804/`

环境变量（都有默认值，不写死）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8804` | 新前端监听的端口（**不得占用 8803**） |
| `UPSTREAM` | `http://127.0.0.1:8803` | 能力层上游实例，`/api`、`/files`、`/icons`、`/live2d-lib` 反代到它 |

> 为什么反代而不是让页面直连上游：`/api/roots` 等接口没有发 CORS 头，跨源 `fetch` 会被浏览器拦；
> 反代后新前端全程同源，`/api/tree`、`/api/models` 同样可直接用。

## 三、品牌与标题

品牌**不写死在前端**：启动时 `GET /api/brand` 取 `title` / `icon` / `iconKind`，同时应用到顶栏与
`document.title`；服务端配置为空（返回 `null`）时回落到默认品牌名 `ModelStage`。

- `iconKind === 'text'`：当文字/emoji 渲染
- `iconKind === 'image'`：当 `<img>` 渲染（站内绝对路径 / http(s) / data:）
- 两者均空：保留 `index.html` 内置的内联 SVG 图标

改配置后刷新页面即生效，无需重启服务。

## 四、当前进度

### M1 骨架（已完成）

- [x] `index.html` 五区域骨架，几何与旧前端在 1920×1080 实测值**逐值一致**
      顶栏 `[0,0,1920,48]` / 左栏 `[0,48,304,968]` / 舞台铺满 `[0,0,1920,1080]` /
      右栏 `[1744,48,176,968]` / 底栏浮条 `[600,1023,720,42]`
- [x] `style.css` 手写深色主题（背景 `#131416`、卡片 `#1f2326`、主色 `#1fc0c5`、棋盘格舞台）
- [x] 品牌走 `GET /api/brand`：顶栏标题、`document.title`、图标三处同源；空配置回落 `ModelStage`
- [x] `dev-server.mjs` 零依赖静态服务 + `/api` 反代；起在 8804，不碰 8803
- [x] 控制台 0 错误、无横向滚动条

### M2 名册三级树（已完成）

- [x] 一级 = **游戏**（按资源根配置的 name 合并同名根，照 `char-tree.js` 的 buildTree 规则）：
      碧蓝航线的 3 个根（azurlane / azurlane_spine / azurlane_bundle）合并成 **1 个游戏节点**，
      节点上标「N 根」（title 列出根 id）。二级 = 角色，三级 = 变体
- [x] **按游戏懒加载**：启动只拉 `/api/roots`；首次展开某游戏才请求它名下各根的
      `/api/names?root=` + `/api/models?root=`（Live2D 根回落到 `/api/live2d/models`，
      bundle 根走 `/api/tree` 的 `kind:'bundle'` 条目）；已加载过的游戏再展开不再发请求
- [x] **角色跨根归并**：同一游戏下把各根模型并成一个数组再归并，同一角色来自不同根的变体
      落在**同一个角色节点**下（实测：阿尔比恩 = Live2D `aerbien_3` + Spine `aerbien_4`）
- [x] 归并规则逐条照 `public/char-tree.js`：`charKeyOf`（去 `cutscene_` / `_hx` / `_N`）、
      `assetCandidates` 逐级放宽查表、命中用英文名归组 + 标题「中文名 英文名」、
      变体排序立绘在前技能在后、角色排序普通角色在前 NPC 在后、角色键 `char:游戏名|组名`
- [x] 实测规模（与旧前端一致）：**2 游戏 / 354 角色 / 721 变体**
      —— 棕色尘埃2 109 角色 / 389 变体；碧蓝航线 245 角色 / 332 变体（3 根跨根归并后）
- [x] 搜索：角色名 / 服装名 / 资源名 / 目录名（前端过滤；首次输入时并行补加载各游戏，之后走内存）
- [x] 选中态：点变体行高亮（`aria-selected` + `.is-selected`），再点别的行自动切换
- [x] 展开/折叠 + 「收起」按钮（只清空展开状态，面板保留）
- [x] 状态持久化沿用旧前端键名 `spine-multi-viewer.tree-state.v1`（`games` / `chars` /
      `activeGame` 存游戏名 / `lastByGame` 按游戏名存上次模型 id）
- [x] 键盘可达：树行 `tabindex=0`，Enter / 空格等价于点击
- [x] 未接线控件全部 `disabled` 并标注「待接线（M3/M6）」（顶栏导入/截图导出/菜单/影院模式、左栏选择目录、底栏 8 个）
- [x] 穷举实操 31 项全过 + 控制台零错误（`test/roster-actions.js` + `tool/check-console.mjs`）

未做（后续里程碑）：

- [ ] 右栏控件与底栏播放条接线（M3 / M6）
- [ ] 舞台渲染（M4 Spine、M5 Live2D）
- [ ] 设置导入导出（M7）
- [ ] 顶栏空闲自动隐藏（旧前端空闲时把 header 上移 48px；视觉已降级，M6 再谈）

## 五、自测方式

```bash
# 1) 零错误自证（四类信号：console.error / 未捕获异常 / 浏览器日志 error / 4xx 与请求失败）
node tool/check-console.mjs http://127.0.0.1:8804/
# 有错退出码 2，可直接进 CI/验收脚本

# 2) 穷举实操 + 断言（脚本在页面上下文里执行，结果随报告一起打印）
node tool/check-console.mjs http://127.0.0.1:8804/ --script test/roster-actions.js
#    动作脚本的形态约定：文件内容是一个自求值 async IIFE，返回值即结果
#    （这样既能在页面里 await，又能通过 node --check 的语法检查）

# 3) 反代与数据源
curl -s http://127.0.0.1:8804/api/roots | head -c 200
curl -s http://127.0.0.1:8804/api/brand

# 4) 页面状态快照（浏览器控制台里读，自动化断言也用这个）
#    window.__WEB__.rosterSnapshot()
#    → { games:[{key,name,roots,status,sources,chars,variants,miss}],
#        expandedGames, expandedChars, keyword, selected, domRows }
```

## 六、决策记录（已裁决）

1. **一级节点按 name 合并**：与旧前端 `char-tree.js` 一致（2 个游戏节点），角色**跨根归并**。
   早期一版按一根一行实现（4 个节点），已按裁决改回合并口径。
2. **搜索补加载全部游戏**：为做全局过滤，首次输入关键词时并行拉齐各游戏（服务端有清单缓存，
   实测 <1s）。取舍：宁可多一次请求，也要搜得到——只搜已展开的游戏会让人以为列表缺内容。
3. **`tool/diff-rect.mjs` 不做**：视觉已降级，区域几何改用 `tool/shot-compare.mjs` 或人工核对。
4. **穷举动作脚本入库在 `test/roster-actions.js`**：M2 的回归脚本，改左栏行为后先跑它。
