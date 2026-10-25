// panel-schema.js —— 右侧控制面板 + 底部播放条的**声明式**控件表（M3）
//
// 做什么：把"面板里有哪些分组、每组有哪些控件、控件有哪些选项"集中成纯数据，
//   渲染逻辑（panel.js）与样式（panel.css）都从这份表来。
// 为什么用声明式：
//   1. M6 接线时只需给控件补 `id`/取值逻辑，不用再动 DOM 结构；
//   2. 控件清单可被 test/panel-actions.js 直接枚举核对（数量对齐、disabled 断言）；
//   3. 单个文件不会因为"控件多"而膨胀（分组表 ≈ 数据，不掺渲染代码）。
//
// 取值口径（全部照旧前端 8803 实测 DOM，不自己编）：
//   · 9 个手风琴分组名、设置组 10 个子项的标题与选项文字逐字照旧；
//   · 每个控件都带 `pending: true` 语义（M3 一律不接线，渲染成 disabled + data-pending）。

/**
 * @typedef {{kind: string, label?: string, options?: Array<string|{text: string, title?: string}>,
 *            buttons?: string[], note?: string, id?: string}} Control
 * @typedef {{id: string, title: string, defaultOpen?: boolean, controls: Control[]}} Group
 */

/**
 * 与渲染器无关的控件（无能力信息时唯一允许出现的项）。
 * 为什么需要：面板回落策略是「无能力信息 ⇒ 只显示通用项」，而不是"默认全支持"
 *   —— 默认全支持会让"声明了但没实现"的缺陷静默存在（见 docs/契约/渲染面.md §五）。
 */
// 滑块的取值域与默认值统一由 slider.js 提供（避免"面板写一套、映射写另一套"）
import { MIX_DEFAULT, MIX_MAX, MIX_MIN, MIX_STEP, SPEED_DEFAULT, SPEED_MAX, SPEED_MIN, SPEED_STEP } from './slider.js';

export const RENDERER_INDEPENDENT = [
  // 背景类全部与渲染器无关（外壳行为）：纯色预设列表也是外壳数据，不依赖任何渲染能力
  'ctl-theme', 'ctl-bg-mode', 'ctl-bg-color', 'ctl-bg-image', 'ctl-bg-sources',
  'ctl-hang-guard', 'ctl-memory-guard', 'ctl-memory-readout', 'ctl-show-status', 'ctl-debug-log', 'ctl-settings-io',
  // 动作组的循环开关由应用层定时器推进、动作列表内容由应用层填，
  //   与"渲染器是否声明某项能力"无关（两面都要有）。
  'ctl-anim-loop', 'ctl-anim-list',
  // 运行时版本读数：只读文本，跟着渲染器自己报的值走，不参与能力判断。
  'ctl-runtime',
];

/** 占位说明（M3 不接线；M6 会把动态内容填进这些分组） */
const PLACEHOLDER = (what) => ({ kind: 'note', note: `${what}（M6 接线）` });

