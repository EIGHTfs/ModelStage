// engine/pipeline.js —— 贴图装载流水线：解码 → PMA 判定 → 上传 → 建图集
//
// 这一段是旧引擎 loadAtlas 的可读版（legacy/source/engine.js 行 284 @32100–34000），顺序与判定条件逐项照抄：
//   解码每页 →（auto 档）取像素做检测 → 三分支定 PMA → 决定 GPU/CPU 预乘 → 上传纹理 → 用页名匹配建 atlas
// 业务层（player / loader）只调本文件，不碰运行时版本差异（版本相关的取类走 runtime-capabilities + adapters）。

import {
  SMALL_PAGE_PX, parseAtlasPageSizes, decodeImageSource, sampleSourceImageData,
  uploadTextures, makePlaceholderTexture,
} from './textures.js';
import { atlasDeclaredPma, filenamePmaHint, detectPma, resolvePmaInfo, gpuUnpackAvailable } from './pma.js';
import { pickMember } from './runtime-capabilities.js';

/** 透明占位页（保留尺寸，不上传真实像素） */
function transparentEntry(file, size) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(size.width || 1));
  canvas.height = Math.max(1, Math.floor(size.height || 1));
  return { name: file.name, width: canvas.width, height: canvas.height, img: null, canvas, transparent: true };
}

/** 页名 → 已上传纹理：精确 → 去扩展名 → 互相包含（与旧引擎的匹配顺序一致） */
function matchTexture(map, pageName) {
  if (map.has(pageName)) return map.get(pageName);
  const key = String(pageName || '').split(/[\\/]/).pop().toLowerCase();
  const stripped = key.replace(/\.[^.]+$/, '');
  for (const [name, tex] of map) {
    const n = String(name).split(/[\\/]/).pop().toLowerCase();
    if (n === key || n.replace(/\.[^.]+$/, '') === stripped) return tex;
  }
  for (const [name, tex] of map) {
    const n = String(name).replace(/\.[^.]+$/, '').toLowerCase();
    if (stripped && (n.includes(stripped) || stripped.includes(n))) return tex;
  }
  return null;
}

/**
 * 解码全部贴图页。多页图集里 <100px 的页按旧引擎做法用透明画布跳过
 * （这类页通常是占位，参与像素检测会把结论带偏）。
 */
async function decodePages({ descriptor, pageSizes, multiPage, wantSamples, log }) {
  const entries = new Map();
  const samples = [];
  for (const file of (descriptor.textureFiles || [])) {
    try {
      const declared = multiPage ? pageSizes.get(file.name) || pageSizes.get(findPageName(pageSizes, file.name)) : null;
      if (declared && (declared.width < SMALL_PAGE_PX || declared.height < SMALL_PAGE_PX)) {
        entries.set(file.name, transparentEntry(file, declared));
        log('info', `检测到小尺寸图集页 ${file.name}（${declared.width}x${declared.height}），已用透明贴图跳过`, 'loader');
        continue;
      }
      const decoded = await decodeImageSource(file);
      if (multiPage && (decoded.width < SMALL_PAGE_PX || decoded.height < SMALL_PAGE_PX)) {
        entries.set(file.name, transparentEntry(file, decoded));
        log('info', `检测到小尺寸图集页 ${file.name}（${decoded.width}x${decoded.height}），已用透明贴图跳过`, 'loader');
        continue;
      }
      const entry = { name: file.name, width: decoded.width, height: decoded.height, img: decoded.img, canvas: null, transparent: false };
      entries.set(file.name, entry);
      if (wantSamples) {
        const sampled = sampleSourceImageData(entry);
        if (sampled) samples.push(sampled);
      }
    } catch (e) {
      log('error', `加载贴图 ${file && file.name} 失败: ${e && e.message ? e.message : e}`, 'loader');
    }
  }
  return { entries, samples };
}

