// ============================================================================
// lib/errors.js —— 插件错误码表 + 带码的失败构造器
//
// 为什么需要：只给中文 message 时，调用方（新前端/其它程序）无法**程序化区分**失败类型——
//   做重试、降级、提示都只能靠字符串匹配（脆、且随文案变化而失效）。
//   这里给每类失败一个**稳定错误码**（大写蛇形 + ULB_ERR_ 前缀），message 仍保留中文可读说明。
//
// 稳定性约定：
//   · 码按「失败类别」定义，**不按行号/临时条件生成**；同一失败原因永远同一码。
//   · 已发布的码不删不改（需要区分新情况时**新增**码）。
//   · 错误对象上：err.code（稳定码）+ err.message（中文可读）+ err.ulb = true（便于跨层识别）。
//
// 挂载：globalThis.__ULB__.errors = { CODES, fail, isUlbError, codeOf }
// ============================================================================

'use strict';

{
  /** 稳定错误码表（值即码本身；键用于文档与自检遍历） */
  const CODES = {
    BAD_ARGS: 'ULB_ERR_BAD_ARGS',                       // 调用参数缺失/非法（缺 rootId/rel 等）
    IO: 'ULB_ERR_IO',                                   // 读取资源失败（宿主取文件失败、HTTP 非 2xx、超时）
    NO_FILE: 'ULB_ERR_NO_FILE',                         // 目标文件不存在/为空（路径对但文件没有）
    NOT_UNITYFS: 'ULB_ERR_NOT_UNITYFS',                 // 文件不是 UnityFS 容器
    NO_CAB: 'ULB_ERR_NO_CAB',                           // 容器里没有 CAB-* 节点（不是资产包）
    CONTAINER_PARSE: 'ULB_ERR_CONTAINER_PARSE',         // 容器/序列化/类型树解析失败（数据布局不符该版本）
    EXTRACT: 'ULB_ERR_EXTRACT',                         // 从对象表抽取资产失败（缺 .resS、越界等）
    TEXTURE_FORMAT_UNSUPPORTED: 'ULB_ERR_TEX_FORMAT_UNSUPPORTED',   // 纹理格式未实现
    TEXTURE_DATA_SHORT: 'ULB_ERR_TEX_DATA_SHORT',       // 纹理压缩数据不足（截断/尺寸不符）
    TEXTURE_DECODE: 'ULB_ERR_TEX_DECODE',               // 纹理解码失败（其余原因）
    CURVE_BINDING_MISMATCH: 'ULB_ERR_CURVE_BINDING_MISMATCH',       // 曲线数与绑定数不一致
    STREAMED_CLIP_INVALID: 'ULB_ERR_STREAMED_CLIP_INVALID',         // StreamedClip 结构异常
    MODEL_BUILD: 'ULB_ERR_MODEL_BUILD',                 // 拼装可渲染模型失败（缺 moc3/贴图等）
    NO_HOST: 'ULB_ERR_NO_HOST',                         // 宿主能力面缺失（§3.6：fetchFile 不可用且 file.bytes 缺失，可退化）
    EXPORT_NO_SPACE: 'ULB_ERR_EXPORT_NO_SPACE',           // 导出：磁盘剩余不足（预估 ×1.5 仍不够）
    EXPORT_INTERRUPTED: 'ULB_ERR_EXPORT_INTERRUPTED',     // 导出：被 SIGINT/SIGTERM 中断（临时目录已清理）
  };

  /**
   * 构造一个带稳定错误码的 Error。
   * @param {string} code CODES 里的码
   * @param {string} message 中文可读说明
   * @param {object} [extra] 附加字段（会挂到 err 上，便于调用方取上下文，如 { texture: 'texture_00' }）
   */
  function fail(code, message, extra) {
    const err = new Error(message);
    err.code = code;
    err.ulb = true;
    if (extra && typeof extra === 'object') {
      for (const k of Object.keys(extra)) {
        if (k !== 'code' && k !== 'message' && k !== 'ulb') err[k] = extra[k];
      }
    }
    return err;
  }

  /** 是否本插件产出的带码错误 */
  function isUlbError(e) {
    return Boolean(e && e.ulb === true && typeof e.code === 'string');
  }

  /** 取错误码（非本插件的错误返回 null，便于调用方区分） */
  function codeOf(e) {
    return isUlbError(e) ? e.code : null;
  }

  const NS = (globalThis.__ULB__ = globalThis.__ULB__ || {});
  NS.errors = { CODES, fail, isUlbError, codeOf };
}
