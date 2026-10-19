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

/** 占位说明（M3 不接线；M6 会把动态内容填进这些分组） */
const PLACEHOLDER = (what) => ({ kind: 'note', note: `${what}（M6 接线）` });

/** 右侧面板的 9 个分组（顺序与旧前端一致） */
export const PANEL_GROUPS = [
  {
    id: 'motion',
    title: '动作',
    defaultOpen: true,
    controls: [
      { kind: 'switch', label: '混合模式', id: 'ctl-mix-mode', title: '动画切换时是否交叉淡化（与皮肤组同一状态）' },
      { kind: 'dynamic-list', label: '动作列表', note: '选中模型后逐条列出动作（M6 接线）' },
    ],
  },
  {
    id: 'skin',
    title: '皮肤',
    controls: [
      // 与「动作」组的混合模式是同一状态，两处点任一处都要同步（main.js 统一维护）
      { kind: 'switch', label: '混合模式', id: 'ctl-skin-mix', title: '动画切换时是否交叉淡化（与动作组同一状态）' },
      // 皮肤列表：加载模型后按 skeletonData.skins 重建；默认 default
      { kind: 'chips', label: '皮肤列表', id: 'ctl-skin-list', defaultValue: 'default', options: [{ text: 'default', value: 'default' }] },
    ],
  },
  {
    id: 'play',
    title: '播放',
    controls: [
      // 按关键词把部件从渲染中剔除（引擎 setSlotFilter + hideFilteredSlots 已有能力）
      { kind: 'switch', label: '部件筛除', id: 'ctl-part-filter', title: '按关键词筛除部件（默认关）' },
      // 关键字默认值取自旧端存储的 partFilterKeywords（mask,mosai,mmd,mozaiku）
      {
        kind: 'chips',
        label: '关键字',
        id: 'ctl-part-filter-reset',
        defaultValue: 'reset',
        options: [{ text: '恢复默认关键字', value: 'reset' }],
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
        id: 'ctl-filter-preset',
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
        id: 'ctl-pma',
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
      { kind: 'readonly', label: '运行时版本', id: 'ctl-runtime', note: '按模型骨架版本自动选择' },
    ],
  },
  {
    id: 'theme',
    title: '主题背景',
    controls: [
      // 主题换的是整站配色（CSS 变量层），背景模式换的是舞台底色，两件独立的事
      {
        kind: 'select',
        label: '主题',
        id: 'ctl-theme',
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
        id: 'ctl-bg-mode',
        options: ['棋盘格', '纯色', '透明', '自定义'],
        values: ['checkerboard', 'solid', 'transparent', 'custom'],
        defaultValue: 'checkerboard',
        disabledValues: ['custom'],
        titles: ['棋盘格底纹', '纯色底色', '透明（露出页面底色）', '本地图片背景：需文件选择器，二期接入'],
      },
    ],
  },
  {
    id: 'debug',
    title: '调试绘制',
    controls: [
      // 8 个独立开关（可同时开）；键名与引擎 debugDraw 的字段一一对应
      { kind: 'switch', label: '骨骼', id: 'ctl-debug-bones', debugKey: 'bones' },
      { kind: 'switch', label: '网格', id: 'ctl-debug-meshes', debugKey: 'meshes' },
      { kind: 'switch', label: '包围盒', id: 'ctl-debug-boundingBoxes', debugKey: 'boundingBoxes' },
      { kind: 'switch', label: '路径', id: 'ctl-debug-paths', debugKey: 'paths' },
      { kind: 'switch', label: '点', id: 'ctl-debug-points', debugKey: 'points' },
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
      { kind: 'segmented', label: '渲染帧率', id: 'ctl-fps', options: ['60 FPS', '30 FPS'], values: [60, 30], defaultValue: 60, readout: true },
      { kind: 'segmented', label: '渲染像素比（DPR）', id: 'ctl-dpr', options: ['自动', '1', '1.5', '2'], values: ['auto', 1, 1.5, 2], defaultValue: 'auto' },
      {
        kind: 'segmented',
        label: '初始缩放',
        id: 'ctl-fit',
        values: ['subject', 'all', 'animation'],
        defaultValue: 'subject',
        options: [
          { text: '主体优先', title: '排除游离特效/背景，以人物主体适配（推荐）' },
          { text: '全部部件', title: '以所有部件的整体包围盒适配' },
          { text: '动画全程', title: '采样全部动画帧，保证播放过程不超出屏幕' },
        ],
      },
      // 旧端默认是「最邻近」（不是双线性），默认项按旧端对齐
      { kind: 'segmented', label: '纹理过滤', id: 'ctl-filter', options: ['双线性', '最邻近'], values: ['linear', 'nearest'], defaultValue: 'nearest' },
      { kind: 'segmented', label: '抗锯齿（MSAA）', id: 'ctl-msaa', options: ['自动', '关闭'], values: ['auto', 'off'], defaultValue: 'auto' },
      // 旧前端这部分 UI 被自家补丁隐藏了（只追加不覆盖），但 M3 口径要求列全，故照列并标注
      { kind: 'segmented', label: '模型导入模式', id: 'ctl-import-mode', options: ['替换', '追加'], values: ['replace', 'append'], defaultValue: 'append' },
      { kind: 'switch', label: '防卡死保护', id: 'ctl-hang-guard', defaultOn: true },
      { kind: 'switch', label: '显示状态信息', id: 'ctl-show-status', defaultOn: true },
      { kind: 'switch', label: '调试日志', id: 'ctl-debug-log', defaultOn: true },
      { kind: 'actions', buttons: ['导出设置', '导入设置', '恢复默认'], id: 'ctl-settings-io' },
    ],
  },
];

/** 底部播放条的控件（顺序与旧前端可见控件一致；皮肤/动作用下拉表达） */
export const TRANSPORT_CONTROLS = [
  { kind: 'button', id: 'transport-loop', label: '单动循环', title: '单动循环' },
  { kind: 'button', id: 'transport-prev', label: '上一个', title: '上一个' },
  { kind: 'select', id: 'transport-skin', label: '皮肤', value: 'default', options: ['default'] },
  { kind: 'button', id: 'transport-play', label: '播放/暂停', title: '播放/暂停' },
  // 动作下拉不预置任何真实动作：选项由模型动作列表填充（meta.motions / skeletonData.animations）。
  // 这里的单条是**占位文案**（value 为空，不会被当成可播动作），M6 接线时整体替换 options。
  { kind: 'select', id: 'transport-motion', label: '动作', value: '', options: ['（选中模型后列出动作）'] },
  { kind: 'button', id: 'transport-next', label: '下一个', title: '下一个' },
  { kind: 'button', id: 'transport-reset-view', label: '重置视图', title: '重置视图' },
  { kind: 'button', id: 'transport-bg', label: '背景', title: '背景' },
];