/** 右侧面板的 9 个分组（顺序与旧前端一致） */
export const PANEL_GROUPS = [
  {
    id: 'motion',
    title: '动作',
    defaultOpen: true,
    controls: [
      // 动作组只剩循环播放一个开关（管"播完接谁"）。
      //   「混合模式」开关已移除：过渡强度改由「播放」组的「混合时长」滑块统一控制
      //   （0 秒 = 不混合 = 原来的"混合模式关"），两个开关 + 一个时长属于三重控制，多余。
      { kind: 'switch', label: '循环播放', id: 'ctl-anim-loop', core: true, title: '播完之后接谁：开=按列表顺序连播、末尾回到第一条；关=停留当前动作重复播' },
      { kind: 'dynamic-list', label: '动作列表', id: 'ctl-anim-list', core: true, note: '选中模型后逐条列出动作，点一条即播放' },
    ],
  },
  {
    id: 'skin',
    title: '皮肤',
    controls: [
      // 「皮肤混合」开关已移除：换肤过渡同样由「播放」组的「混合时长」一个数控制（0 = 不混合）。
      // 皮肤列表：加载模型后按 skeletonData.skins 重建；默认 default
      // capabilityKey: skin —— 渲染面不声明就置灰（Live2D 面没有皮肤概念）
      { kind: 'chips', layout: 'list', label: '皮肤列表', id: 'ctl-skin-list', core: true, capabilityKey: 'skin', defaultValue: 'default', emptyText: '默认皮肤', options: [{ text: 'default', value: 'default' }] },
    ],
  },
  {
    id: 'play',
    title: '播放',
    controls: [
      // 顺序照旧端：速度 → 混合时长（两个连续值滑块，标签左、当前值右）
      // 播放速度：统一入口（spine 缩动画时间轴 / Live2D 缩整帧时间）
      {
        kind: 'slider',
        label: '速度',
        id: 'ctl-speed',
        capabilityKey: 'speed',
        core: true,
        min: SPEED_MIN,
        max: SPEED_MAX,
        step: SPEED_STEP,
        defaultValue: SPEED_DEFAULT,
        format: 'x',            // 显示 1.5x
        // 非线性双段：左半 0.1~1.0 细调、右半 1.0~3.0 粗调，1.0 恰在正中（映射见 view.js SLIDER_CURVES）
        curve: 'speed',
        title: '动画播放速率 0.1–3。spine 缩放动画时间轴；Live2D 缩放整帧时间（物理/呼吸/眨眼会一起变快）。双击数值复位 1',
      },
      // 混合时长：切换动作/皮肤时的交叉淡化秒数。**0 秒即关闭混合**（硬切），
      //   取代了原来的两处「混合模式」开关（一个数同时表达"开不开"和"开多久"）。
      {
        kind: 'slider',
        label: '混合时长',
        id: 'ctl-mix-time',
        capabilityKey: 'mixTime',
        core: true,
        min: MIX_MIN,
        max: MIX_MAX,
        step: MIX_STEP,
        defaultValue: MIX_DEFAULT,
        format: 's',            // 显示 0.85s
        zeroText: '关',         // 0 秒显示"关"，不写 0.00s（语义更直白）
        title: '切换动作/皮肤时的交叉淡化时长（0–1 秒）。拖到最左（0）＝不混合、硬切；双击数值复位 0.2s',
      },
    ],
  },
  {
    id: 'filter',
    title: '滤镜',
    controls: [
      // id 取自引擎内置预设表（original/bright/soft/mono/warm/cool/fresh/sepia/tealorange/cyber/negative/woodcut）
      {
        kind: 'chips',
        label: '滤镜预设',
        id: 'ctl-filter-preset', capabilityKey: 'presetFilter',
        defaultValue: 'original',
        options: [
          { text: '原画', value: 'original' },
          { text: '亮部增强', value: 'bright' },
          { text: '亮部柔和', value: 'soft' },
          { text: '黑白', value: 'mono' },
          { text: '暖色', value: 'warm' },
          { text: '冷色', value: 'cool' },
          { text: '日系清新', value: 'fresh' },
          { text: '棕褐复古', value: 'sepia' },
          { text: '青橙电影', value: 'tealorange' },
          { text: '赛博朋克', value: 'cyber' },
          { text: '负片', value: 'negative' },
          { text: '版画二值', value: 'woodcut' },
        ],
      },
    ],
  },
  {
    id: 'pma',
    title: 'PMA 预乘',
    controls: [
      // 与旧端一致的四档：自动推断 / 强制已预乘 / 强制非预乘 / 上传时转预乘（切换都会重传贴图）
      {
        kind: 'segmented',
        label: 'PMA 预乘',
        id: 'ctl-pma', capabilityKey: 'pma',
        // 2×2 网格（对齐旧端布局：用户已经习惯了那个排列），下方跟随四行只读诊断
        layout: 'grid-2',
        diag: 'pma',
        options: ['自动', '已预乘', '非预乘', '转预乘'],
        titles: ['按像素抽样自动推断', '强制按已预乘处理', '强制按非预乘处理（运行时 4.1+ 才原生支持，较早版本会降级为转预乘）', '上传时在 GPU 上转成预乘'],
        values: ['auto', 'premultiplied', 'straight', 'upload'],
        defaultValue: 'auto',
      },
    ],
  },
  {
    id: 'runtime',
    title: '运行时',
    controls: [
      // 只读：运行时由模型骨架版本决定，引擎不支持手动切换（切了也只会加载失败）
      { kind: 'readonly', label: '运行时版本', id: 'ctl-runtime', core: true, note: '按模型骨架版本自动选择' },
    ],
  },
  {
    id: 'theme',
    title: '主题背景',
    controls: [
      // 主题换的是整站配色（CSS 变量层），背景模式换的是舞台底色，两件独立的事
      {
        // 用 chips 而不是原生 <select>：面板里其它"单选预设组"（滤镜预设等）都是自绘 chips，
        //   原生下拉在视觉上是另一套东西。主题只有 5 项、名字 2~5 字，chips 换行两排完全可接受。
        //   注意：**不要**给它加 capabilityKey —— 主题是外壳行为（在 RENDERER_INDEPENDENT 里），
        //   加了会在 Live2D 面被置灰。
        kind: 'chips',
        label: '主题',
        id: 'ctl-theme', core: true,
        defaultValue: 'dark-cyan',
        options: [
          { text: '深空青', value: 'dark-cyan' },
          { text: '暖陶暗色', value: 'eye-gray' },
          { text: '日间纸', value: 'day-paper' },
          { text: '霓虹夜', value: 'neon-violet' },
          { text: '云蓝', value: 'cloud-blue' },
        ],
      },
      {
        kind: 'segmented',
        label: '背景模式',
        id: 'ctl-bg-mode', core: true,
        // 带 ▾ 的两项点下去会展开二级列表（纯色预设 / 自定义图片）；另两项直接切换
        options: ['棋盘格', '纯色 ▾', '透明', '自定义 ▾'],
        values: ['checkerboard', 'solid', 'transparent', 'custom'],
        defaultValue: 'checkerboard',
        titles: ['棋盘格底纹', '纯色底色', '透明（露出页面底色）', '本地图片背景（选一张图片作为舞台背景）'],
      },
      {
        // 背景来源的**公共列表区**：纯色预设与自定义图片共用这一个位置。
        //   为什么合并（原来上下一处一个，切换要上下找）：切组时视线不动、按钮行不位移。
        //   label 留空 —— 具体组名与数量由渲染层在内容顶部出小标题（「纯色预设 · 5 个」）。
        kind: 'dynamic-list',
        label: '',
        id: 'ctl-bg-sources', core: true,
      },
    ],
  },
  {
    id: 'debug',
    title: '调试绘制',
    controls: [
      // 7 个独立开关（可同时开）；键名与引擎 debugDraw 的字段一一对应
      // 注：不含「点(points)」——各版本 Spine 运行时的 SkeletonDebugRenderer 都没有 drawPoints，
      //     该项永远画不出来，列入声明会让面板出现一个永远无效的开关
      { kind: 'switch', label: '骨骼', id: 'ctl-debug-bones', debugKey: 'bones' },
      { kind: 'switch', label: '网格', id: 'ctl-debug-meshes', debugKey: 'meshes' },
      { kind: 'switch', label: '包围盒', id: 'ctl-debug-boundingBoxes', debugKey: 'boundingBoxes' },
      { kind: 'switch', label: '路径', id: 'ctl-debug-paths', debugKey: 'paths' },
      { kind: 'switch', label: '区域', id: 'ctl-debug-regions', debugKey: 'regions' },
      { kind: 'switch', label: '裁剪', id: 'ctl-debug-clipping', debugKey: 'clipping' },
      { kind: 'switch', label: '外壳', id: 'ctl-debug-hulls', debugKey: 'hulls' },
    ],
  },
  {
    id: 'settings',
    title: '设置',
    defaultOpen: true,
    controls: [
      // values 与 options 一一对应：面板只负责把"点了哪个选项"翻成机器值，再交给接线方
      { kind: 'segmented', label: '渲染帧率', id: 'ctl-fps', capabilityKey: 'fps', options: ['90 FPS', '60 FPS', '30 FPS'], values: [90, 60, 30], defaultValue: 60, readout: true },
      { kind: 'segmented', label: '渲染像素比（DPR）', id: 'ctl-dpr', capabilityKey: 'dpr', options: ['自动', '1', '1.5', '2'], values: ['auto', 1, 1.5, 2], defaultValue: 'auto' },
      {
        kind: 'segmented',
        label: '初始缩放',
        id: 'ctl-fit', capabilityKey: 'fit',
        values: ['subject', 'all', 'animation'],
        defaultValue: 'subject',
        options: [
          { text: '主体优先', title: '排除游离特效/背景，以人物主体适配（推荐）' },
          { text: '全部部件', title: '以所有部件的整体包围盒适配' },
          { text: '动画全程', title: '采样全部动画帧，保证播放过程不超出屏幕' },
        ],
      },
      // 旧端默认是「最邻近」（不是双线性），默认项按旧端对齐
      { kind: 'segmented', label: '纹理过滤', id: 'ctl-filter', capabilityKey: 'textureFilter', options: ['双线性', '最邻近'], values: ['linear', 'nearest'], defaultValue: 'nearest' },
      { kind: 'segmented', label: '抗锯齿（MSAA）', id: 'ctl-msaa', capabilityKey: 'msaa', options: ['自动', '关闭'], values: ['auto', 'off'], defaultValue: 'auto' },
      // 注：不设「模型导入模式（替换/追加）」——本项目的模型来源是资源根目录扫描，
      //     不存在"往当前场景导入单个模型"这条路径，留着会是一个点了没意义的入口
      {
        // 内存容量保护：与下面「防卡死保护」并列但**不是一回事**
        //   （前者防 OOM / 页面崩溃；后者防画面停住没人知道）。旧端同名开关绑的是内存预检，
        //   新端沿用同名的那个是帧停滞看门狗，所以这里新开一项，不改 hang-guard 的语义。
        kind: 'switch',
        label: '内存保护（解包准入 + 堆占用）',
        id: 'ctl-memory-guard', core: true, defaultOn: true,
      },
      {
        // 判据读数：数值全部来自服务端 /api/unpack/capacity（由服务端读系统内存信息），前端不自己估
        kind: 'readonly',
        label: '内存判据',
        id: 'ctl-memory-readout',
        // core 必需：不标 core 会按 id 推导成能力键 memory-readout，渲染器没声明 ⇒ 整项被隐藏
        core: true,
        note: '可用内存 / 本次需求（打开面板时自动取服务端真实值）',
      },
      { kind: 'switch', label: '防卡死保护', id: 'ctl-hang-guard', core: true, defaultOn: true },
      { kind: 'switch', label: '显示状态信息', id: 'ctl-show-status', core: true, defaultOn: true },
      { kind: 'switch', label: '调试日志', id: 'ctl-debug-log', core: true, defaultOn: true },
      {
        kind: 'actions',
        id: 'ctl-settings-io',
        core: true,
        buttons: [
          { text: '导出设置', title: '把当前面板设置导出成 JSON 文件' },
          { text: '导入设置', title: '导入之前导出的 JSON（项目配置走 POST /api/config/import，前端偏好写本地存储）' },
          { text: '恢复默认', title: '清空本地保存的设置、面板回到声明默认值并复位视图' },
        ],
      },
    ],
  },
];

