// probe.mjs —— 只读探测工具：版本号、atlas 键、贴图页、路径越界防护、MIME 表
//
// 都是纯函数或「只读文件头」的低成本操作，不持有状态、不写盘。
import fs from 'node:fs';
import path from 'node:path';

/** JS 系扩展名共用的 MIME：.js/.mjs/.mts/.cjs 四个键映射同一值，只在这里写一次 */
const MIME_JS = 'text/javascript';
/** 二进制兜底 MIME：.skel/.moc/.mtn 都是八位字节流 */
const MIME_OCTET = 'application/octet-stream';
const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.js': MIME_JS, '.mjs': MIME_JS,
  '.mts': MIME_JS, '.cjs': MIME_JS, '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webp': 'image/webp', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.atlas': 'text/plain', '.skel': MIME_OCTET,
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.txt': 'text/plain', '.map': 'application/json', '.webm': 'video/webm',
  // Live2D 相关（天命之子资源）：moc 是二进制模型、mtn 是二进制动作，都按八位字节流发
  '.moc': MIME_OCTET, '.mtn': MIME_OCTET,
  '.moc3': 'application/octet-stream', '.phy': 'application/json',
};

const SPINE_EXT = new Set(['.skel', '.atlas', '.png', '.json', '.jpg', '.jpeg', '.webp']);

/** 版本归一到主次版本（照抄 原版实现的 Ew：4.1.24 -> 4.1）。 */
export function normalizeVersion(v) {
  const t = String(v).split('.');
  return t.length >= 2 ? `${t[0]}.${t[1]}` : String(v);
}

/**
 * 探测二进制 .skel 的 Spine 版本（**照抄 原版实现的 Mw**）。
 *
 * 为什么不能用宽松正则：原版 只认它支持的版本区间
 *   （2.x / 3.5-3.8 / 4.0-4.3 形式，后接点号与补丁号），
 *   避免误匹配文件头里 hash 等处的数字。
 * 探测不到时返回 **"4.0"**（与 原版 默认值一致）——
 *   此前我返回空串，导致前端 getRuntimeWithFallback("") 选错运行时、渲染与 8801 不一致。
 */
export function detectSkelVersion(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(512);
    const read = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    if (read <= 0) return '4.0';
    const s = buf.slice(0, read).toString('latin1')
      .match(/(2\.\d+|3\.[5-8]|4\.[0-3])\.\d+[\w-]*/);
    return s ? normalizeVersion(s[0]) : '4.0';
  } catch {
    return '4.0';
  }
}

/**
 * 探测 JSON 骨架的 Spine 版本（**照抄 原版实现的 ww**）。
 *
 * 此前我只对 .skel 探测，导致 41 个 .json 骨架模型 version 为空串（渲染不一致）。
 * skeleton.spine 位于文件开头，故只读前 4KB，避免为 MB 级骨架整文件读盘。
 */
export function detectJsonVersion(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const read = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    if (read <= 0) return '4.0';
    const m = buf.slice(0, read).toString('utf8').match(/"spine"\s*:\s*"([^"]+)"/);
    return m ? normalizeVersion(m[1]) : '4.0';
  } catch {
    return '4.0';
  }
}

/**
 * 解析 atlas 的 PMA（预乘 Alpha）声明（**照抄 原版实现的 Tp**）。
 *
 * 返回 true / false / **null（未声明 = 未知）**。
 * 为什么不能硬编码 false：BD2 系 atlas 均未声明 pma，正确语义是"未知"，
 *   应由前端做像素检测；硬编码 false 等于断言"非预乘"，会污染其判定，
 *   导致与原始 原版 渲染不一致（实测踩坑）。
 */
export function detectAtlasPma(file) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(/^pma:\s*(true|false)/m);
    return m ? m[1] === 'true' : null;
  } catch {
    return null;
  }
}

/**
 * 探测 Spine 二进制 .skel 文件的版本号（如 "4.1"）。
 *
 * 原理：Spine 二进制导出时，文件头区域包含版本字符串。
 *   实测 BD2 资源前 40 字节可见 "4.1.11"（偏移约 8-14）。
 *   只读前 64 字节 + 正则提取，成本极低（无需读取整个文件）。
 *
 * 返回主次版本（如 "4.1"），供模型对象选择对应运行时；探测失败返回 null，
 *   由调用方回退到自动识别模式（原版实现的 runtimeMode:"auto"）。
 *
 * @param {string} file 绝对路径
 * @returns {string|null} 如 "4.1"
 */
