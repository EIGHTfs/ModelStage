// bad-dup-a：形状合法的样本。脚本里必须有**真实调用**（不是注释里提到），否则 A7 会报"没有 registerEffect("。
const host = window.SpineViewerPlugins;
if (host && host.registerEffect) {
  host.registerEffect({ id: 'dup_effect', fragment: 'clamp(c + u_amount, 0.0, 1.0)' });
}
