#!/usr/bin/env node
// compare-with-原版.mjs —— 逐字段比对我的模型对象 与 原版 原生导入结果
//
// 目的：逐个检查与 8801 部署产物不一致的地方。
//   本脚本把 原版 的构造公式（Ek/_w/hk/Ps/ta/Ew/ww/Mw/Tp/Sw/ck/Po）
//   在 Node 里原样实现，对同一批磁盘文件算出「原版 会得到的模型对象」，
//   再与我的 /api/models 输出逐字段比对，列出所有差异。
//
// 用法：node tool/compare-with-原版.mjs
// 说明：只读，不修改任何东西。

import fs from 'node:fs';
import path from 'node:path';

// ---------------- 原版 的原函数（照抄，仅改从磁盘读内容） ----------------
const ta = (n) => n.replace(/\.[^/.]+$/, '');                       // 去扩展名
const Ps = (n) => n.replace(/-pma$/i, '').replace(/-pro$/i, '').replace(/-export$/i, '')
  .replace(/_pma$/i, '').replace(/_pro$/i, '').replace(/_export$/i, '').toLowerCase();
const hk = (n) => (n.toLowerCase().includes('.skel') ? 'skel' : 'json');  // format
const Ew = (v) => { const t = String(v).split('.'); return t.length >= 2 ? `${t[0]}.${t[1]}` : String(v); };
const Po = (p) => { const t = p.replace(/\\/g, '/').split('/').filter(Boolean); t.pop(); return t.join('/'); };
const ck = (p) => { const t = p.split('/'); return t.length <= 1 ? '根目录' : (t[t.length - 2] || '根目录'); };
const _w = (n) => (/\.json$/i.test(n) ? 'application/json'
  : /\.atlas/i.test(n) ? 'text/plain'
    : /\.png$/i.test(n) ? 'image/png'
      : /\.jpe?g$/i.test(n) ? 'image/jpeg'
        : /\.webp$/i.test(n) ? 'image/webp'
          : 'application/octet-stream');
const uk = (n) => /\.(skel|json)(\.txt)?$/i.test(n) && !/\.atlas/i.test(n);   // 骨架
const dk = (n) => /\.atlas(\.txt)?$/i.test(n);                                 // 图集
const fk = (n) => /\.(png|jpg|jpeg|webp|pvr|etc|atf)$/i.test(n);               // 贴图

const Tp = (txt) => { if (!txt) return null; const m = txt.match(/^pma:\s*(true|false)/m); return m ? m[1] === 'true' : null; };
const ww = (jsonText) => { try { const a = JSON.parse(jsonText); return a.skeleton && a.skeleton.spine ? Ew(a.skeleton.spine) : '4.0'; } catch { return '4.0'; } };
const Mw = (buf) => {
  try {
    const s = Buffer.from(buf).slice(0, 512).toString('latin1')
      .match(/(2\.\d+|3\.[5-8]|4\.[0-3])\.\d+[\w-]*/);
    return s ? Ew(s[0]) : '4.0';
  } catch { return '4.0'; }
};
const Sw = (txt) => {   // 从 atlas 内容取页名
  if (!txt) return [];
  const out = [];
  let fresh = true;
  for (const line of txt.split('\n')) {
    const c = line.trim();
    if (!c) { fresh = true; continue; }
    if (fresh && !line.startsWith(' ') && !line.includes(':') && /\.(png|jpg|jpeg|webp|pvr|etc|atf)/i.test(c)) {
      out.push(c);
    }
    fresh = false;
  }
  return out;
};

// ---------------- 用 原版 公式构造模型 ----------------
function 原版Model(absDir, skelName, atlasName, textureNames) {
  const skelPath = `${absDir}/${skelName}`;
  const atlasPath = `${absDir}/${atlasName}`;
  const skelBuf = fs.readFileSync(skelPath);
  const atlasText = fs.readFileSync(atlasPath, 'utf8');

  const k = hk(skelName);
  let v = '4.0';
  if (k === 'json') v = ww(skelBuf.toString('utf8'));
  else v = Mw(skelBuf);

  const z = Tp(atlasText);                       // null / true / false
  const x = Ps(ta(skelName));
  const V = x.replace(/[-_](pma|pro|export)$/i, '');
  const name = V.charAt(0).toUpperCase() + V.slice(1);

  const textures = textureNames.map((t) => ({ name: t, type: _w(t), size: fs.statSync(`${absDir}/${t}`).size }));
  const fileSize = skelBuf.length + fs.statSync(atlasPath).size + textures.reduce((s, t) => s + t.size, 0);

  return {
    name,
    directory: ck(skelPath),
    dirPath: Po(skelPath),
    version: v,
    format: k,
    atlasPma: z === null ? undefined : z,          // 未声明 -> undefined
    textureCount: textures.length,
    fileSize,
    skeletonType: _w(skelName),
    atlasType: _w(atlasName),
    textureTypes: textures.map((t) => t.type).join(','),
  };
}

