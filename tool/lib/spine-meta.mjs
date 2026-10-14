// ============================================================================
// tool/lib/spine-meta.mjs —— Spine 模型的元数据提取（服务端，供 /api/model-meta）
//
// 产出与 Cubism 的 modelMeta **同字段名**，让新前端用一套代码吃两种模型：
//   { kind:'spine', version, designSize:{width,height}, bbox:{x,y,width,height,unit,pose},
//     bones, slots, animations, skins, runtime:{origin} }
//
// 口径与限制（与 Cubism 侧一致，写进文档）：
//   · designSize = SkeletonData 的 width/height（Spine 的设计画布尺寸）
//   · bbox = **rest pose（setup pose）**下的可视包围盒，单位是模型单位，不含动作/物理变形
//
// 错误码（SPINE_ERR_*，同一失败原因永远同一码）：
//   SPINE_ERR_BAD_ARGS / SPINE_ERR_NO_FILE / SPINE_ERR_BAD_VERSION / SPINE_ERR_NO_RUNTIME / SPINE_ERR_PARSE
// ============================================================================

import { loadRuntime, listRuntimeVersions } from './spine-runtime.mjs';
import { classifyAll } from './spine-motions.mjs';

export const SPINE_CODES = {
  BAD_ARGS: 'SPINE_ERR_BAD_ARGS',
  NO_FILE: 'SPINE_ERR_NO_FILE',
  BAD_VERSION: 'SPINE_ERR_BAD_VERSION',
  NO_RUNTIME: 'SPINE_ERR_NO_RUNTIME',
  PARSE: 'SPINE_ERR_PARSE',
};

function fail(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  err.ulb = true;
  if (extra && typeof extra === 'object') Object.assign(err, extra);
  return err;
}

