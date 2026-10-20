// engine/loader.js —— 描述符（骨架/图集/纹理 ArrayBuffer）→ 可渲染对象
//
// 本文件**不出现任何版本判断**：纹理创建、图集构造签名、骨架解析全部经 adapters，
//   差异收敛在 `adapters/*`；这里只做"资源 → 调用顺序"的编排。

/** 文件名最后一段去扩展名（页名/贴图名匹配用） */
function baseName(name) {
  const s = String(name || '');
  return s.split('/').pop().replace(/\.[^.]+$/, '');
}

/** 骨架是否 JSON（首个非空白字节为 `{`） */
function sniffJson(buf) {
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < Math.min(bytes.length, 64); i += 1) {
    const c = bytes[i];
    if (c === 9 || c === 10 || c === 13 || c === 32) continue;
    return c === 0x7B;
  }
  return false;
}

/** ArrayBuffer → 图片源（优先 ImageBitmap，回退 <img>） */
async function toImage(entry) {
  const blob = new Blob([entry.content], { type: 'image/png' });
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch { /* 回退 */ }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`贴图解码失败：${entry.name}`)); };
    img.src = url;
  });
}

/** 并发解码全部贴图（保留文件顺序，供顺序兜底匹配） */
async function loadImages(textureFiles) {
  const list = Array.isArray(textureFiles) ? textureFiles : [];
  const decoded = await Promise.all(list.map(async (f) => {
    try { return { key: baseName(f.name), image: await toImage(f) }; } catch { return null; }
  }));
  return decoded.filter(Boolean);
}

/**
 * 页名 ↔ 贴图匹配：同名 → 归一化互相包含 → 顺序兜底。
 * 必须做兜底：实测存在页名 `aerbien_4.png` 而文件叫 `aerbien_42.png` 的模型，
 *   精确匹配失败会退到占位纹理，画面直接空。
 * @param {Array<{key: string, image: any}>} ordered
 */
function makeTextureMatcher(ordered) {
  const used = new Set();
  return (pageName) => {
    const page = baseName(pageName).toLowerCase();
    let idx = ordered.findIndex((it, i) => !used.has(i) && it.key.toLowerCase() === page);
    if (idx < 0) {
      idx = ordered.findIndex((it, i) => {
        if (used.has(i)) return false;
        const k = it.key.toLowerCase();
        return k.includes(page) || page.includes(k);
      });
    }
    if (idx < 0) idx = ordered.findIndex((_it, i) => !used.has(i));
    if (idx < 0) return null;
    used.add(idx);
    return ordered[idx].image;
  };
}

/**
 * 建模型对象。
 * @param {{adapters: object, descriptor: object, log: Function}} ctx
 */
export async function buildModel({ adapters, descriptor, log }) {
  const images = await loadImages(descriptor.textureFiles);
  const atlasText = new TextDecoder().decode(descriptor.atlasFile.content);
  const premultiplied = descriptor.atlasPma !== false;
  const matchImage = makeTextureMatcher(images);
  const atlas = adapters.atlas.create(atlasText, (pageName) => {
    const img = matchImage(pageName);
    if (!img) log('warn', `Atlas 页「${pageName}」没有可用贴图，使用 1×1 占位纹理`, 'loader');
    return img;
  }, premultiplied);
  const textures = ((atlas && atlas.pages) || []).map((p) => p.texture).filter(Boolean);
  const loader = adapters.skeleton.attachmentLoader(atlas);
  const skeletonData = readSkeletonData(adapters, descriptor, loader);
  const runtime = adapters.skeleton.createRuntime(skeletonData);
  return { atlas, textures, skeletonData, ...runtime, premultiplied };
}

/** 解析骨架数据（JSON 或二进制；尾逗号防御沿用旧引擎做法） */
function readSkeletonData(adapters, descriptor, loader) {
  const buf = descriptor.skeletonFile.content;
  if (sniffJson(buf)) {
    const text = new TextDecoder().decode(buf);
    return adapters.skeleton.readJson(loader, JSON.parse(text.replace(/,(\s*[}\]])/g, '$1')));
  }
  return adapters.skeleton.readBinary(loader, buf);
}
