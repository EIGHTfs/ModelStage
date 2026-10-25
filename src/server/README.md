# src/server/ —— 共用服务端数据层

把原先内联在 `server.mjs` 里的只读数据逻辑抽成**不依赖 http、不读端口**的模块，让 8803（旧前端）
与 8804（新前端）可以共用同一份实现，最终新前端能脱离旧端独立运行。

过渡期仍由 `server.mjs` 继续服务（本目录与旧实现并行存在），切换在后续步骤进行。

## 装配方式

```js
import { createServerData } from './src/server/index.mjs';

const data = createServerData({ root: <项目根绝对路径> });

data.config.readConfig()            // 资源根配置
data.tree.listTree(id, rel)         // → { status, body }
data.models.getModels(cfg, force)   // Spine 模型清单（文件缓存）
data.live2d.getLive2DModels(cfg, f) // Live2D 模型清单（文件缓存）
data.modelMeta.readModelMeta(id, p) // → Promise<{ status, body }>
data.bundleProbe.probeBundle(id, p) // → Promise<{ status, body }>
```

约定：

- **只读**接口统一返回 `{ status, body }`，由调用方决定怎么发响应（JSON 序列化方式保持
  `JSON.stringify` 无缩进，与 `server.mjs` 的 `sendJson` 一致，便于逐字节比对）；
- 项目根由调用方注入（`createPaths({ root })`），模块内不写死绝对路径；
- 写接口（`/api/roots` POST、`/api/config/import`、`/api/diag`）**不在此层**：过渡期保持
  「单写者」（只有 8803 写 `config/` 与 `data/`），避免两进程并行写产生竞态。

## 模块划分

| 文件 | 职责 |
|---|---|
| `paths.mjs` | 由项目根推导 config/plugins/tool/data 下的位置 |
| `env.mjs` | `.env` 极简解析 + `1/0,true/false,on/off,yes/no` 归一 |
| `config.mjs` | 资源根配置读写（保留注释头、tmp+rename）、按 name 归并的分组视图、配置导出 |
| `plugins.mjs` | 展示类型插件发现、启停开关、`fileKind` 可用性、资源包容器魔数识别 |
| `probe.mjs` | 版本号/atlas 键/贴图页探测、越界路径解析、MIME 表（纯函数） |
| `models.mjs` | Spine 模型扫描与清单缓存（`config/models.<rootId>.json`） |
| `live2d.mjs` | Live2D 模型扫描与清单缓存（`config/live2d.<rootId>.json`）、运行时库探测 |
| `names.mjs` | 角色名表读取（`config/names/<id>.json`） |
| `tree.mjs` | 目录树列举（`/api/tree` 数据层：Spine 三件套识别、bundle 可见性） |
| `model-meta.mjs` | Spine 元数据（`/api/model-meta` 数据层，按需 import 解析器 + 动作规则缓存） |
| `bundle-probe.mjs` | UnityFS 资源包预检（`/api/bundle/probe` 数据层） |
| `browse.mjs` | 服务端目录浏览（`/api/browse` 数据层） |
| `index.mjs` | 装配入口 `createServerData({ root })` |

## 等价性验证

抽离后必须证明「响应逐字节不变」，验证方式是：用本目录模块重放同一批 URL 的响应体，
与旧实现（8803）的真实响应比 `sha256`。已覆盖的 URL 与结果记录在交付报告里。

## 技术债（抽离阶段刻意保留原行为，不在重构中顺带修改）

1. **6 个接口未校验 HTTP method**：`/api/tree`、`/api/spine/models`、`/api/live2d/models`、
   `/api/names`、`/api/browse`、`/api/file` 不检查 `req.method`，POST 也会照常返回数据。
   抽离阶段以「行为逐字不变」为唯一目标，未修正；后续单独任务处理（补 405）。
2. **无 `Range` / `HEAD` 支持**：静态文件与 `/api/file` 等大文件一律 `Content-Length` + 全量流，
   HEAD 请求也会带 body。做断点续传/视频拖动时需要单独实现（属于独立任务）。
3. **写接口未进本层**：`/api/roots`(POST)、`/api/config/import`、`/api/diag` 仍留在 `server.mjs`，
   过渡期维持单写者；等 8804 完全独立后再评估（需先解决两进程写同一份 `config/` 的竞态）。
4. **静态托管与首页注入仍在 `server.mjs`**：`index.html` 的 store 锚点注入、防闪屏 CSS、
   `window.__APP_BRAND__` 都是旧前端（`dist/` + React）特化逻辑，共用层不应知道这些。
5. **`/api/names` 未切到本层（保留 `server.mjs` 旧实现）**：本层的 `getNameTable()` 带
   **进程内缓存**，且只有「有时返回表 / 无时返回 null」两态；而旧路由是「**每次现读文件** +
   文件缺失返回 404 + 解析失败返回 500」三态。直接切换会改变可观测行为（结果被缓存化、404 变 200），
   与「抽离阶段行为逐字不变」冲突，故保留旧实现。
   将来若要统一：需在本层新增一个「无缓存 + 三态返回」的读取函数（属于新增逻辑，不在抽离范围内，
   也需先与调用方确认 404/500 的对外契约是否保留）。
