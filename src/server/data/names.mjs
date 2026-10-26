// names.mjs —— 角色名表读取（v2 index 优先、v1 兜底）
//
// 名表是数据（JSON），不写死在代码里；后端只读取与返回，怎么显示由前端决定。
//
// 两代格式并存（见 docs/设计/名表.md §九）：
//   v2：config/index/<names>.index.json —— 名字是多语言数组、byAsset 值是 {char, costume?, how}
//   v1：config/names/<names>.json       —— 名字是字符串 + nameZh、byAsset 值是字符串
//
// **对外只给一种形状**：不管背后是 v1 还是 v2，都归一化成同一份 `table`：
//   { source, specVersion, game, characters, byAsset }
//   characters[id] = { name: '显示名', names: [{lang,text}], avatar }
//   byAsset[key]   = { char, costume, how }        ← v1 的字符串值在这里被包成对象
// 这样消费方（头像解析、角色树聚合）不需要各写一套 v1/v2 分支 —— 分支只在本文件里存在一次。
//
// 「两者都没有」必须**明确报错**而不是静默返回空表：
//   静默空表的后果是整片名字消失且界面上没有任何提示（只有"名字变成目录名"这一个隐晦症状），
//   比一条明确的错误难查一百倍。
import fs from 'node:fs';
import { createLogger } from '../core/log.mjs';
import path from 'node:path';

const log = createLogger('names');

/** 名表读取失败的原因码（调用方据此决定 HTTP 状态码与文案） */
export const NAME_TABLE_ERRORS = {
  NOT_CONFIGURED: 'NOT_CONFIGURED',   // 该资源根没配 names
  NO_TABLE: 'NO_TABLE',               // 配了 names，但 index 与 v1 两个文件都不存在
  BROKEN: 'BROKEN',                   // 文件存在但解析失败 / 结构不可用
};

/**
 * 把名字数组归一化成"显示名"。
 * 显示规则（设计文档 §三）：中文优先 → 数组第一个元素 → 空串（调用方回退资源目录名）。
 */
function displayName(names) {
  if (!Array.isArray(names) || !names.length) return '';
  const zh = names.find((n) => n && n.lang === 'zh' && typeof n.text === 'string' && n.text.trim());
  if (zh) return zh.text.trim();
  const first = names.find((n) => n && typeof n.text === 'string' && n.text.trim());
  return first ? first.text.trim() : '';
}

/** v2 条目归一化 */
function fromV2Char(c) {
  const names = Array.isArray(c && c.name) ? c.name.filter((n) => n && typeof n.text === 'string') : [];
  return {
    name: displayName(names),
    names,
    avatar: c && typeof c.avatar === 'string' ? c.avatar : '',
    costumes: (c && c.costumes) || null,
  };
}

/** v1 条目归一化（name + nameZh → 多语言数组；icon → avatar） */
function fromV1Char(c) {
  const zh = c && typeof c.nameZh === 'string' ? c.nameZh.trim() : '';
  const base = c && typeof c.name === 'string' ? c.name.trim() : '';
  const text = zh || base;
  const names = text ? [{ lang: 'zh', text }] : [];
  return {
    name: text,
    names,
    avatar: c && typeof c.icon === 'string' ? c.icon : '',
    costumes: null,
  };
}

/** 把 byAsset 的值统一成 { char, costume, how }（v1 的字符串值在这里被包起来） */
function normalizeAssetMap(byAsset) {
  const out = {};
  if (!byAsset || typeof byAsset !== 'object') return out;
  for (const [key, v] of Object.entries(byAsset)) {
    if (typeof v === 'string') {
      out[key] = { char: v, costume: null, how: 'upstream' };   // v1：值就是角色 ID
    } else if (v && typeof v === 'object' && typeof v.char === 'string') {
      out[key] = { char: v.char, costume: typeof v.costume === 'string' ? v.costume : null, how: v.how || 'upstream' };
    }
  }
  return out;
}

