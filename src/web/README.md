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

- [x] 一级 = 资源根（**逐个**一行，与 `/api/roots` 完全对应），二级 = 角色，三级 = 变体
- [x] **逐根懒加载**：启动只拉 `/api/roots`；首次展开某根才请求该根的
      `/api/names?root=` + `/api/models?root=`（Live2D 根回落到 `/api/live2d/models`，
      bundle 根走 `/api/tree` 的 `kind:'bundle'` 条目）；已加载过的根再展开不再发请求
- [x] 角色归并规则逐条照 `public/char-tree.js`：`charKeyOf`（去 `cutscene_` / `_hx` / `_N`）、
      `assetCandidates` 逐级放宽查表、命中用英文名归组 + 标题「中文名 英文名」、
      变体排序立绘在前技能在后、角色排序普通角色在前 NPC 在后
- [x] 实测归并结果：`bd2` 389 模型 → 109 角色（名表 miss 仅 1）、`azurlane` 119 → 78、
      `azurlane_spine` 194 → 175、`azurlane_bundle` 19 → 18
- [x] 搜索：角色名 / 服装名 / 资源名 / 目录名（前端过滤；首次输入时并行补加载各根，之后走内存）
- [x] 选中态：点变体行高亮（`aria-selected` + `.is-selected`），再点别的行自动切换
- [x] 展开/折叠 + 「收起」按钮（只清空展开状态，面板保留）
- [x] 状态持久化沿用旧前端键名 `spine-multi-viewer.tree-state.v1`（`games` / `chars` / `activeGame` / `lastByGame`）
- [x] 键盘可达：树行 `tabindex=0`，Enter / 空格等价于点击
- [x] 未接线控件全部 `disabled` 并标注「待接线（M3/M6）」（顶栏导入/截图导出/菜单/影院模式、左栏选择目录、底栏 8 个）
- [x] 穷举实操 32 项全过 + 控制台零错误（`tool/check-console.mjs`）

未做（后续里程碑）：

- [ ] 右栏控件与底栏播放条接线（M3 / M6）
- [ ] 舞台渲染（M4 Spine、M5 Live2D）
- [ ] 设置导入导出（M7）
- [ ] 顶栏空闲自动隐藏（旧前端空闲时把 header 上移 48px；视觉已降级，M6 再谈）
- [ ] `tool/diff-rect.mjs`（已获批但 M2 未用到；M3 控件清单核对时再做）

## 五、自测方式

```bash
# 1) 零错误自证（含四类信号：console.error / 未捕获异常 / 浏览器日志 error / 4xx 与请求失败）
node tool/check-console.mjs http://127.0.0.1:8804/
# 有错退出码 2，可直接进 CI/验收脚本

# 2) 穷举实操 + 断言（脚本在页面里跑，返回值随报告一起打印）
node tool/check-console.mjs http://127.0.0.1:8804/ --script <动作脚本.js> --json

# 3) 反代与数据源
curl -s http://127.0.0.1:8804/api/roots | head -c 200
curl -s http://127.0.0.1:8804/api/brand

# 4) 页面状态快照（浏览器控制台里读，自动化断言也用这个）
#    window.__WEB__.rosterSnapshot()
#    → { roots:[{id,status,source,chars,variants,miss}], expandedRoots, expandedChars, keyword, selected, domRows }
```

## 六、建议与待决（给 Lead 的裁决项）

1. **一级节点按"资源根"还是按"游戏名合并"**：旧前端 `char-tree.js` 按 `rootName` 合并同名根
   （碧蓝的 3 个根会并成 1 个游戏节点 → 全站只 2 个游戏）。M2 按你的验收条目「左栏显示 4 个游戏根」
   实现为**一根一行**，因此同名根会出现 3 次（用 id 徽标区分）。两种都能一键切换，等你裁决。
2. **`web.sh restart` 有 bug**（见第二节说明）：脚本内部 `"$0"` 在 `bash web.sh` 调用下是相对名，
   导致 `web.sh: command not found`。属你的维护范围，我没改。
3. **搜索会补加载全部根**：输入关键词时为做全局过滤会并行拉齐 4 个根（服务端有清单缓存，实测 <1s）。
   若你更希望"只搜已展开的根"，改一行即可。
4. `tool/diff-rect.mjs` 已获批但 M2 未用到（视觉已降级）；建议放到 M3 做"控件清单核对"时一起写。
