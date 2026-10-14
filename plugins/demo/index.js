// ============================================================================
// plugins/demo/index.js —— 展示类型插件机制的最小示例（只注册、不解析任何文件）
//
// 用途：验证「放 js 就获得能力」这条链路端到端可用 ——
//   ① 服务端 GET /api/plugins 扫到 plugins/demo/plugin.json
//   ② public/plugin-host.js 注入本文件
//   ③ 本文件调用 window.SpineViewerPlugins.register(...) 完成注册
// 删掉 plugins/demo/ 整个目录后刷新页面，能力随之消失（清单来自实时扫描，无任何写死登记）。
//
// 它不声明能读任何文件种类（fileKinds 为空），probe 恒返回 0，open 直接抛可读错误 ——
// 这样它永远不会被"选中去解析"，也不会干扰真实插件。
// ============================================================================

'use strict';

(function () {
  const host = window.SpineViewerPlugins;
  if (!host) {
    console.warn('[demo] SpineViewerPlugins 未就绪（plugin-host.js 未加载？），示例插件未注册');
    return;
  }

  host.register({
    id: 'demo',
    name: '示例插件（只注册不解析）',
    version: 1,
    // 不声明任何可读文件种类：宿主/角色库不会把文件交给它
    fileKinds: [],
    // 置信度恒为 0：任何文件都不归它读
    probe() { return 0; },
    // 即便被显式调用，也只给出可读错误，绝不产出坏模型
    async open(ctx) {
      const name = (ctx && ctx.name) || '(未命名)';
      throw new Error(`示例插件不解析文件：${name}（它只用于验证插件注册链路）`);
    },
  });
})();