// ---------------- 比对我方输出 ----------------
const MANIFEST = {
  bd2: 'config/models.bd2.json',
  spine_mod: 'config/models.spine_mod.json',
};
const ROOTS = {
  bd2: '/volume1/@appdata/DeepSeekHarness-NAS/0.1.6-alpha.1/工作区/spine-viewers/BD2-L2D-Viewer/src/assets/spines',
  spine_mod: '/volume1/@appdata/DeepSeekHarness-NAS/0.1.6-alpha.1/工作区/spine-mod',
};

function main() {
  const all = [];
  for (const [rid, mf] of Object.entries(MANIFEST)) {
    if (!fs.existsSync(mf)) continue;
    for (const m of JSON.parse(fs.readFileSync(mf, 'utf8')).models) {
      all.push({ rid, m });
    }
  }
  console.log(`清单模型总数: ${all.length}`);

  // 抽样：每个资源根取前几个 + 含 pma 声明的
  const samples = [];
  const byRoot = {};
  for (const x of all) {
    byRoot[x.rid] = byRoot[x.rid] || [];
    if (byRoot[x.rid].length < 3) { byRoot[x.rid].push(x); samples.push(x); }
  }
  for (const x of all) {
    if (x.m.atlasPma === true && !samples.includes(x)) samples.push(x);
  }

  const diffs = {};
  const bump = (k, detail) => { diffs[k] = diffs[k] || []; diffs[k].push(detail); };

  for (const { rid, m } of samples) {
    const absDir = path.join(ROOTS[rid], m.srcDir || '');
    const skelName = m.skeletonFile.name;
    const atlasName = m.atlasFile.name;
    const texNames = m.textureFiles.map((t) => t.name);

    let bv;
    try { bv = 原版Model(absDir, skelName, atlasName, texNames); }
    catch (e) { console.log(`  [跳过] ${rid}/${m.srcDir}: ${e.message}`); continue; }

    const label = `${rid}:${m.srcDir || '.'}/${m.name}`;
    if (m.version !== bv.version) bump('version', `${label}  我=${JSON.stringify(m.version)} 原版=${JSON.stringify(bv.version)}`);
    if (m.format !== bv.format) bump('format', `${label}  我=${JSON.stringify(m.format)} 原版=${JSON.stringify(bv.format)}`);
    const myPma = m.atlasPma === null ? undefined : m.atlasPma;
    if (myPma !== bv.atlasPma) bump('atlasPma', `${label}  我=${JSON.stringify(myPma)} 原版=${JSON.stringify(bv.atlasPma)}`);
    if (m.textureCount !== bv.textureCount) bump('textureCount', `${label}  我=${m.textureCount} 原版=${bv.textureCount}`);
    if (m.fileSize !== bv.fileSize) bump('fileSize', `${label}  我=${m.fileSize} 原版=${bv.fileSize}`);
    // 以下为「有意不同」的字段，仅记录
    if (m.name !== bv.name) bump('[有意]name', `${label}  我=${m.name} 原版=${bv.name}`);
    if (m.dirPath !== bv.dirPath) bump('[有意]dirPath', `${label}  我=${m.dirPath} 原版=${bv.dirPath}`);
  }

  console.log(`\n抽样 ${samples.length} 个模型比对：`);
  const keys = Object.keys(diffs);
  if (!keys.length) { console.log('  ✅ 无任何差异'); return; }
  for (const k of keys) {
    console.log(`\n【${k}】${diffs[k].length} 处`);
    diffs[k].slice(0, 5).forEach((d) => console.log('  ' + d));
  }
}

main();
