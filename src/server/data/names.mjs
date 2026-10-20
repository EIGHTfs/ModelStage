// names.mjs —— 角色名表读取（config/names/<id>.json）
//
// 名表是数据（JSON），不写死在代码里；后端只读取与返回，怎么显示由前端决定。
import fs from 'node:fs';
import path from 'node:path';

/** @param {{root: string}} p */
export function createNames(p) {
  const ROOT = p.root;
  /** 名表缓存：按 names id 记忆解析结果（含 null），避免重复解析大 JSON */
  const nameTableCache = new Map();

/** 读资源根的名表（统一规范见 tool/name-table-spec.mjs）。无配置或读不到返回 null。 */
function getNameTable(root) {
  if (!root || !root.names) return null;
  if (nameTableCache.has(root.names)) return nameTableCache.get(root.names);
  let t = null;
  try {
    t = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'names', `${root.names}.json`), 'utf8'));
  } catch (e) {
    console.warn(`[names] 名表读取失败 config/names/${root.names}.json: ${e.message}`);
    t = null;
  }
  nameTableCache.set(root.names, t);
  return t;
}

  return { getNameTable };
}

