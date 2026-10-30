// engine/pma/resolve.js —— 决策：**唯一**算"怎么画"的地方（档位 + 探测结论 + 运行时能力 → 一份 decision）
//
// 上传（upload.js）与混合（blend.js / render-frame）都必须从这里派生，不允许各自再判断一次。
// 本文件不读 DOM、不碰 GL —— 纯函数，便于单测钉住每一档。

/**
 * 档位 → decision。字段含义：
 *   effectiveMode  最终生效的路径：premultiplied（源图已预乘）/ upload（上传时乘）/ straight（直通混合）
 *   needPremultiply 是否**需要在上传时乘一次**（只有 upload 路径为 true）
 *   blendMode      混合口径：premultiplied（src 因子用 ONE）/ straight（用 SRC_ALPHA）
 *   degraded       是否因运行时能力不足而降级（显式 straight 落到 upload 时才是 true）
 * @param {string} mode auto | premultiplied | straight | upload
 * @param {{finalIsPremultiplied: boolean}} detection
 * @param {boolean} supportsStraight 运行时是否支持非预乘直通混合
 */
export function resolvePmaInfo(mode, detection, supportsStraight) {
  const auto = detection && detection.finalIsPremultiplied;
  switch (mode) {
    case 'premultiplied':
      return { effectiveMode: 'premultiplied', needPremultiply: false, blendMode: 'premultiplied', runtimeSupportsStraight: supportsStraight, degraded: false };
    case 'straight':
      return supportsStraight
        ? { effectiveMode: 'straight', needPremultiply: false, blendMode: 'straight', runtimeSupportsStraight: supportsStraight, degraded: false }
        : { effectiveMode: 'upload', needPremultiply: true, blendMode: 'premultiplied', runtimeSupportsStraight: supportsStraight, degraded: true };
    case 'upload':
      return { effectiveMode: 'upload', needPremultiply: true, blendMode: 'premultiplied', runtimeSupportsStraight: supportsStraight, degraded: false };
    case 'auto':
    default: {
      // 三态处理：明确预乘 / 明确非预乘 / **检测不出**
      //   检测不出（auto 为 null/undefined）时**按已预乘**，对齐既有口径三条兜底（init-default / safe-fallback /
      //   atlas 未声明）都默认 true 的做法。
      //   理由与「沿袭既有」无关，而是**失败代价不对称**：
      //     · 兜底成"非预乘" ⇒ needPremultiply=true ⇒ 若图其实是预乘的 ⇒ **双重预乘 ⇒ 明显黑圈**
      //     · 兜底成"已预乘" ⇒ 不乘 ⇒ 若图其实是直通 ⇒ 只是混合略暗
      //   少乘的可接受程度远高于多乘，所以不确定时选"不乘"。
      if (auto === false) {
        // 检测为"非预乘"。**运行时支持直通时，这一档必须与显式 straight 完全等价**：
        //   都走 straight 混合、都不预乘。不看能力就无条件 upload（上传时预乘 + premultiplied 混合）
        //   会让"自动"与"用户强制选非预乘"对同一张图给出两种画面 —— 实测就是面部/眼周白斑。
        //   能力不允许时才退回 upload（与显式 straight 的降级方向一致，但 degraded 保持 false：
        //   这不是"降级"，而是这台运行时唯一可行的路径，与改动前逐字段相同）。
        return supportsStraight
          ? { effectiveMode: 'straight', needPremultiply: false, blendMode: 'straight', runtimeSupportsStraight: supportsStraight, degraded: false }
          : { effectiveMode: 'upload', needPremultiply: true, blendMode: 'premultiplied', runtimeSupportsStraight: supportsStraight, degraded: false };
      }
      return { effectiveMode: 'premultiplied', needPremultiply: false, blendMode: 'premultiplied', runtimeSupportsStraight: supportsStraight, degraded: false };
    }
  }
}

