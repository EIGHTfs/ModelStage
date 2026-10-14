#!/usr/bin/env node
// ============================================================================
// build-product.mjs — 产出「原版 + MOD 改动」的页面，并生成可用于验证的校验台
//
// 与 tool/build-from-parts.mjs 的分工：
//   build-from-parts.mjs  基线：装配 ≡ src/.app-shell.orig.html ≡ dist（逐字节，不可破坏）
//   build-product.mjs     产物：基线 + 保留 MOD 块 → 新 sha256（P4 起有意与 baseline 不同）
//
// 为什么不直接写 dist/：
//   本次任务边界是「不改 dist / baseline」；故产物写到 **校验台目录**（默认 /tmp 下），
//   由 `SPINE_DIST_DIR=<校验台目录> node server.mjs 8899` 起一个**只读**服务来验证。
//   校验台页面自带与 server.mjs 完全相同的注入（store 钩子 + 5 个自有脚本 + 防闪烁 CSS）：
//   注入函数在 --verify-injection 时会拿 dist 跑一遍并与 8803 的真实响应**逐字节比对**，
//   比对通过才认为校验台等价于生产环境的服务方式（避免「第二套注入实现」造成误判）。
//
// 用法：
//   node tool/build-product.mjs                                   # 只报告（装配/哈希/MOD 清单）
//   node tool/build-product.mjs --out /tmp/p4/serve/index.html     # 写产物（拒绝写 dist/）
//   node tool/build-product.mjs --harness-dir /tmp/p4/serve        # 写校验台（index/prod/compare）
//   node tool/build-product.mjs --verify-injection                 # 注入函数 vs 8803 实测比对
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { assemble, buildArtifactFromParts } from './build-from-parts.mjs';
import { listMods } from './lib/mods.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ORIG = path.join(ROOT, 'src', '.app-shell.orig.html');
const DIST = path.join(ROOT, 'dist', 'index.html');
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

// ---------------------------------------------------------------------------
// server.mjs 的注入镜像（逐条对照 server.mjs 的 ANCHOR/HOOK/SCRIPT_TAGS/ANTI_FLASH_CSS）
// ---------------------------------------------------------------------------
const STORE_ANCHOR = '=Fe(),';
const STORE_HOOK = '=(window.__SPINE_STORE__=Fe,Fe)(),';
const SCRIPT_TAGS = '<script src="/local-roots.js"></script>'
  + '<script src="/roots-ui.js"></script>'
  + '<script src="/char-tree.js"></script>'
  + '<script src="/live2d-stage.js"></script>'
  + '<script src="/settings-io.js"></script>';
const ANTI_FLASH_CSS = '<style>'
  + '.bv-sidebar.left-0 { display: none !important; }'
  + '.absolute.inset-0.flex.items-center.justify-center.pointer-events-none.z-10.text-slate-200 { display: none !important; }'
  + '</style>';

/** 复刻 server.mjs 对 dist/index.html 的响应处理（顺序、幂等判断一致）。 */
export function injectLikeServer(html) {
  const pos = html.indexOf(STORE_ANCHOR);
  let patched = pos >= 0 ? html.slice(0, pos) + STORE_HOOK + html.slice(pos + STORE_ANCHOR.length) : html;
  if (!patched.includes('/local-roots.js')) {
    const bodyEnd = patched.lastIndexOf('</body>');
    patched = bodyEnd >= 0 ? patched.slice(0, bodyEnd) + SCRIPT_TAGS + patched.slice(bodyEnd) : patched + SCRIPT_TAGS;
  }
  if (!patched.includes('.bv-sidebar.left-0')) {
    const headEnd = patched.indexOf('</head>');
    patched = headEnd >= 0 ? patched.slice(0, headEnd) + ANTI_FLASH_CSS + patched.slice(headEnd) : ANTI_FLASH_CSS + patched;
  }
  return patched;
}

