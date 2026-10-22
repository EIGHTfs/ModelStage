// spine/canvas-document.js —— Document → 舞台描述符
//
// 职责：把（已就绪的）Document 翻成引擎能直接吃的描述符，并区分两类失败：
//   aborted（用户切换导致的中止，属正常）与 business（真实失败，要显示给用户）。
// 契约：Document 是渲染层唯一输入，这里不做资源抓取，只读已经解析好的地址。

import { buildDocument } from '../infra/document.js';

/**
 * 被取代的装载错误：业务错误 + aborted 标记。
 * 为什么单列：调用方必须能区分"装载失败"与"被更新的选择取代"——后者是正常竞态结果，
 *   不该显示成红色故障，也不该被当成"成功"继续读结果字段（曾经因此抛 TypeError 留下空白画面）。
 */
export function abortedError(msg = '加载已被新的选择取代', cause) {
  const e = businessError(msg, cause);
  e.aborted = true;
  return e;
}

/** 业务错误：调用方只更新提示，不抛控制台 */
export function businessError(msg, cause) {
  const e = new Error(msg);
  e.business = true;
  if (cause) e.cause = cause;
  return e;
}

// 说明：模型资源（骨架 / atlas / 贴图）的**取用已上移到 infra/document.js**（Assets 层），
//   本文件只消费 Document 给出的地址与字节 —— 渲染器里不再有 fetch / XHR 取模型资源，
//   因此也不会有"取资源失败"分支（契约 渲染器契约 §五-6、Document 契约 D4）。
//   运行时库（/spine-runtimes/*）仍在这里加载：那是**库**不是模型资产，属已批准的豁免项。

/**
 * 取出 ready 的 Document（舞台入参的唯一形态）。
 * 只认 { document }：非 Document 直接抛，ready 之外（error）也抛并留痕。
 *   组装是调用方的事（api.buildDocument 或 app/model-actions），舞台不代劳。
 * @param {object} st 舞台状态
 * @param {object} arg 只接受 { document }
 * @returns {object} ready 的 Document
 */
export function resolveDocument(st, arg) {
  // **只接受 Document**，不做旧形状（catalog entry）的兜底组装：
  //   兜底留着，调用方忘了组装就会静默走它，而"组装失败"这条路径永远没人覆盖。
  //   组装入口是 api.buildDocument（Assets 层 infra/document.js），调用方显式两步走。
  const doc = arg && arg.document;
  if (!doc || typeof doc.state !== 'string') {
    // 旧形状（{ root, model }）要点名，否则调用方只看到 undefined 不知错在哪
    const got = arg && arg.model
      ? `旧形状 { root, model }（kind=${(arg.model.kind) || '?'}）`
      : (doc && typeof doc === 'object' ? `普通对象（kind=${doc.kind || '?'}）` : String(doc));
    throw businessError(`stage.load 只接受 Document（请先 buildDocument 组装），收到：${got}`);
  }
  if (doc.state !== 'ready') {
    const why = (doc.warnings || []).join('；') || '未提供原因';
    st.lastError = why;   // 组装失败要留痕：下一次成功装载会清掉它
    throw businessError(`Document 不是 ready 状态（${doc.state}）：${why}`);
  }
  return doc;
}

/**
 * engine 的模型描述符（字段名是 engine 的契约，见文档 §14）。
 * 数据全部来自 **Document.assets**（地址已由 Assets 层经 VirtualFS 解析、字节也由那一层取好）。
 * @param {object} doc ready 的 Document
 * @param {string} ver 运行时版本
 */
export function buildDescriptor(doc, ver) {
  const assets = (doc && doc.assets) || {};
  const entry = assets.entry || {};
  const atlas = assets.atlas || {};
  const textures = Array.isArray(assets.textures) ? assets.textures : [];
  return {
    name: (doc && (doc.name || doc.id)) || '',
    version: ver,
    skeletonFile: { name: entry.name || '', content: entry.bytes },
    atlasFile: { name: atlas.name || '', content: atlas.bytes },
    textureFiles: textures.map((t) => ({ name: t.name || '', content: t.bytes })),
    atlasPma: doc && doc.meta && doc.meta.extras ? doc.meta.extras.atlasPma : null,
  };
}
