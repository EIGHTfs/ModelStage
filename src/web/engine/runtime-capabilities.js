// engine/runtime-capabilities.js —— 运行时能力探测（一次，缓存）
//
// 设计原则：
//   · **只探测，不看版本号**：拿到命名空间后逐项问"这个方法/类在不在"；
//   · 版本号仅用于日志与 getRendererInfo 展示，不参与任何行为分支；
//   · 探测结果即"能力矩阵"：渲染/纹理/图集/骨架四组，业务层只读该矩阵；
//   · 探测失败不静默：写进 `warns`，由调用方统一打到 log(warn)。
//
// 为什么必须这样做（实测教训）：切片按 4.x 的调用写死了 `texture.bind()`，
//   而 3.8 的纹理对象没有 bind ⇒ 每帧抛错、画面全空且错误被 catch 进 lastError，极难定位。

/** 在命名空间顶层与 `webgl` 子命名空间里找类/方法（3.x 的 WebGL 类只在子命名空间） */
export function pickMember(ns, name) {
  if (!ns) return null;
  if (ns[name] != null) return ns[name];
  const w = ns.webgl;
  if (w && w[name] != null) return w[name];
  return null;
}

/** 探测某个类的原型上是否有指定方法 */
function hasProtoMethod(cls, name) {
  try { return !!(cls && cls.prototype && typeof cls.prototype[name] === 'function'); } catch { return false; }
}

/** 构造签名探测：用 `Function.prototype.length` 判断必填参数个数 */
function arityOf(cls) {
  try { return cls && typeof cls === 'function' ? cls.length : 0; } catch { return 0; }
}

/** 诊断开关：URL 里 `?missing-capability=<key>` 可强制某项探测为 false，用于验证降级路径 */
function simulatedMissing() {
  try {
    const v = new URLSearchParams(window.location.search).get('missing-capability');
    return v ? new Set(v.split(',').map((s) => s.trim()).filter(Boolean)) : new Set();
  } catch {
    return new Set();
  }
}

/**
 * 一次性取出运行时成员（顺序与原实现逐条一致，**不要重排**）。
 * 为什么集中在一处调用而不是各段自己取：成员读取是"读事实"，
 *   集中取能保证四段只做"判断"、不各自重取同一成员 —— 顺序一变，
 *   `pickMember` 的调用序列就变了，等价验证会当场失败。
 * @param {object} spine 运行时命名空间
 */
function collectMembers(spine) {
  return {
    Texture: pickMember(spine, 'Texture'),
    GLTexture: pickMember(spine, 'GLTexture'),
    TextureAtlas: pickMember(spine, 'TextureAtlas'),
    SceneRenderer: pickMember(spine, 'SceneRenderer'),
    SkeletonRenderer: pickMember(spine, 'SkeletonRenderer'),
    OrthoCamera: pickMember(spine, 'OrthoCamera'),
    PolygonBatcher: pickMember(spine, 'PolygonBatcher'),
    SkeletonJson: pickMember(spine, 'SkeletonJson'),
    SkeletonBinary: pickMember(spine, 'SkeletonBinary'),
    AtlasAttachmentLoader: pickMember(spine, 'AtlasAttachmentLoader'),
    Vector2: pickMember(spine, 'Vector2'),
    Skin: pickMember(spine, 'Skin'),
    // 调试绘制渲染器：3.x/4.x 都叫 SkeletonDebugRenderer（个别版本叫 DebugRenderer），没有就只能不画
    SkeletonDebugRenderer: pickMember(spine, 'SkeletonDebugRenderer') || pickMember(spine, 'DebugRenderer'),
  };
}

/** 纹理组：3.x 的 GLTexture 有 bind()/setFilters()；4.x 也有，但若换成 Texture 基类则没有 */
function probeTexture(m, missing, say) {
  const hasBind = say(!missing.has('textureBind') && (hasProtoMethod(m.GLTexture, 'bind') || hasProtoMethod(m.Texture, 'bind')),
    'texture.bind', '纹理对象没有 bind()（批处理器需要它）');
  const hasSetFilters = hasProtoMethod(m.GLTexture, 'setFilters') || hasProtoMethod(m.Texture, 'setFilters');
  const hasDispose = hasProtoMethod(m.GLTexture, 'dispose') || hasProtoMethod(m.Texture, 'dispose');
  return { hasBind, hasSetFilters, hasDispose, glTextureCtor: m.GLTexture, textureCtor: m.Texture };
}

/** 图集组：4.x 的 TextureAtlas 只吃 (data)；3.x 吃 (data, resolver) */
function probeAtlas(m, missing, say) {
  const arity = arityOf(m.TextureAtlas);
  const acceptsResolver = say(!missing.has('atlasResolver') && arity >= 2,
    'atlas.resolver', `TextureAtlas 构造只接受 ${arity} 个参数，纹理需要构造后补挂`);
  return { ctor: m.TextureAtlas, acceptsResolver, arity };
}

