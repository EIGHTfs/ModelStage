// data/manifest-jsonl.mjs —— 模型清单的 JSONL 存储（P1）
//
// 为什么换格式：旧实现把整份清单 `JSON.stringify` 后一次写盘，于是
//   ① 扫描期间**一条都写不出去**（必须等全部扫完）—— 中途被杀就全丢，用户重来一次还是几十秒；
//   ② 大根的清单是单个巨大字符串，解析时要整份 materialize 到内存；
//   ③ 想"边扫边写"根本没法做（JSON 不是流式可写的格式）。
//   JSONL 每行一个独立对象：可以逐条 append、可以逐行解析、坏一行不影响其它行。
//
// 三个必须理解的约束（每条都对应一个实测踩过的坑，详见设计 §4.3）：
//   ① 句柄声明在**能执行到的外层**：曾经把 fd 声明在 try 内，catch/finally 里访问不到 ⇒ 从未关闭 ⇒
//      遍历大目录后句柄耗尽，且 rename 时目标仍有未关闭读句柄 ⇒ CIFS 上 EACCES
//   ② rename 前必须已关句柄，且**不用 copyFile 绕开**（覆盖已存在文件在 CIFS 上 EPERM，且丢原子性）
//   ③ 打开一次 + writeSync 多次，不要每条 open/close（431 条模型 = 431 次 open 是不可接受的开销）
//
// 行格式（设计 §4.2）：
//   首行 meta   {"_":"meta","rootId","ts","generator","dirStamps","complete":false}
//   数据行       {"t":"m","k":"<模型 id>","v":{…}}
//   末行 complete {"t":"meta","k":"complete","v":{"count":N,"ts":T}}   ← last-wins
// 同一 key 重复出现 ⇒ 后写覆盖先写（重扫时不必先删旧行）

import fs from 'node:fs';
import path from 'node:path';

/** 同一进程内的 tmp 序号：保证"每次扫描的 tmp 唯一" */
let tmpSeq = 0;

/** 坏行占比超过这个阈值 ⇒ 判整体损坏（设计 §4.4）。千分之一：少量截断尾巴能容忍，成片坏说明文件本身废了。 */
const BAD_LINE_RATIO_LIMIT = 0.01;

/**
 * 打开一个清单写入器。
 *
 * @param {string} base 不带扩展名的路径（如 `…/config/models/spine.<rootId>`）
 * @param {object} meta 首行要写的元信息：{rootId, ts, generator, dirStamps}
 *   （**不含 kind**：清单是可分发数据，渲染器类型由读取方按来源判断）
 * @returns {{
 *   append: (model: object) => void,
 *   finish: (count: number) => {bytes: number, file: string},
 *   abort: () => void,
 *   bytesWritten: number,
 *   tmpFile: string,
 *   finalFile: string,
 * }}
 */
