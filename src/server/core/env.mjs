// env.mjs —— 项目根 .env 的极简解析（零依赖）

const log = createLogger('brand');
//
// 不引入 dotenv：只需要 KEY=VALUE、注释、成对引号剥除这几条规则。
// 每次调用都重读文件，改完 .env 刷新页面即生效。
import fs from 'node:fs';
import { createLogger } from './log.mjs';

/** @param {{dotenvFile: string}} p 由 createPaths() 产出 */
export function createEnv(p) {
  const DOTENV_FILE = p.dotenvFile;
  const ENV_FLAG_TRUE = new Set(['1', 'true', 'on', 'yes']);
  const ENV_FLAG_FALSE = new Set(['0', 'false', 'off', 'no']);

function readDotEnv() {
  const out = {};
  try {
    if (!fs.existsSync(DOTENV_FILE)) return out;
    const text = fs.readFileSync(DOTENV_FILE, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key) out[key] = val;
    }
  } catch (e) {
    log.warn('读取 .env 失败，按内置默认处理', { err: e.message });
  }
  return out;
}

function parseEnvFlag(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!v) return null;
  if (ENV_FLAG_TRUE.has(v)) return true;
  if (ENV_FLAG_FALSE.has(v)) return false;
  return null;
}

  return { readDotEnv, parseEnvFlag, DOTENV_FILE };
}