/** 渲染器组：3.x SceneRenderer(canvas, gl) 自带相机；4.x 可能只有 SkeletonRenderer(gl) */
function probeRenderer(m, warns) {
  const sceneArity = arityOf(m.SceneRenderer);
  const kind = m.SceneRenderer ? 'scene' : (m.SkeletonRenderer ? 'skeleton' : 'none');
  if (kind === 'none') warns.push('renderer：没有 SceneRenderer / SkeletonRenderer，无法渲染');
  const hasCameraOnScene = !!(m.SceneRenderer && m.SceneRenderer.prototype && 'camera' in m.SceneRenderer.prototype);
  return {
    kind,
    sceneCtor: m.SceneRenderer,
    skeletonCtor: m.SkeletonRenderer,
    sceneArity,
    hasCameraOnScene,
    orthoCtor: m.OrthoCamera,
    orthoArity: arityOf(m.OrthoCamera),
    batcherCtor: m.PolygonBatcher,
    // 调试绘制（bones/meshes/... 八类）：没有构造器时该能力整体不可用，由调用方降级
    debugCtor: m.SkeletonDebugRenderer,
  };
}

/**
 * 骨架组：四个构造器 + skeletonOps 的四项方法探测。
 *
 * `pickMember(spine,'Skeleton')` **只取一次**（局部变量 Skeleton）。
 *   早先这里是 5 次（setToSetupPose 那行因短路写了两遍、其余三项各一次），当时刻意不合并，
 *   理由是"合并会改变成员读取次数这个可观测事实"，留给后续单独一轮处理 —— 本轮就是那一轮：
 *   已合并，读取次数从 5 次（无 Spine 时因短路为 4 次）降为 1 次。
 *   四项探测结果逐项不变；等价脚本的判据也从"读取序列相同"改成"探测结果相同"
 *   （见 tool/.tmp-caps-equiv.mjs 的 diff 注释：读取次数是该优化的目标本身，不能同时当等价标尺）。
 */
function probeSkeleton(spine, m, warns) {
  const Skeleton = pickMember(spine, 'Skeleton');
  const skeletonOps = {
    setToSetupPose: !!(Skeleton && hasProtoMethod(Skeleton, 'setToSetupPose')),
    updateWorldTransform: hasProtoMethod(Skeleton, 'updateWorldTransform'),
    getBounds: hasProtoMethod(Skeleton, 'getBounds'),
    setSkin: hasProtoMethod(Skeleton, 'setSkin'),
  };
  for (const [k, ok] of Object.entries(skeletonOps)) {
    if (!ok) warns.push(`skeletonOps.${k}：缺失（相关功能会降级）`);
  }
  return {
    skeleton: { jsonCtor: m.SkeletonJson, binaryCtor: m.SkeletonBinary, attachmentLoaderCtor: m.AtlasAttachmentLoader, vector2: m.Vector2 },
    ops: skeletonOps,
  };
}

/**
 * 精简矩阵的构造（给 getRendererInfo 展示用）。由返回对象的 `matrix()` 传 this 进来调用，
 *   抽出成独立函数只是为了让 detectCapabilities 本体保持"只做编排"。
 * @param {object} caps detectCapabilities 的产出（必须有 texture/atlas/renderer/skeleton/skeletonOps）
 */
function matrixOf(caps) {
  return {
    textureBind: caps.texture.hasBind,
    textureFilters: caps.texture.hasSetFilters,
    atlasResolver: caps.atlas.acceptsResolver,
    rendererKind: caps.renderer.kind,
    sceneHasCamera: caps.renderer.hasCameraOnScene,
    batcher: !!caps.renderer.batcherCtor,
    skeletonJson: !!caps.skeleton.jsonCtor,
    skeletonBinary: !!caps.skeleton.binaryCtor,
    orthoCamera: !!caps.renderer.orthoCtor,
    skeletonDebug: !!caps.renderer.debugCtor,
    ops: { ...caps.skeletonOps },
  };
}

/**
 * 探测一个运行时命名空间的能力。
 * @param {object} spine 运行时命名空间
 * @param {string} version 版本号（仅记录）
 * @returns {object} 能力矩阵
 */
export function detectCapabilities(spine, version) {
  const missing = simulatedMissing();
  const warns = [];
  /** say：探测结果收集器 —— 不 ok 就记一条 warn，并把 ok 原样返回（供三元/&& 链式使用） */
  const say = (ok, key, reason) => { if (!ok) warns.push(`${key}：${reason}`); return ok; };

  const m = collectMembers(spine);
  const texture = probeTexture(m, missing, say);
  const atlas = probeAtlas(m, missing, say);
  const renderer = probeRenderer(m, warns);
  const sk = probeSkeleton(spine, m, warns);

  return {
    version, // 仅用于展示
    texture,
    atlas,
    renderer,
    skeleton: sk.skeleton,
    skinCtor: m.Skin,
    skeletonOps: sk.ops,
    warns,
    /**
     * 精简矩阵（给 getRendererInfo 展示用）。
     * 这是**返回对象上的方法**，把 `this` 交给 matrixOf 构造 ——
     *   不要改成箭头函数（箭头函数没有自己的 this，会读到模块作用域）；
     *   也不要把 capabilities 深拷贝 / JSON 序列化后跨线程传（this 会失效，调用即抛错）。
     */
    matrix() { return matrixOf(this); },
  };
}

/** 按版本缓存探测结果（同一运行时只探测一次） */
const cache = new Map();

/**
 * 取（或首次探测）某版本的能力矩阵。
 * @param {object} spine
 * @param {string} version
 * @returns {object}
 */
export function capabilitiesFor(spine, version) {
  const key = String(version || 'unknown');
  if (cache.has(key)) return cache.get(key);
  const caps = detectCapabilities(spine, key);
  cache.set(key, caps);
  return caps;
}

/** 清空缓存（测试/重建上下文时用） */
export function resetCapabilities() {
  cache.clear();
}
