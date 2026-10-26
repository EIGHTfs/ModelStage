// names.mjs —— 名表读取（只读文件、原样返回）
//
// 名表是数据（JSON），不写死在代码里。**服务端不认识它的结构**：
//   不做解析、不归一化、不校验业务字段 —— 只把 config/names/<id>.json 读出来交给调用方。
//
// 为什么这样切：名表是纯数据，形状会随游戏演进（多语言数组、归并字段…）。
//   服务端当文件搬运工 ⇒ 以后改名表结构不需要动服务端一行代码，
//   也不会出现"服务端理解一份形状、前端理解另一份"的两套知识。
//   结构合法性由 tool/check-index.mjs 在提交前拦，不在运行期兜底。
//
// 「文件不存在」必须**明确报错**而不是静默返回空表：
//   静默空表的后果是整片名字消失且界面上没有任何提示，比一条明确的错误难查一百倍。
import fs from 'node:fs';
import { createLogger } from '../core/log.mjs';
import path from 'node:path';

const log = createLogger('names');

/** 名表读取失败的原因码（调用方据此决定 HTTP 状态码与文案） */
export const NAME_TABLE_ERRORS = {
  NOT_CONFIGURED: 'NOT_CONFIGURED',   // 该资源根没配 names
  NO_TABLE: 'NO_TABLE',               // 配了 names，但 config/names/<id>.json 不存在
  BROKEN: 'BROKEN',                   // 文件存在但解析失败
};

/** @param {{root: string, namesDir: string, indexDir: string}} p */
export function createNames(p) {
  const NAMES_DIR = p.namesDir || path.join(p.root, 'config', 'names');
  /** 名表缓存：按 names id 记忆归一化结果（含失败结果），避免重复解析大 JSON */
  const nameTableCache = new Map();

  /**
   * 读一个 names id 对应的表：**只读 config/names/<id>.json，原样返回**。
   *
   * 为什么不做任何解析/归一化：名表是纯数据，形状会随游戏演进（这轮就在改 name 为多语言数组、
   *   加归并字段）。服务端只当文件搬运工 ⇒ 以后改名表结构不需要动服务端一行代码，
   *   也不会出现"服务端理解一份形状、前端理解另一份"的两套知识。
   *   结构不合法由 tool/check-index.mjs 在提交前拦，不在运行期兜底。
   *
   * @param {string} namesId 名表 id（= resources.json 里该根的 names 字段，即 config/names/<id>.json 的文件名）
   * @returns {{table: object|null, error: string|null, detail: string}}
   */
  function loadNamesTable(namesId) {
    if (!namesId) return { table: null, error: NAME_TABLE_ERRORS.NOT_CONFIGURED, detail: '该资源根未配置 names 名表' };

    const file = path.join(NAMES_DIR, `${namesId}.json`);
    // 缓存按文件 mtime 失效：名表是**手工维护的纯数据文件**，改完不该要求重启服务才生效
    //   （踩过：改了表里的中文名，接口仍返回旧内容，排查半天以为链路错）。
    //   一次 stat 的开销可忽略，换来"存盘即生效"。
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { mtimeMs = 0; }
    const cached = nameTableCache.get(namesId);
    if (cached && cached.mtimeMs === mtimeMs) return cached.result;

    let result;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      result = {
        table: {
          source: 'names',
          specVersion: Number((raw._meta && raw._meta.v) || 2),
          game: (raw._meta && raw._meta.game) || namesId,
          mergeBy: (raw._meta && raw._meta.mergeBy) || 'id',
          characters: raw.characters || {},
          byAsset: raw.byAsset || {},
        },
        error: null,
        detail: '',
      };
    } catch (e) {
      const missing = e && e.code === 'ENOENT';
      result = missing
        ? { table: null, error: NAME_TABLE_ERRORS.NO_TABLE, detail: `名表不存在：config/names/${namesId}.json` }
        : { table: null, error: NAME_TABLE_ERRORS.BROKEN, detail: `config/names/${namesId}.json 解析失败：${e.message}` };
    }
    nameTableCache.set(namesId, { mtimeMs, result });
    return result;
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