/**
 * 上传口径：这一页贴图要不要在 `texImage2D` 那一下让浏览器乘一次 alpha。
 *
 * 三种输入（恰好是 `resolvePmaInfo` 的三个出口），只有第三种必须乘：
 *   · 源图已预乘（`effectiveMode:'premultiplied'`，needPremultiply=false）⇒ **不乘**：再乘就是双重预乘（明显黑圈）
 *   · 源图 straight 且走 straight 路径（`effectiveMode:'straight'`，needPremultiply=false）⇒ **不乘**：
 *     乘了就和 straight 混合错配（数据是预乘、blend 却按直通）
 *   · 源图 straight 且走 upload 路径（`effectiveMode:'upload'`，needPremultiply=true）⇒ **乘**：
 *     运行时不支持直通混合，只能把数据也预乘，让"预乘数据 + 预乘 blend"配套（不乘就是白斑）
 *
 * 为什么单列成纯函数：`needPremultiply` 曾只作诊断、没有任何地方执行它，
 *   于是 upload 路径「要求预乘却没乘」⇒ GPU 上是直通数据、却按预乘混合绘制 ⇒ 半透明边缘发白。
 *   抽出来才能用单测把三种输入钉死，避免再次退化成"硬编码 false"。
 * @param {{needPremultiply?: boolean}} info `resolvePmaInfo` 的结果
 * @returns {boolean} 是否在上传时预乘
 */
export function shouldPremultiplyOnUpload(info) {
  return !!(info && info.needPremultiply === true);
}

/**
 * 上传口径的**完整派生**：`{ unpack, pmaFlag }`。
 *
 * 两个字段都是"从 decision 读出来"的派生量，不允许调用方再自己判断一次：
 *   unpack   上传时要不要让浏览器乘一次 alpha —— 只有 upload 路径要（见 shouldPremultiplyOnUpload）
 *   pmaFlag  **上传完成后 GPU 上的数据是否预乘**：
 *              premultiplied（源图本来就预乘，原样传）⇒ true
 *              upload       （上传时乘过一次，现在也是预乘）⇒ **true**
 *              straight     （原样传，仍是直通）          ⇒ false
 *            早前这里写成 `effectiveMode === 'premultiplied'`，把 upload 路径也标成 false ——
 *            与"它其实已经预乘"自相矛盾。虽有该字段的消费方目前是保留路径（无运行时带 pma 属性），
 *            但语义必须与数据真实形态一致，否则下一个人会照它做判断。
 * @param {{effectiveMode?: string, needPremultiply?: boolean}} info `resolvePmaInfo` 的结果
 * @returns {{unpack: boolean, pmaFlag: boolean}}
 */
export function planTextureUpload(info) {
  const mode = (info && info.effectiveMode) || '';
  return {
    unpack: shouldPremultiplyOnUpload(info),
    pmaFlag: mode === 'premultiplied' || mode === 'upload',
  };
}

// 混合口径只有两种结果，预建成冻结常量：planBlend 在**每帧**都会被调用，
//   每次 new 一个对象等于每帧一次 GC 压力。返回共享常量既零分配也不会被误改。
const BLEND_PREMULTIPLIED = Object.freeze({ premultiplied: true });
const BLEND_STRAIGHT = Object.freeze({ premultiplied: false });

/**
 * 混合口径派生：只回答一件事 —— **绘制时按预乘还是直通混合**。
 *
 * `premultiplied` 直接喂给绘制层（决定 blend 的 src 因子是 `ONE` 还是 `SRC_ALPHA`、
 *   以及顶点色是否乘 alpha）。"要不要改写 blendFunc"这件事**不在这里回答**：
 *   blend.js 的 `installBlendHooks` 在每个上下文上装一次钩子，改写与否由它自己在
 *   每次 `blendFunc` 调用时按 `pmaInfo.blendMode` 判断 —— 这里再给一个 needHook 字段
 *   只会多出一份没人消费的平行语义（早前版本就这么干过，已删）。
 * @param {{blendMode?: string}} info `resolvePmaInfo` 的结果
 * @returns {{premultiplied: boolean}} 冻结的共享常量（零分配）
 */
export function planBlend(info) {
  return (info && info.blendMode === 'premultiplied') ? BLEND_PREMULTIPLIED : BLEND_STRAIGHT;
}
