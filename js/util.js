/* NOTE TRANSIT — 共通ユーティリティ */
(function (NT) {
  'use strict';
  const U = {};

  U.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  // 決定的な乱数（mulberry32）
  U.rng = function (seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  U.hash = function (s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  };

  U.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  U.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  U.uid = (p) => (p || 'id') + Math.random().toString(36).slice(2, 9);
  U.clone = (o) => JSON.parse(JSON.stringify(o));

  // https のみ許可。javascript: data: などは拒否。資格情報付きURLも拒否。
  U.safeUrl = function (raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s || s.length > 2048) return null;
    let u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    if (!u.hostname || !/^[a-z0-9.-]+$/i.test(u.hostname) || u.hostname.indexOf('.') < 0) return null;
    return u.href;
  };

  U.isNoteHost = function (url) {
    try { const h = new URL(url).hostname; return h === 'note.com' || h.endsWith('.note.com'); } catch (e) { return false; }
  };

  // "2026-09-19 12:00:16" → Date（端末のローカル時刻として解釈しない。日付は表示用に文字列で保持）
  U.parseWpDate = function (s) {
    if (!s || typeof s !== 'string') return null;
    const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    if (y === 0) return null;
    const iso = `${m[1]}-${m[2]}-${m[3]}` + (m[4] ? `T${m[4]}:${m[5]}:${m[6] || '00'}` : 'T00:00:00');
    return iso;
  };
  U.dayNumber = function (iso) { // 1970-01-01 からの日数
    if (!iso) return null;
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
  };
  U.fromDayNumber = function (n) {
    if (n == null) return null;
    const d = new Date(n * 86400000);
    return d.toISOString().slice(0, 10) + 'T00:00:00';
  };
  U.fmtDate = function (iso) {
    if (!iso) return '日付不明';
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${+m[1]}年${+m[2]}月${+m[3]}日` : '日付不明';
  };
  U.monthKey = (iso) => (iso ? iso.slice(0, 7) : null);
  U.fmtMonth = function (k) { if (!k) return '日付不明'; const [y, m] = k.split('-'); return `${+y}年${+m}月`; };

  // base64url
  U.b64uEncode = function (bytes) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  U.b64uDecode = function (str) {
    if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('base64urlとして不正な文字があります');
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  // 文字幅の実測（canvas）。SVG と同じフォント指定を使う。
  const FONT = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic",Meiryo,system-ui,sans-serif';
  U.FONT = FONT;
  let ctx = null;
  const cache = new Map();
  U.measure = function (text, size, weight) {
    const key = (weight || 400) + '|' + size + '|' + text;
    if (cache.has(key)) return cache.get(key);
    let w;
    try {
      if (!ctx && typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d');
      ctx.font = `${weight || 400} ${size}px ${FONT}`;
      w = ctx.measureText(text).width;
    } catch (e) {
      w = 0;
      for (const ch of text) w += ch.charCodeAt(0) > 0xff ? size : size * 0.6;
    }
    if (cache.size > 5000) cache.clear();
    cache.set(key, w);
    return w;
  };

  U.download = function (blob, filename) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  U.CancelError = class extends Error { constructor() { super('キャンセルしました'); this.name = 'CancelError'; } };

  NT.util = U;
})(globalThis.NT = globalThis.NT || {});
