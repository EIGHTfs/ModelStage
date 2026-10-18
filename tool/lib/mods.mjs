// ============================================================================
// mods.mjs — 「源文件里的 MOD 标记块」剥离器（P4a 起）
//
// 背景（为什么需要它）：
//   P3 完成后的 src/** 是**逐字节可回填的原文分片**（tool/slices.json 的区间表 +
//   tool/build-byte-equal.mjs 的逐字节校验链）。P4 起开始有**有意修改的源码** ——
//   若直接改分片正文，等于覆盖掉原文区间信息，逐字节校验链会永久失效（无法再证明
//   「解压产物 ≡ 原版」）。故约定：修改以**显式标记块**追加在原文旁边，不改原文一个字：
//
//     /*<<<MOD <id>>>*/
//     …新增/替换的代码（可读、多行）…
//     /*<<<ENDMOD <id>>>*/
//
//   两条读取路径：
//     · 基线(path A)：stripMods() 剥掉全部 MOD 块 → 必须逐字节 ≡ 原版区间（校验链依旧全绿）
//     · 产物(path B)：保留 MOD 块 → 装配出「原版 + 本次改动」的页面对外服务
//   这样「原文区间信息」与「改动」同时存在、互不覆盖，且改动按 id 可追溯（谁加的、加在哪）。
//
// 标记行要求：必须**独占一行**，且 MOD/ENDMOD 的 id 必须成对且一致。
// ============================================================================

const OPEN = /^[ \t]*\/\*<<<MOD[ \t]+([A-Za-z0-9_.:-]+)>>>\*\/[ \t]*$/;
const CLOSE = /^[ \t]*\/\*<<<ENDMOD[ \t]+([A-Za-z0-9_.:-]+)>>>\*\/[ \t]*$/;

/** 列出文本里的 MOD 块 [{id, openLine, closeLine, chars}]（行号从 1 起）。 */
export function listMods(text) {
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(OPEN);
    if (m) {
      if (cur) throw new Error(`MOD 块未闭合：${cur.id}（第 ${cur.openLine} 行）又遇到 ${m[1]}`);
      const c = lines[i].match(CLOSE);
      if (c) throw new Error(`MOD 标记写法错误（第 ${i + 1} 行）：同一行既有 MOD 又有 ENDMOD?`);
      cur = { id: m[1], openLine: i + 1, closeLine: -1, chars: 0 };
      continue;
    }
    const c = lines[i].match(CLOSE);
    if (c) {
      if (!cur) throw new Error(`遇到 ENDMOD 但没有对应的 MOD（第 ${i + 1} 行：${c[1]}）`);
      if (cur.id !== c[1]) throw new Error(`MOD 块 id 不匹配：开 ${cur.id}（第 ${cur.openLine} 行）闭 ${c[1]}（第 ${i + 1} 行）`);
      cur.closeLine = i + 1;
      out.push(cur);
      cur = null;
    }
  }
  if (cur) throw new Error(`MOD 块未闭合：${cur.id}（第 ${cur.openLine} 行）`);
  return out;
}

/**
 * 剥掉全部 MOD 块，得到「原文内容」——**必须逐字节可复现**（基线校验的前提）。
 *
 * 删除规则（字符级，保证「插入式改动」剥离后与原文完全一致）：
 *   对每个 MOD 块，删除区间 =
 *     [开标记行首, 闭标记行尾]  ∪  开标记行**前面紧邻的那一个 `\n`（若有）**
 *                              ∪  闭标记行**后面紧邻的那一个 `\n`（若有）**
 *   也就是说：块自己独占两行标记 + 中间代码，连同「前后各一个新行」一起被吃掉。
 *   于是两种写法都能精确还原：
 *     · 行内插入（原文此处没有换行）：`前缀{` + `\n<MOD>` + `代码` + `\n<ENDMOD>` + `\n后缀`
 *       → 还原为 `前缀{后缀`
 *     · 行缝插入（原文此处本就是行首）：`…\n` + `\n<MOD>` + … + `\n<ENDMOD>` + `\n后缀`
 *       → 还原为 `…\n后缀`
 *   ⚠️ 因此**块标记之外不要留额外缩进/空行**：那些字符不属于块，剥离后会残留。
 */
