# ModelStage · 前端（`src/web/`）

纯 HTML + 原生 ES 模块 + 手写 CSS，无构建步骤。页面与接口由同一个服务提供
（`src/server/serve.mjs`：静态文件 + `/api/*` + `/files/*` 模型资源），同源、无反向代理。

## 一、怎么起

```bash
bash web.sh start|stop|restart|status   # 默认 8804
```

打开 `http://<本机IP>:8804/`。

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8804` | 监听端口 |
| `MODELSTAGE_AVATAR_ROOT` | `<项目根>/avatars` | 头像根（也可用 `--avatar-root` 传）|

启停一律走 `web.sh`（PID 与日志由脚本统一管理，不要用 nohup）。

## 二、目录结构

```
src/web/
├── index.html        五区域骨架：顶栏 / 左栏（名册）/ 舞台 / 右栏 / 底栏
├── style.css         变量 + 基础重置 + 舞台 + 五区域容器几何
├── components.css    控件外观：品牌、按钮、搜索框、三级树行、分组行、底栏、错误横幅
├── main.js           入口：只做装配（品牌、面板开关、资源根、名册挂载、渲染器、错误兜底、__WEB__）
├── transport.js      底部播放条渲染
│
├── infra/            与业务无关的基础设施
│   ├── api.js        同源 JSON 请求封装（统一错误口径）
│   ├── vfs.js        内存资源视图（登记表 + 字节缓存）
│   ├── diag.js       诊断探针 __DIAG__（错误/警告/关键事件 + 落盘）
│   └── plugin-host.js 插件宿主适配
│
├── roster/           左栏名册
│   ├── list.js       数据层：按根取清单 + 名表归并 + 角色聚合
│   ├── filter.js     搜索过滤
│   ├── view.js       视图层：状态、事件、懒加载、选中态、持久化
│   └── rows.js       三级树行渲染（纯 DOM 工厂，无状态）
│
├── panel/            右栏控制面板
│   ├── schema.js     控件声明（9 组 + 播放条）
│   ├── view.js       手风琴渲染（能力不支持的不构建）
│   ├── shell-controls.js / dom.js / memory-bar.js
│   └── panel.css     右栏/播放条内部样式
│
├── render/           舞台与渲染面
│   ├── surface.js    渲染面：几何唯一来源、背景模式、渲染器切换与生命周期
│   ├── spine.js      Spine 渲染器
│   ├── live2d.js     Live2D 渲染器
│   ├── interaction.js 交互层：滚轮/拖动/双指/重置
│   └── camera/       统一相机（范围、步进、钳制）
│
├── spine/            Spine 运行时（引擎封装、多版本运行时选择）
├── live2d/           Live2D 运行时（库加载、模型挂载、缩放平移桥）
└── debug/            调试（环形日志、日志面板、模型差异采集）
```

**目录约定**

| 目录 | 放什么 | 不放什么 |
|---|---|---|
| `infra/` | 通用能力（请求、存储、诊断） | 模型/渲染逻辑 |
| `roster/` `panel/` | 左右栏的视图与数据 | 渲染与相机 |
| `render/` | 渲染面、渲染器、相机、交互 | 具体模型的加载（在 `spine/`、`live2d/`） |
| `spine/` `live2d/` | 各自运行时的加载与能力封装 | 跨渲染器公共逻辑 |
| `debug/` | 日志与排障 | 生产路径依赖 |

规则：单文件 ≤ 400 行；文件名不带模块前缀（目录已表达归属）；`main.js` 只装配。

## 三、尺寸与相机的唯一来源

| 事 | 唯一负责人 | 约束 |
|---|---|---|
| 舞台几何（CSS 像素） | `render/surface.js` 的 `geometry()` | 渲染器只读取，不得自行测 DOM |
| 背板像素尺寸 | 由 `geometry()` 推导后交给渲染器 | 不允许第二处 DPR 计算 |
| 相机（范围/步进/锚点/复位） | `render/camera/index.js` | 唯一钳制点，Spine 与 Live2D 语义一致 |
| 交互（滚轮/拖动/双指） | `render/interaction.js` | 绑 `surface.interactionTarget`，不绑某块画布 |
| 背景（棋盘/纯色/透明） | `surface.setBackground()` | 写 `data-bg` 的唯一入口，渲染器不画背景 |

调参只改 `render/camera/constants.js`（`MIN 0.125 / MAX 16 / STEP 0.1 / FIT_MARGIN 0.05`），逻辑里不出现同样的裸数字。

## 四、品牌与标题

品牌不写死在前端：启动时 `GET /api/brand` 取 `title` / `icon` / `iconKind`，同时应用到顶栏与 `document.title`；
配置为空时回落默认名 `ModelStage`。

- `iconKind === 'text'`：按文字/emoji 渲染
- `iconKind === 'image'`：按 `<img>` 渲染（站内绝对路径 / http(s) / data:）
- 均空：保留 `index.html` 里的内联 SVG 图标

改配置后刷新即生效，无需重启。

## 五、诊断（`window.__DIAG__`）

`main.js` 在模块体第一件事就安装它，保证早期错误也能抓到。

采什么（只收错误/警告/关键事件，不做每帧采样）：

- `window.onerror`（含 img/script/link/video/audio 资源加载失败，capture 阶段）
- `unhandledrejection`
- 包装 `console.error / warn / info`（幂等；内部日志不自激）
- 业务主动上报：`__DIAG__.event('stage.load', { … })`

```js
__DIAG__.__installed     // 已安装
__DIAG__.errors()        // error 级条目
__DIAG__.warnings()
__DIAG__.timeline()      // 一行一条时间线（便于贴出来排查）
__DIAG__.tail(10) / dump() / size() / clear() / flushNow()
```

落盘：批量 `POST /api/diag` → 追加写 `data/diag.jsonl`；失败静默降级为仅内存，不影响页面。

## 六、自定义背景图存储（`data/backgrounds/`）

- 索引 `index.json`：原子写（tmp → fsync → rename），进程内串行排队，避免并发上传互相覆盖
- 文件名由服务端生成（`bg-<时间戳>-<随机>.<ext>`），不用用户提供的名字
- 删除：文件移入 `data/backgrounds/.trash/`（可恢复），索引同步移除
- 上限 5MB；只收 png / jpeg / webp（按文件头判定，不信 Content-Type 与扩展名）；
  刻意不收 gif —— 动画背景在软渲染机上持续重绘，与「暂停不空转」冲突

| 方法 | 路径 | 说明 | 失败码 |
|---|---|---|---|
| GET | `/api/backgrounds` | 列表（新的在前） | — |
| POST | `/api/backgrounds` | 上传（原始二进制 + `x-filename` 显示名） | `too-large`(413) / `bad-type`(415) / `empty`(400) / `disk-error`(500) |
| POST | `/api/backgrounds/rename` | 只改显示名，重名自动加 `(2)` | `bad-name`(400) / `not-found`(404) |
| POST | `/api/backgrounds/delete` | 删除（文件进 `.trash/`） | `not-found`(404) |
| GET | `/api/backgrounds/file/<id>` | 出图（只查索引，不拼路径） | `not-found`(404) |

`data/backgrounds/` 是部署侧数据：换机或备份要一起带走（已 gitignore）。

## 七、自测方式

自动门禁只跑 node-test（13 套，约 100s）；浏览器注入脚本在 `test/browser/`，手动单跑。

```bash
node tool/test-all.mjs                     # 自动门禁（13 套 node-test）
node tool/test-all.mjs --only f3-reveal    # 单跑一个浏览器脚本
node tool/test-all.mjs --browser           # 把浏览器脚本也纳入
```

三道静态/数据门禁，失败即拦：

```bash
node tool/check-wiring.mjs    # 控件声明 ↔ 接线
node tool/check-index.mjs     # 名表结构校验
node tool/check-single-source.mjs
```

零错误自证（四类信号：console.error / 未捕获异常 / 浏览器 error 日志 / 4xx 与请求失败）：

```bash
node tool/check-console.mjs http://127.0.0.1:8804/     # 有错退出码 2
```

### 浏览器脚本的硬规矩

1. **前置条件由脚本自己建立或自己断言**，不依赖「上次跑时环境正好合适」
2. **不出现硬编码绝对路径**：需要路径的一律由调用方传参或从项目相对位置派生
3. **缺前置 = skip，不是 fail**：文案以 `skipped:` 开头，报告里单列计数；该失败的仍然 fail

| 脚本 | 前置 | 传参 |
|---|---|---|
| `f1-controls` | 页面已启动；至少一个能扫出模型的资源根 | 无（自动发现） |
| `f2-topbar` | 同上（截图要有画面可截） | 无 |
| `f3-reveal` | 名册有足够长的列表 | 无（自己挑变体最多的游戏） |
| `f4-roots` | 服务端存在探针目录 | **要**：`?f4probe=<服务端已存在目录>` |
| `spine-actions` | 至少一个能扫出模型的根；WebGL 可用 | 无 |
| `panel-actions` / `roster-actions` / `anim-list` / `debug-drag` | 页面已启动 | 无 |

F4 的探针目录别用点开头的隐藏目录（`/api/browse` 不列隐藏项，会被预检判成不存在）。

### 页面状态快照

```js
window.__WEB__.rosterSnapshot()
// → { games:[{key,name,roots,status,sources,chars,variants,miss}],
//     expandedGames, expandedChars, keyword, selected, domRows }
```

自动化断言也读这个出口。

## 八、决策记录

1. **一级节点按 name 合并**：一个游戏一个节点，角色**跨根归并**（同一角色的 Live2D 与 Spine 聚成一个）
2. **搜索补加载全部游戏**：首次输入关键词时并行拉齐各游戏（服务端有清单缓存，实测 <1s）。
   取舍：宁可多一次请求，也要搜得到 —— 只搜已展开的游戏会让人以为列表缺内容
3. **不做区域几何 diff 工具**：视觉已降级，改用截图比对或人工核对
4. **改左栏行为后先跑 `roster-actions`**（穷举实操 + 断言）
5. **名字与头像来自名表**，不从资源目录名现场推断：目录名只作匹配线索，名字以名表为准
