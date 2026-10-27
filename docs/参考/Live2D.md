# 参考 · Live2D

> Live2D 渲染面的运行时接入要点：模块划分、运行时库加载顺序、覆盖层与生命周期、
> VirtualFS 介入点、以及几个只读探针。
>
> 相机语义与钳制规则见[设计/相机](../设计/相机.md)；渲染器接口见[渲染面契约](../契约/渲染面.md)；
> 资源位置解析见[数据与接口契约](../契约/数据与接口.md) §1。

---

## 一、模块划分

```
src/web/live2d/
├── stage.js          对外入口：createLive2DStage({ vfs, getOverlayHost, log })
├── stage-ctx.js      共享上下文（st）+ 运行时库加载
├── pixi-app.js       PIXI Application 的创建与校准
├── overlay.js        覆盖层容器（OVERLAY_ID = 'live2d-overlay'）
├── model.js          模型装载 / 卸载 / 重排
├── bridge.js         相机与播放的桥（只被渲染面的相机 backend 消费）
├── view.js           视图状态（缩放/位移）
├── vfs-settings.js   把 VirtualFS 接到库的 resolveURL 钩子
├── release.js        资源释放（releaseLive2DResources）
└── probe*.js         只读探针（几何 / 播放 / 通用）
```

**分文件的原因**：这几块的生命周期不同（库只加载一次、app 每次激活重建、模型每次装载重建），
合在一个文件里最容易出现「该释放的没释放、该保留的被重建」。

---

## 二、运行时库加载顺序（不可颠倒）

```
1. /live2d-lib/live2dcubismcore.min.js   ← 必须最先（库初始化时检查它）
2. /live2d-lib/live2d.min.js
3. /live2d-lib/pixi.min.js
4. /live2d-lib/index.min.js              ← pixi-live2d-display 入口
```

- 以 `<script>` 追加方式**懒加载**（首次需要 Live2D 时才拉，约 1.4MB）
- 顺序错了的典型报错：`PIXI.live2d 不存在：运行时库顺序或版本不匹配`
- 加载失败必须报出**具体是哪个文件**，否则只看到"Live2D 起不来"

---

## 三、覆盖层与几何

```
覆盖层容器：position:absolute; inset:0（= 舞台的 100%），不参与布局、不改变舞台尺寸
覆盖层 canvas：与容器等大，pointer-events: none（Spine 画布保持可命中）
```

**两条硬约束**：

1. **覆盖层与舞台逐像素重合** —— 断言 `overlayRect === stageRect`（每次 activate 与 resize 后）
2. **禁止在隐藏态读尺寸** —— `display:none` 时 `clientWidth/Height` 为 0，
   渲染器会退回默认尺寸；从隐藏变可见后**必须重新校准一次**

尺寸的完整三条等式见[设计/相机](../设计/相机.md) §五。

---

## 四、生命周期

| 时机 | 做什么 |
|---|---|
| **装载** | 建（或复用）PIXI Application + 覆盖层 canvas → 加载模型 → 播第一个动作 |
| **卸载（同面换内容）** | 销毁 PIXI app + 移除覆盖层容器 + 状态复位；渲染器实例本身不销毁，下次靠重建覆盖层 |
| **释放（换渲染面 / Surface 销毁）** | 在卸载基础上彻底释放，不留旧 GL 上下文 |
| **resize** | 覆盖层 rect 跟随舞台重算 → 渲染器校准 → 模型重排 |

**为什么卸载也要销毁 PIXI app**：app 持有一个 WebGL 上下文与整棵 display tree。
只把覆盖层 `hide()` 属**遗留自建 GL 资源**，而且连续切换会让上下文数量随切换次数增长。

**为什么卸载保留覆盖层 DOM 的移除动作**：`app.destroy(true)` 会把 canvas 摘掉只留容器，
留下「容器在、canvas 不在」的中间态；下游若按容器复用，就会渲染到**不在 DOM 的游离画布**上
（页面全白，而统计与像素采样都正常）。所以代价最低的做法是：卸载即全量移除，下次重建。

> 重建复用容器时**必须同时**确认容器里有 canvas，缺了就补建 —— 不能依赖「上游永远不制造那个中间态」。

---

## 五、VirtualFS 介入点

该库所有内部文件（moc3 / 贴图 / physics / 动作）的相对引用解析**全部收敛到单一钩子**
`settings.resolveURL`（库自带的「拖文件夹上传」功能就是覆盖它）。

