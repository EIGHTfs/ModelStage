// panel-schema.js —— 右侧控制面板 + 底部播放条的**声明式**控件表（M3）
//
// 做什么：把"面板里有哪些分组、每组有哪些控件、控件有哪些选项"集中成纯数据，
//   渲染逻辑（panel.js）与样式（panel.css）都从这份表来。
// 为什么用声明式：
//   1. M6 接线时只需给控件补 `id`/取值逻辑，不用再动 DOM 结构；
//   2. 控件清单可被 test/panel-actions.js 直接枚举核对（数量对齐、disabled 断言）；
//   3. 单个文件不会因为"控件多"而膨胀（分组表 ≈ 数据，不掺渲染代码）。
//
// 取值口径（取值域按实际行为实测定，不自己编）：
//   · 9 个手风琴分组名、设置组 10 个子项的标题与选项文字逐字照旧；
//   · 控件可声明 `pending: true` 表示暂不可用，渲染成 disabled + data-pending。

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
  // 纯色/图片不再是独立控件：背景统一走 ctl-bg-mode（模式）+ ctl-bg-sources（公共列表容器），
  //   白名单里原先的 ctl-bg-color / ctl-bg-image 已随改造废弃，故不再列（无声明即无意义）。
  'ctl-theme', 'ctl-bg-mode', 'ctl-bg-sources',
  'ctl-hang-guard', 'ctl-memory-guard', 'ctl-memory-bar', 'ctl-show-status', 'ctl-debug-log', 'ctl-settings-io',
  // 动作组的循环开关由应用层定时器推进、动作列表内容由应用层填，
  //   与"渲染器是否声明某项能力"无关（两面都要有）。
  'ctl-anim-loop', 'ctl-anim-list',
  // 运行时版本读数：只读文本，跟着渲染器自己报的值走，不参与能力判断。
  'ctl-runtime',
];

/** 占位说明（M3 不接线；M6 会把动态内容填进这些分组） */
const PLACEHOLDER = (what) => ({ kind: 'note', note: `${what}（M6 接线）` });

