// write.mjs —— 写接口的共用管道（资源根增删改名启停 / 配置导入）
//
// 固定顺序：**校验 → 备份 → 写（tmp + rename）→ 失效缓存**。顺序不可换：
//   · 校验最前：非法输入在碰磁盘之前就被拒，配置文件一个字节都不变；
//   · 备份在写之前：写一旦出问题，手里还有可回滚的完整副本；
//   · 写用 tmp + rename（见 core/config.mjs）：rename 原子，任何时刻外部读到的
//     要么是"旧的完整版本"要么是"新的完整版本"，不存在读到半截；
//   · 失效缓存放最后：若先清缓存再写而写失败，会留下被删掉的清单文件，下次访问要全量重扫。
//
// 返回形态统一为 { status, body }，内部不抛异常（与 data 层只读接口同形）：
//   写路径的任何异常都必须在函数内部变成响应，不能让 http 回调里的未捕获异常打挂进程。
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc } from '../../../tool/parse-jsonc.mjs';

/** 请求体上限（字符）：roots 配置体量很小，超过就不正常；拒绝而不是截断，避免写出坏配置 */
const MAX_BODY_CHARS = 1e6;
/** 显示名长度上限：过长会把左栏布局撑坏 */
const MAX_NAME_CHARS = 60;
/** 支持的写动作（改这里要同步左栏 UI 与文档） */
const ROOT_ACTIONS = ['add', 'remove', 'rename', 'toggle'];
/** 导入请求体上限（字符）：名表可能较大，与旧端一致取 5MB */
const MAX_IMPORT_CHARS = 5e6;
/** 备份保留份数：更早的移入 config/.trash/（可恢复），避免反复导入把 config/ 堆满 */
const BACKUP_KEEP = 5;
/** 允许导入的文件白名单：只有资源配置与名表 —— 不给"任意写盘"的口子 */
const IMPORTABLE = [/^resources\.json$/, /^names\/[^/\\]+\.json$/];

/**
 * 时间戳（用于备份目录名）：本地时间 YYYYMMDD-HHmmss，可排序、人可读。
 * @param {Date} d
 * @returns {string}
 */