export function openManifestWriter(base, meta) {
  // tmp 文件名**每次扫描唯一**：<base>.<pid>.<seq>.jsonl.tmp
  //   为什么不能固定名：并发场景下（另一个根的 refresh、或任何一次 invalidate）会清理"看起来像残留"的 tmp，
  //   固定名的话它会把**正在写**的那份删掉 ⇒ finish 时 rename ENOENT（实测踩到：
  //   `rename 'spine.<rootId>.jsonl.tmp' -> 'spine.<rootId>.jsonl'` ENOENT）。
  //   唯一名让"两个扫描互不干扰"，也让"清理残留"能安全地只删老的。
  const tmpFile = `${base}.${process.pid}.${(tmpSeq += 1)}.jsonl.tmp`;
  const finalFile = `${base}.jsonl`;
  fs.mkdirSync(path.dirname(base), { recursive: true });

  // ① 自己这个唯一名理论上不该已存在（seq 单调递增）；存在说明进程内序号被复用（极罕见），覆盖即可。
  try {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  } catch { /* 删不掉也无所谓：下面 'w' 会截断它 */ }

  // ② 句柄声明在**外层**（见文件头约束①）：finish/abort 都要能访问到
  let fd = null;
  let closed = false;
  let bytesWritten = 0;

  function writeLine(obj) {
    const line = `${JSON.stringify(obj)}\n`;
    fs.writeSync(fd, line);
    bytesWritten += Buffer.byteLength(line);
  }

  fd = fs.openSync(tmpFile, 'w');
  // 首行 meta：complete:false 起始 —— 读侧看到 false 就知道"这份还没写完"
  // meta 行**不写 kind**：清单是可分发的数据，不应该带"这是哪种渲染器"的标签；
  //   前端需要的类型由 catalog 读取时按来源盖章（值域仍是 'spine' / 'live2d'）。
  writeLine({
    _: 'meta',
    rootId: meta.rootId,
    ts: meta.ts,
    generator: meta.generator,
    dirStamps: meta.dirStamps,
    complete: false,
  });

  function close() {
    if (closed) return;
    closed = true;
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch { /* 已关闭/句柄失效：忽略 */ }
    fd = null;
  }

  return {
    /**
     * 追加一条模型。**同步写**：单条几十~几百字节，一次 writeSync 是微秒级，
     *   不会像目录遍历那样长时间占住事件循环（进度帧仍能正常发出）。
     * @param {object} model 与旧格式 models[i] **逐字段一致**
     */
    append(model) {
      if (closed) return;
      const key = model && model.id ? String(model.id) : '';
      writeLine({ t: 'm', k: key, v: model });
    },
    /**
     * 收尾：写 complete 行 → 关句柄 → rename 覆盖正式文件。
     * @param {number} count 最终模型数（读侧据此做一致性自检）
     * @returns {{bytes: number, file: string}}
     */
    finish(count) {
      if (closed) return { bytes: bytesWritten, file: finalFile };
      writeLine({ t: 'meta', k: 'complete', v: { count, ts: Date.now() } });
      const bytes = bytesWritten;
      close();
      // ② rename 前已关句柄（见约束②）
      //    tmp 不在 ⇒ 明确说是"被并发清理删掉了"而不是抛一个裸 ENOENT 让人猜
      if (!fs.existsSync(tmpFile)) {
        throw new Error(
          `清单 tmp 在收尾前消失：${tmpFile}`
          + `（可能被并发的失效清理删掉了；正式文件 ${path.basename(finalFile)} 未受影响，下次请求会重建）`,
        );
      }
      fs.renameSync(tmpFile, finalFile);
      return { bytes, file: finalFile };
    },
    /** 失败：只关句柄，**不动正式文件**（它保持上一次的完整版本）；自己的 tmp 留着供排查 */
    abort() {
      close();
    },
    get bytesWritten() { return bytesWritten; },
    tmpFile,
    finalFile,
  };
}

/** 当前优先的存储格式：默认 json（原行为）；env MODELSTAGE_MANIFEST_FORMAT=jsonl 才用 JSONL */
export function preferredManifestFormat() {
  return String(process.env.MODELSTAGE_MANIFEST_FORMAT || 'json').toLowerCase() === 'jsonl' ? 'jsonl' : 'json';
}

