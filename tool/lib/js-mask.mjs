// ============================================================================
// tool/lib/js-mask.mjs — JS 词法掩码 / 括号配平 / 代码位改名（P2.4 从 bundle-map.mjs 拆出）
//
// 用途：
//   ① 压缩产物（单文件 bundle）里字符串、模板串、正则、注释中都可能含 `{}[]()`
//      —— 朴素括号计数必然错位；本模块给出「代码位掩码」，只对真实代码做括号配平。
//   ② 定位某个类/函数的精确起止（matchBrace）。
//   ③ 只在「代码位」上做标识符改名（renameInCode）——字符串/注释里的同名文本不动，
//      且改名规则对称（改过去 / 改回来）以支持「切出 → 回填逐字节校验」。
//
// 为什么独立成文件：bundle-map.mjs 原本 880 行，超过项目「单文件 ≤ 400 行」的提交要求；
//   掩码这段与「地图数据/报告」职责无关，拆出后两个文件各自内聚，且 P2 的回填脚本
//   （legacy/extract-tools/rebuild-from-slices.mjs）也能复用同一套掩码，避免两份实现漂移。
//
// 零依赖：仅用语言内置能力，不引入任何 npm 包。
// ============================================================================

/**
 * JS 词法状态机（够用版）。状态：
 *   code      普通代码
 *   sq/dq     单/双引号字符串
 *   tpl       模板串字面量部分
 *   line      行注释
 *   block     块注释
 *   regex     正则字面量（含字符类 [] 内部）
 * 模板串里的 `${ ... }` 会切回 code，并用栈记录「进入表达式时的花括号深度」，
 * 对应的 `}` 用于闭合表达式回到 tpl。
 *
 * 正则 vs 除号判定：看上一个非空白「代码字符」是否可作为操作数结尾
 *   （标识符字符 / 数字 / `)` / `]`）；若上一个 token 是 return/typeof/case 等关键字，则视为正则。
 *   判定不确定时回退「当作除号」（宁可漏判正则，也不要错误吞掉大段代码）。
 *
 * @param {string} text 源文本（整份文件；偏移都是相对整份文本的绝对偏移）
 * @param {number} [from] 扫描起点
 * @param {number} [to] 扫描终点（不含）
 * @param {{traceRegex?: boolean}} [opts] traceRegex=true 时收集被判定为正则的字面量（排错用）
 * @returns {{mask: Uint8Array, regexLog: Array<{start:number,end:number,text:string}>}}
 *          mask[i] === 1 表示第 i 个字符是「真实代码位」
 */
export function buildCodeMask(text, from = 0, to = text.length, opts = {}) {
  const traceRegex = Boolean(opts && opts.traceRegex);
  const n = to; // 扫描右边界（不含）
  const regexLog = []; // --trace-regex 时记录被判定为正则的字面量（掩码自检排错用）
  const mask = new Uint8Array(text.length); // 1 = 真实代码字符
  const ctx = []; // 模板表达式栈：{ base: 进入 ${ 时的花括号深度 }
  let state = 'code';
  let i = from;
  let braceDepth = 0;
  let prev = ''; // 上一个「有意义」的代码字符（用于正则判定）
  let word = ''; // 上一个标识符/关键字
  const KEYWORD_NON_OPERAND = /^(return|typeof|instanceof|in|of|new|delete|void|do|else|case|yield|await|throw)$/;

  const isWordChar = (ch) => /[\w$]/.test(ch);

  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];

    if (state === 'code') {
      // --- 注释 ---
      if (c === '/' && c2 === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && c2 === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      // --- 字符串 ---
      if (c === '"' || c === "'") {
        state = c === '"' ? 'dq' : 'sq';
        i++;
        continue;
      }
      if (c === '`') {
        state = 'tpl';
        mask[i] = 1;
        i++;
        continue;
      }
      // --- 正则 or 除号 ---
      if (c === '/') {
        const prevIsOperand = prev !== '' && /[\w$)\]]/.test(prev);
        const keywordBefore = KEYWORD_NON_OPERAND.test(word);
        if (prevIsOperand && !keywordBefore) {
          mask[i] = 1;
          prev = '/';
          word = '';
          i++;
          continue;
        }
        // 试扫正则：找不到闭合 `/` 就回退当除号
        let j = i + 1;
        let inClass = false;
        let closed = -1;
        while (j < n) {
          const d = text[j];
          if (d === '\\') {
            j += 2;
            continue;
          }
          if (d === '\n') break; // 正则不跨行 → 判定失败
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) {
            closed = j;
            break;
          }
          j++;
        }
        if (closed > 0) {
          // 正则字面量：内容全部不作为代码（mask 保持 0），尾部 flags 也跳过
          let k = closed + 1;
          while (k < n && /[a-z]/i.test(text[k])) k++;
          if (traceRegex) regexLog.push({ start: i, end: k, text: text.slice(i, k) });
          i = k;
          prev = ')'; // 正则字面量视作操作数结尾
          word = '';
          continue;
        }
        mask[i] = 1;
        prev = '/';
        word = '';
        i++;
        continue;
      }
      // --- 模板表达式闭合 ---
      if (c === '}' && ctx.length && braceDepth === ctx[ctx.length - 1].base) {
        ctx.pop();
        state = 'tpl';
        i++;
        continue;
      }
      // --- 普通代码字符 ---
      mask[i] = 1;
      if (c === '{') braceDepth++;
      else if (c === '}') braceDepth--;
      if (isWordChar(c)) {
        word += c;
      } else if (!/\s/.test(c)) {
        word = '';
      }
      if (!/\s/.test(c)) prev = c;
      i++;
      continue;
    }

    if (state === 'line') {
      if (c === '\n') state = 'code';
      i++;
      continue;
    }

    if (state === 'block') {
      if (c === '*' && c2 === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (state === 'sq' || state === 'dq') {
      // 字符串内容与非转义引号都**不算代码位**（只用于状态推进），
      // 否则字符串里的 `{}[]()` 会污染括号配平（实测踩过：'link[rel="modulepreload"]'）。
      if (c === '\\') {
        i += 2;
        continue;
      }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) {
        state = 'code';
        prev = ')';
        word = '';
      }
      i++;
      continue;
    }

    // 模板串字面量部分
    if (state === 'tpl') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        state = 'code';
        mask[i] = 1;
        prev = ')';
        word = '';
        i++;
        continue;
      }
      if (c === '$' && c2 === '{') {
        // 注意：`${` 的 `$`/`{` 以及与之配对的 `}` 都**不算代码位**。
        // 否则「标记了 `{` 却没标记配对的 `}`（那个 `}` 用于从表达式回到模板串）」会破坏括号配平。
        // 模板表达式内部真正的 `{}`（对象字面量/块）仍被标记，配平不受影响。
        ctx.push({ base: braceDepth });
        prev = '{';
        word = '';
        i += 2;
        state = 'code';
        continue;
      }
      i++;
      continue;
    }

    i++;
  }
  return { mask, regexLog };
}

