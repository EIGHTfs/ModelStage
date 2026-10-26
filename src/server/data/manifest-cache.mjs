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

/** Spine 清单路径：config/models/spine.<rootId>.json */
export function spineManifestFile(configFile, rootId) {
  return path.join(manifestDir(configFile), `spine.${rootId}.json`);
}

/** Live2D 清单路径：config/models/live2d.<rootId>.json */
export function live2dManifestFile(configFile, rootId) {
  return path.join(manifestDir(configFile), `live2d.${rootId}.json`);
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
  if (rootId) {
    for (const f of [spineManifestFile(configFile, rootId), live2dManifestFile(configFile, rootId)]) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        /* 删除失败不影响调用方：清单不可用会被后续扫描覆盖 */
      }
    }
    return;
  }
  try {
    const dir = manifestDir(configFile);
    for (const n of fs.readdirSync(dir)) {
      if (/^(?:spine|live2d)\..+\.json$/.test(n)) fs.unlinkSync(path.join(dir, n));
    }
  } catch {
    /* 目录不存在 = 没有清单要删 */
  }
}