/** JSONL 单文件解析（文件必须存在） */
function readJsonlFile(jsonlFile) {
  let text = '';
  let bytes = 0;
  try {
    text = fs.readFileSync(jsonlFile, 'utf8');
    bytes = Buffer.byteLength(text);
  } catch (e) {
    return { format: 'jsonl', meta: null, models: [], complete: false, badLines: 0, bytes: 0, error: e.message };
  }
  const lines = text.split('\n');
  let metaRow = null;
  /** @type {Map<string, object>} key → model（last-wins 靠 Map.set 天然实现） */
  const byKey = new Map();
  let badLines = 0;
  let totalLines = 0;
  let completeRow = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    totalLines += 1;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      badLines += 1;      // 坏行跳过（进程被杀时常留下半行）—— 不影响其它行
      continue;
    }
    if (obj && obj._ === 'meta') { metaRow = obj; continue; }
    if (obj && obj.t === 'meta' && obj.k === 'complete') { completeRow = obj; continue; }
    if (obj && obj.t === 'm') {
      // last-wins：同 key 后写覆盖先写（重扫追加时不需先删旧行）
      byKey.set(String(obj.k), obj.v);
      continue;
    }
    badLines += 1;        // 结构不认识的行也计坏行
  }

  // 坏行过多 ⇒ 判损坏（设计 §4.4）。少量坏行（截断尾巴）可容忍。
  const tooManyBad = totalLines > 0 && badLines / totalLines > BAD_LINE_RATIO_LIMIT;
  // 认头条件（**不再有版本字段**）：`_ === 'meta'` 且带 rootId / generator / dirStamps。
  //   缺任一 ⇒ 判不完整、走重建（宁可重扫，不拿来历不明的结构当结果）。
  const meta = (metaRow && metaRow._ === 'meta' && metaRow.rootId
    && metaRow.generator !== undefined && metaRow.dirStamps !== undefined)
    ? {
      rootId: metaRow.rootId,
      ts: metaRow.ts,
      generator: metaRow.generator,
      dirStamps: metaRow.dirStamps,
      complete: true,   // 头部自洽；整体完整性由下面的三条件判定
    }
    : null;

  // complete 判定 = **三条件**：meta 头存在 + complete 末行存在 + 末行 count === 实际条数
  const countMatches = completeRow && completeRow.v && Number(completeRow.v.count) === byKey.size;
  const complete = Boolean(meta && countMatches && !tooManyBad);

  return {
    format: 'jsonl',
    meta,
    models: [...byKey.values()],
    complete,
    badLines,
    bytes,
    ...(tooManyBad ? { error: `坏行过多（${badLines}/${totalLines}），判为损坏` } : {}),
  };
}

/** 单个历史 JSON 清单解析（文件必须存在）：**视为 complete=true**（历史文件都是完整写出的） */
function readJsonFile(jsonFile) {
  try {
    const text = fs.readFileSync(jsonFile, 'utf8');
    const payload = JSON.parse(text);
    return {
      format: 'json',
      meta: {
        rootId: payload.rootId || null,
        ts: payload.ts || null,
        generator: payload.generator || null,
        dirStamps: payload.dirStamps || null,
        complete: true,
      },
      models: Array.isArray(payload.models) ? payload.models : [],
      complete: true,
      badLines: 0,
      bytes: Buffer.byteLength(text),
    };
  } catch (e) {
    return { format: 'json', meta: null, models: [], complete: false, badLines: 0, bytes: 0, error: e.message };
  }
}

/**
 * 读清单：先按**当前优先格式**读，缺失再回落另一种。
 *
 * 默认优先 `.json`（保持原有行为）；`MODELSTAGE_MANIFEST_FORMAT=jsonl` 时优先 `.jsonl`。
 * 两种格式都能读，切换格式不需要迁移历史文件。
 *
 * @param {string} base 不带扩展名的路径
 * @returns {{
 *   format: 'jsonl'|'json'|'none',
 *   meta: object|null,
 *   models: object[],
 *   complete: boolean,
 *   badLines: number,
 *   bytes: number,
 *   error?: string,
 * }}
 */
export function readManifest(base) {
  const jsonlFile = `${base}.jsonl`;
  const jsonFile = `${base}.json`;
  const order = preferredManifestFormat() === 'jsonl' ? ['jsonl', 'json'] : ['json', 'jsonl'];
  for (const fmt of order) {
    if (fmt === 'jsonl') {
      if (fs.existsSync(jsonlFile)) return readJsonlFile(jsonlFile);
      continue;
    }
    if (fs.existsSync(jsonFile)) return readJsonFile(jsonFile);
  }
  return { format: 'none', meta: null, models: [], complete: false, badLines: 0, bytes: 0 };
}

export { BAD_LINE_RATIO_LIMIT };
