// engine/pipeline.js —— 贴图装载流水线：解码 → PMA 判定 → 上传 → 建图集
//
// 顺序与判定条件：
//   解码每页 →（auto 档）取像素做检测 → 三分支定 PMA → 决定 GPU/CPU 预乘 → 上传纹理 → 用页名匹配建 atlas
// 业务层（player / loader）只调本文件，不碰运行时版本差异（版本相关的取类走 runtime-capabilities + adapters）。

import {
  SMALL_PAGE_PX, parseAtlasPageSizes, decodeImageSource, sampleSourceImageData,
  uploadTextures, makePlaceholderTexture,
} from './textures.js';
import { atlasDeclaredPma, filenamePmaHint, detectPma, resolvePmaInfo } from './pma.js';
import { pickMember } from './runtime-capabilities.js';
import { createLogger } from '../infra/log.js';

/** PMA 诊断日志通道（debug 级：点分事件名 + 结构化 detail，机器可解析；不进 error 位、不刷屏） */
const pmaLog = createLogger('pma');

/** 透明占位页（保留尺寸，不上传真实像素） */
function transparentEntry(file, size) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(size.width || 1));
  canvas.height = Math.max(1, Math.floor(size.height || 1));
  return { name: file.name, width: canvas.width, height: canvas.height, img: null, canvas, transparent: true };
}

/** 页名 → 已上传纹理：精确 → 去扩展名 → 互相包含 */
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
 * 解码全部贴图页。多页图集里 <100px 的页按做法用透明画布跳过
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
        // 同步 canvas 取样
        const sampled = sampleSourceImageData(entry);
        if (sampled) samples.push(sampled);
      }
    } catch (e) {
      log('error', `加载贴图 ${file && file.name} 失败: ${e && e.message ? e.message : e}`, 'loader');
    }
  }
  return { entries, samples };
}

/**
 * PMA 判定链：atlas 声明 → 文件名线索 → 像素检测 → 生效模式。
 *
 * 四个判定串成一条链、彼此是数据依赖（后一步吃前一步的结论），所以放一起；
 * 但整段**不产生产物、不抛错**：全部走返回值，由调用方决定怎么记日志。
 * 与日志分开的理由：日志是副作用、判定是纯逻辑 —— 混在一起时
 *   "流程走到哪一步"会被十几个日志字段淹没（拆分前就是这个问题）。
 * @returns {{atlasDeclared: boolean|null, filenameHint: boolean|null, detection: object, pmaInfo: object}}
 */
