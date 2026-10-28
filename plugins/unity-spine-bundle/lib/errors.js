// ============================================================================
// lib/errors.js —— Spine 资源包插件的错误码表 + 带码的失败构造器
//
// 为什么需要：只给中文 message 时，调用方（服务端/前端/其它程序）无法**程序化区分**失败类型 ——
//   做重试、降级、提示都只能靠字符串匹配（脆、且随文案变化而失效）。
//   这里给每类失败一个**稳定错误码**（大写蛇形 + SPI_ERR_ 前缀），message 仍保留中文可读说明。
//
// 为什么前缀是 SPI_ 而不是复用 live2d 那套 ULB_：
//   `errorCodes` 是**插件自描述**（契约 插件.md §二 / §3.4）。两个 asset-provider 插件共用一套
//   码空间时，"这个错是哪个插件报的"就无法从码本身判断 —— 排障时要多查一层。
//   前缀区分后，看到 SPI_ERR_* 就知道是 spine 插件。
//
// 稳定性约定（与 live2d 版一致）：
//   · 码按「失败类别」定义，不按行号/临时条件生成；同一失败原因永远同一码。
//   · 已发布的码不删不改（需要区分新情况时新增码）。
//   · 错误对象上：err.code（稳定码）+ err.message（中文可读）+ err.spi = true（便于跨层识别）。
//
// 挂载：globalThis.__ULB__.errors = { CODES, fail, isSpiError, codeOf }
//   （命名空间沿用 __ULB__：本项目各 lib 文件彼此依赖它，改命名空间会让整份 lib 都要动）
// ============================================================================

'use strict';

{
  /** 稳定错误码表（值即码本身；键用于文档与自检遍历） */
  const CODES = {
    BAD_ARGS: 'SPI_ERR_BAD_ARGS',                       // 调用参数缺失/非法（缺 rootId/rel 等）
    NO_FILE: 'SPI_ERR_NO_FILE',                         // 目标文件不存在/为空（路径对但文件没有）
    IO: 'SPI_ERR_IO',                                   // 读取资源失败（宿主取文件失败、HTTP 非 2xx、超时）
    NO_HOST: 'SPI_ERR_NO_HOST',                         // 宿主能力面缺失（契约 §3.6：fetchFile 不可用且 file.bytes 缺失）
    NOT_UNITYFS: 'SPI_ERR_NOT_UNITYFS',                 // 不是明文 UnityFS 容器（含"原始包已加密，需先解密"的情形）
    NO_CAB: 'SPI_ERR_NO_CAB',                           // 容器里没有 CAB-* 节点（不是资产包）
    CONTAINER_PARSE: 'SPI_ERR_CONTAINER_PARSE',         // 容器/序列化/类型树解析失败（数据布局不符该版本）
    LZMA_FAIL: 'SPI_ERR_LZMA_FAIL',                     // LZMA 解压失败（数据损坏 / 解出长度与声明不符）
    LZMA_UNAVAILABLE: 'SPI_ERR_LZMA_UNAVAILABLE',       // LZMA 解码器未加载（lib/lzma-d-min.js 未按序声明）
    NO_SKEL: 'SPI_ERR_NO_SKEL',                         // 容器可读但没有 .skel（不是 Spine 包，或包型不支持）
    NO_ATLAS: 'SPI_ERR_NO_ATLAS',                       // 有 .skel 但缺同名 .atlas
    SKEL_INVALID: 'SPI_ERR_SKEL_INVALID',               // .skel 字节不可用（无 Spine 版本串 / 长度异常）
    EXTRACT: 'SPI_ERR_EXTRACT',                         // 从对象表抽取资产失败（缺 .resS、越界等）
    TEXTURE_FORMAT_UNSUPPORTED: 'SPI_ERR_TEX_FORMAT_UNSUPPORTED',  // 纹理格式未实现（既非 RGBA32 也未解码器）
    TEXTURE_DATA_SHORT: 'SPI_ERR_TEX_DATA_SHORT',       // 纹理压缩数据不足（截断/尺寸不符）
    TEXTURE_DECODE: 'SPI_ERR_TEX_DECODE',               // 纹理解码失败（其余原因）
    PNG_ENCODE: 'SPI_ERR_PNG_ENCODE',                   // RGBA → PNG 编码失败
    ENTRY_BUILD: 'SPI_ERR_ENTRY_BUILD',                 // 组装 entry.json 失败（缺必要字段）
  };

  /**
   * 构造一个带稳定错误码的 Error。
   * @param {string} code CODES 里的码
   * @param {string} message 中文可读说明
   * @param {object} [extra] 附加字段（会挂到 err 上，便于调用方取上下文，如 { skel: 'c200_01.skel' }）
   */
  function fail(code, message, extra) {
    const err = new Error(message);
    err.code = code;
    err.spi = true;
    if (extra && typeof extra === 'object') {
      for (const k of Object.keys(extra)) {
        if (k !== 'code' && k !== 'message' && k !== 'spi') err[k] = extra[k];
      }
    }
    return err;
  }

  /** 是否本插件产出的带码错误 */
  function isSpiError(e) {
    return Boolean(e && e.spi === true && typeof e.code === 'string');
  }

  /** 取错误码（非本插件的错误返回 null，便于调用方区分） */
  function codeOf(e) {
    return isSpiError(e) ? e.code : null;
  }

  const NS = (globalThis.__ULB__ = globalThis.__ULB__ || {});
  // isUlbError 是历史名（live2d 版用过）：本插件里没有调用方依赖它，保留别名只为
  //   万一有共享 lib 片段按旧名引用时不至于 undefined（当前 grep 实测为 0 处）。
  NS.errors = { CODES, fail, isSpiError, codeOf, isUlbError: isSpiError };
}