/** 从 JSON 骨架里取版本（skeleton.spine，如 "3.8.99"） */
function versionFromJson(bytes) {
  try {
    const j = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    const v = j && j.skeleton && j.skeleton.spine;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * 探测 .skel 二进制里的版本号。
 *   格式：前 8 字节是 hash，紧随其后是版本——**3.8 起是字符串**（1 字节长度 + 字符），
 *   更早（3.6/3.7）是 4 字节小端 float。两种都试，取合理值。
 * @returns {string|null} 形如 '3.8' / '4.2'
 */
export function detectSpineVersion(bytes, fileName) {
  if (!bytes || !bytes.length) return null;
  const isJson = /\.json$/i.test(fileName || '') || bytes[0] === 0x7b; // '{'
  if (isJson) {
    const v = versionFromJson(bytes);
    if (!v) return null;
    const m = v.match(/^(\d+)\.(\d+)/);
    return m ? `${m[1]}.${m[2]}` : null;
  }
  // 二进制：不同版本的头部布局不完全一样（实测 3.8 是「8 字节 hash + 20 字符 hash 串 + 版本串」），
  //   所以不假设固定偏移，而是在前 64 字节里扫两种特征：
  //     ① 「长度字节 + 形如 数字.数字 的短字符串」——版本号总是这种形态
  //     ② 合理的 float32（更老的格式直接存 float 版本）
  const limit = Math.min(bytes.length, 64);
  for (let i = 0; i + 1 < limit; i++) {
    const len = bytes[i];
    if (len < 3 || len > 16) continue;
    if (i + 1 + len > bytes.length) continue;
    // 只要求"开头像版本号"（数字+点+数字）：有的版本会把版本串按长度补满，尾部未必还是数字/点
    let s = '';
    for (let k = 0; k < Math.min(len, 8); k++) {
      const c = bytes[i + 1 + k];
      if ((c >= 0x30 && c <= 0x39) || c === 0x2e) s += String.fromCharCode(c);
      else break;
    }
    const m = s.match(/^(\d+)\.(\d+)/);
    if (m) return `${m[1]}.${m[2]}`;
  }
  // float 兜底（3.6 / 3.7 这类老格式）
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 8; i + 4 <= limit; i++) {
    const f = dv.getFloat32(i, true);
    if (Number.isFinite(f) && f > 2 && f < 5 && Math.abs(f - Math.round(f * 10) / 10) < 0.001) {
      return f.toFixed(1);
    }
  }
  return null;
}

/** 选最接近的可用运行时版本（精确命中优先，否则取同 major 的最大 minor） */
function pickRuntimeVersion(want) {
  const all = listRuntimeVersions();
  if (!all.length) return null;
  if (all.includes(want)) return want;
  const major = String(want).split('.')[0];
  const sameMajor = all.filter((v) => v.split('.')[0] === major).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return sameMajor.length ? sameMajor[sameMajor.length - 1] : null;
}

/** 读 setup pose 的可视包围盒（模型单位）；拿不到时返回 null，不抛错 */
function readSetupBbox(spine, skeleton) {
  try {
    if (typeof skeleton.getBounds !== 'function' || !spine.Vector2) return null;
    const off = new spine.Vector2();
    const size = new spine.Vector2();
    skeleton.getBounds(off, size, []);
    if (!(size.x > 0 && size.y > 0) || !Number.isFinite(off.x) || !Number.isFinite(off.y)) return null;
    return { x: +off.x.toFixed(3), y: +off.y.toFixed(3), width: +size.x.toFixed(3), height: +size.y.toFixed(3), unit: 'model', pose: 'rest' };
  } catch {
    return null;
  }
}

/**
 * 解析 Spine 骨架并产出元数据。
 * @param {object} input
 * @param {Uint8Array} input.bytes 骨架文件字节
 * @param {string} input.fileName 文件名（用于判断 json/skel）
 * @param {string} [input.atlasText] 同目录 atlas 文本（提供时才能算 bbox；没有则 bbox=null）
 * @returns {object} 元数据（字段见文件头）
 */
export function readSpineMeta(input) {
  const bytes = input && input.bytes;
  const fileName = (input && input.fileName) || '';
  if (!bytes || !bytes.length) throw fail(SPINE_CODES.NO_FILE, '骨架文件为空或不存在');
  const detected = detectSpineVersion(bytes, fileName);
  if (!detected) throw fail(SPINE_CODES.BAD_VERSION, `无法识别 Spine 版本（文件 ${fileName || '(未命名)'}）：既不是 JSON 骨架，也没有可识别的版本头`);
  const runtimeVersion = pickRuntimeVersion(detected);
  if (!runtimeVersion) throw fail(SPINE_CODES.NO_RUNTIME, `没有可用的 Spine ${detected} 运行时（可用：${listRuntimeVersions().join(', ') || '无'}）`);

  let loaded;
  try {
    loaded = loadRuntime(runtimeVersion);
  } catch (e) {
    throw fail(SPINE_CODES.NO_RUNTIME, `加载 Spine ${runtimeVersion} 运行时失败：${e.message}`);
  }
  const spine = loaded.spine;

  // 附件加载器：有 atlas 时按真实 region 建附件（能算 bbox）；没有时用返回 null 的桩（只出计数）。
  //   4.x 的 atlas/附件绑定与 3.8 不完全一致（实测 4.1 在解析阶段会摸 page.texture.getImage），
  //   所以 atlas 路径失败时**降级**到桩加载器：designSize/计数照出，bbox 置空并在结果里标注原因。
  const makeStubLoader = () => ({
    newRegionAttachment: () => null, newMeshAttachment: () => null,
    newBoundingBoxAttachment: () => null, newPathAttachment: () => null,
    newPointAttachment: () => null, newClippingAttachment: () => null,
  });
  let loader = null;
  let atlasNote = null;
  try {
    if (input.atlasText && spine.TextureAtlas && spine.AtlasAttachmentLoader) {
      const fakePage = {
        width: 1024, height: 1024,
        setTexture() {}, setFilters() {}, setWraps() {}, dispose() {},
        getImage: () => ({ width: 1024, height: 1024 }),
        // 4.x 的附件绑定会直接读 page.texture.getImage()（3.8 不会），所以这里也垫一层
        texture: { getImage: () => ({ width: 1024, height: 1024 }) },
      };
      const atlas = new spine.TextureAtlas(input.atlasText, () => fakePage);
      // 4.x 的附件绑定会直接读 page.texture.getImage()，而 setTexture 在部分版本里是空实现
      //   ⇒ 构造完 atlas 后直接把 texture 挂到每个 page 上（3.8 无副作用，4.x 必需）
      for (const pg of atlas.pages || []) {
        pg.texture = { getImage: () => ({ width: 1024, height: 1024 }) };
      }
      loader = new spine.AtlasAttachmentLoader(atlas);
    }
  } catch (e) {
    loader = null;
    atlasNote = `atlas 不可用（${e.message}），bbox 置空`;
  }
  if (!loader) loader = makeStubLoader();

  const stubLoader = makeStubLoader();
  const parseWith = (ld) => {
    const isJson = /\.json$/i.test(fileName) || bytes[0] === 0x7b;
    let d;
    if (isJson) {
      const json = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      d = new spine.SkeletonJson(ld).readSkeletonData(json);
    } else {
      d = new spine.SkeletonBinary(ld).readSkeletonData(new Uint8Array(bytes));
    }
    const sk = new spine.Skeleton(d);
    try { sk.updateWorldTransform(2); } catch { sk.updateWorldTransform(); }
    return { data: d, skeleton: sk };
  };
  let parsed;
  try {
    parsed = parseWith(loader);
  } catch (e) {
    if (loader !== stubLoader) {
      // atlas 绑定与运行时版本不完全兼容时降级重试：只出计数与 designSize，bbox 置空并标注原因
      try {
        parsed = parseWith(stubLoader);
        atlasNote = `atlas 绑定与 Spine ${runtimeVersion} 运行时不完全兼容（${e.message}），已降级为仅计数，bbox 置空`;
      } catch (e2) {
        throw fail(SPINE_CODES.PARSE, `骨架解析失败（Spine ${runtimeVersion}）：${e2.message}`);
      }
    } else {
      throw fail(SPINE_CODES.PARSE, `骨架解析失败（Spine ${runtimeVersion}）：${e.message}`);
    }
  }
  const data = parsed.data;
  const skeleton = parsed.skeleton;

  const width = Number(data.width) || 0;
  const height = Number(data.height) || 0;
  // 动作名 → 分组/循环/置信度：规则由调用方注入（读 tool/spine-motion-rules.json）；
  //   不注入时全部按"未知名"处理（group=动作名、loop=false、confidence=low），不猜。
  const animNames = (data.animations || []).map((a) => a && a.name).filter((n) => typeof n === 'string' && n);
  const motions = input.rules
    ? classifyAll(animNames, input.rules)
    : animNames.map((n) => ({ name: n, group: n, loop: false, confidence: 'low', rule: null }));
  return {
    kind: 'spine',
    version: detected,
    designSize: width > 0 && height > 0 ? { width, height, source: 'skeleton.width/height' } : null,
    bbox: readSetupBbox(spine, skeleton),
    bboxNote: atlasNote || null,
    bones: (data.bones || []).length,
    slots: (data.slots || []).length,
    animations: animNames.length,
    motions,
    skins: (data.skins || []).length,
    runtime: { version: runtimeVersion, origin: loaded.origin },
  };
}
