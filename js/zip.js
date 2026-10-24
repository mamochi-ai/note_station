/* NOTE TRANSIT — ZIPリーダー
 * 中央ディレクトリだけを先に読み、各エントリは必要になった時に File.slice で順次展開する。
 * 画像を一括展開しない。サイズ・件数・圧縮率の上限を持つ。 */
(function (NT) {
  'use strict';
  const U = NT.util;

  const LIMITS = {
    maxEntries: 5000,
    maxXmlBytes: 64 * 1024 * 1024,      // XML 1ファイルの展開後上限
    maxXmlTotal: 160 * 1024 * 1024,     // XML 合計
    maxImageBytes: 25 * 1024 * 1024,    // 画像1枚の展開後上限
    maxRatio: 1000,                     // 圧縮率（展開後/圧縮）の上限
    chunk: 256 * 1024,
  };

  class ZipError extends Error { constructor(msg) { super(msg); this.name = 'ZipError'; } }

  async function readSlice(file, start, end) {
    const b = file.slice(start, end);
    if (b.arrayBuffer) return new Uint8Array(await b.arrayBuffer());
    return new Uint8Array(await new Response(b).arrayBuffer());
  }

  function decodeName(bytes, utf8Flag) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { /* fallthrough */ }
    if (!utf8Flag) { try { return new TextDecoder('shift_jis').decode(bytes); } catch (e) { /* ignore */ } }
    return new TextDecoder('utf-8').decode(bytes);
  }

  async function open(file, opts) {
    const lim = Object.assign({}, LIMITS, opts && opts.limits);
    const size = file.size;
    if (size < 22) throw new ZipError('ZIPファイルとして小さすぎます（壊れている可能性があります）');
    const tailLen = Math.min(size, 65536 + 22);
    const tail = await readSlice(file, size - tailLen, size);
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipError('ZIPの終端情報が見つかりません。ZIPファイルか、壊れていないか確認してください');
    const total = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOff = dv.getUint32(eocd + 16, true);
    if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new ZipError('ZIP64形式には未対応です');
    if (total > lim.maxEntries) throw new ZipError(`ZIP内のファイル数が上限（${lim.maxEntries}件）を超えています: ${total}件`);
    if (cdOff + cdSize > size) throw new ZipError('ZIPの中央ディレクトリが壊れています');
    const cd = await readSlice(file, cdOff, cdOff + cdSize);
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const entries = [];
    let p = 0;
    for (let n = 0; n < total; n++) {
      if (p + 46 > cd.length || cv.getUint32(p, true) !== 0x02014b50) throw new ZipError('ZIPのファイル一覧が壊れています');
      const flags = cv.getUint16(p + 8, true);
      const method = cv.getUint16(p + 10, true);
      const compSize = cv.getUint32(p + 20, true);
      const size2 = cv.getUint32(p + 24, true);
      const nameLen = cv.getUint16(p + 28, true);
      const extraLen = cv.getUint16(p + 30, true);
      const commentLen = cv.getUint16(p + 32, true);
      const localOff = cv.getUint32(p + 42, true);
      const name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), !!(flags & 0x800));
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue;
      if (/(^|\/)__MACOSX\//.test(name) || /(^|\/)\._/.test(name)) continue;
      entries.push({ name, method, flags, compSize, size: size2, localOff });
    }
    const byName = new Map(entries.map((e) => [e.name, e]));
    return { file, entries, byName, limits: lim, read: (e, o) => readEntry(file, e, lim, o) };
  }

  // エントリを展開して Uint8Array を返す。onProgress(0..1), signal(AbortSignal) に対応。
  async function readEntry(file, e, lim, o) {
    o = o || {};
    const max = o.maxBytes || lim.maxImageBytes;
    if (e.flags & 1) throw new ZipError(`暗号化されたファイルは読めません: ${e.name}`);
    if (e.size > max) throw new ZipError(`展開後サイズが上限を超えています: ${e.name}（${(e.size / 1048576).toFixed(1)}MB）`);
    if (e.compSize > 0 && e.size / e.compSize > lim.maxRatio) throw new ZipError(`圧縮率が異常です（ZIP爆弾の可能性）: ${e.name}`);
    const lh = await readSlice(file, e.localOff, e.localOff + 30);
    const lv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
    if (lh.length < 30 || lv.getUint32(0, true) !== 0x04034b50) throw new ZipError(`ZIP内のファイルヘッダが壊れています: ${e.name}`);
    const start = e.localOff + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
    const end = start + e.compSize;
    if (end > file.size) throw new ZipError(`ZIPが途中で切れています: ${e.name}`);
    if (e.method === 0) {
      if (e.compSize > max) throw new ZipError(`展開後サイズが上限を超えています: ${e.name}`);
      return await readSlice(file, start, end);
    }
    if (e.method !== 8) throw new ZipError(`未対応の圧縮方式です（${e.method}）: ${e.name}`);
    const chunks = [];
    let outLen = 0;
    let err = null;
    const inf = new fflate.Inflate((chunk) => {
      outLen += chunk.length;
      if (outLen > max) { err = new ZipError(`展開後サイズが上限を超えました: ${e.name}`); return; }
      chunks.push(chunk);
    });
    for (let off = start; off < end; off += lim.chunk) {
      if (o.signal && o.signal.aborted) throw new U.CancelError();
      const piece = await readSlice(file, off, Math.min(end, off + lim.chunk));
      try { inf.push(piece, off + lim.chunk >= end); } catch (ex) { throw new ZipError(`展開に失敗しました（ZIPが壊れている可能性）: ${e.name}`); }
      if (err) throw err;
      if (o.onProgress) o.onProgress(Math.min(1, (off + lim.chunk - start) / Math.max(1, e.compSize)));
      if (o.yield) await U.sleep(0);
    }
    const out = new Uint8Array(outLen);
    let q = 0;
    for (const c of chunks) { out.set(c, q); q += c.length; }
    return out;
  }

  NT.zip = { open, LIMITS, ZipError };
})(globalThis.NT = globalThis.NT || {});
