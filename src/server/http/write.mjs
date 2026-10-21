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

/** 请求体上限（字符）：roots 配置体量很小，超过就不正常；拒绝而不是截断，避免写出坏配置 */
const MAX_BODY_CHARS = 1e6;
/** 显示名长度上限：过长会把左栏布局撑坏 */
const MAX_NAME_CHARS = 60;
/** 支持的写动作（改这里要同步左栏 UI 与文档） */
const ROOT_ACTIONS = ['add', 'remove', 'rename', 'toggle'];

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
 * 创建写接口。
 * @param {{paths: object, config: object, models: object}} deps
 *   paths  = core/paths.mjs 的路径表（configDir / configFile / root）
 *   config = core/config.mjs（readConfigRaw / writeConfig / readConfig / buildGroups）
 *   models = data/models.mjs（invalidateModelsCache：不传参 = 失效全部）
 * @returns {{writeRoots: (rawBody: string) => Promise<{status:number, body:object}>}}
 */
export function createWriteApi({ paths, config, models }) {
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

  return { writeRoots };
}
