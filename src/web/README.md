# ModelStage · 新前端（`src/web/`）

纯 HTML + 原生 ES 模块 + 手写 CSS 的前端实现，与旧前端（`src/app-shell.html` + `src/js/**` + `public/**`）
**双栈并行**：旧前端继续跑在 8803 作对照端，新前端跑在 8804，逐块替换、逐块比对。

设计依据：`doc/前端重写路线图.MD`（功能 8 块 / L1 视觉 + L2 结构 + L3 行为三层判据 / M1~M8 里程碑）、
进度看板：`doc/任务-前端重写.md`。

## 一、目录结构

```
src/web/
├── index.html        五区域骨架：顶栏 / 左栏 / 舞台 / 右栏 / 底栏
├── style.css         变量 + 基础重置 + 舞台 + 五区域容器几何（尺寸对齐旧前端实测 rect）
├── components.css    控件外观：品牌、按钮、资源根列表、右栏分组行、底栏分组、错误横幅
├── main.js           入口：品牌、面板开关、资源根加载、错误兜底、window.__WEB__ 调试出口
├── api.js            同源 JSON 请求封装（统一错误口径，M2+ 复用）
├── roots-list.js     资源根列表渲染（M2 将扩展为 游戏→角色→变体 三级树）
└── dev-server.mjs    零依赖开发服务：静态托管 src/web + 反代 /api 到上游
```

CSS 拆成两个文件只为把单文件控制在 400 行内：`style.css` 管"在哪、多大"，`components.css` 管"长什么样"。

后续里程碑在同目录追加：`char-tree.js`（M2 名册）、`panel.js` + `transport.js`（M3 面板与播放条）、
`stage.js`（M4 舞台渲染）、`store.js`（M7 持久化）。单文件上限 400 行。

## 二、怎么起

```bash
# 前提：旧前端已在 8803 运行（提供 /api/* 数据）
bash server.sh status

# 启动新前端（8804）
cd <项目根>
PORT=8804 UPSTREAM=http://127.0.0.1:8803 node src/web/dev-server.mjs
```

后台启动（开发期常用）：

```bash
nohup node src/web/dev-server.mjs > /tmp/modelstage-web8804.log 2>&1 &
```

打开：`http://<本机IP>:8804/`

环境变量（都有默认值，不写死）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8804` | 新前端监听的端口（**不得占用 8803**） |
| `UPSTREAM` | `http://127.0.0.1:8803` | 能力层上游实例，`/api`、`/files`、`/icons`、`/live2d-lib` 反代到它 |

> 为什么反代而不是让页面直连上游：`/api/roots` 等接口没有发 CORS 头，跨源 `fetch` 会被浏览器拦；
> 反代后新前端全程同源，M2+ 的 `/api/tree`、`/api/models` 同样可直接用。

## 三、品牌与标题

品牌**不写死在前端**：启动时 `GET /api/brand` 取 `title` / `icon` / `iconKind`，同时应用到顶栏与
`document.title`；服务端配置为空（返回 `null`）时回落到默认品牌名 `ModelStage`。

- `iconKind === 'text'`：当文字/emoji 渲染
- `iconKind === 'image'`：当 `<img>` 渲染（站内绝对路径 / http(s) / data:）
- 两者均空：保留 `index.html` 内置的内联 SVG 图标

改配置后刷新页面即生效，无需重启服务。

## 四、当前进度（M1）

已完成：

- [x] `index.html` 五区域骨架，几何与旧前端在 1920×1080 实测值**逐值一致**
      顶栏 `[0,0,1920,48]` / 左栏 `[0,48,304,968]` / 舞台铺满 `[0,0,1920,1080]` /
      右栏 `[1744,48,176,968]` / 底栏浮条 `[600,1023,720,42]`
- [x] `style.css` 手写深色主题（背景 `#131416`、卡片 `#1f2326`、主色 `#1fc0c5`、棋盘格舞台）
- [x] 品牌走 `GET /api/brand`：顶栏标题、`document.title`、图标三处同源；空配置回落 `ModelStage`
- [x] `main.js` 拉 `/api/roots` 渲染资源根列表；失败时左栏红条提示，不抛控制台
- [x] 顶栏「模型库」= 左栏显示/隐藏（位移 + 淡出，非 `display` 切换）；「全屏」接原生 API
- [x] `dev-server.mjs` 零依赖静态服务 + `/api` 反代；起在 8804，不碰 8803
- [x] 控制台 0 错误、无横向滚动条（`scrollWidth == clientWidth == 1920`）

未做（后续里程碑）：

- [ ] 左栏三级树 / 搜索 / 选中态（M2）；届时左栏文案与旧前端对齐（面板标题「角色库」、
      按钮「选择目录」，M1 现在是「模型库 / ＋ 资源根」，因为此刻列的是资源根而不是角色）
- [ ] 右栏控件与底栏播放条接线（M3 / M6）
- [ ] 舞台渲染（M4 Spine、M5 Live2D）
- [ ] 持久化与设置导入导出（M7）
- [ ] `__WEB__.state` 目前只是最小容器，M7 换成带 localStorage 的 store
- [ ] 顶栏空闲自动隐藏（旧前端空闲时把 header 上移 48px，新前端目前常显）

## 五、自测方式

```bash
# 1) 首页确实是新前端
curl -s http://127.0.0.1:8804/ | head

# 2) 反代通（数据与旧前端同源）
curl -s http://127.0.0.1:8804/api/roots | head -c 200
curl -s http://127.0.0.1:8804/api/brand

# 3) 渲染结果与旧前端一致：页面把渲染出的资源根 id 序列写到 <html data-roots-ids>，
#    可用浏览器控制台对照 8803 的 /api/roots
#    document.documentElement.dataset.rootsIds
```

## 六、建议与待决（给 Lead 的裁决项）

1. **缺 L2/L3 的可跑断言工具**：现在"五区域位置正确、控制台 0 错误"靠一次性脚本手工量，
   建议在 `tool/` 补两个脚本（`src/web/` 之外，需你拍板）：
   - `tool/check-console.mjs <url>`：CDP 打开页面，收集 `console.error` / 未捕获异常 / 失败请求，
     有错即非零退出（M1 验收第 3 条可自动化，不用每次人眼核）
   - `tool/diff-rect.mjs <urlA> <urlB> <选择器清单>`：两站点逐区域 rect 比对，超阈值即报错
     （L1/L2 的定量版本，M2 起每个里程碑都能一键回归）
   我本地已用等价脚本验过 M1，但脚本放在 `/tmp`，不入库。
2. **旧前端顶栏会自动隐藏**（空闲时 `translateY(-48px)`），新前端目前常显。
   L1 截图比对时两边状态不同会误判，建议比对脚本先统一"顶栏可见/隐藏"再截。
3. **`src/web/` 外需要的东西**（`server.sh` 加 8804 的 start/stop 分支、PID 文件落项目根）
   都涉及 `src/web/**` 以外的文件，我先不动；需要时按你的裁决做。