function stampOf(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-`
    + `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/**
 * 目录是否存在且是目录（statSync 可能因竞态抛错，这里一并吞成 false）。
 * @param {string} p
 * @returns {boolean}
 */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 把资源根原始列表映射成前端视图（与 GET /api/roots 同形）。
 * 存在性单独探测：配置里的路径可能已被用户挪走，前端要据此标灰。
 * @param {Array<object>} list 原始资源根数组（含停用项）
 * @returns {Array<object>}
 */
export function toRootView(list) {
  return list.map((r) => ({
    id: r.id,
    name: r.name,
    path: r.path,
    kind: r.kind || 'spine',
    profile: r.profile || null,
    enabled: r.enabled !== false,
    exists: isDir(r.path),
  }));
}

/**
 * 由目录名推导资源根 id：小写、非字母数字转下划线、去首尾下划线。
 * 为什么不用随机串：id 会出现在清单文件名（models.<id>.json）里，人类可读便于排障。
 * @param {string} dir
 * @returns {string}
 */
function idFromPath(dir) {
  return path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
}

/**
 * 校验一批待导入的配置文件（纯函数，不碰磁盘）。
 *
 * 校验口径（整体通过才写）：
 *   · 文件名必须在白名单内（`resources.json` 或 `names/<名>.json`），其余一律拒绝；
 *   · 内容必须是非空字符串；
 *   · `resources.json` 要能被 JSONC 解析、`roots` 是数组、每项 id/path 齐全且 id 不重复、
 *     path 是绝对路径（相对路径会按进程工作目录解析，落到别处）；
 *   · 名表要能被 JSON.parse 且结果是对象。
 *
 * @param {object} files 形如 { 'resources.json': '<文本>', 'names/x.json': '<文本>' }
 * @returns {string[]} 错误清单；空数组表示通过
 */
function validateImportFiles(files) {
  const errs = [];
  const entries = Object.entries(files || {});
  if (!entries.length) {
    errs.push('导入内容为空');
    return errs;
  }
  for (const [rel, text] of entries) {
    if (!IMPORTABLE.some((re) => re.test(rel))) {
      errs.push(`${rel}: 不在允许导入的白名单内（只接受 resources.json 与 names/<名>.json）`);
      continue;
    }
    if (typeof text !== 'string' || !text.trim()) {
      errs.push(`${rel}: 内容为空或不是字符串`);
      continue;
    }
    if (rel === 'resources.json') {
      try {
        const cfg = parseJsonc(text, 'resources.json');
        if (!Array.isArray(cfg.roots)) {
          errs.push('resources.json: 缺少 roots 数组');
          continue;
        }
        const seen = new Set();
        cfg.roots.forEach((r, i) => {
          if (!r || typeof r !== 'object') {
            errs.push(`resources.json: roots[${i}] 不是对象`);
            return;
          }
          if (!r.id || typeof r.id !== 'string') errs.push(`resources.json: roots[${i}] 缺少 id`);
          else if (seen.has(r.id)) errs.push(`resources.json: roots[${i}] id 重复（${r.id}）`);
          else seen.add(r.id);
          if (!r.path || typeof r.path !== 'string') errs.push(`resources.json: roots[${i}] 缺少 path`);
          else if (!path.isAbsolute(r.path)) errs.push(`resources.json: roots[${i}] path 不是绝对路径`);
        });
      } catch (e) {
        errs.push(`resources.json 解析失败: ${e.message}`);
      }
    } else {
      try {
        const obj = JSON.parse(text);
        if (!obj || typeof obj !== 'object') errs.push(`${rel}: 解析结果不是对象`);
      } catch (e) {
        errs.push(`${rel} 解析失败: ${e.message}`);
      }
    }
  }
  return errs;
}

/**
 * 解析导入请求体（管道第①步）：只判形状，不碰磁盘。
 *
 * 为什么单独成函数：请求体有四种"不像话"的形态（空 / 超限 / 非法 JSON / 缺 files），
 *   各自对应不同状态码，混在编排里会让主流程读不出"这段在干什么"。
 *
 * @param {string} rawBody 原始请求体
 * @returns {{ok:true, files:object} | {ok:false, status:number, error:string}}
 */
function parseImportBody(rawBody) {
  if (typeof rawBody !== 'string') return { ok: false, status: 400, error: '请求体为空' };
  if (rawBody.length > MAX_IMPORT_CHARS) {
    return { ok: false, status: 413, error: `请求体超过 ${MAX_IMPORT_CHARS} 字符` };
  }
  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch {
    return { ok: false, status: 400, error: '请求体不是合法 JSON' };
  }
  const files = payload && payload.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return {
      ok: false,
      status: 400,
      error: '缺少 files 对象：{ "files": { "resources.json": "<文本>", "names/<名>.json": "<文本>" } }',
    };
  }
  return { ok: true, files };
}

/**
 * 逐文件原子写（管道第④步）：每个文件先写 `.tmp` 再 rename。
 *
 * 为什么按文件而不是整批：rename 是原子的，单个文件不会出现"写一半"；
 *   整批失败时**不回滚**——已写的保持新内容、未写的保持原样，
 *   两者都能从同一个备份目录整体还原（回滚交给备份，而不是半途反向写）。
 *
 * @param {string} configDir 配置目录
 * @param {Array<{rel:string, text:string}>} entries 待写文件
 * @returns {{written:string[], error:Error|null}}
 */