/** 右侧面板的 9 个分组（顺序） */
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
      // 顺序速度 → 混合时长（两个连续值滑块，标签左、当前值右）
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
      // 的四档：自动推断 / 强制已预乘 / 强制非预乘 / 上传时转预乘（切换都会重传贴图）
      {
        kind: 'segmented',
        label: 'PMA 预乘',
        id: 'ctl-pma', capabilityKey: 'pma',
        // 2×2 网格（用户已经习惯这个排列），下方跟随四行只读诊断
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
      // 默认「最邻近」（不是双线性）—— 与实机观感一致
      { kind: 'segmented', label: '纹理过滤', id: 'ctl-filter', capabilityKey: 'textureFilter', options: ['双线性', '最邻近'], values: ['linear', 'nearest'], defaultValue: 'nearest' },
      { kind: 'segmented', label: '抗锯齿（MSAA）', id: 'ctl-msaa', capabilityKey: 'msaa', options: ['自动', '关闭'], values: ['auto', 'off'], defaultValue: 'auto' },
      // 注：不设「模型导入模式（替换/追加）」——本项目的模型来源是资源根目录扫描，
      //     不存在"往当前场景导入单个模型"这条路径，留着会是一个点了没意义的入口
      {
        // 内存容量保护：与下面「防卡死保护」并列但**不是一回事**
        //   （前者防 OOM / 页面崩溃；后者防画面停住没人知道）。护」这个开关历史上绑的是内存预检，
        //   本实现沿用同名的那个是帧停滞看门狗，所以这里新开一项，不改 hang-guard 的语义。
        kind: 'switch',
        label: '内存保护（解包准入 + 堆占用）',
        id: 'ctl-memory-guard', core: true, defaultOn: true,
      },
      {
        // 内存三色条容器：内容由 panel/memory-bar.js 填（总 / 可用 / 服务端已占用）。
        //   与舞台左下状态行那条是**同一个组件**，不复制实现。
        kind: 'dynamic-list',
        label: '',
        id: 'ctl-memory-bar', core: true,
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
/**
 * 插件控件的 **kind 白名单**（契约 §9.2）。未列出的一律拒绝：
 * 插件只能提交声明式数据，不能借控件形态塞任意 DOM / 内联样式 / 事件处理器字符串。
 */
export const PLUGIN_CONTROL_KINDS = ['segmented', 'toggle', 'button'];

/**
 * 插件控件 kind → 渲染层 kind 的**唯一映射点**。
 *
 * 为什么必须有这一层：插件契约用的是 `segmented / toggle / button`，
 *   而渲染层（view.js 的 renderControl）认的是 `segmented / switch / actions / …`。
 *   两套词汇直接撞的后果实测过：`toggle`/`button` 落到 view 的 default 分支，
 *   渲染成一个空 `<p class="ctl-note">` —— 没有 data-ctl、没有 label，
 *   表现就是"控件消失了"（置灰原因也一起丢了，违反契约 §9.3 的降级可见）。
 * 新增 kind 时只改这里，两路（老接口 registerControls 与插槽）同时生效。
 */
const PLUGIN_KIND_TO_VIEW = { segmented: 'segmented', toggle: 'switch', button: 'actions' };

/**
 * 校验并归一"插件提交的一节控件"。
 *
 * 分三级处置（契约 §9.2 / §9.3 的差别就在这儿）：
 *   · **整节拒绝**（返回 ok:false）：group 名不存在、controls 不是数组或为空 —— 绝不静默新建分组，
 *     否则插件一多就长出一堆没人认识的分组；
 *   · **单控件拒绝**（进 rejects）：kind 不在白名单、缺 id、id 与已占用重名、segmented 缺 options；
 *   · **单控件置灰**（进 disabled）：id 在清单 effects[] 里声明过，但 registerEffect 没成功 ——
 *     这类要出现在界面上并给出原因，而不是消失（消失后用户会以为自己记错了）。
 *
 * @param {{pluginId:string, group:string, controls:Array}} section 宿主收到的原始节
 * @param {object} ctx
 * @param {Set<string>} ctx.groupTitles 既有分组名集合（用 title 匹配，与契约示例一致）
 * @param {Set<string>} ctx.registeredEffects 注册成功的效果 id
 * @param {Set<string>} ctx.takenIds 已被占用的控件 id（内置 + 先前插件）
 * @returns {{ok:boolean, reason?:string, title?:string, controls?:Array, rejects?:Array}}
 */
/**
 * 把"插件写的分组名"解析成内置分组 id。
 *
 * 分组存在性判断已从 **title 集合**改为 **groupId**（设计 §七·一 的前置：分组有稳定 id）。
 * 老接口（registerControls）传的是标题（「设置」），所以这里 id 优先、title 兜底 ——
 *   两种写法都能命中同一个内置组；兼容层会在后续任务里单独收口成只认 id。
 * @param {string} group 插件写的分组名
 * @param {{groupIds?: Set<string>, groupTitles?: Set<string>, titleToId?: Map<string,string>}} ctx
 * @returns {string|null} 命中返回分组 id；不命中返回 null（由调用方给出可读原因）
 */
function resolveGroupId(group, ctx) {
  if (ctx && ctx.groupIds && ctx.groupIds.has(group)) return group;
  if (ctx && ctx.groupTitles && ctx.groupTitles.has(group)) return ctx.titleToId.get(group) || null;
  return null;
}

/**
 * 校准单个插件控件声明（老接口 registerControls 的每一节都走这里）。
 * 抽出来的理由：normalizePluginSection 只管"整节"的成败，逐控件规则放一起读着才不累。
 * @param {object} raw 插件给的控件声明
 * @param {{takenIds:Set<string>, registeredEffects:Set<string>}} ctx
 * @param {Array} rejects 逐控件拒绝清单（就地追加）
 * @param {{pluginId?: string}} section 所属节
 * @returns {object|null} 归一后的控件；不合规返回 null
 */
function normalizePluginControl(raw, ctx, rejects, section) {
    const id = String((raw && raw.id) || '').trim();
    const kind = String((raw && raw.kind) || '').trim();
    if (!id) { rejects.push({ id: '', reason: '控件缺 id' }); return null; }
    if (!PLUGIN_CONTROL_KINDS.includes(kind)) {
      rejects.push({ id, reason: `kind「${kind}」不在白名单（${PLUGIN_CONTROL_KINDS.join(' / ')}）` });
      return null;
    }
    if (ctx.takenIds.has(id)) { rejects.push({ id, reason: '控件 id 与已存在控件重名' }); return null; }
    if (kind === 'segmented' && !(Array.isArray(raw.options) && raw.options.length)) {
      rejects.push({ id, reason: 'segmented 必须给 options' });
      return null;
    }
    if (kind === 'button' && !String(raw.label || '').trim()) {
      rejects.push({ id, reason: 'button 必须给 label' });
      return null;
    }
    const registered = ctx.registeredEffects.has(id);
    const viewKind = PLUGIN_KIND_TO_VIEW[kind] || kind;
    const optionTexts = kind === 'segmented' ? raw.options.map(String) : null;
  return ({
      // 归一成与内置控件同形的声明：渲染层完全按既有 kind 分派，不认"插件控件"这个概念
      id,
      kind: viewKind,
      // button 在渲染层是"动作组"（renderActions 遍历的是 ctl.buttons，不是 actions）
      //   ⇒ 形状必须补成 buttons[]，否则渲染时读 undefined 抛错、落进 ctl-row-broken 兜底行
      ...(viewKind === 'actions' ? { buttons: [String(raw.label || id)] } : {}),
      label: String(raw.label || id),
      // segmented 必须同时给 options 与 values：渲染层用 `ctl.values[i]` 当按钮的取值
      //   （契约 §9.2 的插件声明里只有 options，所以"选项文本即取值"这层翻译由宿主补 ——
      //    缺了它 String(undefined[i]) 会抛错，而一个控件抛错会拖掉**整组**，实测踩过）
      ...(optionTexts ? { options: optionTexts, values: optionTexts.slice() } : {}),
      // 默认值权威 = options[0]（第 0 档即"关"）。这是设计裁定：面板档位控件的默认值
      //   只有一个来源，plugin.json 的 params[].default 只是"设置值缺失时的 uniform 兜底"。
      //   没有这个字段时工厂拿不到默认值（view.js 只收 defaultValue !== undefined 的控件）
      //   ⇒「恢复默认」不会重置插件控件。
      ...(kind === 'segmented' ? { defaultValue: optionTexts[0] } : {}),
      ...(kind === 'toggle' ? { defaultOn: false } : {}),
      // 能力键**一律**显式声明为 effect id：
      //   已注册 ⇒ 宿主把它追加进 capabilities.settings ⇒ 正常可用；
      //   未注册 ⇒ 不在白名单 ⇒ 走 keepDisabled 分支置灰（并显示下面的原因）。
      //   若不声明，裸 effect id（没有 ctl- 前缀）推导不出能力键，会被判成"unsupported"
      //   并显示成"无法确定能力键"—— 用户看不懂，也丢了"哪个效果没注册成功"这个关键信息。
      capabilityKey: id,
      // disabled 必须在数据层就标上：panel-settings 用它收集 keepDisabled 白名单，
      //   漏了这一步控件会被 applyCapabilities 直接丢掉（消失而不是置灰）。
      ...(registered ? {} : { disabled: true, disabledReason: `效果「${id}」未注册成功（插件脚本可能加载失败或被禁用）` }),
      pluginId: String(section.pluginId || ''),
  });
}

/**
 * @deprecated 旧控件节的逐节校验（registerControls → controlSections 那条链的遗留）。
 * 老接口已改为内部转插槽注册，这条链**不再有输入**；保留只为契约兼容与既有单测。
 * 新代码请用 `slots.register` + `mergeSlotControls`。下一步删除。
 * @param {object} section
 * @param {object} ctx
 * @returns {{ok: boolean, reason?: string, title?: string, controls?: Array, rejects?: Array}}
 */
export function normalizePluginSection(section, ctx) {
  const group = String((section && section.group) || '').trim();
  const controls = Array.isArray(section && section.controls) ? section.controls : null;
  if (!group || !controls || !controls.length) {
    return { ok: false, reason: '节缺少 group 或 controls' };
  }
  const resolved = resolveGroupId(group, ctx);
  if (!resolved) {
    return {
      ok: false,
      reason: `分组「${group}」不存在：老接口（registerControls）只能往**既有分组**加控件；`
        + '新建分组请改用 slots.register("panel.group.plugin.<pluginId>.<name>", …)',
    };
  }
  const out = [];
  const rejects = [];
  for (const raw of controls) {
    const ctl = normalizePluginControl(raw, ctx, rejects, section);
    if (ctl) { out.push(ctl); ctx.takenIds.add(String(ctl.id)); }
  }
  if (!out.length) {
    return { ok: false, reason: `节内 ${controls.length} 个控件全部不合规`, rejects };
  }
  return { ok: true, title: group, controls: out, rejects };
}

/**
 * 把插件控件节合并进内置分组表（**返回新数组，不改 PANEL_GROUPS 静态表**）。
 *
 * 为什么必须返回新数组：`PANEL_GROUPS` 同时是
 *   ① uiState 派生 SPEC 的依据 ② `test/browser/panel-actions.js` 的"控件分类门禁"遍历对象。
 *   原地改它会把插件控件塞进门禁的检查范围（门禁要求每个控件显式归到三层优先级之一），
 *   等于要求插件也去维护那张表 —— 违反"插件只交声明式数据"的边界。
 *
 * @param {Array} baseGroups 内置分组
 * @param {Array<{pluginId:string, group:string, controls:Array}>} sections 插件提交的节
 * @param {object} [opts]
 * @param {(rej:{pluginId:string, group:string, reason:string, rejects?:Array}) => void} [opts.onReject] 拒绝/丢弃的回报口（写 diag）
 * @returns {{groups:Array, added:number, rejected:number, rejectedControls:number}}
 */
/**
 * @deprecated 旧控件节合并（`registerControls` 迁移后已无输入，`controlSections` 恒为空）。
 * 新代码请用 `mergeSlotControls`。保留仅为契约兼容与既有单测；下一步会删除。
 * @param {Array} baseGroups 内置分组
 * @param {Array} sections 旧控件节
 * @param {object} [opts]
 * @returns {{groups: Array, added: number, rejected: number, rejectedControls: number}}
 */
export function mergePluginControls(baseGroups, sections, opts = {}) {
  const base = Array.isArray(baseGroups) ? baseGroups : [];
  const report = typeof (opts && opts.onReject) === 'function' ? opts.onReject : () => {};
  const list = Array.isArray(sections) ? sections : [];
  if (!list.length) return { groups: base, added: 0, rejected: 0, rejectedControls: 0 };

  const groupTitles = new Set(base.map((g) => String(g.title || '')));
  const groupIds = new Set(base.map((g) => String(g.id || '')));
  const titleToId = new Map(base.map((g) => [String(g.title || ''), String(g.id || '')]));
  const registeredEffects = new Set((opts && opts.registeredEffects) || []);
  const takenIds = new Set();
  for (const g of base) {
    for (const c of (g && g.controls) || []) if (c && c.id) takenIds.add(String(c.id));
  }
  const ctx = { groupTitles, groupIds, titleToId, registeredEffects, takenIds };

  // 深拷贝分组与控件数组：只拷一层结构，控件对象本身按需替换，避免动到内置对象
  const groups = base.map((g) => ({ ...g, controls: (g.controls || []).slice() }));
  const byTitle = new Map(groups.map((g) => [String(g.title || ''), g]));
  let added = 0;
  let rejected = 0;
  let rejectedControls = 0;

  for (const section of list) {
    const res = normalizePluginSection(section, ctx);
    if (!res.ok) {
      rejected += 1;
      rejectedControls += (res.rejects || []).length;
      report({ pluginId: section.pluginId || '', group: section.group || '', reason: res.reason, rejects: res.rejects });
      continue;
    }
    const target = byTitle.get(res.title);
    if (!target) {   // 双保险：normalize 已检查过标题存在
      rejected += 1;
      report({ pluginId: section.pluginId || '', group: res.title, reason: '目标分组在合并时消失' });
      continue;
    }
    target.controls = target.controls.concat(res.controls);
    added += res.controls.length;
    if (res.rejects && res.rejects.length) {
      rejectedControls += res.rejects.length;
      report({ pluginId: section.pluginId || '', group: res.title, reason: '部分控件不合规', rejects: res.rejects });
    }
  }
  return { groups, added, rejected, rejectedControls };
}

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
  // keepDisabled：即使能力不匹配也要**保留**的控件 id（插件已声明、但 registerEffect 没成功的那些）。
  //   为什么单独开这个口：面板能力契约 §3.1 规定"不支持的能力项根本不构建"，
  //   但插件契约 §9.3 要求相反 —— 已声明未生效的控件必须**置灰并给出原因**，
  //   消失会让用户以为自己记错了。两种诉求都成立，所以用显式白名单区分，而不是放宽统一规则。
  const keepDisabled = options && options.keepDisabled instanceof Set ? options.keepDisabled : null;
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
        if (!settings.has(resolved.key)) {
          // 能力不匹配：默认不构建；插件已声明项例外 —— 保留并置灰，让"为什么没有生效"可见
          if (keepDisabled && ctl.id && keepDisabled.has(String(ctl.id))) {
            controls.push({ ...ctl, disabled: true, reason: ctl.disabledReason || reason });
          }
          continue;
        }
        controls.push({ ...ctl });
      }
      return { ...group, controls };
    })
    .filter((group) => group.controls.length > 0);
}