/**
 * 括号配平自检（只在掩码为 1 的代码位上数）——掩码失效会让后续所有偏移错，
 * 所以任何依赖掩码的脚本都应先跑一次这个检查。
 *
 * @returns {{ok:boolean, counts?:Record<string,number>, at?:number, expect?:string}}
 */
export function balanceCheck(text, mask, from, to) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const close2open = { '}': '{', ')': '(', ']': '[' };
  const stack = [];
  const counts = { '{': 0, '}': 0, '(': 0, ')': 0, '[': 0, ']': 0 };
  for (let i = from; i < to; i++) {
    if (!mask[i]) continue;
    const c = text[i];
    if (pairs[c]) {
      counts[c]++;
      stack.push({ c, i });
    } else if (close2open[c]) {
      counts[c]++;
      const top = stack.pop();
      if (!top || top.c !== close2open[c]) return { ok: false, at: i, expect: top ? top.c : '(empty stack)' };
    }
  }
  if (stack.length) return { ok: false, at: stack[0].i, expect: '未闭合 ' + stack[0].c };
  return { ok: true, counts };
}

/**
 * 从 openIdx（掩码上的 `{`）找到配对 `}` 的下标（找不到返回 -1）。
 * 只在代码位上计数，因此字符串/模板/正则里的花括号不会干扰。
 */
export function matchBrace(text, mask, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (!mask[i]) continue;
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 只在「代码位」上做标识符改名（词边界匹配）。字符串/注释/正则里的同名文本保持原样。
 *
 * 为什么需要它（P2 的关键纪律）：
 *   抽取时把 `mt` 改名成 `SpineEngine`、`Xd` 改名成 `SpineEngineAlias`，
 *   回填时按**相反顺序**（先长后短）改回来，必须严格可逆 —— 本函数保证
 *   「改过去 → 改回来」逐字节恢复原文（不允许碰到字符串里的 'mt' 之类）。
 *
 * 注意：pairs 的顺序即替换顺序；如同时改 `SpineEngine` 与 `SpineEngineAlias`，
 *   改回来时必须先 `SpineEngineAlias → Xd` 再 `SpineEngine → mt`（长名优先），
 *   否则 `SpineEngineAlias` 会被先替换成 `mtAlias`。
 *
 * @param {string} text 源文本
 * @param {Uint8Array} mask 代码位掩码（同文本偏移）
 * @param {Array<[string,string]>} pairs [from, to] 改名对（from 为正则词）
 * @param {number} [from] 生效区间起点
 * @param {number} [to] 生效区间终点
 * @returns {{text:string, changed:number}} 改名后的全文与该区间内改动次数
 */
export function renameInCode(text, mask, pairs, from = 0, to = text.length) {
  let out = '';
  let i = 0;
  let changed = 0;
  const isWord = (ch) => ch !== undefined && /[\w$]/.test(ch);
  while (i < text.length) {
    // 只考虑区间内、且是词首位置
    if (i < from || i >= to || !mask[i] || !/[A-Za-z_$]/.test(text[i]) || isWord(text[i - 1])) {
      out += text[i];
      i++;
      continue;
    }
    // 取出一个完整标识符（整段都必须是代码位，否则说明它跨越了字符串边界，不动）
    let j = i;
    let allCode = true;
    while (j < text.length && isWord(text[j])) {
      if (!mask[j]) allCode = false;
      j++;
    }
    const word = text.slice(i, j);
    if (!allCode) {
      out += text[i];
      i++;
      continue;
    }
    let mapped = null;
    for (const [a, b] of pairs) {
      if (word === a) {
        mapped = b;
        break;
      }
    }
    out += mapped ?? word;
    if (mapped !== null) changed++;
    i = j;
  }
  return { text: out, changed };
}

/** 便捷：对一份文本取「整段代码位掩码」并做配平自检（from/to 默认全文）。 */
export function maskAndCheck(text, from = 0, to = text.length, opts = {}) {
  const { mask, regexLog } = buildCodeMask(text, from, to, opts);
  const balance = balanceCheck(text, mask, from, to);
  return { mask, regexLog, balance };
}
