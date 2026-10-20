// ============================================================================
// tool/lib/spine-motions.mjs —— Spine 动作名的「分组 / 循环 / 置信度」判定（纯函数）
//
// 为什么独立成纯函数 + 数据文件：
//   Spine 的动作命名规则因游戏而异（bd2 与碧蓝航线画风/命名都不同），把它写进引擎
//   （`legacy/source/engine.js` 是压缩产物）既难维护、也会绑定到某个前端。能力层应当只提供
//   「规则数据 + 判定函数」，由调用方（新前端/导出工具）自行决定怎么用。
//
// 判定优先级：overrides（精确名） → families（正则族，按声明顺序首个命中） → defaults
// 置信度：high = 规则显式匹配且有实测样本；low = 未命中任何规则（交给调用方保守处理）
// ============================================================================

import fs from 'node:fs';

/** 读取规则文件（调用方可用自己的路径） */
export function loadRules(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, ''); // 允许 // 注释
  const rules = JSON.parse(text);
  validateRules(rules);
  return rules;
}

/**
 * 校验规则结构（失败抛可读错误，避免"规则写错了却静默不生效"）。
 * 不做业务判断，只保证字段存在、类型正确、正则可编译。
 */
export function validateRules(rules) {
  if (!rules || typeof rules !== 'object') throw new Error('规则文件不是对象');
  if (!rules.defaults || typeof rules.defaults.loop !== 'boolean') throw new Error('规则缺少 defaults.loop（布尔）');
  if (!rules.defaults.confidence) throw new Error('规则缺少 defaults.confidence');
  const fams = rules.families;
  if (!Array.isArray(fams)) throw new Error('规则缺少 families 数组');
  for (const [i, f] of fams.entries()) {
    const at = `families[${i}]`;
    if (!f || typeof f.group !== 'string' || !f.group) throw new Error(`${at}.group 必须是非空字符串`);
    if (!Array.isArray(f.patterns) || !f.patterns.length) throw new Error(`${at}.patterns 必须是非空数组`);
    for (const p of f.patterns) {
      try { new RegExp(p); } catch (e) { throw new Error(`${at} 的正则非法 ${JSON.stringify(p)}：${e.message}`); }
    }
    if (typeof f.loop !== 'boolean') throw new Error(`${at}.loop 必须是布尔`);
    if (typeof f.hits !== 'number') throw new Error(`${at}.hits 必须是数字（实测命中数）`);
    if (typeof f.note !== 'string' || !f.note.trim()) throw new Error(`${at}.note 必须写明依据`);
  }
  if (rules.overrides !== undefined && !Array.isArray(rules.overrides)) throw new Error('overrides 必须是数组');
  return true;
}

/**
 * 判定单个动作名。
 * @param {string} name 动作名
 * @param {object} rules loadRules 的结果
 * @returns {{name:string, group:string, loop:boolean, confidence:'high'|'low', rule:string|null}}
 */
export function classify(name, rules) {
  const n = String(name == null ? '' : name);
  const ruleName = (r) => (r && r.id ? String(r.id) : null);

  // ① 精确名覆盖（少量特例：名字一样但语义不同，比如 mission 与 mission_complete）
  for (const o of (rules && rules.overrides) || []) {
    if (o && o.name === n) {
      return {
        name: n,
        group: o.group || n,
        loop: typeof o.loop === 'boolean' ? o.loop : rules.defaults.loop,
        confidence: o.confidence || 'high',
        rule: ruleName(o) || `override:${n}`,
      };
    }
  }
  // ② 正则族（按声明顺序，首个命中即用）
  for (const f of (rules && rules.families) || []) {
    for (const p of f.patterns) {
      let hit = false;
      try { hit = new RegExp(p).test(n); } catch { hit = false; }
      if (hit) {
        return { name: n, group: f.group, loop: !!f.loop, confidence: f.confidence || 'high', rule: ruleName(f) || `family:${f.group}` };
      }
    }
  }
  // ③ 兜底：分组=动作名本身，不循环，低置信（宁可一次性动作也不误判成循环）
  return { name: n, group: n, loop: !!rules.defaults.loop, confidence: rules.defaults.confidence || 'low', rule: null };
}

/** 批量判定（保持输入顺序） */
export function classifyAll(names, rules) {
  return (names || []).map((n) => classify(n, rules));
}

/** 统计规则命中情况（自检/报告用：证明每条规则都有实测样本） */
export function countHits(names, rules) {
  const out = [];
  for (const f of (rules && rules.families) || []) {
    let n = 0;
    for (const name of names || []) {
      for (const p of f.patterns) {
        let hit = false;
        try { hit = new RegExp(p).test(String(name)); } catch { hit = false; }
        if (hit) { n++; break; }
      }
    }
    out.push({ group: f.group, declaredHits: f.hits, actualHits: n, ok: f.hits === n });
  }
  return out;
}