/**
 * 把插槽登记（`panel.group.<groupId>`）合进面板分组表 —— **纯函数，返回新数组**。
 *
 * 为什么在装配期（panel-settings.js 调用）而不是渲染期：
 *   · 渲染层（view.js）只认"拿到什么画什么"，它不该知道"控件是插件来的"；
 *   · 审批（拒绝/warn）、能力白名单并入、SPEC 登记都发生在装配期，聚合放这里才同源；
 *   · 结果**绝不写回** `PANEL_GROUPS` 静态导出 —— 那份同时被 uiState SPEC 派生与浏览器测试的
 *     控件分类门禁遍历，写回会让插件控件被当成"必须显式归类"的内置控件（误报孤儿能力键）。
 *
 * 排序：组内先内置（保持原序），插件控件按 order 升序追加在后（缺省 1000）。
 * 冲突：同一组内 id 重名 ⇒ 后者被拒 + onReject 回报（不静默覆盖）。
 *
 * @param {Array} baseGroups 内置分组（或用别的聚合结果做底）
 * @param {Array<{pluginId:string,name:string,id:string,order:number,label:string,spec:object}>} entries 插槽登记
 * @param {{onReject?: (rej: object) => void}} [opts]
 * @returns {{groups: Array, added: number, rejected: number, capabilityKeys: string[]}}
 */
