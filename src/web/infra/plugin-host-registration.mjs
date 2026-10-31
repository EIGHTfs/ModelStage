// src/web/infra/plugin-host-registration.mjs —— 注册与校验（从 plugin-host.js 抽出，B2）
//
// 为什么单独成模块：这是**插件唯一能碰的对外面**（window.SpineViewerPlugins / ModelStagePlugins.slots），
//   四条通道（provider / effect / 老接口控件 / 通知）+ 它们的拒绝原因，语义独立于一整套装载与解包；
//   搬出去后 plugin-host 只剩"组装 hostApi"。
//
// 依赖约定（**不传整块 ctx**，只传它真正读写的窄视图；工具 say/emit 也随参传入）：
//   · io      = { say, emit }                                   —— 日志与事件（依赖，不是状态）
//   · tables  = { providers, loadState, registeredEffects, getSlotRegistry }
//       前三张是稳定引用（Map）；slotRegistry 是**惰性初始化**的，必须用 getter 现取，不能快照
//   · decls   = { manifestProvides, manifestEffects, registrationRejects, maxFragmentChars }
//       清单声明与拒绝记录（低频状态，宿主持有，这里按引用用）
//   · probe   = { getLoadingPluginId, getLastLoadedPluginId, dispatch }
//       loadingPluginId 是**装载期窗口开关**：必须现读，快照会让窗口判定永远为假
//   · sinks   = { addEffect, publishSlotStats }
//       宿主的回收登记与统计发布（注册成功后要挂 disposer、要刷新 __SLOT_STATS__）
//
// ⚠️ 对外契约（逐字保留，改动即破坏兼容）：错误码与文案（not-in-load-window / undeclared-slot /
//   slot-not-open / unknown-slot / risk-mismatch / missing-setting / bad-group-id …）与校验**顺序**
//   都不许动；`window.ModelStagePlugins.slots.register` 的签名与返回值（disposer 或 null）也不许动。

import { EVENTS } from './events.mjs';
import { PANEL_GROUPS } from '../panel/schema.js';

/**
 * @param {{io:object, tables:object, decls:object, probe:object, sinks:object}} deps
 * @returns {{registerProvider:Function, registerEffect:Function, registerControls:Function,
 *            slots:object, notify:Function}}
 */
