// ============================================================================
// plugins/unity-live2d-bundle/lib/bytes.js —— 二进制读取原语
//
// 职责：在 ArrayBuffer/Uint8Array 上做**小端**定长读取、变长字符串、对齐、hex/sha256。
//   Unity 的资源文件一律小端（本插件暂不支持大端序列化文件，遇到就抛可读错误）。
//
// 设计要点：
//   · 只用 DataView + Uint8Array（浏览器与 Node 都有），零依赖。
//   · 位置（pos）显式可读写：容器格式里有大量「先跳到某处再读」的写法。
//   · 64 位整数统一用 Number 返回 —— 本插件只处理「文件内偏移/长度」这类远小于 2^53 的值；
//    读到的值超出安全整数范围时抛可读错误，避免静默精度丢失。
//   · sha256 分两种实现：有 WebCrypto 用 crypto.subtle（浏览器/https），否则用宿主注入的实现
//     （Node 侧自检脚本会注入 node:crypto）。二者都不可用时返回 null，由调用方决定是否算校验失败。
//
// 挂载：globalThis.__ULB__ = { bytes: {...} }（浏览器与 Node 自检脚本都走同一入口）
// ============================================================================

'use strict';

{
  const root = globalThis;   // 原 IIFE 的 root 引用（脚本级裸块内保持同名）
  const NS = (root.__ULB__ = root.__ULB__ || {});

  const HEX = '0123456789abcdef';

  // CRC32（多项式 0xEDB88320，初值/末值取反）——与 zlib.crc32 一致。
  // 用途：Unity 的动画绑定把「属性路径」存成 32 位哈希，本插件用 CRC32 反查名字
  //   （实测 crc32('Value') = 3702945584，正是本样本所有绑定的 attribute 值）。
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  /** 字符串（UTF-8）的 CRC32，返回无符号 32 位整数 */
  function crc32(str) {
    const u8 = new TextEncoder().encode(str);
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** 字节数组 → 十六进制小写串 */
  function toHex(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += HEX[u8[i] >> 4] + HEX[u8[i] & 15];
    return s;
  }

  function concatBytes(list) {
    let total = 0;
    for (const b of list) total += b.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of list) { out.set(b, off); off += b.length; }
    return out;
  }

  /** 用 latin1 解码一段字节（用于比较 ASCII 魔数，不受 UTF-8 影响） */
  function latin1(u8, from, to) {
    let s = '';
    const end = to === undefined ? u8.length : Math.min(to, u8.length);
    for (let i = from; i < end; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  /**
   * 字节读取器。
   * @param {ArrayBuffer|Uint8Array} buf 数据
   * @param {object} [opts]
   *   pos        起始位置（相对 buf）
   *   baseOffset 把「相对 buf 的偏移」换算成「相对整个文件的偏移」（缓冲区是切片时用）
   *   endian     '>' 大端 / '<' 小端（默认 '<'）。
   *              注意：**同一个文件里可能两种字节序都有** —— UnityFS 容器头与 blocksInfo 表是
   *              大端，而容器里内嵌的 SerializedFile 的字节序由它自己的头字节决定（通常小端）。
   *              所以字节序是「读取器实例」的属性，不写成全局常量。
   */
  class Reader {
    constructor(buf, opts) {
      const o = opts || {};
      this.raw = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      this.view = new DataView(this.raw.buffer, this.raw.byteOffset, this.raw.byteLength);
      this.pos = o.pos || 0;
      this.baseOffset = o.baseOffset || 0;
      this.le = o.endian !== '>';
      this.length = this.raw.byteLength;
    }

    /** 相对整个文件的绝对偏移 */
    get absOffset() { return this.baseOffset + this.pos; }
    get remaining() { return this.length - this.pos; }
    eof() { return this.pos >= this.length; }

    need(n, what) {
      if (this.pos + n > this.length) {
        throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `读取越界：需要 ${n} 字节（${what || '未命名字段'}），剩余 ${this.remaining}`);
      }
    }

    seek(pos) { this.pos = pos; return this; }
    skip(n) { this.pos += n; return this; }
    align(n) { const r = this.pos % n; if (r !== 0) this.pos += n - r; return this; }

    u8() { this.need(1, 'u8'); return this.view.getUint8(this.pos++); }
    i8() { this.need(1, 'i8'); return this.view.getInt8(this.pos++); }
    bool() { return this.u8() !== 0; }
    u16() { this.need(2, 'u16'); const v = this.view.getUint16(this.pos, this.le); this.pos += 2; return v; }
    i16() { this.need(2, 'i16'); const v = this.view.getInt16(this.pos, this.le); this.pos += 2; return v; }
    u32() { this.need(4, 'u32'); const v = this.view.getUint32(this.pos, this.le); this.pos += 4; return v; }
    i32() { this.need(4, 'i32'); const v = this.view.getInt32(this.pos, this.le); this.pos += 4; return v; }
    f32() { this.need(4, 'f32'); const v = this.view.getFloat32(this.pos, this.le); this.pos += 4; return v; }
    f64() { this.need(8, 'f64'); const v = this.view.getFloat64(this.pos, this.le); this.pos += 8; return v; }

    /** 64 位整数（返回 Number；超出安全整数范围抛错，避免静默丢精度） */
    i64(what) {
      this.need(8, 'i64');
      const v = this.view.getBigInt64(this.pos, this.le);
      this.pos += 8;
      const n = Number(v);
      if (Math.abs(n) > Number.MAX_SAFE_INTEGER) {
        throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `64 位整数超出安全范围（${what || ''}）：${v.toString()}，本插件按 Number 处理会丢精度`);
      }
      return n;
    }

    /** 64 位整数（返回 BIGINT，不做范围检查；适合 pathID 这类会超过 2^53 的标识） */
    i64b(what) {
      this.need(8, 'i64');
      const v = this.view.getBigInt64(this.pos, this.le);
      this.pos += 8;
      void what;
      return v;
    }

    u64(what) { return this.i64(what); }

    bytes(n, what) {
      this.need(n, what || 'bytes');
      const out = this.raw.subarray(this.pos, this.pos + n);
      this.pos += n;
      return out;
    }

    /** 以 NUL 结尾的字符串（Unity 的 string-to-null，UTF-8 解码） */
    cstring(what) {
      const start = this.pos;
      while (this.pos < this.length && this.raw[this.pos] !== 0) this.pos++;
      if (this.pos >= this.length) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `字符串缺少结尾 NUL（${what || ''}）`);
      const raw = this.raw.subarray(start, this.pos);
      this.pos++;   // 跳过 NUL
      return new TextDecoder('utf-8').decode(raw);
    }

    /** Unity 的长度前缀字符串：i32 长度 + UTF-8 字节 + 4 字节对齐 */
    string(what) {
      const len = this.i32();
      if (len === 0) { this.align(4); return ''; }
      if (len < 0 || len > this.remaining) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `字符串长度非法（${what || ''}）：${len}`);
      const raw = this.bytes(len, what);
      this.align(4);
      return new TextDecoder('utf-8').decode(raw);
    }
  }

  /**
   * 可注入的 sha256 实现：Node 自检脚本启动时调用 setSha256() 注入 node:crypto 版本；
   * 浏览器里若存在 crypto.subtle 则用内置实现；都没有时返回 null。
   */
  let sha256Impl = null;
  function setSha256(fn) { sha256Impl = fn; }

  async function sha256Hex(u8) {
    if (sha256Impl) return sha256Impl(u8);
    const subtle = root.crypto && root.crypto.subtle;
    if (subtle && subtle.digest) {
      const buf = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
        ? u8.buffer : u8.slice().buffer;
      const d = await subtle.digest('SHA-256', buf);
      return toHex(new Uint8Array(d));
    }
    return null;
  }

  NS.bytes = { Reader, toHex, concatBytes, latin1, sha256Hex, setSha256, crc32 };
}