export function mergeSlotControls(baseGroups, entries, opts = {}) {
  const base = Array.isArray(baseGroups) ? baseGroups : [];
  const list = Array.isArray(entries) ? entries : [];
  const report = typeof (opts && opts.onReject === 'function') ? opts.onReject : () => {};
  if (!list.length) return { groups: base, added: 0, rejected: 0, capabilityKeys: [] };

  const groups = base.map((g) => ({ ...g, controls: (g.controls || []).slice() }));
  const byId = new Map(groups.map((g) => [String(g.id || ''), g]));
  const taken = new Set();
  for (const g of groups) for (const c of g.controls || []) if (c && c.id) taken.add(String(c.id));

  const acc = {
    added: 0, rejected: 0, capabilityKeys: [], byGroup: new Map(),
    // 内置组标题：新建分组允许与之同名，但要在诊断里提示（设计 §七·一）
    builtinTitles: new Set(groups.map((g) => String(g.title || ''))),
    // 新建的插件分组（最后统一追加到所有内置组之后）
    newGroups: [], seq: 0,
  };
  for (const entry of list) resolveSlotEntry(entry, taken, byId, acc, report, opts);

  for (const [groupId, bucket] of acc.byGroup) {
    const group = byId.get(groupId);
    if (!group) continue;
    bucket.sort((a, b) => a.order - b.order);          // order 小在前；相同 order 按注册先后（sort 稳定）
    group.controls = [...group.controls, ...bucket.map((b) => b.ctl)];
  }
  // 内置组 order 0~99 保持在原位；插件组缺省 1000，按 order 再按注册先后追加在最后
  acc.newGroups.sort((a, b) => a.order - b.order || a.seq - b.seq);
  for (const ng of acc.newGroups) groups.push(ng.group);
  return { groups, added: acc.added, rejected: acc.rejected, capabilityKeys: acc.capabilityKeys };
}