```js
// vfs-settings.js
installResolver(settings, {
  resolve: (url) => vfs.resolve(url) || url,   // 命中用 Blob URL，未命中回落原 URL
});
```

**不需要** patch fetch、不需要装加载器中间件。这个钩子的存在与否是「能不能干净接入」的分界线。

**一条真实限制**：`blob:` 不能作为相对引用的**基址**
（`new URL('textures/b.bin', 'blob:http://host/uuid')` 会抛 Invalid URL），
所以不能简单把「基址」换成 blob 地址 —— 必须逐引用解析。

---

## 六、相机与播放

- 相机：`bridge.js` 只作为渲染面的**相机 backend**（`getScale/setScale/pan/resetView`），
  档位与钳制由统一相机负责，**bridge 内不再夹范围**（双层钳制会让上层改不动）
- 播放：动作标签 →（group, index）→ `model.motion(group, index)`；
  未知标签返回 `false` 而不是抛错

---

## 七、只读探针

| 探针 | 用途 |
|---|---|
| `probe-geometry.js` | 读模型几何（内部尺寸 / display / 包围盒 / 实际绘制范围），供跨模型 diff |
| `probe.js` | 通用状态快照 |
| `playback-probe.js` | 播放状态（当前 group / index / 是否在动） |
| `probe-geometry.js` 的 `alphaProbe` | 逐帧取像素 → alpha 包围盒，用于测算「主体实际占多大」 |

诊断字段的完整清单与判定规则见[设计/相机](../设计/相机.md) §九。

---

## 八、已知限制

1. **纹理格式**：现网资源以 ETC2 为主；ASTC / PVRTC / BC6H / BC7 未实现，会抛带格式号的错误
2. **多皮肤未验证**：当前资产库中模型 skin 数普遍为 1，多皮肤路径没有真实数据覆盖
3. **主体包围盒**：Live2D 无骨骼/插槽概念，`fit` 的 `subject` 语义只能用 alpha 包围盒近似，
   与 Spine 的部件名黑名单不等价

## 九、PIXI Filter 的 fragment 约束（6.5.3，页面内实测）

**PIXI 只注入两行前导**，其余全靠 fragment 自己声明：

```js
// 页面内实测：new PIXI.Filter(null, frag, uniforms).program.fragmentSrc
"precision mediump float;\n#define SHADER_NAME pixi-shader-6\n<传入的 frag 原样>"
```

⇒ `varying vec2 vTextureCoord` 与 `uniform sampler2D uSampler` **必须由 fragment 自己写**
（PIXI 自己的 `Filter.defaultFragmentSrc` 就是手写的这两行，可作参照）。
省略它们得到 `ERROR: 0: 'uSampler' : undeclared identifier`；
连 `precision mediump float;` 一起省掉会报 `shader couldn't be compiled` 并整屏空白。

最小可用 fragment：

```glsl
precision mediump float;
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
void main() {
  vec4 texColor = texture2D(uSampler, vTextureCoord);   // PIXI 纹理是预乘 alpha
  float a = texColor.a;
  vec3 c = texColor.rgb / max(a, 0.00001);              // 还原直通色再算
  gl_FragColor = vec4(c * a, a);                        // 再乘回预乘
}
```

构造签名是 `new PIXI.Filter(vertexSrc|null, fragmentSrc, uniforms)`（`PIXI.Filter.length === 3`），
`filter.uniforms` 是**真实普通对象**，直接 `filter.uniforms.u_x = v` 即可；
而 spine-webgl 的 Shader 没有 `uniforms` 属性，必须 `bind()` + `setUniformf/setUniform2f` ——
两条链路的 uniform 写法**不通用**，别互抄。

---

## 修改记录

- 由原「Live2D 桥接接口清单」重写。
- **原文描述的对象已不存在**：它逐行列举了一个已删除的引擎如何通过全局对象委托给 bridge
  （含引擎方法行号、全局 `window.__LIVE2D_STAGE__` 的形状）。引擎重写后这些委托全部移除，
  该文开头自己也标注了「描述的是已删除的切片引擎」。保留行号会让人去找不存在的代码。
- 改为描述**当前实现**的模块划分与生命周期，保留仍然有效的部分：
  运行时库加载顺序（4 步，未变）、覆盖层几何约束、VirtualFS 的 `settings.resolveURL` 介入点、
  `blob:` 不能作相对基址这一限制。
- 删除「待确认」小节：其中的问题（模型 URL 字段、覆盖层归属、切回时序）均已在实现中确定。
