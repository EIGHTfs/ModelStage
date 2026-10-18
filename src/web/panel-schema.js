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
      { kind: 'switch', label: '混合模式', id: 'ctl-mix-mode' },
      { kind: 'dynamic-list', label: '动作列表', note: '选中模型后逐条列出动作（M6 接线）' },
    ],
  },
  { id: 'skin', title: '皮肤', controls: [PLACEHOLDER('选中模型后列出皮肤')] },
  { id: 'play', title: '播放', controls: [PLACEHOLDER('速度 / 循环 / 帧步进')] },
  { id: 'filter', title: '滤镜', controls: [PLACEHOLDER('滤镜预设')] },
  { id: 'pma', title: 'PMA 预乘', controls: [PLACEHOLDER('预乘 alpha 处理')] },
  { id: 'runtime', title: '运行时', controls: [PLACEHOLDER('运行时版本与能力信息')] },
  { id: 'theme', title: '主题背景', controls: [PLACEHOLDER('背景样式与配色')] },
  { id: 'debug', title: '调试绘制', controls: [PLACEHOLDER('骨骼 / 包围盒 / 网格绘制')] },
  {
    id: 'settings',
    title: '设置',
    defaultOpen: false,
    controls: [
      { kind: 'segmented', label: '渲染帧率', id: 'ctl-fps', options: ['60 FPS', '30 FPS'] },
      { kind: 'segmented', label: '渲染像素比（DPR）', id: 'ctl-dpr', options: ['自动', '1', '1.5', '2'] },
      {
        kind: 'segmented',
        label: '初始缩放',
        id: 'ctl-fit',
        options: [
          { text: '主体优先', title: '排除游离特效/背景，以人物主体适配（推荐）' },
          { text: '全部部件', title: '以所有部件的整体包围盒适配' },
          { text: '动画全程', title: '采样全部动画帧，保证播放过程不超出屏幕' },
        ],
      },
      { kind: 'segmented', label: '纹理过滤', id: 'ctl-filter', options: ['双线性', '最邻近'] },
      { kind: 'segmented', label: '抗锯齿（MSAA）', id: 'ctl-msaa', options: ['自动', '关闭'] },
      // 旧前端这部分 UI 被自家补丁隐藏了（只追加不覆盖），但 M3 口径要求列全，故照列并标注
      { kind: 'segmented', label: '模型导入模式', id: 'ctl-import-mode', options: ['替换', '追加'] },
      { kind: 'switch', label: '防卡死保护', id: 'ctl-hang-guard' },
      { kind: 'switch', label: '显示状态信息', id: 'ctl-show-status' },
      { kind: 'switch', label: '调试日志', id: 'ctl-debug-log' },
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
  { kind: 'select', id: 'transport-motion', label: '动作', value: 'idle', options: ['idle'] },
  { kind: 'button', id: 'transport-next', label: '下一个', title: '下一个' },
  { kind: 'button', id: 'transport-reset-view', label: '重置视图', title: '重置视图' },
  { kind: 'button', id: 'transport-bg', label: '背景', title: '背景' },
];
