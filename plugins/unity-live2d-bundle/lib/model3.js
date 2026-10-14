// ============================================================================
// plugins/unity-live2d-bundle/lib/model3.js —— 重建 model3.json（+ 动作分组规则）
//
// 适用对象：Unity 集成版 Live2D 资源包（包内没有 model3.json，只有 moc3/physics3/纹理/动画曲线）。
//   原生 Cubism 包不需要本文件（包内自带 model3.json）。
//
// 产出结构（Cubism 4 model3.json，Version 3）：
//   { Version, FileReferences: { Moc, Textures[], Physics, Motions{ 组: [{File,...}] } },
//     Groups: [ { Target:"Parameter", Name:"EyeBlink", Ids:[...] } ] }
//
// 两条与"游戏无关"的原则：
//   ① 资源路径**由调用方给 URL**（本仓库的实现给 Blob URL）——本文件不关心资源从哪来，
//      只管把 URL 填进 model3.json；这样既能用于资源根里的相对路径，也能用于内存里拼出来的 Blob。
//   ② 动作分组走**通用规则 + 数据化覆盖**：通用规则 = 去掉动作名结尾的数字/下划线（idle7 → idle、
//      main_3 → main、touch_idle2 → touch_idle）；游戏特有归并写在 profiles/<游戏>.json 的
//      motion.groups（形如 { "group": "touch", "patterns": ["^touch_"] }），代码里不写游戏名。
//
// 挂载：globalThis.__ULB__.model3
// ============================================================================

'use strict';

(function (root) {
  const NS = (root.__ULB__ = root.__ULB__ || {});

  /**
   * 动作名 → 动作组名。
   *
   * 默认规则：**一个动作一个组**（组名 = 动作名）。
   *   本仓库既有的碧蓝航线模型（目录版）就是这样组织的 model3.json：`idle`、`main_1`、`complete`…
   *   各成一个组，右栏标签形如 `idle / idle`、`main_1 / main_1`。默认跟它保持一致，
   *   同一个模型的两条来源（目录版 / 单文件版）在界面上看着是同一种东西。
   *
   * 需要把多个动作并进一个组时，由 profiles/<游戏>.json 的 motion.groups 覆盖
   *   （形如 { "group": "idle", "patterns": ["^idle"] }）：命中规则的动作用规则里的组名。
   */
  function motionGroupOf(name, profile) {
    const rules = (profile && profile.motion && profile.motion.groups) || [];
    for (const rule of rules) {
      if (!rule || !rule.group || !Array.isArray(rule.patterns)) continue;
      for (const p of rule.patterns) {
        try { if (new RegExp(p).test(name)) return String(rule.group); } catch { /* 规则写错就跳过这条 */ }
      }
    }
    return String(name);
  }

  /**
   * 动作名 → 是否循环（Cubism 的 Meta.Loop）。
   * 规则同样数据化：profile.motion.loopPatterns 命中即循环；没配就默认不循环（一次性动作更安全）。
   */
  function motionLoops(name, profile) {
    const pats = (profile && profile.motion && profile.motion.loopPatterns) || [];
    return pats.some((p) => { try { return new RegExp(p).test(name); } catch { return false; } });
  }

  /**
   * 从参数名候选里挑出分组用的参数（眼闪、口型）。
   * 规则按 Cubism 的常见命名：眼闪 = 含 Eye 且含 Open 的参数，口型 = 含 MouthOpen 的参数。
   * 挑不到就不生成该组（Groups 只列真正存在的参数，避免运行时找不到参数名）。
   */
  function deriveGroups(paramNames) {
    const names = (paramNames || []).filter((n) => typeof n === 'string');
    const eye = names.filter((n) => /Eye/.test(n) && /Open/.test(n));
    const mouth = names.filter((n) => /MouthOpen/.test(n));
    const groups = [];
    if (eye.length) groups.push({ Target: 'Parameter', Name: 'EyeBlink', Ids: eye });
    if (mouth.length) groups.push({ Target: 'Parameter', Name: 'LipSync', Ids: mouth });
    return groups;
  }

  /**
   * 推导 HitAreas（点击热区）：**数据化规则**，写在 profiles/<游戏>.json 的 hitAreas 里，
   *   形如 [{ "Id": "TouchBody", "Motion": "touch_body" }]。
   *   只有对应动作确实存在时才写入（不同皮肤的动作集不同，避免列出无对应动作的热区）。
   *   与原生 model3.json 的形态一致：{ "Id": "TouchBody", "Name": "touch_body" }。
   */
  function deriveHitAreas(motionNames, profile) {
    const rules = (profile && profile.hitAreas) || [];
    const have = new Set(motionNames || []);
    const out = [];
    for (const r of rules) {
      if (!r || !r.Id) continue;
      if (r.Motion && !have.has(r.Motion)) continue;
      out.push({ Id: String(r.Id), Name: String(r.Motion || r.Id) });
    }
    return out;
  }

  /**
   * 组装 model3.json。
   * @param {object} input
   *   { mocUrl, textureUrls[], physicsUrl|null, motions: [{name, url, group, loop}], paramNames[], profile }
   * @returns {object} model3.json 对象（未序列化）
   */
  function buildModel3(input) {
    const i = input || {};
    const motions = i.motions || [];
    const byGroup = new Map();
    for (const m of motions) {
      const group = m.group || motionGroupOf(m.name, i.profile);
      if (!byGroup.has(group)) byGroup.set(group, []);
      const entry = { File: m.url };
      // 淡入淡出与循环写在动作项上：Cubism 的 Motion 项支持这三个字段
      const fadeIn = (i.profile && i.profile.motion && i.profile.motion.fadeInTime);
      const fadeOut = (i.profile && i.profile.motion && i.profile.motion.fadeOutTime);
      if (typeof fadeIn === 'number') entry.FadeInTime = fadeIn;
      if (typeof fadeOut === 'number') entry.FadeOutTime = fadeOut;
      byGroup.get(group).push(entry);
    }
    // 组顺序：idle 最前（切过去就是待机），其余按名称序，保证输出稳定可复现
    const groupNames = [...byGroup.keys()].sort((a, b) => (a === 'idle' ? -1 : b === 'idle' ? 1 : a.localeCompare(b)));
    const fileRefs = {
      Moc: i.mocUrl,
      Textures: i.textureUrls || [],
    };
    if (i.physicsUrl) fileRefs.Physics = i.physicsUrl;
    const motionMap = {};
    for (const g of groupNames) motionMap[g] = byGroup.get(g);
    fileRefs.Motions = motionMap;

    const model3 = {
      Version: 3,
      FileReferences: fileRefs,
    };
    const groups = deriveGroups(i.paramNames);
    if (groups.length) model3.Groups = groups;
    const hitAreas = deriveHitAreas(motions.map((m) => m.name), i.profile);
    if (hitAreas.length) model3.HitAreas = hitAreas;
    if (i.profile && i.profile.model3 && typeof i.profile.model3 === 'object') {
      Object.assign(model3, i.profile.model3);   // 允许 profile 覆盖/补充（如 Layout、HitAreas）
    }
    return model3;
  }

  NS.model3 = { buildModel3, motionGroupOf, motionLoops, deriveGroups, deriveHitAreas };
})(typeof globalThis !== 'undefined' ? globalThis : this);