function detectPmaStage({ atlasText, descriptor, pmaMode, supportsStraight, samples, log }) {
  const atlasDeclared = atlasDeclaredPma(atlasText);
  const firstName = (descriptor.textureFiles && descriptor.textureFiles[0] && descriptor.textureFiles[0].name)
    || descriptor.atlasFile.name;
  const filenameHint = filenamePmaHint(firstName);
  const detection = detectPma({ atlasDeclared, filenameHint, samples }, log);
  const pmaInfo = resolvePmaInfo(pmaMode, detection, supportsStraight);
  return { atlasDeclared, filenameHint, detection, pmaInfo };
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
 * PMA 的三条日志，按固定顺序发：debug（结构化诊断）→ degraded 时 warn → info（人读汇总）。
 *
 * 顺序不是随意的：现场排障时是拿 info 那一行去和 debug 里的 `pixelDetected/reason` 对拉，
 *   warn 夹在中间是为了"降级"这件事在日志流里紧跟着它的原因出现。改顺序会破坏这个对拉关系。
 *
 * 为什么必须记这条 debug：切模式时那条 info 只覆盖"用户手动切换"，而**首次装载 / 刷新后走 auto 的那一次**
 *   以前完全没有记录 —— 现场"刷新后自动档似乎没按预乘处理"就卡在这个盲区里。
 *
 * 本函数**不改变任何行为**（不写状态、不改 pmaInfo），是整条流水线里唯一可以完全跳过的一段。
 */
function logPmaStage({ descriptor, pmaMode, atlasDeclared, filenameHint, detection, pmaInfo, supportsStraight, log }) {
  pmaLog.debug('pma.resolve', {
    model: descriptor && (descriptor.id || descriptor.rel || descriptor.name) || null,
    mode: pmaMode,
    detected: detection ? detection.finalIsPremultiplied : null,     // 探测最终结论
    pixelDetected: detection ? detection.pixelDetected : null,       // 纯像素结论（null=像素不足）
    atlasDeclared: detection ? detection.atlasDeclared : null,
    filenameHint: detection ? detection.filenameHint : null,
    reason: detection ? detection.reason : null,
    effective: pmaInfo.effectiveMode,
    needPremultiply: pmaInfo.needPremultiply,
    blend: pmaInfo.blendMode,
    degraded: !!pmaInfo.degraded,
    supportsStraight,
    runtimeSupportsStraight: pmaInfo.runtimeSupportsStraight,
  });
  if (pmaInfo.degraded) log('warn', '运行时不支持非预乘直通混合，已自动转为转预乘', 'pma');
  // 上传口径已固定：**一律 UNPACK_PREMULTIPLY_ALPHA_WEBGL=false（不再乘）**，
  //   理由与实测数字见 pma.js uploadTextures 的注释（源 HTMLImageElement 解码即预乘，再乘是双乘）。
  //   所以这里不再计算 gpuUnpack —— 它已经不影响任何行为，留着会误导下一个人。
  // 与同文案（生效口径 + 运行时是否支持直通），便于两引擎日志直接对拉
  log('info', `PMA: 用户=${pmaMode}, atlas声明=${atlasDeclared === null ? '未声明' : String(atlasDeclared)}, `
    + `文件名=${filenameHint === null ? '无线索' : String(filenameHint)}, 像素检测=${detection.pixelDetected === null ? '未检测' : String(detection.pixelDetected)}, `
    + `生效=${pmaInfo.effectiveMode}, 运行时直通=${pmaInfo.runtimeSupportsStraight ? '支持' : '不支持'}`, 'pma');
}

/**
 * 用已上传的纹理建 TextureAtlas，并把页对象上的 texture 补齐。
 *
 * 两个运行时形态差异就在这里（调用方不需要知道）：
 *   · 3.x：`new TextureAtlas(atlasText, resolver)` 构造时就用 resolver 把每页填好；
 *   · 4.x：构造函数不吃 resolver，页对象上留 `setTexture()`，需在构造后逐页补。
 * 缺页时 resolver 落到 `makePlaceholderTexture()`（1×1 透明），**每个缺页各建一个**——
 *   不要改成共享同一个：placeholder 是 1×1 canvas，次数变化不会报错，只会多/少一个 GPU 纹理。
 * @returns {object} 已就绪的 atlas
 */
function buildAtlasFromTextures({ spine, atlasText, textures }) {
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
  return atlas;
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
  // ① 解码全部页（只有 auto 档才取样，供后面的像素检测用）
  const { entries, samples } = await decodePages({ descriptor, pageSizes, multiPage, wantSamples: pmaMode === 'auto', log });
  if (entries.size === 0) throw new Error('没有成功加载任何贴图文件，无法渲染模型');
  // ② PMA 判定（纯逻辑）与诊断日志（副作用）分两步，后者完全不影响返回值
  const pmaStage = detectPmaStage({ atlasText, descriptor, pmaMode, supportsStraight, samples, log });
  logPmaStage({ descriptor, pmaMode, ...pmaStage, supportsStraight, log });
  // ③ 上传纹理（口径固定不乘，见 pma.js uploadTextures 注释）
  //   空判定不在这里重复：uploadTextures 自己就在 out.size === 0 时抛
  //   「没有成功上传任何贴图到 GPU，无法创建 TextureAtlas」—— 它永不返回空 Map，
  //   此处再判一次是**不可达的死判定**（同一条件、同一文案）。权威放在产出侧 pma.js：
  //   只有它知道"实际传上了几页"，消费侧无从复核，也不该有第二份口径。
  const textures = await uploadTextures({
    gl, GLTextureCtor: pickMember(spine, 'GLTexture'), entries, textureFilter, log,
    effectiveMode: pmaStage.pmaInfo.effectiveMode, needPremultiply: pmaStage.pmaInfo.needPremultiply,
  });
  // ④ 建 atlas（3.x 构造吃 resolver / 4.x 构造后补页的差异在内部消化）
  const atlas = buildAtlasFromTextures({ spine, atlasText, textures });
  // 不再返回 gpuUnpack：上传口径固定不乘（见 pma.js uploadTextures 注释），保留字段名会误导
  return {
    atlas, entries, textures: [...textures.values()],
    pmaInfo: pmaStage.pmaInfo, pmaDetection: pmaStage.detection, atlasText,
  };
}