/**
 * 处理单条插槽登记：校验分组/重名/render 形状，合格就按组分桶（排序交给调用方）。
 * 抽出来的理由：mergeSlotControls 主体要读得动，且"哪条为什么被拒"集中在这一处。
 * @param {object} entry 插槽登记
 * @param {Set<string>} taken 已被占用的控件 id（含内置与本轮已加的）
 * @param {Map<string, object>} byId groupId → 分组
 * @param {{added:number, rejected:number, capabilityKeys:string[], byGroup:Map}} acc 累加器
 * @param {(rej: object) => void} report 拒绝回报
 */
function resolveSlotEntry(entry, taken, byId, acc, report, opts = {}) {
  const m = /^panel\.group\.(.+)$/.exec(String((entry && entry.name) || ''));
  if (!m) {
    acc.rejected += 1;
    report({ pluginId: entry && entry.pluginId, slot: entry && entry.name, reason: '该插槽类型暂不参与渲染（只有 panel.group.* 进面板）' });
    return;
  }
  const groupId = m[1];
  let group = byId.get(groupId);
  if (!group) {
    group = createPluginGroup(entry, groupId, byId, acc, report);
    if (!group) return;
  }
  const id = String((entry && entry.id) || '');
  if (!id || taken.has(id)) {
    acc.rejected += 1;
    report({ pluginId: entry && entry.pluginId, slot: entry && entry.name, id, reason: taken.has(id) ? `控件 id「${id}」与已有控件重名` : '控件缺 id' });
    return;
  }
  // owner props：settings 传**真实值**（当前值 ?? 声明默认值），S4 会再加 geometry/activeSurface/document
  const props = typeof opts.buildProps === 'function' ? opts.buildProps(entry) : {};
  const desc = slotSpecToControl(entry, props);
  if (!desc) {
    acc.rejected += 1;
    report({ pluginId: entry && entry.pluginId, slot: entry && entry.name, id, reason: 'render() 没有返回可用的控件描述（kind 必须是已知类型）' });
    return;
  }
  // 老接口迁移来的控件带 effectId：效果没注册成功 ⇒ 置灰 + 原因（与迁移前语义一致，契约 §9.3）
  const effectId = String((entry && entry.spec && entry.spec.effectId) || '');
  const registered = new Set((opts && opts.registeredEffects) || []);
  const effectMissing = !!effectId && !registered.has(effectId);
  const ctl = {
    ...desc,
    id,
    label: String((entry && entry.label) || id),
    pluginId: String((entry && entry.pluginId) || ''),
    // 存值键：给了 spec.setting 就用它（与清单设置键统一），否则沿用 control id（兼容既有插件）
    setting: String((entry && entry.setting) || ''),
    ...(effectMissing ? {
      disabled: true,
      // reason 与 disabledReason 两个键都要给：
      //   applyCapabilities 读 disabledReason，mountPanel 建 disabledMap 时读的是 reason ——
      //   只给一个会出现"置灰了但文案是通用的「当前渲染器不支持」"（实测踩到）。
      reason: `效果「${effectId}」未注册成功（插件脚本可能加载失败或被禁用）`,
      disabledReason: `效果「${effectId}」未注册成功（插件脚本可能加载失败或被禁用）`,
    } : {}),
    // 能力键显式声明为该控件 id：装配期把 id 并进 capabilities.settings，渲染层据此认它
    capabilityKey: id,
    // 插件的动作回调（面板点击时派发；由装配层负责调用并兜住异常）
    onAction: typeof (entry.spec || {}).onAction === 'function' ? entry.spec.onAction : null,
  };
  taken.add(id);
  acc.capabilityKeys.push(id);
  acc.added += 1;
  const bucket = acc.byGroup.get(groupId) || [];
  bucket.push({ ctl, order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : 1000 });
  acc.byGroup.set(groupId, bucket);
}

