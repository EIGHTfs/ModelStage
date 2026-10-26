# 插件扩展点：renderer + panel（以「清晰度增强」为第一个案例）

> 调研日期：2026-10-26 ｜ **仍属调研/设计阶段，不落地代码**
> 目标：借「清晰度档位」这个真实功能，把契约里留位的两类插件角色跑通
> —— `renderer`（目前核心内部实现、未开放注册）与 `panel`（目前留位）。

---

## 一、现状：五类角色各自到哪一步（代码实测）

| 角色 | 契约里声明的接口 | 实际状态 |
|---|---|---|
| `asset-provider` | `canHandle(file)` / `resolve(file)` | ✅ **已落地**：`infra/plugin-host.js` 全链路接线（`/api/plugins` → 注入 `files[]` → `register` → prefilter / findProvider / materialize） |
| `renderer` | `mount(document, host)` / `unmount()` | ⚠️ **核心内部实现，未开放给插件注册**（live2d / spine 两个渲染器是内置模块） |
| `editor` | `Document` 读写 + `applyCommand(cmd)` | 留位 |
| `exporter` | `Document` 只读 + 写输出 | 留位 |
| `panel` | `mountPanel(slot)` | 留位 |

两个关键既有事实（决定了插件怎么接最省事）：

```
① 右面板是**纯声明式控件表**（panel/schema.js：分组 → 控件 → 选项全是数据），
   渲染逻辑与样式都从表来 ⇒ 插件"加一个开关"本质是**往表里合并一节数据**，
   不需要插件操作 DOM
② 渲染器用 capabilities.settings 声明自己支持哪些设置键
   （live2d 现为 ['textureFilter','fps','dpr','presetFilter','animation','speed']）
   ⇒ 插件想加"清晰度"键，必须让宿主把它并进能力键白名单，否则面板控件存不住值
```

---

## 二、设计取舍：不开放「整块渲染器替换」，先开放两条细粒度扩展点

`renderer` 契约原本的形态是 `mount(document, host) → 渲染一类内容`。
那意味着插件**接管整个渲染**（自建 canvas、自己做相机、自己实现 PIXI/WebGL）。
对"加一个锐化档位"来说这是杀鸡用牛刀，而且风险极高（渲染器是最难回退的一层）。

所以第一版只开放两条**受限扩展点**，都挂在既有渲染器之上：

```
A. 效果扩展（renderer 角色下的能力）
   插件声明：registerEffect({ id, label, fragment, uniforms })
   宿主：把 fragment 合并进既有片元注入管线
         · Spine —— engine/filters.js 的 __FILTER__ 模板（已有注入机制）
         · Live2D —— PIXI 自定义 Filter（片元同源）
   约束：只允许片段着色器表达式 + 一组标量 uniform，**不允许插件碰渲染器生命周期**

B. 控件扩展（panel 角色）
   插件声明：registerControls({ group, controls: [...] })
   宿主：把这一节并入 panel/schema.js 的表，panel.js 照常渲染
   约束：只允许声明式控件（开关 / 档位 / 按钮），**不允许插件塞任意 DOM 或内联样式**
```

这两条合起来，就是用户要的「renderer + panel 两类插件真实接入」的最小闭环：
**面板出现开关 → 打开后渲染管线多一段效果 → 关掉即还原**。

---

## 三、目标形态（插件清单 + 导出）

### 3.1 清单（`plugins/<id>/plugin.json`）

```json
{
  "id": "sharpness",
  "name": "清晰度增强",
  "provides": ["renderer", "panel"],
  "produces": { "kind": null },
  "effects": [{ "id": "sharpness", "label": "清晰度" }]
}
```

> `provides` 里同时声明两个角色：`renderer` 表示"我贡献一段渲染效果"，
> `panel` 表示"我贡献面板控件"。两者独立验证，缺一个也能跑（只开关不生效要在面板里置灰）。

### 3.2 导出（浏览器侧脚本，沿用现有经典脚本形态）

