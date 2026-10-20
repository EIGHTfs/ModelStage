// adapters/atlas.js —— 图集适配（构造签名差异 + 页纹理挂载）
//
// 3.x：`new TextureAtlas(text, imageResolver)` —— resolver 的返回值就是页纹理；
// 4.x：`new TextureAtlas(text)` —— 不吃 resolver，必须构造后逐页补挂。
// 这里用能力矩阵判断，不读版本号。

/**
 * @param {{caps: object, texture: object, onWarn?: Function}} ctx
 */
export function createAtlasAdapter({ caps, texture, onWarn }) {
  const Ctor = caps.atlas.ctor;
  if (!Ctor) throw new Error('运行时缺少 TextureAtlas');

  /** 给尚未挂纹理的页补挂（4.x 路径；也兜住 3.x 中 resolver 未覆盖的页） */
  function attachPages(atlas, resolveImage, premultiplied) {
    for (const page of (atlas && atlas.pages) || []) {
      if (page.texture) continue;
      const img = resolveImage(page.name);
      const tex = img ? texture.create(img, premultiplied) : texture.placeholder();
      if (typeof page.setTexture === 'function') page.setTexture(tex);
      else page.texture = tex;
    }
  }

  /**
   * 建图集。
   * @param {string} text atlas 文本
   * @param {(pageName: string) => any|null} resolveImage 页名 → 图片源
   * @param {boolean} premultiplied
   * @returns {object} atlas
   */
  function create(text, resolveImage, premultiplied) {
    if (caps.atlas.acceptsResolver) {
      // resolver 的返回值会被直接当作页纹理 ⇒ 必须在这里创建纹理对象（不能返回裸图片）
      return new Ctor(text, (pageName) => {
        const img = resolveImage(pageName);
        return img ? texture.create(img, premultiplied) : texture.placeholder();
      });
    }
    onWarn && onWarn(`atlas：该运行时 TextureAtlas 只接受 ${caps.atlas.arity} 个参数，改用"构造后补挂纹理"路径`);
    const atlas = new Ctor(text);
    attachPages(atlas, resolveImage, premultiplied);
    return atlas;
  }

  return { create };
}