/**
 * 从 .atlas 内容首行提取资源标识（归一 key 的来源）。
 *
 * 为什么从内容取而不是用目录名：
 *   同一资源的目录命名可能大小写不统一（实测 Char000203_2 与 char000203），
 *   且不同资源根/不同层级下目录结构各异；而 atlas 首行引用的贴图名是资源内部
 *   一致的信息，用它做归一 key 更可靠 —— 原版与 Mod 只要贴图名相同即归一。
 *
 * 规则（刻意简化，不多此一举）：仅去扩展名 + 转小写。
 *   保留 cutscene_ 前缀（立绘/技能是真实区分）、保留 _2/_3 形态后缀。
 *   例：char000206.png -> "char000206"
 *       CutScene_Char000203_2.png -> "cutscene_char000203_2"
 *
 * @param {string} file atlas 绝对路径
 * @returns {string|null}
 */
export function detectAtlasKey(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256);
    const read = fs.readSync(fd, buf, 0, 256, 0);
    fs.closeSync(fd);
    if (read <= 0) return null;
    const firstLine = buf.slice(0, read).toString('utf8').split('\n')[0].trim();
    if (!firstLine) return null;
    return firstLine.replace(/\.[^.]+$/, '').toLowerCase();
  } catch {
    return null;
  }
}

/** 与前端 local-roots.js 的 buildModel 保持一致的构造逻辑（服务端版）。 */
/**
 * 解析 .atlas 内容，取出它引用的贴图页文件名。
 *
 * Spine atlas 格式：每个贴图页以「未缩进的图片文件名」开头（多页 atlas 会有多行这样的页头），
 * 其后是缩进的属性行（size:/filter:/bounds:/rotate: 等）；区域名也可能未缩进，但不带图片扩展名。
 * 因此判定规则：**未缩进 且 以图片扩展名结尾**的行 = 贴图页头。
 *
 * 为什么必须解析 atlas：同一目录可能同时存在多个资源
 *   （实测 066402/cutscene 下有 cutscene_char066402 与 cutscene_char066402_camera），
 *   若把「目录里所有图片」都当贴图，会把别的资源的贴图错配进来。
 */
export function parseAtlasPages(atlasPath) {
  try {
    // 先剥一次 BOM 再按行匹配。原因：JS 的 \s **包含 U+FEFF**，而 AssetStudio 导出的 atlas
    //   首行是「BOM + 页名」（EF BB BF ...）⇒ 不剥的话首行被 /^[^\s]/ 判成"有前导空白"整行跳过
    //   ⇒ 多页图集的**第一页页名丢失**（现场：NIKKE 根 247 个模型里 34 份 atlas 带 BOM，均丢第一页 ⇒ 贴图拿不到、画面空白）。
    // 为什么前端 src/web/engine/textures.js 没这个坑：它**先 trim() 再匹配**，而 trim() 会把 U+FEFF
    //   当空白吃掉 —— 所以那边页名本来就干净。这里剥 BOM 就是与"先 trim"等价，别删。
    // 只剥解析用的文本：**不改 atlas 落盘字节、不改页名大小写**（产物必须逐字节不变）。
    const txt = fs.readFileSync(atlasPath, 'utf8').replace(/^\uFEFF/, '');
    const pages = [];
    for (const line of txt.split('\n')) {
      if (/^[^\s].*\.(png|jpg|jpeg|webp)\s*$/i.test(line)) pages.push(line.trim());
    }
    return pages;
  } catch {
    return [];
  }
}

/** 校验并解析出安全的绝对路径；越界返回 null。 */
export function resolveSafe(rootBase, relPath) {
  const rel = String(relPath || '').replace(/^\/+/, '');
  const abs = path.resolve(rootBase, rel);
  const base = path.resolve(rootBase);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

// 逐段编码路径：保留 / 分隔符，其余段各自 encodeURIComponent。
// 为什么：Live2D 资源目录含中文（皮肤名）与括号等字符，必须编码；
//   但整体 encodeURIComponent 会把 / 也编掉，破坏路径结构。
export function encodePath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

export { MIME, SPINE_EXT };