/** 底部播放条的控件。
 *
 * **这里的数组顺序就是底栏的显示顺序**，分组不用另写一份：
 *   标了 `center: true` 的控件单独成中块，它之前的都归左块、之后的都归右块
 *   （见 panel/transport.js 的派生逻辑）。调整位置只改这个数组即可。
 *
 * 当前顺序：主题背景 · 上一个 · 皮肤列表 · 暂停播放 · 动作列表 · 下一个 · 重置视图
 */
export const TRANSPORT_CONTROLS = [
  { kind: 'select', custom: 'picker', id: 'transport-bg', label: '背景', title: '选择舞台背景（内置模式或已上传的自定义图）', value: 'mode:checkerboard', options: [] },
  { kind: 'button', id: 'transport-prev', label: '上一个', title: '上一个' },
  { kind: 'select', custom: 'picker', id: 'transport-skin', label: '皮肤', value: 'default', options: ['default'] },
  // 文案与图标同义（写"点了会做什么"）：初始为播放中 ⇒ 图标是暂停符号、文案「暂停」；
  // 运行时由 transport.setIcon 随状态同步，不再写死"播放/暂停"。
  // center: true ⇒ 这一项固定落在底栏正中（其余控件自动分到左右两块）。
  { kind: 'button', id: 'transport-play', label: '暂停', title: '暂停', center: true },
  // 动作下拉不预置任何真实动作：选项由模型动作列表填充（meta.motions / skeletonData.animations）。
  // 这里的单条是**占位文案**（value 为空，不会被当成可播动作），M6 接线时整体替换 options。
  // 自绘下拉（custom:'picker'）：原生 select 无法统一视觉与键盘语义
  { kind: 'select', custom: 'picker', id: 'transport-motion', label: '动作', value: '', options: ['（选中模型后列出动作）'] },
  { kind: 'button', id: 'transport-next', label: '下一个', title: '下一个' },
  { kind: 'button', id: 'transport-reset-view', label: '重置视图', title: '重置视图' },
];