/** @param {{root: string, namesDir: string, indexDir: string}} p */
export function createNames(p) {
  const NAMES_DIR = p.namesDir || path.join(p.root, 'config', 'names');
  const INDEX_DIR = p.indexDir || path.join(p.root, 'config', 'index');
  /** 名表缓存：按 names id 记忆归一化结果（含失败结果），避免重复解析大 JSON */
  const nameTableCache = new Map();

  /**
   * 读一个 names id 对应的表：**index 优先 → v1 兜底 → 都没有明确报错**。
   * @param {string} namesId 名表 id（= resources.json 里根的 names 字段，如 azurlane）
   * @returns {{table: object|null, error: string|null, detail: string}}
   */
  function loadNamesTable(namesId) {
    if (!namesId) return { table: null, error: NAME_TABLE_ERRORS.NOT_CONFIGURED, detail: '该资源根未配置 names 名表' };
    if (nameTableCache.has(namesId)) return nameTableCache.get(namesId);

    const indexFile = path.join(INDEX_DIR, `${namesId}.index.json`);
    const v1File = path.join(NAMES_DIR, `${namesId}.json`);
    const hasIndex = fs.existsSync(indexFile);
    const hasV1 = fs.existsSync(v1File);

    let result;
    if (hasIndex) {
      // ① v2 index（优先）
      try {
        const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        const chars = raw.characters || {};
        const characters = {};
        for (const [id, c] of Object.entries(chars)) characters[id] = fromV2Char(c);
        result = {
          table: {
            source: 'index',
            specVersion: Number((raw._meta && raw._meta.specVersion) || 2),
            game: (raw._meta && raw._meta.game) || namesId,
            characters,
            byAsset: normalizeAssetMap(raw.byAsset),
          },
          error: null,
          detail: '',
        };
      } catch (e) {
        // index 坏了不直接失败：按设计"index 优先、v1 兜底"，坏索引应降级到 v1 而不是让功能整体不可用
        log.warn('index 名表解析失败，尝试 v1 兜底', { file: `config/index/${namesId}.index.json`, err: e.message });
        result = hasV1 ? readV1() : {
          table: null, error: NAME_TABLE_ERRORS.BROKEN,
          detail: `config/index/${namesId}.index.json 解析失败（${e.message}），且没有可兜底的 v1 名表`,
        };
      }
    } else if (hasV1) {
      result = readV1();
    } else {
      result = {
        table: null,
        error: NAME_TABLE_ERRORS.NO_TABLE,
        detail: `名表不存在：既没有 config/index/${namesId}.index.json，也没有 config/names/${namesId}.json`,
      };
    }
    nameTableCache.set(namesId, result);
    return result;

    /** v1 兜底读 */
    function readV1() {
      try {
        const raw = JSON.parse(fs.readFileSync(v1File, 'utf8'));
        const chars = raw.characters || {};
        const characters = {};
        for (const [id, c] of Object.entries(chars)) characters[id] = fromV1Char(c);
        return {
          table: {
            source: 'v1',
            specVersion: Number((raw._meta && raw._meta.specVersion) || 1),
            game: (raw._meta && raw._meta.game) || namesId,
            characters,
            byAsset: normalizeAssetMap(raw.byAsset),
          },
          error: null,
          detail: '',
        };
      } catch (e) {
        return {
          table: null, error: NAME_TABLE_ERRORS.BROKEN,
          detail: `config/names/${namesId}.json 解析失败：${e.message}`,
        };
      }
    }
  }

  /**
   * 读资源根的名表（旧签名：只返回表，供头像解析这类"拿到就用、拿不到就退化"的场景）。
   * 拿不到时**记一条 warn**（不静默），返回 null 让调用方走回退路径。
   */
  function getNameTable(root) {
    if (!root || !root.names) return null;
    const { table, error, detail } = loadNamesTable(root.names);
    if (!table) {
      log.warn('名表不可用', { names: root.names, error, detail });
      return null;
    }
    return table;
  }

  /**
   * 清空名表缓存。
   *
   * 为什么需要：名表是"文件内容"的缓存，导入配置会整体替换名表文件；
   *   不清缓存的话，进程内还留着旧名表，界面会继续显示导入前的角色名，
   *   直到重启服务才更新（表现为"导入没生效"）。
   */
  function clearNameCache() {
    nameTableCache.clear();
  }

  return { getNameTable, loadNamesTable, clearNameCache };
}