/** 贴图文件名 ↔ atlas 页名（页名带相对路径时也能对上） */
function findPageName(pageSizes, file) {
  const want = String(file.name || '').split(/[\\/]/).pop().toLowerCase();
  for (const page of pageSizes.keys()) {
    if (String(page).split(/[\\/]/).pop().toLowerCase() === want) return page;
  }
  return null;
}

/**
 * 走完整流水线，产出可直接交给 AtlasAttachmentLoader 的 atlas。
 * @param {{spine: object, gl: WebGLRenderingContext, descriptor: object, pmaMode: string,
 *          textureFilter: string, supportsStraight: boolean, log?: Function}} ctx
 */
export async function prepareAtlas(ctx) {
  const { spine, gl, descriptor, pmaMode, textureFilter, supportsStraight, log = () => {} } = ctx;
  const atlasText = new TextDecoder().decode(descriptor.atlasFile.content);
  if (!atlasText) throw new Error('atlas 文件为空或无法读取');
  const pageSizes = parseAtlasPageSizes(atlasText);
  const multiPage = (descriptor.textureFiles || []).length > 1;
  const { entries, samples } = await decodePages({
    descriptor, pageSizes, multiPage, wantSamples: pmaMode === 'auto', log,
  });
  if (entries.size === 0) throw new Error('没有成功加载任何贴图文件，无法渲染模型');

  const atlasDeclared = atlasDeclaredPma(atlasText);
  const firstName = (descriptor.textureFiles && descriptor.textureFiles[0] && descriptor.textureFiles[0].name)
    || descriptor.atlasFile.name;
  const filenameHint = filenamePmaHint(firstName);
  const detection = detectPma({ atlasDeclared, filenameHint, samples }, log);
  const pmaInfo = resolvePmaInfo(pmaMode, detection, supportsStraight);
  if (pmaInfo.degraded) log('warn', '运行时不支持非预乘直通混合，已自动转为转预乘', 'pma');
  const gpuUnpack = pmaInfo.needPremultiply && gpuUnpackAvailable(gl);
  // 与旧引擎同文案（生效口径 + 运行时是否支持直通），便于两引擎日志直接对拉
  log('info', `PMA: 用户=${pmaMode}, atlas声明=${atlasDeclared === null ? '未声明' : String(atlasDeclared)}, `
    + `文件名=${filenameHint === null ? '无线索' : String(filenameHint)}, 像素检测=${detection.pixelDetected === null ? '未检测' : String(detection.pixelDetected)}, `
    + `生效=${pmaInfo.effectiveMode}, 运行时直通=${pmaInfo.runtimeSupportsStraight ? '支持' : '不支持'}`, 'pma');

  const textures = await uploadTextures({
    gl,
    GLTextureCtor: pickMember(spine, 'GLTexture'),
    entries,
    effectiveMode: pmaInfo.effectiveMode,
    needPremultiply: pmaInfo.needPremultiply,
    gpuUnpack,
    cpuPremultiplied: pmaInfo.needPremultiply && !gpuUnpack,
    textureFilter,
    log,
  });
  if (textures.size === 0) throw new Error('没有成功上传任何贴图到 GPU，无法创建 TextureAtlas');

  const TextureAtlas = pickMember(spine, 'TextureAtlas');
  if (!TextureAtlas) throw new Error('当前运行时不支持 TextureAtlas');
  const resolvePage = (pageName) => matchTexture(textures, pageName) || makePlaceholderTexture();
  // 3.x 构造吃 resolver；4.x 不吃 → 构造后再逐页补齐（匹配规则相同）
  const atlas = new TextureAtlas(atlasText, resolvePage);
  for (const page of (atlas.pages || [])) {
    if (page.texture) continue;
    const tex = resolvePage(page.name);
    if (typeof page.setTexture === 'function') page.setTexture(tex);
    else page.texture = tex;
  }
  return {
    atlas,
    entries,
    textures: [...textures.values()],
    pmaInfo,
    pmaDetection: detection,
    gpuUnpack,
    atlasText,
  };
}