/**
 * 按 id 前缀推导能力键（**兜底路径**，只在控件没有显式声明时使用）。
 * 推导规则：
 *   · `ctl-debug-<key>` → 调试项 { kind: 'debug', key }（如 ctl-debug-bones → bones）
 *   · `ctl-<key>`       → 设置项 { kind: 'setting', key }（如 ctl-fps → fps）
 *   · 其它形态         → null（推导不出来，不猜；调用方按"不支持"处理）
 * @param {string} id 控件 id
 * @returns {{kind: string, key: string}|null}
 */
export function inferCapabilityKey(id) {
  if (typeof id !== 'string') return null;
  const debugMatch = /^ctl-debug-(.+)$/.exec(id);
  if (debugMatch) return { kind: 'debug', key: debugMatch[1] };
  const settingMatch = /^ctl-(.+)$/.exec(id);
  if (settingMatch) return { kind: 'setting', key: settingMatch[1] };
  return null;
}

/**
 * 解析控件对应的能力键：**显式声明永远优先**，推导只是兜底且必须告警。
 *   · debugKey / capabilityKey 有显式声明 → 直接采用（不做任何推导）；
 *   · core === true（主题/背景/运行时/IO 等核心项）→ 返回 null，不参与能力过滤；
 *   · 其余：按 id 推导；成功与失败都发 warn（成功时提示补显式声明）。
 * @param {object} ctl 控件
 * @param {(message: string) => void} [onWarn] 告警出口（缺省静默）
 * @returns {{kind: string, key: string}|null} null 表示核心项
 */
