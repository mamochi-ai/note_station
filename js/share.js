/* NOTE TRANSIT — URL共有（フラグメント #map=v1.<deflate+base64url>）
 * 含めるもの：駅名・原題・元記事URL・日付（任意）・路線・駅順・配置・seed・共有設定。
 * 含めないもの：本文・抜粋・下書き・画像・添付・原本ZIP。圧縮は暗号化ではない。 */
(function (NT) {
  'use strict';
  const U = NT.util;
  const PREFIX = 'map=v1.';
  const LIM = { chars: 400000, bytes: 2 * 1024 * 1024, stations: 3000, lines: 60, links: 200 };
  const COLOR = /^#[0-9a-f]{6}$/i;

  function commonPrefix(urls) {
    const cnt = new Map();
    for (const u of urls) {
      const m = u && u.match(/^(https:\/\/[^/]+\/[^/]+\/n\/)/);
      if (m) cnt.set(m[1], (cnt.get(m[1]) || 0) + 1);
    }
    let best = '', bc = 1;
    for (const [p, c] of cnt) if (c > bc) { best = p; bc = c; }
    return best;
  }
  const packUrl = (u, pre) => (!u ? '' : pre && u.startsWith(pre) ? '~' + u.slice(pre.length) : u);
  const unpackUrl = (u, pre) => (!u ? '' : u[0] === '~' ? pre + u.slice(1) : u);

  /* view: { title, mode, seed, lines:[{name,color,order:[sid]}], stations:[{id,short,title,url,date,x,y,main}], links:[{a,b,term}] }
   * opts: { dates:true, analysis:false } */
  function payload(view, opts) {
    opts = opts || {};
    const idx = new Map(view.stations.map((s, i) => [s.id, i]));
    const pre = commonPrefix(view.stations.map((s) => s.url));
    const lineIdx = new Map(view.lines.map((L, i) => [L.id, i]));
    const q = (v) => Math.round(v * 100) / 100;
    return {
      v: 1,
      t: String(view.title || '').slice(0, 100),
      m: view.mode === 'time' && !opts.dates ? 'topic' : view.mode,
      s: view.seed | 0,
      u: pre,
      o: { d: opts.dates ? 1 : 0, a: opts.analysis ? 1 : 0 },
      L: view.lines.map((L) => [String(L.name).slice(0, 40), L.color, L.order.filter((id) => idx.has(id)).map((id) => idx.get(id))]),
      S: view.stations.map((s) => [
        String(s.short || '').slice(0, 60), String(s.title || '').slice(0, 300), packUrl(s.url, pre),
        opts.dates && s.date ? U.dayNumber(s.date) : null, q(s.x), q(s.y), s.main && lineIdx.has(s.main) ? lineIdx.get(s.main) : -1,
      ]),
      K: (view.links || []).filter((k) => idx.has(k.a) && idx.has(k.b)).map((k) => (k.term ? [idx.get(k.a), idx.get(k.b), k.term] : [idx.get(k.a), idx.get(k.b)])),
    };
  }

  function encode(view, opts) {
    const p = payload(view, opts);
    const json = JSON.stringify(p);
    const bytes = new TextEncoder().encode(json);
    const z = fflate.deflateSync(bytes, { level: 9 });
    return { fragment: PREFIX + U.b64uEncode(z), payload: p, jsonBytes: bytes.length };
  }

  function buildUrl(base, fragment) {
    const b = String(base || '').split('#')[0];
    return b + '#' + fragment;
  }

  class ShareError extends Error { constructor(m) { super(m); this.name = 'ShareError'; } }

  function inflateLimited(z) {
    const chunks = []; let n = 0; let over = false;
    const inf = new fflate.Inflate((c) => { n += c.length; if (n > LIM.bytes) { over = true; return; } chunks.push(c); });
    try { inf.push(z, true); } catch (e) { throw new ShareError('リンクのデータが壊れています（展開できません）'); }
    if (over) throw new ShareError('リンクのデータが大きすぎます');
    const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  /* フラグメント文字列（# 以降）→ 検証済み view */
  function decode(hash) {
    let h = String(hash || '').replace(/^#/, '');
    if (!h.startsWith('map=')) throw new ShareError('共有データがありません');
    if (!h.startsWith(PREFIX)) throw new ShareError('このリンクの形式（バージョン）には対応していません');
    h = h.slice(PREFIX.length);
    if (h.length > LIM.chars) throw new ShareError('リンクが長すぎます');
    let z;
    try { z = U.b64uDecode(h); } catch (e) { throw new ShareError('リンクが途中で切れているか、文字が壊れています'); }
    const bytes = inflateLimited(z);
    let p;
    try { p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch (e) { throw new ShareError('リンクのデータを読み取れません'); }
    return validate(p);
  }

  const isStr = (v, max) => typeof v === 'string' && v.length <= max;
  const isNum = (v) => typeof v === 'number' && isFinite(v) && Math.abs(v) < 100000;
  const isInt = (v) => Number.isInteger(v);

  function validate(p) {
    const bad = (m) => { throw new ShareError('共有データが不正です：' + m); };
    if (!p || typeof p !== 'object' || Array.isArray(p)) bad('形式');
    if (p.v !== 1) bad('schema version');
    if (!isStr(p.t, 100)) bad('タイトル');
    if (!['topic', 'time', 'surprise'].includes(p.m)) bad('モード');
    if (!isInt(p.s)) bad('seed');
    if (!isStr(p.u, 300)) bad('URL接頭辞');
    if (p.u && !U.safeUrl(p.u)) bad('URL接頭辞');
    if (!p.o || typeof p.o !== 'object') bad('共有設定');
    if (!Array.isArray(p.L) || p.L.length > LIM.lines) bad('路線の件数');
    if (!Array.isArray(p.S) || p.S.length < 1 || p.S.length > LIM.stations) bad('駅の件数');
    if (!Array.isArray(p.K) || p.K.length > LIM.links) bad('接点の件数');
    const n = p.S.length;
    const stations = p.S.map((s, i) => {
      if (!Array.isArray(s) || s.length !== 7) bad(`駅${i + 1}`);
      const [short, title, url, day, x, y, main] = s;
      if (!isStr(short, 60) || !isStr(title, 300) || !isStr(url, 2100)) bad(`駅${i + 1}の文字列`);
      if (!(day === null || (isInt(day) && day > 7000 && day < 50000))) bad(`駅${i + 1}の日付`);
      if (!isNum(x) || !isNum(y)) bad(`駅${i + 1}の位置`);
      if (!isInt(main) || main < -1 || main >= p.L.length) bad(`駅${i + 1}の路線`);
      const full = unpackUrl(url, p.u);
      const safe = full ? U.safeUrl(full) : null;
      if (full && !safe) bad(`駅${i + 1}のURL`);
      return { id: 's' + i, short, title, url: safe, date: day === null ? null : U.fromDayNumber(day), x, y, mainIdx: main };
    });
    const lines = p.L.map((L, i) => {
      if (!Array.isArray(L) || L.length !== 3) bad(`路線${i + 1}`);
      const [name, color, order] = L;
      if (!isStr(name, 40) || !COLOR.test(color) || !Array.isArray(order) || order.length > n) bad(`路線${i + 1}`);
      if (!order.every((k) => isInt(k) && k >= 0 && k < n)) bad(`路線${i + 1}の駅順`);
      return { id: 'L' + i, name, color, order: order.map((k) => 's' + k) };
    });
    stations.forEach((s) => { s.main = s.mainIdx >= 0 ? 'L' + s.mainIdx : null; delete s.mainIdx; });
    const links = p.K.map((k, i) => {
      if (!Array.isArray(k) || k.length < 2 || k.length > 3 || !isInt(k[0]) || !isInt(k[1]) || k[0] < 0 || k[1] < 0 || k[0] >= n || k[1] >= n) bad(`接点${i + 1}`);
      if (k.length === 3 && !isStr(k[2], 40)) bad(`接点${i + 1}`);
      return { a: 's' + k[0], b: 's' + k[1], term: k[2] || '' };
    });
    return { title: p.t, mode: p.m, seed: p.s, lines, stations, links, opts: { dates: !!p.o.d, analysis: !!p.o.a } };
  }

  NT.share = { encode, decode, buildUrl, payload, validate, ShareError, PREFIX, commonPrefix, packUrl, unpackUrl };
})(globalThis.NT = globalThis.NT || {});
