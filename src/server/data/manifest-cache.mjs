// data/manifest-cache.mjs —— 模型索引清单的路径、目录与失效（Spine 与 Live2D 共用）
//
// 为什么单独一层：两套清单（spine.<id>.json / live2d.<id>.json）落在同一个目录 config/models/，
//   而「路径怎么拼」「目录不存在先建」「失效某个根 / 失效全部」这三件事与具体扫描器无关。
//   早期实现把它们塞在 Spine 模块里，导致一个「只管 Spine」的模块同时定义 Live2D 的清单路径、
//   还负责删两套清单 —— 职责与名字对不上，也没法把文件改成 spine.mjs。
//
// 失效只扫 config/models/ 目录、只认 `^(spine|live2d).<id>.json$`：
//   手工配置（如 config/live2d.json 的渲染开关）不在这个目录里，
//   所以不存在"按前缀匹配误删用户配置"的风险（旧实现按 config/ 前缀匹配时真出过一次）。

import fs from 'node:fs';
import path from 'node:path';

/** 清单目录：<config>/models/ —— 扫描产物与手工配置分开存放 */
export function manifestDir(configFile) {
  return path.join(path.dirname(configFile), 'models');
}

/**
 * 清单的**基名**（不带扩展名）：config/models/spine.<rootId>
 * 为什么引入 base：同一份清单现在有两种落盘格式（.jsonl 当前 / .json 历史），
 *   读写层需要"同一个名字 + 不同后缀"，而不是各自拼一遍字符串（拼两处早晚拼歪）。
 */
export function spineManifestBase(configFile, rootId) {
  return path.join(manifestDir(configFile), `spine.${rootId}`);
}

/** Live2D 清单基名：config/models/live2d.<rootId> */
export function live2dManifestBase(configFile, rootId) {
  return path.join(manifestDir(configFile), `live2d.${rootId}`);
}

/** Spine 清单路径（历史 JSON 格式）：config/models/spine.<rootId>.json */
export function spineManifestFile(configFile, rootId) {
  return `${spineManifestBase(configFile, rootId)}.json`;
}

/** Live2D 清单路径（历史 JSON 格式）：config/models/live2d.<rootId>.json */
export function live2dManifestFile(configFile, rootId) {
  return `${live2dManifestBase(configFile, rootId)}.json`;
}

/** 写清单前确保目录存在（首次运行或目录被清空时，不能因为缺目录写失败） */
export function ensureManifestDir(configFile) {
  fs.mkdirSync(manifestDir(configFile), { recursive: true });
}

/**
 * 失效清单。传 rootId 只删这个根的两套；不传删目录下全部。
 * 文件不存在、目录不存在都不算错（本来就没有清单可删）。
 */
export function invalidateManifests(configFile, rootId) {
  // **只删成品**（.jsonl / .json），**不删 tmp**。
  //
  //   为什么 tmp 不能删：tmp 是"扫描正在写的那份"。invalidate 可能被**并发触发**
  //   （另一个根 refresh、或任何一次失效），删掉正在写的 tmp ⇒ 那个扫描 finish 时 rename ENOENT
  //   （实测日志：`rename 'spine.nikke_2.jsonl.tmp' -> 'spine.nikke_2.jsonl'`）。
  //   tmp 现在带 pid+seq 唯一名，靠"年龄"清理：只删老到不可能是"正在写"的。
  const FINAL_SUFFIXES = ['.jsonl', '.json'];
  const TMP_MAX_AGE_MS = 60 * 60 * 1000;   // 1 小时：正常扫描远用不到，超过即视为残留
  const TMP_RE = /\.\d+\.\d+\.jsonl\.tmp$/;   // <base>.<pid>.<seq>.jsonl.tmp

  function cleanupStaleTmp(dir) {
    const now = Date.now();
    try {
      for (const n of fs.readdirSync(dir)) {
        if (!TMP_RE.test(n)) continue;
        const full = path.join(dir, n);
        try {
          // 只删老的：新 tmp 可能正是另一个扫描正在写的
          if (now - fs.statSync(full).mtimeMs > TMP_MAX_AGE_MS) fs.unlinkSync(full);
        } catch { /* 单个文件处理失败不影响整体 */ }
      }
    } catch { /* 目录读不了就算了 */ }
  }

  if (rootId) {
    for (const base of [spineManifestBase(configFile, rootId), live2dManifestBase(configFile, rootId)]) {
      for (const suffix of FINAL_SUFFIXES) {
        const f = `${base}${suffix}`;
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch {
          /* 删除失败不影响调用方：清单不可用会被后续扫描覆盖 */
        }
      }
    }
    cleanupStaleTmp(manifestDir(configFile));
    return;
  }
  try {
    const dir = manifestDir(configFile);
    for (const n of fs.readdirSync(dir)) {
      if (/^(?:spine|live2d)\..+\.(?:jsonl|json)$/.test(n)) fs.unlinkSync(path.join(dir, n));
    }
    cleanupStaleTmp(dir);
  } catch {
    /* 目录不存在 = 没有清单要删 */
  }
}