export function resolveCapabilityKey(ctl, onWarn) {
  const warn = typeof onWarn === 'function' ? onWarn : () => {};
  if (ctl && typeof ctl.debugKey === 'string' && ctl.debugKey) return { kind: 'debug', key: ctl.debugKey };
  if (ctl && typeof ctl.capabilityKey === 'string' && ctl.capabilityKey) return { kind: 'setting', key: ctl.capabilityKey };
  if (ctl && ctl.core === true) return null;
  const id = ctl && ctl.id ? ctl.id : '';
  const inferred = inferCapabilityKey(id);
  if (inferred) {
    warn(`面板控件 ${id} 缺少能力键声明，已按 id 推导为 ${inferred.kind}.${inferred.key}（建议补显式声明）`);
    return inferred;
  }
  warn(`面板控件 ${id || (ctl && ctl.label) || '(无 id)'} 无法确定能力键，按“不支持”处理`);
  return { kind: 'unsupported', key: '' };
}

/**
 * 按渲染器能力过滤面板 schema（纯函数，不改原 schema）。
 * 规则：
 *   · 调试项：不在 capabilities.debugDraw 里 ⇒ 整项隐藏；
 *   · 设置项：不在 capabilities.settings 里 ⇒ disabled + reason；
 *   · 核心项（core: true）：原样保留；
 *   · 推导不出能力键：disabled + reason（不猜）并告警；
 *   · 过滤后为空的分组整组移除。
 * @param {Array} groups 面板分组
 * @param {{settings?: string[], debugDraw?: string[]}} capabilities 渲染器能力
 * @param {{onWarn?: (message: string) => void}} [options] 告警出口
 * @returns {Array} 过滤后的新分组数组
 */