export function createRegistration({ io, tables, decls, probe, sinks }) {
  const { say, emit } = io;
  const { providers, loadState, registeredEffects, getSlotRegistry } = tables;
  const { manifestProvides, manifestEffects, registrationRejects, maxFragmentChars } = decls;
  const { getLoadingPluginId, getLastLoadedPluginId, dispatch } = probe;
  const { addEffect, publishSlotStats } = sinks;

  /**
   * 注册被拒：显式记一条 + 可读原因（H2）。
   *
   * 与"静默丢弃"的区别：调用方能拿到 false，日志里能看出**哪个阶段**、**哪个插件**、
   *   **为什么**（异步注册 vs 缺字段），并且 `effectsReport().rejects` 可被测试断言。
   * @param {string} kind register / registerEffect / registerControls
   * @param {string} why 人话原因
   * @param {object} [detail] 附加信息（id / group 等）
   * @returns {false}
   */
  function rejectRegistration(kind, why, detail) {
    const rec = {
      kind, why, at: Date.now(),
      pluginId: getLoadingPluginId() || null,
      likelyOwner: getLoadingPluginId() ? null : (getLastLoadedPluginId() || null),
      ...(detail || {}),
    };
    registrationRejects.push(rec);
    if (registrationRejects.length > 50) registrationRejects.shift();
    say.warn(`插件注册被拒（${kind}）：${why}${rec.likelyOwner ? `（疑似来自最后装载的插件 ${rec.likelyOwner}）` : ''}`);
    emit('plugin.register-rejected', rec);
    return false;
  }

  /**
   * 内置分组的 title → id 映射（兼容层用）。
   *
   * 为什么从 PANEL_GROUPS 派生而不是写死一张表：老接口传的是**标题**（「设置」），
   *   而插槽名要的是 groupId；写死映射会在加组/改标题时静默失配（这正是本轮要消灭的"两处表达"）。
   * 传进来的本来就是合法 id 时原样返回，方便调用方"标题或 id 都行"。
   * @param {string} name
   * @returns {string|null}
   */
  function groupIdOfTitle(name) {
    const want = String(name || '').trim();
    if (!want) return null;
    if (PANEL_GROUPS.some((g) => String(g.id || '') === want)) return want;
    const hit = PANEL_GROUPS.find((g) => String(g.title || '') === want);
    return hit ? String(hit.id || '') : null;
  }

  /**
   * 老控件声明 → 插槽 spec（兼容层用）。
   *
   * 老接口给的是"数据"，插槽要的是"render 函数"：这里把老形状包成一个返回老形状的 render，
   *   之后统一由 mergeSlotControls → slotSpecToControl 翻译成渲染层 kind（一处翻译，两路共用）。
   * @param {object} raw 老控件声明（{id, kind, label, options, order, ...}）
   * @returns {object|null} 插槽 spec；缺 id 返回 null
   */
  function legacyControlToSlotSpec(raw) {
    const id = String((raw && raw.id) || '').trim();
    if (!id) return null;
    return {
      id,
      label: String((raw && raw.label) || id),
      // 老接口的语义：控件 id 就是个效果 id —— 效果没注册成功时该控件要**置灰 + 给原因**（契约 §9.3）。
      //   转插槽后由 mergeSlotControls 用 registeredEffects 判定，语义与迁移前一致。
      effectId: id,
      // 老接口没有 order 概念：缺省 1000（排在组内内置控件之后），显式给了就尊重
      order: Number.isFinite(Number(raw && raw.order)) ? Number(raw.order) : 1000,
      render: () => ({
        kind: String((raw && raw.kind) || ''),
        options: Array.isArray(raw && raw.options) ? raw.options.slice() : undefined,
        label: String((raw && raw.label) || id),
      }),
    };
  }
  /** 插件注册自己：只收有 id 的对象；缺 canHandle/resolve 时保留但标注（供排障） */
function registerProvider(plugin) {
    if (!plugin || typeof plugin !== 'object') { say.warn('register 收到非对象，已忽略'); return false; }
    const id = String(plugin.id || '').trim();
    if (!id) { say.warn('register 缺少 id，已忽略'); return false; }
    // 契约 PL2：id 重复必须**拒绝**且不覆盖已注册的那个。
    //   静默 providers.set 覆盖会让"后加载的插件顶掉先加载的"，且排障时看不出发生过覆盖。
    //   保留先注册的实例（先到先得）：它可能已经参与过解析，换掉会留下"半新半旧"的对象。
    if (providers.has(id)) {
      say.warn(`插件 ${id} 重复注册，已忽略（保留先注册的实例）`);
      return false;
    }
    // 角色以**清单**为准（契约 插件契约 §二）：register 上来的对象不覆盖它
    const declared = manifestProvides.get(id) || [];
    const rec = { ...plugin, id, provides: declared.slice() };
    providers.set(id, rec);
    // 登记回收动作：卸载时把 provider 从表里摘掉（只摘自己这一份，别误删后来者）
    addEffect(id, {
      kind: 'provider',
      label: id,
      dispose: () => { if (providers.get(id) === rec) providers.delete(id); },
    });
    const st = loadState.get(id) || { files: 0, ms: 0 };
    loadState.set(id, { ...st, loaded: true, error: null });
    const caps = [];
    if (typeof rec.canHandle === 'function') caps.push('canHandle');
    if (typeof rec.resolve === 'function') caps.push('resolve');
    say.info(`已注册提供者 ${id}（${rec.name || id}）：${caps.join('/') || '无可调用成员'}`);
    try { dispatch(EVENTS.PLUGIN_REGISTERED, { id }); } catch { /* 忽略 */ }
    return true;
  }
  /**
   * 注册一个渲染效果（契约 §9.2）：只收"作用于当前像素的表达式"，不是完整着色器。
   *
   * 校验三条（任一不满足即注册失败，**不是静默忽略**）：
   *   · id 必须在本插件清单的 effects[].id 里声明过 —— 否则能力键白名单不会认它，
   *     面板能选、渲染层不认，就是"选了没反应"的静默失败；
   *   · fragment 必须是非空字符串；
   *   · id 全局唯一（跨插件也唯一，防两个插件抢同一个 uniform 命名空间）。
   * @param {{id:string, fragment:string}} spec
   * @returns {boolean} 是否注册成功
   */
function registerEffect(spec) {
    const pluginId = getLoadingPluginId();
    const id = String((spec && spec.id) || '').trim();
    if (!pluginId) {
      return rejectRegistration('registerEffect', '不在脚本装载期（异步注册不被支持：registerEffect 必须在脚本顶层同步调用）', { id });
    }
    if (!id) { say.warn(`registerEffect 缺少 id（插件 ${pluginId}），已忽略`); return false; }
    const declared = (manifestEffects.get(pluginId) || []).some((e) => String(e.id) === id);
    if (!declared) {
      say.warn(`registerEffect(${id}) 未在插件 ${pluginId} 的 effects[] 里声明，已拒绝`);
      return false;
    }
    if (typeof (spec && spec.fragment) !== 'string' || !spec.fragment.trim()) {
      say.warn(`registerEffect(${id}) 的 fragment 为空，已拒绝`);
      return false;
    }
    // 超长直接拒：fragment 会被拼进着色器并在挂载时编译，没有长度闸门就等于
    //   允许插件往渲染链路里塞任意大段代码（编译失败还会连带拖慢首帧）
    if (spec.fragment.length > maxFragmentChars) {
      say.warn(`registerEffect(${id}) 的 fragment 过长（${spec.fragment.length} > ${maxFragmentChars} 字符），已拒绝`);
      return false;
    }
    if (registeredEffects.has(id)) {
      say.warn(`registerEffect(${id}) 重复注册（已被 ${registeredEffects.get(id).pluginId} 占用），已忽略`);
      return false;
    }
    // uniforms 是插件侧的"参数默认值兜底"（清单 params[].default 的补充口）。
    //   实际每档用哪个值由 effect-chain.uniformsForOption 按档位算，这里只做缺省兜底。
    const uniforms = (spec && spec.uniforms && typeof spec.uniforms === 'object') ? { ...spec.uniforms } : {};
    registeredEffects.set(id, { pluginId, fragment: spec.fragment, uniforms });
    addEffect(pluginId, {
      kind: 'effect',
      label: id,
      dispose: () => registeredEffects.delete(id),
    });
    say.info(`已注册效果 ${id}（插件 ${pluginId}）`);
    return true;
  }
  /**
   * **兼容层**：老接口 `registerControls({group, controls})` —— 内部转成插槽注册。
   *
   * 新插件请直接用 `slots.register('panel.group.<groupId>', { id, render })`；
   *   这里保留是因为它写在契约里（公开面），不能因为"现网没人用"就悄悄删掉。
   *
   * 三条兼容语义（都是老插件能零改动继续工作的前提）：
   *   ① 分组参数是**标题**（「设置」）⇒ 用内置表的 title→id 映射换成 groupId（不写死映射表）
   *   ② 老控件 id **不强制** plugin. 前缀（分组插槽本就不要求前缀）
   *   ③ **隐式声明**：老插件没有 plugin.json 的 slots 字段 ⇒ 视为已声明该分组插槽，
   *      不报 undeclared-slot（否则老插件一升级就全部失效）
   *
   * 迁移后老接口与 slots.register 的控件走**同一条**合并/渲染/回收链路：
   *   登记进同一个 slotRegistry ⇒ disposer 进同一个 effect 容器 ⇒ unloadPlugin 一并回收。
   * @param {{group:string, controls:Array}} section
   * @returns {boolean} 至少成功登记一个控件
   */
function registerControls(section) {
    const pluginId = getLoadingPluginId();
    if (!pluginId) {
      return rejectRegistration('registerControls', '不在脚本装载期（异步注册不被支持：registerControls 必须在脚本顶层同步调用）', {
        group: String((section && section.group) || ''),
      });
    }
    const groupName = String((section && section.group) || '').trim();
    const controls = Array.isArray(section && section.controls) ? section.controls : null;
    if (!groupName || !controls || !controls.length) {
      say.warn(`registerControls（插件 ${pluginId}）缺少 group 或 controls，已忽略`);
      return false;
    }
    if (!getSlotRegistry()) {
      say.warn(`registerControls（插件 ${pluginId}）失败：插槽注册表尚未就绪`);
      return false;
    }
    // ① 标题 → groupId：内置表派生；传进来的本来就是 id 时原样放过
    const groupId = groupIdOfTitle(groupName) || groupName;
    const slotName = `panel.group.${groupId}`;
    let ok = 0;
    const rejects = [];
    for (const raw of controls) {
      const spec = legacyControlToSlotSpec(raw);
      if (!spec) { rejects.push({ id: (raw && raw.id) || '', reason: '控件缺 id' }); continue; }
      // ②③ 前缀不强制、隐式声明：都靠 implicitDeclare 分支表达
      const dispose = getSlotRegistry().register(pluginId, slotName, spec, { implicitDeclare: true });
      if (typeof dispose === 'function') {
        // 与 slots.register 完全同一条回收链：disposer 进同一个 effect 容器
        //   （不挂的话 unloadPlugin 只能靠 disposeAll 兜底，统计上会显示"disposed 少、slotsRemoved 多"）
        addEffect(pluginId, { kind: 'slot', label: slotName, dispose });
        ok += 1;
      } else {
        rejects.push({ id: spec.id, reason: '插槽注册被拒（见 stats.rejects）' });
      }
    }
    say.info(`插件 ${pluginId} 提交控件节（兼容层 → 插槽）：分组「${groupName}」→ ${slotName}，成功 ${ok}/${controls.length}`
      + (rejects.length ? `，被拒 ${rejects.length}` : ''));
    publishSlotStats();
    return ok > 0;
  }
  /** 提示通道：插件不直接操作 DOM，走这里（同时派发事件给页面其它部分） */
function notify(kind, msg) {
    const level = kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'info';
    say[level](`[插件] ${msg}`);
    try { dispatch(EVENTS.NOTIFY, { kind, msg }); } catch { /* 忽略 */ }
  }
  /**
   * 插槽注册（设计 §四）：**只登记、不渲染**（渲染在 S2 接）。
   *
   * 插件侧写法（经典脚本，必须在脚本顶层**同步**调用）：
   *   const dispose = window.ModelStagePlugins.slots.register('panel.group.settings', {
   *     id: 'plugin.<pluginId>.sharpness',  // 必填，必须带插件前缀（设计 §8.2）
   *     order: 100,                          // 可选，列表插槽按它排序（小在前）
   *     label: '清晰度',                      // 必填，诊断与冲突提示都用它
   *     render(props) { return { kind: 'segmented', options: ['关', '轻', '强'] }; },
   *     onAction(action, props) { … },
   *   });
   *
   * 拒绝原因在 stats().rejects 里可读（unknown-slot / slot-not-open / undeclared-slot / risk-mismatch）。
   * @param {string} name 插槽名（见 /api/plugins 的 slotCatalog）
   * @param {object} spec { id, order?, label?, render?, onAction? }
   * @returns {null | (() => void)} disposer（已登记进该插件的 effect 容器，卸载时自动回收）
   */
  const slots = {
      register(name, spec) {
        if (!getSlotRegistry()) {
          say.warn('插槽注册失败：注册表尚未就绪（插件清单还没拿到，通常是页面刚启动）');
          return null;
        }
        const dispose = getSlotRegistry().register(getLoadingPluginId(), name, spec);
        if (typeof dispose === 'function') {
          // 挂进 S1-b1 的 effect 容器 ⇒ unloadPlugin 会连插槽登记一起回收
          addEffect(getLoadingPluginId(), { kind: 'slot', label: String(name), dispose });
        }
        publishSlotStats();
        return dispose;
      },
      /** 只读快照（同时挂到 window.__SLOT_STATS__ 供测试断言） */
      stats: () => (getSlotRegistry() ? getSlotRegistry().stats() : {
        openStage: 'S1', catalogSize: 0, total: 0, byPlugin: {}, entries: [], rejects: [],
      }),
  };
  return { registerProvider, registerEffect, registerControls, slots, notify };
}