```js
// 与 unity-live2d-bundle 同一套装载方式（非 ESM，挂 host 注册）
const host = window.SpineViewerPlugins;

host.registerEffect({
  id: 'sharpness',
  label: '清晰度',
  // 片段着色器表达式：入参 c = 当前像素（直通 alpha），uv = 纹理坐标，u = uniform
  fragment: 'clamp(c + u_amount * (c - textureSample(uv - u_texel).rgb), 0.0, 1.0)',
  uniforms: { u_amount: { type: 'float', min: 0, max: 1, default: 0.35 } },
});

host.registerControls({
  group: '设置',
  controls: [
    { id: 'sharpness', kind: 'segmented', label: '清晰度', options: ['关', '轻', '强'] },
  ],
});
```

---

## 四、宿主侧要改的点（实现时照这张表做）

| # | 位置 | 改什么 | 风险 |
|---|---|---|---|
| 1 | `web/infra/plugin-host.js` | 收集 `registerEffect` / `registerControls`，暴露给渲染层与面板层 | 低（与 asset-provider 同一模式） |
| 2 | `server/routes/plugins.mjs` | 清单校验新增 `effects` 字段（可选数组，id 唯一） | 低 |
| 3 | `web/engine/filters.js` | 片元注入支持"效果链"：预设滤镜之后再串插件效果 | 中（注入模板要能拼多段） |
| 4 | `web/render/live2d.js` | PIXI Filter 链支持插件效果 | 中（PIXI 滤镜顺序影响结果，需固定顺序） |
| 5 | `web/panel/schema.js` | 提供合并入口：内置表 + 插件控件节（分组名冲突要报错，不能静默覆盖） | 中（面板控件数被测试断言，见下） |
| 6 | 能力键白名单 | 插件声明的 effect id 自动进 `capabilities.settings` | 低 |
| 7 | `test/browser/panel-actions.js` | 控件计数是断言基线（当前 25）；插件控件会让数量变化 ⇒ 断言要按"内置 + 插件"分组校验 | 中（不改就是必然挂） |

---

## 五、必须同时定下的三条纪律

```
① 能力键白名单必须显式：插件没声明 effects 就不能往 settings 里塞键，
   否则面板能选、渲染层不认，变成"选了没反应"的静默失败
② 插件缺失/加载失败要降级可见：面板控件置灰 + 提示，而不是消失（消失后用户
   会以为是自己记错了）
③ 效果必须可逆：关掉档位要完全还原（不能残留 uniform 或滤镜实例），
   验收用"开→关→再截图与原始帧逐像素相同"
```

---

## 六、验收（将来实现时照这个查）

```
1. 插件装上：右面板出现「清晰度」控件，位于约定的分组里
2. 开「轻」：同机位截图边缘梯度上升（≥5%），且与原图 SSIM 不下降（防过锐化）
3. 开→关：截图与未开启状态**逐像素相同**（可逆性）
4. 拔掉插件目录：面板控件置灰并给出原因，渲染不受影响
5. 插件声明的 effect id 不在白名单里时：清单校验阶段就报错（不进入运行期）
6. 回归：panel-actions 的控件计数断言按"内置 + 插件"分组通过；spine/live2d 两条链各测一次
```

---

## 七、分两步走（建议）

```
第 1 步：只做 panel 角色（控件能出来、能存能读，但效果先挂到既有滤镜上）
  → 验证"插件往面板加控件"这条链路，改动面最小，且能立刻看到东西

第 2 步：再接 renderer 角色的效果扩展（片段着色器合并 + 能力键白名单 + 可逆性验收）
  → 这一步才是真正的渲染链路接入，风险集中在这里
```

> 不建议一上来就开放"整块渲染器替换"（`mount(document, host)` 交给插件）：
> 那需要把相机、Surface、DPR、内存准入全部暴露出去，回退成本极高。
> 先用效果扩展跑通一个真实插件，等第二个真实需求出现再谈整块开放。

---

## 八、与超分调研的关系

「清晰度」这个功能是**载体**，不是目的。它同时满足两个条件：
① 真实有用（相机放大后糊确实存在）② 天然需要 panel 控件 + 渲染期效果。

但要注意：**效果扩展能给的是锐化/边缘放大，不是超分**（补不出像素）。
若以后真要"补像素"，那属于资产变换型插件（见 `docs/设计/贴图超分辨率调研.md` §9.3），
与本方案的扩展点不冲突，可以并存。