// ---------------------------------------------------------------------------
// 校验台里的两页对比工具（同源双 iframe → 逐像素 diff；沿用 P3a 的判据）
// ---------------------------------------------------------------------------
const COMPARE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>P4 对比：产物 vs 基线</title>
<style>body{margin:0;background:#111;color:#ddd;font:12px/1.5 monospace}iframe{width:960px;height:1040px;border:1px solid #444}#log{padding:8px;white-space:pre-wrap}</style></head>
<body><div style="display:flex;gap:8px"><iframe id="a" src="index.html"></iframe><iframe id="b" src="prod.html"></iframe></div><div id="log">初始化…</div>
<script>
const log=(s)=>{document.getElementById('log').textContent += '\\n'+s;};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const frames={a:document.getElementById('a'),b:document.getElementById('b')};
function ctxOf(id){const f=frames[id],w=f.contentWindow,d=f.contentDocument;return {w,d,cv:d.querySelector('canvas.absolute.inset-0'),store:w.__SPINE_STORE__};}
function findBtn(d,label){return [...d.querySelectorAll('button')].find(b=>((b.getAttribute('aria-label')||b.getAttribute('title')||b.textContent||'').trim()===label));}
function snap(ctx){return new Promise(res=>{ctx.w.requestAnimationFrame(()=>{try{const u=ctx.cv.toDataURL('image/png');let h=2166136261;for(let i=0;i<u.length;i+=5){h^=u.charCodeAt(i);h=Math.imul(h,16777619);}
res({digest:((h>>>0).toString(16))+'/'+ctx.cv.width+'x'+ctx.cv.height+'/'+u.length,url:u});}catch(e){res({digest:'err:'+e.message,url:null});}});});}
async function freeze(ctx,modelId){
  for(let i=0;i<80&&(!ctx.store||!ctx.store.getState);i++) await sleep(500);
  for(let i=0;i<240;i++){const n=(ctx.store.getState().models||[]).filter(m=>m.localRoot||m.kind==='live2d').length; if(n>0) break; await sleep(500);}
  ctx.store.getState().setCurrentModel(null);
  ctx.store.getState().setCurrentModel(modelId);
  for(let i=0;i<40;i++){const m=ctx.store.getState().currentModel; if(m&&(m.animations||[]).length) break; await sleep(500);}
  await sleep(2500);
  const play=findBtn(ctx.d,'播放/暂停'); if(play) play.click();
  await sleep(700);
  const anims=(ctx.store.getState().currentModel&&ctx.store.getState().currentModel.animations)||[];
  if(anims.length) ctx.store.getState().setActiveAnimation(anims[0]);
  await sleep(1200);
  const reset=findBtn(ctx.d,'重置视图'); if(reset) reset.click();
  await sleep(900);
}
async function decode(url){const r=await fetch(url);const b=await r.blob();return await createImageBitmap(b);}
window.__run = async (modelId) => {
  const a=ctxOf('a'), b=ctxOf('b');
  await Promise.all([freeze(a,modelId),freeze(b,modelId)]);
  const sa=await snap(a), sb=await snap(b);
  log('产物摘要: '+sa.digest); log('基线摘要: '+sb.digest);
  const out={modelId,digestProduct:sa.digest,digestBaseline:sb.digest,diffPixels:null,diffGt2:null,maxDelta:null,note:''};
  if(!sa.url||!sb.url){out.note='toDataURL 失败（可能无 WebGL）';log(out.note);return out;}
  const [ia,ib]=await Promise.all([decode(sa.url),decode(sb.url)]);
  if(ia.width!==ib.width||ia.height!==ib.height){out.note='尺寸不一致 '+ia.width+'x'+ia.height+' vs '+ib.width+'x'+ib.height;log(out.note);return out;}
  const c1=document.createElement('canvas'),c2=document.createElement('canvas');
  c1.width=c2.width=ia.width;c1.height=c2.height=ia.height;
  const g1=c1.getContext('2d'),g2=c2.getContext('2d');
  g1.drawImage(ia,0,0);g2.drawImage(ib,0,0);
  const d1=g1.getImageData(0,0,c1.width,c1.height).data,d2=g2.getImageData(0,0,c2.width,c2.height).data;
  let diff=0,gt2=0,max=0;
  for(let i=0;i<d1.length;i+=4){
    const dd=Math.max(Math.abs(d1[i]-d2[i]),Math.abs(d1[i+1]-d2[i+1]),Math.abs(d1[i+2]-d2[i+2]));
    if(dd>0)diff++; if(dd>2)gt2++; if(dd>max)max=dd;
  }
  out.diffPixels=diff;out.diffGt2=gt2;out.maxDelta=max;out.pixels=c1.width*c1.height;
  log('尺寸: '+c1.width+'x'+c1.height+' 像素总数='+out.pixels);
  log('diffPixels='+diff+' diffGt2='+gt2+' maxDelta='+max);
  return out;
};
</script></body></html>`;

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

  const origText = readIf(ORIG);
  if (!origText) throw new Error(`读不到 ${ORIG}`);
  const distText = readIf(DIST);

  // ① 基线装配（剥 MOD）必须仍 ≡ 原文；基线 + 内联运行时必须 ≡ dist
  const base = assemble({ withMods: false });
  const baseSha = sha256(base.text);
  const baseRt = (await buildArtifactFromParts({ withMods: false, injectRuntimes: true })).text;
  const distSha = distText ? sha256(distText) : null;
  const baseRtSha = sha256(baseRt);

  // ② 产物装配（保留 MOD）
  const prod = assemble({ withMods: true });
  const prodSha = sha256(prod.text);
  const prodRt = (await buildArtifactFromParts({ withMods: true, injectRuntimes: true })).text;

  // MOD 清单
  const sliceFiles = ['src/engine.js', 'src/js/app/main-component.js', 'src/js/app/store-utils.js', 'src/js/vendor/react.js'];
  const mods = [];
  for (const rel of sliceFiles) {
    const t = readIf(path.join(ROOT, rel));
    if (!t) continue;
    for (const b of listMods(t)) mods.push({ file: rel, id: b.id, line: b.openLine });
  }

  console.log('== P4 产物构建 ==');
  console.log(`基线装配（剥 MOD）      ${base.text.length} chars  sha256=${baseSha}`);
  console.log(`基线 + 内联运行时        ${baseRt.length} chars  sha256=${baseRtSha}`);
  if (distSha) console.log(`dist/index.html         ${distText.length} chars  sha256=${distSha}  ${baseRtSha === distSha ? '✅ 与「基线 + 内联运行时」一致（逐字节）' : '❌ 不一致'}`);
  console.log(`产物装配（保留 MOD）    ${prod.text.length} chars  sha256=${prodSha}  （比基线多 ${prod.text.length - base.text.length} chars，含 MOD 标记与代码）`);
  console.log(`产物 + 内联运行时        ${prodRt.length} chars  sha256=${sha256(prodRt)}  （与 dist 不同属预期：P4 起首次有意改源码）`);
  console.log(`MOD 块：${mods.length} 处`);
  for (const m of mods) console.log(`  · ${m.file}:${m.line}  ${m.id}`);

  if (has('--verify-injection')) {
    if (!distText) {
      console.log('⚠️ 无 dist/index.html，跳过注入等价性比对');
    } else {
      const mine = injectLikeServer(distText);
      try {
        const res = await fetch('http://127.0.0.1:8803/');
        const theirs = await res.text();
        const same = mine === theirs;
        console.log(`${same ? '✅' : '❌'} 注入镜像 ≡ 8803 实测响应（${theirs.length} chars，sha256=${sha256(theirs)}）`);
        if (!same) {
          const n = Math.min(mine.length, theirs.length);
          let at = -1;
          for (let i = 0; i < n; i++) if (mine[i] !== theirs[i]) { at = i; break; }
          console.log(`    首个差异 @${at}\n    本实现: ${JSON.stringify(mine.slice(Math.max(0, at - 60), at + 60))}\n    8803  : ${JSON.stringify(theirs.slice(Math.max(0, at - 60), at + 60))}`);
        }
      } catch (e) {
        console.log(`⚠️ 无法访问 8803 做比对：${e.message}`);
      }
    }
  }

  const outArg = valueOf('--out');
  if (outArg) {
    const outPath = path.resolve(ROOT, outArg);
    if (outPath === path.resolve(DIST) || outPath.startsWith(path.resolve(ROOT, 'dist') + path.sep)) {
      console.error('❌ 拒绝写入 dist/（本次任务边界：不改 dist/baseline）');
      process.exit(2);
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, prodRt, 'utf8');
    console.log(`✅ 产物已写出：${outPath}（${prodRt.length} chars）`);
  }

  const harnessDir = valueOf('--harness-dir');
  if (harnessDir) {
    const dir = path.resolve(ROOT, harnessDir);
    if (dir.startsWith(path.resolve(ROOT, 'dist'))) {
      console.error('❌ 拒绝写入 dist/');
      process.exit(2);
    }
    fs.mkdirSync(dir, { recursive: true });
    // 产物页 / 基线页都用「注入镜像」处理（与 8803 同样的服务方式）
    fs.writeFileSync(path.join(dir, 'index.html'), injectLikeServer(prodRt), 'utf8');
    fs.writeFileSync(path.join(dir, 'prod.html'), injectLikeServer(base.text.replace('/*__SPINE_RUNTIME_SOURCES_PLACEHOLDER__*/', `${'window.__SPINE_RUNTIME_SOURCES__'} = ${JSON.stringify((await import('./resolve-runtimes.mjs')).resolveRuntimes().sources)};`)), 'utf8');
    fs.writeFileSync(path.join(dir, 'compare.html'), COMPARE_HTML, 'utf8');
    console.log(`✅ 校验台已写出：${dir}/{index.html,prod.html,compare.html}`);
    console.log(`   起服务：SPINE_DIST_DIR=${dir} node server.mjs 8899`);
  }

  // 退出码：基线与 dist 不一致才算失败（产物与基线不同是预期）
  process.exit(distSha && baseSha !== distSha ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}