function writeImportFiles(configDir, entries) {
  const written = [];
  try {
    for (const { rel, text } of entries) {
      const full = path.join(configDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(`${full}.tmp`, text, 'utf8');
      fs.renameSync(`${full}.tmp`, full);
      written.push(rel);
    }
    return { written, error: null };
  } catch (e) {
    return { written, error: e };
  }
}

/**
 * 回读自检（管道第⑥步）：写进去的每个文件都必须能重新解析，
 * 且 `resources.json` 的根数要与导入内容一致。
 *
 * 为什么必须回读：写盘成功不代表内容正确 —— 截断、编码破坏、清洗逻辑都可能改条数；
 *   不回读就只能靠"下一次请求报错"才发现，那时已经很难判断是谁写坏的。
 *
 * @param {string} configDir 配置目录
 * @param {string[]} written 已写文件（相对 config/）
 * @param {object} files 导入内容
 * @returns {{readback:object, selfCheckFailed:string|null}}
 */
function selfCheckImportedFiles(configDir, written, files) {
  const readback = { files: {}, rootsCount: null };
  let selfCheckFailed = null;
  for (const rel of written) {
    try {
      const text = fs.readFileSync(path.join(configDir, rel), 'utf8');
      if (rel === 'resources.json') {
        const cfg = parseJsonc(text, 'config/resources.json');
        readback.rootsCount = Array.isArray(cfg.roots) ? cfg.roots.length : null;
      } else {
        JSON.parse(text);
      }
      readback.files[rel] = 'ok';
    } catch (e) {
      readback.files[rel] = `parse-error: ${e.message}`;
      selfCheckFailed = `${rel}: ${e.message}`;
    }
  }
  if (!selfCheckFailed && readback.rootsCount != null) {
    const expect = parseJsonc(files['resources.json'], 'resources.json').roots.length;
    if (readback.rootsCount !== expect) {
      selfCheckFailed = `resources.json 根数不一致：导入 ${expect} / 实际 ${readback.rootsCount}`;
    }
  }
  return { readback, selfCheckFailed };
}

/**
 * 失效缓存（管道第⑤步）：资源根可能全变 ⇒ 清全部清单；名表文件被替换 ⇒ 清名表缓存。
 *
 * 为什么两件事分开 try：它们互相独立，一个失败不该连累另一个；
 *   失败信息汇总到 `error` 回给调用方（缓存没清只是"下次更慢"，不该让导入失败）。
 *
 * @param {object} models data/models.mjs 实例
 * @param {object} names data/names.mjs 实例
 * @returns {{models:boolean, names:boolean, error:string|null}}
 */
function invalidateImportCaches(models, names) {
  const out = { models: false, names: false, error: null };
  try {
    models.invalidateModelsCache();
    out.models = true;
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  try {
    if (names && typeof names.clearNameCache === 'function') {
      names.clearNameCache();
      out.names = true;
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

/**
 * 创建写接口。
 * @param {{paths: object, config: object, models: object, names: object}} deps
 *   paths  = core/paths.mjs 的路径表（configDir / configFile / root）
 *   config = core/config.mjs（readConfigRaw / writeConfig / readConfig / buildGroups）
 *   models = data/models.mjs（invalidateModelsCache：不传参 = 失效全部）
 *   names  = data/names.mjs（clearNameCache：导入替换名表后必须清缓存）
 * @returns {{writeRoots: Function, writeConfigImport: Function}}
 */
export function createWriteApi({ paths, config, models, names }) {
  // 串行队列：两个写请求并发时会各自读旧配置再写回，后写的覆盖先写的（丢一次改动）。
  // 排队保证「读-改-写」这一串不交错；前一个失败不影响后一个继续排队。
  let queue = Promise.resolve();

  /**
   * 把任务排进串行队列。
   * @param {() => {status:number, body:object}} task
   * @returns {Promise<{status:number, body:object}>}
   */
  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 备份 config/ 下的一个文件到 config/.bak-<时间戳>/<相对路径>。
   *
   * 为什么沿用旧端的 `.bak-<时间戳>` 目录约定：备份要和配置文件放在一起（同一个卷、
   *   同一个备份根），这样"找备份"只有一处；用目录而不是单文件后缀，是因为一次导入
   *   可能涉及多个文件，同一次操作应当归到同一个备份目录里。
   *
   * @param {string} rel 相对 config/ 的路径，如 'resources.json'
   * @returns {string|null} 备份文件的相对项目根路径；源文件不存在时返回 null（首次创建无需备份）
   */
  function backupConfigFile(rel) {
    const src = path.join(paths.configDir, rel);
    if (!fs.existsSync(src)) return null;
    const stamp = stampOf(new Date());
    let dir = path.join(paths.configDir, `.bak-${stamp}`);
    let seq = 2;
    // 同一秒内多次写：追加序号，避免覆盖上一次的备份
    while (fs.existsSync(dir)) {
      dir = path.join(paths.configDir, `.bak-${stamp}-${seq}`);
      seq += 1;
    }
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return path.relative(paths.root, dst).split(path.sep).join('/');
  }

  /**
   * 批量备份一批配置文件到同一个 `.bak-<时间戳>/` 目录。
   *
   * 为什么"一个导入一个目录"（而不是每文件各建一个）：一次导入可能改多个文件，
   *   回滚时必须能整体还原到"导入前那一刻"，分散在多个目录里就凑不回同一时点。
   *   源文件不存在（新建的文件）跳过备份 —— 回滚时删掉即可，没有旧内容可留。
   *
   * @param {string[]} rels 相对 config/ 的路径列表
   * @returns {string} 备份目录的相对项目根路径
   */
  function backupMany(rels) {
    const stamp = stampOf(new Date());
    let dir = path.join(paths.configDir, `.bak-${stamp}`);
    let seq = 2;
    while (fs.existsSync(dir)) {
      dir = path.join(paths.configDir, `.bak-${stamp}-${seq}`);
      seq += 1;
    }
    fs.mkdirSync(dir, { recursive: true });
    for (const rel of rels) {
      const src = path.join(paths.configDir, rel);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    return path.relative(paths.root, dir).split(path.sep).join('/');
  }

  /**
   * 备份轮换：只保留最近 keep 份，更早的**移入 config/.trash/**（不永久删除，可恢复）。
   *
   * 为什么要轮换：反复导入会不断生成备份目录，堆满 config/ 且干扰排查；
   *   移入 .trash/ 而不是删除，符合"删除操作可恢复"的约定（.trash/ 已在 .gitignore）。
   *
   * @param {number} keep 保留份数
   * @returns {number} 本次移入回收站的份数
   */
  function pruneBackups(keep) {
    const dir = paths.configDir;
    const trash = path.join(dir, '.trash');
    const baks = fs.readdirSync(dir).filter((n) => n.startsWith('.bak-')).sort().reverse();
    const drop = baks.slice(keep);
    if (!drop.length) return 0;
    fs.mkdirSync(trash, { recursive: true });
    for (const n of drop) {
      let dst = path.join(trash, n);
      let i = 2;
      while (fs.existsSync(dst)) {
        dst = path.join(trash, `${n}-${i}`);
        i += 1;
      }
      fs.renameSync(path.join(dir, n), dst);
    }
    return drop.length;
  }

  /**
   * 组装错误响应。
   * @param {number} status
   * @param {string} error
   * @param {object} [extra]
   * @returns {{status:number, body:object}}
   */
  const fail = (status, error, extra) => ({ status, body: { ok: false, error, ...(extra || {}) } });

  /**
   * 校验并算出「写入后应该是什么」——只做内存计算，不碰磁盘。
   *
   * 为什么单独抽出：校验要能整体失败（返回错误、原列表不动），
   *   而不是边改边校验（那就会半改）。
   *
   * @param {string} action
   * @param {object} payload 请求体
   * @param {Array<object>} raw 当前完整资源根列表（含停用项）
   * @returns {{ok:true, next:Array<object>, changed:object} | {ok:false, status:number, error:string, extra?:object}}
   */
  function planChange(action, payload, raw) {
    const next = raw.map((r) => ({ ...r }));

    if (action === 'add') {
      const rawPath = String(payload.path || '').trim();
      if (!rawPath) return { ok: false, status: 400, error: '缺少 path（要添加的资源根目录）' };
      const dir = path.resolve(rawPath);
      if (!path.isAbsolute(rawPath)) return { ok: false, status: 400, error: 'path 必须是绝对路径', path: dir };
      if (!isDir(dir)) return { ok: false, status: 400, error: '目录不存在或不是目录', path: dir };
      // 同一个目录登记两次会产生重复模型（列表里同一个模型出现两遍），直接拒
      const dup = next.find((r) => path.resolve(String(r.path)) === dir);
      if (dup) {
        return {
          ok: false, status: 409, error: '该目录已登记为资源根', path: dir,
          existing: { id: dup.id, name: dup.name },
        };
      }
      const wantId = String(payload.id || '').trim().toLowerCase();
      const baseId = wantId || idFromPath(dir);
      let id = baseId;
      let seq = 2;
      while (next.some((r) => r.id === id)) {
        id = `${baseId}_${seq}`;
        seq += 1;
      }
      const name = String(payload.name || '').trim() || path.basename(dir);
      if (name.length > MAX_NAME_CHARS) {
        return { ok: false, status: 400, error: `name 超过 ${MAX_NAME_CHARS} 个字符` };
      }
      // kind / profile 是可选声明，原样透传（渲染器按 kind 分组、按 profile 选扫描策略）
      const root = { id, name, path: dir, enabled: payload.enabled !== false };
      if (payload.kind) root.kind = String(payload.kind);
      if (payload.profile) root.profile = String(payload.profile);
      next.push(root);
      return { ok: true, next, changed: { root, merged: next.filter((r) => r.name === name).length > 1 } };
    }

    // 其余三个动作都按 id 定位
    const id = String(payload.id || '').trim();
    if (!id) return { ok: false, status: 400, error: '缺少 id（要操作的资源根标识）' };
    const idx = next.findIndex((r) => r.id === id);
    if (idx < 0) return { ok: false, status: 404, error: '未找到该资源根', id };

    if (action === 'remove') {
      const [removed] = next.splice(idx, 1);
      return { ok: true, next, changed: { removed } };
    }

    if (action === 'rename') {
      const name = String(payload.name || '').trim();
      if (!name) return { ok: false, status: 400, error: '缺少 name（新显示名）', id };
      if (name.length > MAX_NAME_CHARS) {
        return { ok: false, status: 400, error: `name 超过 ${MAX_NAME_CHARS} 个字符`, id };
      }
      const from = next[idx].name;
      next[idx].name = name;
      // name 同时是「归并键」：改成与别的根同名即表示"合并显示"，这是既定语义，不算冲突
      return { ok: true, next, changed: { id, from, to: name, merged: next.filter((r) => r.name === name).length > 1 } };
    }

    // toggle：只接受真正的布尔值，避免 "false" 字符串被当成 true
    if (typeof payload.enabled !== 'boolean') {
      return { ok: false, status: 400, error: 'toggle 需要布尔值 enabled', id };
    }
    const from = next[idx].enabled !== false;
    next[idx].enabled = payload.enabled;
    return { ok: true, next, changed: { id, from, to: payload.enabled } };
  }

  /**
   * POST /api/roots —— 资源根增 / 删 / 改名 / 启停。
   *
   * 请求体：`{ action: 'add'|'remove'|'rename'|'toggle', ... }`
   *   add    `{ path, name?, id?, kind?, profile?, enabled? }`
   *   remove `{ id }`
   *   rename `{ id, name }`
   *   toggle `{ id, enabled: boolean }`
   *
   * @param {string} rawBody 原始请求体文本
   * @returns {Promise<{status:number, body:object}>}
   */
  function writeRoots(rawBody) {
    return enqueue(() => {
      // ---------- ① 解析与形状校验 ----------
      if (typeof rawBody !== 'string') return fail(400, '请求体为空');
      if (rawBody.length > MAX_BODY_CHARS) return fail(413, `请求体超过 ${MAX_BODY_CHARS} 字符`);
      let payload;
      try {
        payload = JSON.parse(rawBody || '{}');
      } catch {
        return fail(400, '请求体不是合法 JSON');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return fail(400, '请求体必须是 JSON 对象');
      }
      const action = String(payload.action || 'add').trim();
      if (!ROOT_ACTIONS.includes(action)) {
        return fail(400, `action 不支持: ${action}`, { allowed: ROOT_ACTIONS });
      }

      // ---------- ② 读当前完整列表（含停用项）----------
      let raw;
      try {
        raw = config.readConfigRaw();
      } catch (e) {
        // 读不出来就中止：拿空列表写回会清空用户配置
        return fail(500, e.message);
      }

      // ---------- ③ 校验并算出目标状态（纯内存，失败则磁盘不动）----------
      const plan = planChange(action, payload, raw);
      if (!plan.ok) return fail(plan.status, plan.error, plan.extra);

      // ---------- ④ 备份（写盘前）----------
      let backup = null;
      try {
        backup = backupConfigFile('resources.json');
      } catch (e) {
        // 备份失败视为"没有回滚手段"，直接放弃写入
        return fail(500, `备份失败，已取消写入: ${e.message}`);
      }

      // ---------- ⑤ 写（tmp + rename，原子）----------
      try {
        config.writeConfig(plan.next);
      } catch (e) {
        return fail(500, `写入配置失败: ${e.message}`, { backup });
      }

      // ---------- ⑥ 失效缓存（只失效受影响的那个根）----------
      // 为什么不能"全部失效"：data/models.mjs 的 invalidateModelsCache() 不带参数时会删除
      //   config/ 下所有 models.* 与 live2d.* 文件 —— 其中 live2d.json 是**入库的手工配置**
      //   （Live2D 渲染开关，带注释、留着备查），删掉等于顺手丢配置。
      //   资源根写操作只影响自己那份清单，按 id 精确失效即可，其它根的缓存继续可用。
      const affectedId = action === 'add' ? plan.changed.root.id
        : action === 'remove' ? plan.changed.removed.id
          : plan.changed.id;
      const invalidated = { models: false, rootId: affectedId, error: null };
      try {
        models.invalidateModelsCache(affectedId);
        invalidated.models = true;
      } catch (e) {
        // 清理失败不影响本次写入结果：配置已生效，下次请求会重新生成清单
        invalidated.error = String((e && e.message) || e);
      }

      // ---------- ⑦ 回读自检：文件里确实变成了新列表 ----------
      let after = [];
      try {
        after = config.readConfigRaw();
      } catch (e) {
        return fail(500, `写入后回读失败（请检查配置）: ${e.message}`, { backup });
      }

      const body = {
        ok: true,
        action,
        changed: plan.changed,
        backup,
        invalidated,
        // roots 与 GET /api/roots 同形（只含启用的，前端直接可渲染）
        roots: toRootView(after.filter((r) => r.enabled !== false)),
        // rootsAll 含停用项：启停操作要能看到"刚被停用的那条"
        rootsAll: toRootView(after),
        groups: config.buildGroups(toRootView(after.filter((r) => r.enabled !== false))),
      };
      return { status: 200, body };
    });
  }

  /**
   * POST /api/config/import —— 导入配置（`resources.json` + `names/*.json`）。
   *
   * 与资源根写操作同一条管道（校验 → 备份 → 写 → 失效缓存 → 回读自检），差异只有四点：
   *   ① 一次可能涉及多个文件，**备份目录只有一个**（同一次导入要能整体回滚到同一时点）；
   *   ② 校验是**整体拒绝**：任一文件不合法就一个字节都不写，避免配置"半新半旧"；
   *   ③ 资源根可能全变，所以这里失效**全部**清单缓存；名表文件被替换，还要清名表缓存
   *      （名表按文件名缓存，不清就会一直显示导入前的角色名，像"导入没生效"）；
   *   ④ 写完全部文件后做回读自检：每个文件都要能重新解析，且 resources.json 的根数
   *      与导入内容一致 —— 这才算真的写对（防截断、防被清洗逻辑改条数）。
   *
   * @param {string} rawBody 原始请求体文本
   * @returns {Promise<{status:number, body:object}>}
   */
  /**
   * POST /api/config/import —— 导入配置（`resources.json` + `names/*.json`）。
   *
   * 本函数只做**编排**，七步各自独立成函数（见本文件上方）：
   *   解析 parseImportBody → 校验 validateImportFiles → 备份 backupMany →
   *   原子写 writeImportFiles → 失效缓存 invalidateImportCaches →
   *   回读自检 selfCheckImportedFiles → 备份轮换 pruneBackups
   *
   * 与资源根写操作同源的两条硬规则：
   *   · 校验**整体拒绝**：任一文件不合法就一个字节都不写（避免配置半新半旧）；
   *   · 备份**一个导入一个目录**：多文件改动要能整体回滚到同一时点。
   *
   * @param {string} rawBody 原始请求体文本
   * @returns {Promise<{status:number, body:object}>}
   */
  function writeConfigImport(rawBody) {
    return enqueue(() => {
      const parsed = parseImportBody(rawBody);
      if (!parsed.ok) return fail(parsed.status, parsed.error);
      const { files } = parsed;

      const details = validateImportFiles(files);
      if (details.length) return fail(400, '配置校验失败', { details });
      const entries = Object.entries(files).map(([rel, text]) => ({ rel, text }));

      let backup = null;
      try {
        backup = backupMany(entries.map((e) => e.rel));
      } catch (e) {
        return fail(500, `备份失败，已取消导入: ${e.message}`);
      }

      const w = writeImportFiles(paths.configDir, entries);
      if (w.error) {
        return fail(500, `写入配置失败（已完成 ${w.written.length}/${entries.length}，备份可回滚）: ${w.error.message}`,
          { backup, written: w.written });
      }

      const invalidated = invalidateImportCaches(models, names);
      const { readback, selfCheckFailed } = selfCheckImportedFiles(paths.configDir, w.written, files);
      if (selfCheckFailed) {
        return fail(500, `导入后自检未通过（备份可回滚）: ${selfCheckFailed}`,
          { backup, written: w.written, readback });
      }

      let pruned = 0;
      try { pruned = pruneBackups(BACKUP_KEEP); } catch { /* 轮换失败不影响导入结果 */ }

      return {
        status: 200,
        body: {
          ok: true,
          written: w.written,
          backup,
          invalidated,
          readback,
          pruned,
          roots: toRootView(config.readConfig()),
        },
      };
    });
  }

  return { writeRoots, writeConfigImport };
}