export function applyCapabilities(groups, capabilities, options = {}) {
  const hasCaps = !!(capabilities && Array.isArray(capabilities.settings));
  const settings = new Set((capabilities && capabilities.settings) || []);
  const debugDraw = new Set((capabilities && capabilities.debugDraw) || []);
  const onWarn = options && typeof options.onWarn === 'function' ? options.onWarn : null;
  const reason = '当前渲染器不支持';
  const list = Array.isArray(groups) ? groups : [];
  const independent = new Set(RENDERER_INDEPENDENT);
  return list
    .map((group) => {
      const controls = [];
      for (const ctl of group.controls || []) {
        // ① 手动隐藏（最高优先级）：隐藏即**永不构建**，两面都不出现，不再看能力声明。
        //   设计意图：有些开关产品上就不想让用户改（如动作混合时长），
        //   与"这一面不支持"是两件事，所以它排在最前、且不受 capabilities 影响。
        if (ctl && ctl.hidden === true) continue;
        // 回落策略（契约 §五）：拿不到能力信息 ⇒ 按「无渲染器」处理，只保留与渲染器无关的项。
        //   判据用显式清单而不是 core 标记：皮肤/部件筛除这类也标了 core，但它们依赖渲染器。
        //   旧行为是"默认全支持"，会让"声明了却没实现"的缺陷静默存在。
        if (!hasCaps) {
          if (ctl && ctl.id && independent.has(ctl.id)) controls.push({ ...ctl });
          else if (!ctl || !ctl.id) controls.push({ ...ctl }); // 无 id 的纯展示项（说明/列表占位）保留
          continue;
        }
        const resolved = resolveCapabilityKey(ctl, onWarn);
        if (!resolved) { controls.push({ ...ctl }); continue; } // 核心项原样保留
        if (resolved.kind === 'debug') {
          if (debugDraw.has(resolved.key)) controls.push({ ...ctl });
          continue; // 不支持 ⇒ 整项隐藏（不是禁用）
        }
        if (resolved.kind === 'unsupported') {
          controls.push({ ...ctl, disabled: true, reason: '无法确定能力键' });
          continue;
        }
        // 当前渲染器没有这项能力 ⇒ **不构建**（面板里根本不存在这个控件）。
        //   依据：面板能力契约 §3.1「能力不支持的项必须根本不构建（无 DOM、无监听、无样式计算）」；
        //        §四十九「这类东西对这种模型不存在 → 不加载」。
        //   注意别和"隐藏"混淆：隐藏=先构建再 display:none（契约明令禁止）；
        //   这里是不进 controls，等于面板里从来没有这一项——Live2D 没有 PMA 口径、没有 MSAA
        //   上下文级开关、没有骨架 fit 三模式，就不该在 Live2D 面画出这几项。
        if (!settings.has(resolved.key)) continue;
        controls.push({ ...ctl });
      }
      return { ...group, controls };
    })
    .filter((group) => group.controls.length > 0);
}

/**
 * 由控件 id 反查它需要的能力键与"该能力对应哪个设置键"。
 * 面板只按 capabilityKey 判定可用性，按 settingKey 下发值给渲染器（二者一般同名，
 *   例外是 debug 类：能力键是 debugDraw 的一项，没有 settingKey）。
 * @param {string} id 控件 id（如 ctl-fps / ctl-debug-bones）
 * @returns {{kind: string, capabilityKey: string, settingKey: string|null}|null}
 */
