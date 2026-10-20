// engine/runtime-capabilities.js —— 运行时能力探测（一次，缓存）
//
// 设计原则：
//   · **只探测，不看版本号**：拿到命名空间后逐项问"这个方法/类在不在"；
//   · 版本号仅用于日志与 getRendererInfo 展示，不参与任何行为分支；
//   · 探测结果即"能力矩阵"：渲染/纹理/图集/骨架四组，业务层只读该矩阵；
//   · 探测失败不静默：写进 `warns`，由调用方统一打到 log(warn)。
//
// 为什么必须这样做（实测教训）：旧引擎切片按 4.x 的调用写死了 `texture.bind()`，
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
 * 探测一个运行时命名空间的能力。
 * @param {object} spine 运行时命名空间
 * @param {string} version 版本号（仅记录）
 * @returns {object} 能力矩阵
 */
export function detectCapabilities(spine, version) {
  const missing = simulatedMissing();
  const warns = [];
  const say = (ok, key, reason) => {
    if (!ok) warns.push(`${key}：${reason}`);
    return ok;
  };

  const Texture = pickMember(spine, 'Texture');
  const GLTexture = pickMember(spine, 'GLTexture');
  const TextureAtlas = pickMember(spine, 'TextureAtlas');
  const SceneRenderer = pickMember(spine, 'SceneRenderer');
  const SkeletonRenderer = pickMember(spine, 'SkeletonRenderer');
  const OrthoCamera = pickMember(spine, 'OrthoCamera');
  const PolygonBatcher = pickMember(spine, 'PolygonBatcher');
  const SkeletonJson = pickMember(spine, 'SkeletonJson');
  const SkeletonBinary = pickMember(spine, 'SkeletonBinary');
  const AtlasAttachmentLoader = pickMember(spine, 'AtlasAttachmentLoader');
  const Vector2 = pickMember(spine, 'Vector2');
  const Skin = pickMember(spine, 'Skin');

  // 纹理：3.x 的 GLTexture 有 bind()/setFilters()；4.x 也有，但若换成 Texture 基类则没有
  const textureHasBind = say(!missing.has('textureBind') && (hasProtoMethod(GLTexture, 'bind') || hasProtoMethod(Texture, 'bind')),
    'texture.bind', '纹理对象没有 bind()（批处理器需要它）');
  const textureHasSetFilters = hasProtoMethod(GLTexture, 'setFilters') || hasProtoMethod(Texture, 'setFilters');
  const textureHasDispose = hasProtoMethod(GLTexture, 'dispose') || hasProtoMethod(Texture, 'dispose');

  // 图集：4.x 的 TextureAtlas 只吃 (data)；3.x 吃 (data, resolver)
  const atlasArity = arityOf(TextureAtlas);
  const atlasAcceptsResolver = say(!missing.has('atlasResolver') && atlasArity >= 2,
    'atlas.resolver', `TextureAtlas 构造只接受 ${atlasArity} 个参数，纹理需要构造后补挂`);

  // 渲染器：3.x SceneRenderer(canvas, gl) 自带相机；4.x 可能只有 SkeletonRenderer(gl)
  const sceneArity = arityOf(SceneRenderer);
  const rendererKind = SceneRenderer ? 'scene' : (SkeletonRenderer ? 'skeleton' : 'none');
  if (rendererKind === 'none') warns.push('renderer：没有 SceneRenderer / SkeletonRenderer，无法渲染');
  const hasCameraOnScene = !!(SceneRenderer && SceneRenderer.prototype && 'camera' in SceneRenderer.prototype);
  const orthoArity = arityOf(OrthoCamera);

  // 骨架能力
  const skeletonOps = {
    setToSetupPose: !!(pickMember(spine, 'Skeleton') && hasProtoMethod(pickMember(spine, 'Skeleton'), 'setToSetupPose')),
    updateWorldTransform: hasProtoMethod(pickMember(spine, 'Skeleton'), 'updateWorldTransform'),
    getBounds: hasProtoMethod(pickMember(spine, 'Skeleton'), 'getBounds'),
    setSkin: hasProtoMethod(pickMember(spine, 'Skeleton'), 'setSkin'),
  };
  for (const [k, ok] of Object.entries(skeletonOps)) {
    if (!ok) warns.push(`skeletonOps.${k}：缺失（相关功能会降级）`);
  }

  return {
    version, // 仅用于展示
    texture: { hasBind: textureHasBind, hasSetFilters: textureHasSetFilters, hasDispose: textureHasDispose, glTextureCtor: GLTexture, textureCtor: Texture },
    atlas: { ctor: TextureAtlas, acceptsResolver: atlasAcceptsResolver, arity: atlasArity },
    renderer: {
      kind: rendererKind,
      sceneCtor: SceneRenderer,
      skeletonCtor: SkeletonRenderer,
      sceneArity,
      hasCameraOnScene,
      orthoCtor: OrthoCamera,
      orthoArity,
      batcherCtor: PolygonBatcher,
    },
    skeleton: { jsonCtor: SkeletonJson, binaryCtor: SkeletonBinary, attachmentLoaderCtor: AtlasAttachmentLoader, vector2: Vector2 },
    skinCtor: Skin,
    skeletonOps,
    warns,
    /** 精简矩阵（给 getRendererInfo 展示用） */
    matrix() {
      return {
        textureBind: this.texture.hasBind,
        textureFilters: this.texture.hasSetFilters,
        atlasResolver: this.atlas.acceptsResolver,
        rendererKind: this.renderer.kind,
        sceneHasCamera: this.renderer.hasCameraOnScene,
        batcher: !!this.renderer.batcherCtor,
        skeletonJson: !!this.skeleton.jsonCtor,
        skeletonBinary: !!this.skeleton.binaryCtor,
        orthoCamera: !!this.renderer.orthoCtor,
        ops: { ...this.skeletonOps },
      };
    },
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