/**
 * 插件新建分组（设计 §七·一）：id 必须带 `plugin.<pluginId>.` 前缀，标题由插件给。
 *
 * 规则与理由：
 *   · 前缀强制 —— 两个插件撞同一个分组 id 时，光看 id 就能判归属；不要求前缀的话
 *     "pluginA 建了 settings2、pluginB 也想建 settings2"只能靠注册顺序决定谁赢，排查时无从下手。
 *   · 允许与内置组**同名**（title 相同、id 不同）—— 标题是给人看的，插件想叫「设置」不算错；
 *     但要在诊断里提示一句，避免"我以为在改内置组"这种误会。
 *   · 缺省 order 1000（内置组 0~99）⇒ 永远排在内置组之后；同 order 按注册先后。
 * @returns {object|null} 建好的分组；被拒返回 null（原因已 report）
 */
function createPluginGroup(entry, groupId, byId, acc, report) {
  const pid = String((entry && entry.pluginId) || '');
  const prefix = `plugin.${pid}.`;
  if (!pid || !groupId.startsWith(prefix) || groupId.length <= prefix.length) {
    acc.rejected += 1;
    report({
      pluginId: pid || '未知插件', slot: entry && entry.name, code: 'bad-group-id',
      reason: `分组「${groupId}」不存在；新建分组的 id 必须写成 plugin.<pluginId>.<name>`
        + `（当前插件 ${pid || '未知'}，应形如 ${pid ? prefix + '<name>' : 'plugin.<pluginId>.<name>'}）`,
    });
    return null;
  }
  const spec = (entry && entry.spec) || {};
  const title = String(spec.groupLabel || spec.title || groupId.slice(prefix.length));
  if (acc.builtinTitles.has(title)) {
    // 允许，但要留痕：这条提示是给排障与插件作者看的
    report({
      pluginId: pid, slot: entry && entry.name, code: 'title-collision',
      reason: `新建分组「${groupId}」的标题「${title}」与内置组同名（允许；请确认你不是想往内置组加控件）`,
    });
  }
  const group = {
    id: groupId,
    title,
    pluginId: pid,
    // 缺省收起：插件分组的内容用户未必关心，别一进来就把面板撑长
    defaultOpen: !!spec.groupDefaultOpen,
    controls: [],
  };
  byId.set(groupId, group);
  acc.newGroups.push({
    group,
    order: Number.isFinite(Number(spec.groupOrder)) ? Number(spec.groupOrder) : 1000,
    seq: acc.seq++,
  });
  return group;
}

