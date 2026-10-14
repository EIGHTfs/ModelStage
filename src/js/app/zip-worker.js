const bk=`
'use strict';

// ---- ZIP 工具 ----
function findEOCD(buffer) {
  const view = new DataView(buffer);
  const len = buffer.byteLength;
  const maxBack = Math.min(len - 22, 65536 + 22);
  for (let i = len - 22; i >= len - maxBack; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

function parseCentralDirectory(buffer, eocdOffset) {
  const view = new DataView(buffer);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const entries = [];
  let pos = cdOffset;
  const end = cdOffset + cdSize;
  while (pos < end) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const nameBytes = new Uint8Array(buffer, pos + 46, nameLen);
    const name = new TextDecoder('utf-8').decode(nameBytes);
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function getDataOffset(buffer, localHeaderOffset) {
  const view = new DataView(buffer);
  const nameLen = view.getUint16(localHeaderOffset + 26, true);
  const extraLen = view.getUint16(localHeaderOffset + 28, true);
  return localHeaderOffset + 30 + nameLen + extraLen;
}

async function inflateEntry(buffer, entry) {
  const dataOffset = getDataOffset(buffer, entry.localHeaderOffset);
  const compressed = new Uint8Array(buffer, dataOffset, entry.compressedSize);
  if (entry.method === 0) {
    // 未压缩，拷贝一份（避免持有原 zipBuffer 引用，因为 zipBuffer 是 transfer 的）
    const copy = new Uint8Array(entry.uncompressedSize);
    copy.set(compressed.subarray(0, entry.uncompressedSize));
    return copy.buffer;
  }
  if (entry.method === 8) {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(compressed);
    writer.close();
    const chunks = [];
    let totalLen = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLen += value.byteLength;
    }
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      result.set(new Uint8Array(c), offset);
      offset += c.byteLength;
    }
    return result.buffer;
  }
  throw new Error('不支持的压缩方式: method=' + entry.method);
}

// ---- 消息处理 ----
let zipBuffer = null;
let entries = [];  // 中央目录解析结果
let cancelled = false; // 取消标志

self.onmessage = async function(e) {
  const { type, payload } = e.data;

  if (type === 'cancel') {
    cancelled = true;
    self.postMessage({ type: 'cancelled' });
    return;
  }

  if (type === 'load-zip') {
    cancelled = false;
    // 只解析中央目录，不立刻解压
    zipBuffer = payload.zipBuffer;
    try {
      const eocdOffset = findEOCD(zipBuffer);
      if (eocdOffset < 0) {
        self.postMessage({ type: 'error', payload: '无效的 ZIP 文件（找不到 EOCD）' });
        return;
      }
      entries = parseCentralDirectory(zipBuffer, eocdOffset);
      const validEntries = entries.filter(e =>
        !e.name.endsWith('/') &&
        !e.name.includes('__MACOSX') &&
        !e.name.split('/').some(p => p.startsWith('.'))
      );
      self.postMessage({
        type: 'zip-loaded',
        payload: {
          totalEntries: validEntries.length,
          entryNames: validEntries.map(e => e.name),
          entrySizes: validEntries.map(e => e.uncompressedSize),
          entryMethods: validEntries.map(e => e.method),
        },
      });
    } catch (err) {
      self.postMessage({ type: 'error', payload: err.message || String(err) });
    }
  }

  if (type === 'extract-all') {
    cancelled = false;
    // 解压全部文件，逐个 postMessage 回去（带进度）
    // 注意：因为 zipBuffer 是 transfer 过来的，我们已经拥有它了
    const validEntries = entries.filter(e =>
      !e.name.endsWith('/') &&
      !e.name.includes('__MACOSX') &&
      !e.name.split('/').some(p => p.startsWith('.'))
    );
    const total = validEntries.length;
    const files = [];
    const transferBuffers = [];

    for (let i = 0; i < total; i++) {
      if (cancelled) {
        self.postMessage({ type: 'cancelled' });
        return;
      }
      const entry = validEntries[i];
      try {
        const content = await inflateEntry(zipBuffer, entry);
        const fileName = entry.name.split('/').pop() || entry.name;
        files.push({
          name: fileName,
          path: entry.name,
          size: entry.uncompressedSize,
          method: entry.method,
          content, // ArrayBuffer
        });
        transferBuffers.push(content);

        if (i % 5 === 0 || i === total - 1) {
          self.postMessage({
            type: 'progress',
            payload: { phase: 'unzipping', scanned: i + 1, total, found: 0,
              message: '解压中... ' + (i + 1) + '/' + total },
          });
        }
      } catch (err) {
        self.postMessage({
          type: 'progress',
          payload: { phase: 'unzipping', scanned: i + 1, total, found: 0,
            message: '解压中 (跳过1个失败)... ' + (i + 1) + '/' + total },
        });
      }
    }

    if (cancelled) {
      self.postMessage({ type: 'cancelled' });
      return;
    }

    // 一次性传回去（用 transfer 0 拷贝）
    self.postMessage({ type: 'extract-done', payload: { files } }, transferBuffers);
  }

  if (type === 'ping') {
    self.postMessage({ type: 'pong' });
  }
};
`;