export function stripMods(text) {
  const blocks = findModBlocks(text);           // [{ openStart, closeEnd }]（字符区间，不含前后换行）
  if (!blocks.length) return text;
  // 从后往前删，避免偏移失效
  let out = text;
  for (let i = blocks.length - 1; i >= 0; i--) {
    let { openStart, closeEnd } = blocks[i];
    let from = openStart;
    let to = closeEnd;
    if (text[from - 1] === '\n') from -= 1;      // 吃掉块前紧邻的一个换行
    if (text[to] === '\n') to += 1;              // 吃掉块后紧邻的一个换行
    // 再吃掉「块后那一行开头的横向缩进」：插入式写法常写成 `…<ENDMOD>\n    <原文续行>`，
    // 这些空格是我们为可读性加的，不属于原文，必须一并吃掉才能逐字节还原。
    while (text[to] === ' ' || text[to] === '\t') to += 1;
    out = out.slice(0, from) + out.slice(to);
  }
  return out;
}

/** 找出全部 MOD 块的字符区间（含标记行，不含前后换行）；供 stripMods / 报告使用。 */
function findModBlocks(text) {
  const lines = text.split('\n');
  const offsets = [];
  let acc = 0;
  for (const l of lines) { offsets.push(acc); acc += l.length + 1; }
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const o = lines[i].match(OPEN);
    if (o) {
      if (cur) throw new Error(`MOD 块未闭合：${cur.id}（第 ${cur.line} 行）又遇到 ${o[1]}（第 ${i + 1} 行）`);
      cur = { id: o[1], line: i + 1, openStart: offsets[i] };
      continue;
    }
    const c = lines[i].match(CLOSE);
    if (c) {
      if (!cur) throw new Error(`遇到 ENDMOD 但没有对应的 MOD（第 ${i + 1} 行：${c[1]}）。`
        + '提示：MOD/ENDMOD 标记必须各自独立占一行（行首无其它字符）。');
      if (cur.id !== c[1]) throw new Error(`MOD 块 id 不匹配：开 ${cur.id}（第 ${cur.line} 行）闭 ${c[1]}（第 ${i + 1} 行）`);
      blocks.push({ id: cur.id, openStart: cur.openStart, closeEnd: offsets[i] + lines[i].length });
      cur = null;
    }
  }
  if (cur) throw new Error(`MOD 块未闭合：${cur.id}（第 ${cur.line} 行）`);
  return blocks;
}

/** 是否含 MOD 块。 */
export function hasMods(text) {
  return listMods(text).length > 0;
}

/**
 * 按声明式清单把「现片段」反替换回「原片段」（严格版，供基线/产物两侧共用）。
 *
 * 为什么需要：MOD 块标记要求标记单独成行，压缩过的单行切片放不下整行标记；
 *   这类改动改用 `tool/mods/app-shell.json` 声明（file/from/to/netChars）。
 *
 * 门禁强度（任一条不满足都抛错，不存在"忽略文件/跳过比对"）：
 *   · 声明的「现片段」必须**恰好出现 1 次**（0 次=声明过期；≥2 次=改动不唯一，无法唯一定位）；
 *   · 声明的「原片段」此时必须**已经不存在**（否则说明代码其实没改，声明多余）；
 *   · 声明的净增字符数必须与两片段之差**完全一致**（防声明与实际改动脱节）。
 * @param {string} text 待处理文本
 * @param {Array<{id:string,file?:string,from:string,to:string,netChars:number}>} mods 生效的声明条目
 * @param {(m:object)=>void} [onApply] 可选回调（用于打印/统计）
 */
export function applyModManifest(text, mods, onApply) {
  let out = text;
  for (const m of mods || []) {
    const hits = out.split(m.to).length - 1;
    if (hits !== 1) {
      throw new Error(`MOD ${m.id}: 声明的现片段出现 ${hits} 次（应恰好 1 次）${m.file ? ` @${m.file}` : ''}`);
    }
    if (out.split(m.from).length - 1 !== 0) {
      throw new Error(`MOD ${m.id}: 原片段仍存在（声明与实际不符）${m.file ? ` @${m.file}` : ''}`);
    }
    const delta = m.to.length - m.from.length;
    if (delta !== m.netChars) {
      throw new Error(`MOD ${m.id}: 声明净增字符 ${m.netChars} ≠ 实际 ${delta}`);
    }
    out = out.replace(m.to, m.from);
    if (onApply) onApply(m);
  }
  return out;
}

/**
 * 产物侧整体剥 MOD（供 verify.mjs 复用）：先剥 MOD 块标记，再按清单反替换。
 *   与基线侧走的是同一份清单与同一套严格校验，避免出现第二份真相源。
 */
export function stripProductMods(text, mods) {
  return applyModManifest(stripMods(text), mods);
}
