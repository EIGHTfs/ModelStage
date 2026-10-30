// server/unpack/write-result.mjs —— 把一次解包结果**原子落盘**
//
// 从 plugin-store.mjs 搬出来的唯一实现（主线程那份已删除）：worker 里解完直接落盘，
//   只把清单回传主线程（几十 MB 的 files Buffer 不过 postMessage）。
//
// 原子性靠"同卷 rename"：先全写进 `.tmp-<fp>-<pid>-<rand>/`，再 rename 成 `<rootDir>/<fp>/`。
//   rename 前要先取走 probe.json、删掉旧目录再 rename（POSIX rename 到非空目录报 ENOTEMPTY），
//   然后把 probe 写回 —— 否则"重新解包"会把历史内存实测值一起丢掉。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 建目录（递归；已存在不报错） */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 把一次解包结果原子落盘。**失败一律清掉半成品临时目录**。
 * @param {{
 *   rootDir: string,            解包缓存根
 *   fp: string,                 指纹（目录名）
 *   res: object,                unpackFile 的返回（含 files 视图 / prefix / entry / unpackMs）
 *   meta: object,               写进 index.json 的源信息（rootId/rel/size/mtimeMs/pluginId/pluginVersion）
 *   probeStore: object,         createProbeStore(...) 的实例（取走/写回 probe）
 *   sampleRss?: Function,       采样回调（可选；只要统计不影响正确性）
 * }} args
 * @returns {Promise<{index: object, files: Array<{path:string,size:number}>}>}
 */
export async function writeResult({ rootDir, fp, res, meta, probeStore, sampleRss }) {
  const tmpDir = path.join(rootDir, `.tmp-${fp}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  const fpDir = path.join(rootDir, fp);
  ensureDir(path.join(tmpDir, 'files'));
  const files = [];
  try {
    for (const { path: relPath } of res.files.entries) {
      const bytes = await res.files.take(relPath);
      if (!bytes) continue;
      const dst = path.join(tmpDir, 'files', relPath);
      ensureDir(path.dirname(dst));
      fs.writeFileSync(dst, bytes);
      files.push({ path: relPath, size: bytes.length });
      // 写完立刻从沙盒 Map 里删掉引用（42MB 包 RSS 增量约 210MB，逐个释放能显著削峰）
      res.files.release(relPath);
      if (typeof sampleRss === 'function') sampleRss();
    }
    const now = new Date().toISOString();
    const index = {
      v: 1,
      fingerprint: fp,
      pluginId: meta.pluginId,
      pluginVersion: meta.pluginVersion,
      source: { rootId: meta.rootId, rel: meta.rel, size: meta.size, mtimeMs: Math.round(meta.mtimeMs) },
      prefix: res.prefix,
      entry: res.entry,
      files,
      createdAt: now,
      lastUsedAt: now,
      unpackMs: res.unpackMs,
    };
    fs.writeFileSync(path.join(tmpDir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
    // 同卷 rename：原子替换，读者要么看到旧目录要么看到新目录。
    // 目标目录已存在时 POSIX rename 会报 ENOTEMPTY（旧实现直接失败 ⇒
    //   "files 缺失要重新解包"这条恢复路径其实一直不可用）。这里先取走 probe 缓存、
    //   删掉旧目录再 rename，然后把缓存写回，避免重新解包把内存实测值一起丢掉。
    const keepProbe = probeStore ? probeStore.read(fp) : null;
    try {
      fs.renameSync(tmpDir, fpDir);
    } catch (e) {
      if (e && (e.code === 'ENOTEMPTY' || e.code === 'EEXIST' || e.code === 'EPERM')) {
        fs.rmSync(fpDir, { recursive: true, force: true });
        fs.renameSync(tmpDir, fpDir);
        if (keepProbe) probeStore.write(fp, keepProbe);
      } else throw e;
    }
    return { index, files };
  } catch (e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败不影响主流程 */ }
    throw e;
  }
}

export default writeResult;