/**
 * 插槽声明的 `render(props)` 结果 → 面板控件描述（view.js 已有的 kind）。
 *
 * 为什么在这里翻译：render() 是**插件侧**的形状（{kind:'segmented', options}），
 *   而面板控件需要宿主口径（segmented 要 values、开关要 defaultOn）。
 *   翻译集中在装配期一处，渲染层就不用认识"插件控件"这个概念。
 * @param {{id:string,label:string,spec:object}} entry
 * @returns {object|null}
 */
function slotSpecToControl(entry, props) {
  const spec = (entry && entry.spec) || {};
  if (typeof spec.render !== 'function') return null;
  let out = null;
  try {
    // props 由装配层构造：settings 是**真实值**（当前值 ?? 声明默认值），S4 再扩 geometry/activeSurface/document
    out = spec.render(props || { settings: {} });
  } catch {
    return null;
  }
  if (!out || typeof out !== 'object') return null;
  const kind = String(out.kind || '');
  if (kind === 'segmented') {
    const options = Array.isArray(out.options) ? out.options.map(String) : [];
    if (!options.length) return null;
    return { kind: 'segmented', options, values: options.slice(), defaultValue: options[0] };
  }
  if (kind === 'toggle' || kind === 'switch') return { kind: 'switch', defaultOn: !!out.value };
  if (kind === 'slider') {
    return { kind: 'slider', min: out.min, max: out.max, step: out.step, unit: out.unit, defaultValue: out.value };
  }
  if (kind === 'select') {
    const options = Array.isArray(out.options) ? out.options.map(String) : [];
    if (!options.length) return null;
    return { kind: 'select', options, values: options.slice(), defaultValue: options[0] };
  }
  if (kind === 'button') {
    // 与老接口共用 PLUGIN_KIND_TO_VIEW 的结论（button → actions）；
    //   形状按渲染层口径给 buttons[]（renderActions 遍历的是它）
    return { kind: PLUGIN_KIND_TO_VIEW.button, buttons: [String(out.label || entry.label || '执行')] };
  }
  return null;
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
