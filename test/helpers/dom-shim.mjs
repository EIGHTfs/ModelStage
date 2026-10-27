// test/helpers/dom-shim.mjs —— 静态套件用的最小 DOM 垫片
//
// 为什么需要它：Live2D 的覆盖层生命周期（buildOverlay / release）是"DOM 关系"正确性问题，
//   用真浏览器验代价高（一次几秒 + 需要服务 + 需要共享标签页），而它的核心不变量
//   （容器里有没有 canvas、容器在不在文档里）完全可以用几十行假 DOM 精确断言。
//
// 只实现被测代码真正用到的那几个 API：createElement / getElementById / appendChild /
//   removeChild / contains / querySelector / isConnected / style / parentElement。
// 不追求规范完备：遇到没实现的用法会直接抛错（宁可红，也不要静默放行）。

class ShimNode {
  constructor(tagName, doc) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentElement = null;
    this.id = '';
    this.style = {};
    this._attrs = new Map();
  }

  get isConnected() {
    let n = this;
    while (n.parentElement) n = n.parentElement;
    return !!(n && n.ownerDocument && n.ownerDocument.__roots && n.ownerDocument.__roots.includes(n));
  }

  appendChild(child) {
    if (!child) throw new Error('appendChild: child 不能为空');
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i < 0) throw new Error(`removeChild: 不是子节点（${child && child.tagName}）`);
    this.children.splice(i, 1);
    child.parentElement = null;
    return child;
  }

  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }

  setAttribute(name, value) { this._attrs.set(String(name), String(value)); }

  getAttribute(name) { return this._attrs.has(String(name)) ? this._attrs.get(String(name)) : null; }

  /** 只支持 '#id' / 'tagName' / 'tag#id' 三种选择器（够覆盖层用） */
  querySelector(sel) {
    const text = String(sel || '').trim();
    let tag = null;
    let id = null;
    if (text.startsWith('#')) id = text.slice(1);
    else if (text.includes('#')) { const [t, i] = text.split('#'); tag = t.toUpperCase(); id = i; }
    else tag = text.toUpperCase();
    const match = (n) => {
      if (id !== null && n.id !== id) return false;
      if (tag && n.tagName !== tag) return false;
      return true;
    };
    const walk = (n) => {
      for (const c of n.children) {
        if (match(c)) return c;
        const deep = walk(c);
        if (deep) return deep;
      }
      return null;
    };
    return walk(this);
  }
}

/**
 * 安装全局 document（幂等：重复调用返回同一个）。
 * @returns {{document: object, reset: Function}} reset 清空根节点（每个用例之间用）
 */
export function installDomShim() {
  const doc = {
    __roots: [],
    createElement(tag) { return new ShimNode(tag, doc); },
    getElementById(id) {
      const want = String(id || '');
      const walk = (n) => {
        for (const c of n.children) {
          if (c.id === want) return c;
          const deep = walk(c);
          if (deep) return deep;
        }
        return null;
      };
      for (const root of doc.__roots) {
        if (root.id === want) return root;
        const hit = walk(root);
        if (hit) return hit;
      }
      return null;
    },
  };
  const mkRoot = (id) => {
    const n = new ShimNode('div', doc);
    n.id = id;
    doc.__roots.push(n);
    return n;
  };
  doc.body = mkRoot('body');
  doc.head = mkRoot('head');
  doc.documentElement = mkRoot('html');
  const reset = () => {
    for (const r of doc.__roots.slice()) {
      if (r.id === 'body' || r.id === 'head' || r.id === 'html') { r.children = []; continue; }
      doc.__roots.splice(doc.__roots.indexOf(r), 1);
    }
  };
  globalThis.document = doc;
  // window 也要给：浏览器里 window === globalThis，但 node 没有它。
  //   src/web/app/context.js 在**模块顶层**就写 `window.__WEB__ = window.__WEB__ || {}`
  //   （那是刻意的：boot 早期就要有状态日志落盘口），缺 window 会让该模块 import 期直接
  //   ReferenceError —— 表现为 renderer-contract 这条测试长期失败，而产品本身没问题。
  //   所以按浏览器语义把 window 指向 globalThis，而不是改产品代码去迁就测试。
  globalThis.window = globalThis;
  return { document: doc, reset };
}