export function settingKeyOf(id) {
  const ctl = CONTROL_INDEX.get(id);
  if (!ctl) return null;
  const resolved = resolveCapabilityKey(ctl, null);
  if (!resolved || resolved.kind === 'unsupported') return null;
  if (resolved.kind === 'debug') return { kind: 'debug', capabilityKey: resolved.key, settingKey: null };
  return { kind: 'setting', capabilityKey: resolved.key, settingKey: resolved.key };
}

/** 控件索引（id → 控件定义），供反查能力键与默认值 */
const CONTROL_INDEX = (() => {
  const map = new Map();
  for (const group of PANEL_GROUPS) {
    for (const ctl of group.controls || []) {
      if (ctl && ctl.id) map.set(ctl.id, ctl);
    }
  }
  return map;
})();

/**
 * 能力自检（面板能力契约 §四）：声明了就必须能落地。
 * 对 capabilities 的每一项调 renderer.setSetting / renderer.getSetting：
 *   · setSetting 返回非 true 或抛异常 ⇒ 违规「声明支持但未实现」
 *   · getSetting 返回 null           ⇒ 违规「无法回显生效值」
 * debugDraw 的项走 setSetting('debug:<key>')，同样要求返回 true。
 * @param {{capabilities?: {settings?: string[], debugDraw?: string[]},
 *          setSetting?: Function, getSetting?: Function}} renderer
 * @returns {{passed: boolean, checked: number, violations: Array<{key: string, expect: string, actual: string}>}}
 */
export function selfCheck(renderer) {
  const violations = [];
  const caps = (renderer && renderer.capabilities) || {};
  const settings = Array.isArray(caps.settings) ? caps.settings : [];
  const debugDraw = Array.isArray(caps.debugDraw) ? caps.debugDraw : [];
  const canSet = renderer && typeof renderer.setSetting === 'function';
  const canGet = renderer && typeof renderer.getSetting === 'function';
  /** 取一项的当前生效值（拿不到则退回控件声明的默认值） */
  const probeValue = (key) => {
    let cur = null;
    try { cur = canGet ? renderer.getSetting(key) : null; } catch { cur = null; }
    if (cur !== null && cur !== undefined) return cur;
    const ctl = CONTROL_INDEX.get(`ctl-${key}`) || findControlByCapability(key);
    if (!ctl) return null;
    return ctl.defaultValue !== undefined ? ctl.defaultValue : (ctl.defaultOn !== undefined ? ctl.defaultOn : null);
  };
  const applyAndCheck = (key, label) => {
    if (!canSet) { violations.push({ key: label, expect: '渲染器实现 setSetting', actual: '缺失' }); return; }
    const value = probeValue(key);
    let ok = false;
    try { ok = renderer.setSetting(key, value) === true; }
    catch (e) { violations.push({ key: label, expect: 'setSetting 不抛异常', actual: `抛异常：${String((e && e.message) || e)}` }); return; }
    if (!ok) { violations.push({ key: label, expect: 'setSetting 返回 true', actual: '返回 false（声明支持但未实现）' }); return; }
    let got = null;
    try { got = canGet ? renderer.getSetting(key) : null; } catch { got = null; }
    if (got === null || got === undefined) violations.push({ key: label, expect: 'getSetting 回显生效值', actual: String(got) });
  };
  // 用"同值回灌"而不是写入新值：自检不能改变用户现场（fit 会重置取景、msaa 会重建上下文）
  for (const key of settings) applyAndCheck(key, key);
  for (const key of debugDraw) applyAndCheck(`debug:${key}`, `debug:${key}`);
  return { passed: violations.length === 0, checked: settings.length + debugDraw.length, violations };
}

/** 按能力键找控件（用于取默认值；同一能力可能有多个控件，取第一个带默认值的） */
function findControlByCapability(key) {
  for (const ctl of CONTROL_INDEX.values()) {
    const resolved = resolveCapabilityKey(ctl, null);
    if (resolved && resolved.kind === 'setting' && resolved.key === key) return ctl;
  }
  return null;
}
