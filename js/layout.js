/* NOTE TRANSIT — 路線図レイアウト
 * 座標はグリッド単位（x=列, y=段）。描画時に px へ変換。
 * 線は 水平・垂直・45度 の折れ線を丸い角でつなぐ。乗換は同一記事の単一駅。交差点には駅を置かない。 */
(function (NT) {
  'use strict';
  const U = NT.util;

  const FS = 14;          // 駅名フォントサイズ
  const H = 150;          // 段の間隔(px)

  /* ---------- 話題モード ---------- */
  // lines: [{id, order:[sid]}], st: Map sid→{main, sub}
  function rowsFor(lines, st) {
    if (!lines.length) return new Map();
    const share = (A, B) => A.order.filter((id) => B.order.includes(id)).length;
    const rest = lines.slice().sort((a, b) => b.order.length - a.order.length || (a.id < b.id ? -1 : 1));
    const seq = [rest.shift()];
    while (rest.length) {
      let best = 0, bs = -1, partner = 0;
      rest.forEach((L, i) => {
        seq.forEach((P, j) => { const s = share(L, P) * 100 + L.order.length; if (s > bs) { bs = s; best = i; partner = j; } });
      });
      const L = rest.splice(best, 1)[0];
      // 相手の直後か直前のうち、端に近い方へ
      const pos = partner >= seq.length / 2 ? partner + 1 : partner;
      seq.splice(pos, 0, L);
    }
    return new Map(seq.map((L, i) => [L.id, i]));
  }

  // 列＝路線の駅順の最長路（DAG）。循環（手動並べ替え由来）は後ろに回す
  function columns(lines, ids) {
    const succ = new Map(ids.map((id) => [id, new Set()]));
    const indeg = new Map(ids.map((id) => [id, 0]));
    for (const L of lines) for (let i = 1; i < L.order.length; i++) {
      const a = L.order[i - 1], b = L.order[i];
      if (!succ.has(a) || !succ.has(b) || succ.get(a).has(b)) continue;
      succ.get(a).add(b); indeg.set(b, indeg.get(b) + 1);
    }
    const col = new Map();
    const q = ids.filter((id) => indeg.get(id) === 0);
    q.forEach((id) => col.set(id, 0));
    let qi = 0;
    while (qi < q.length) {
      const a = q[qi++];
      for (const b of succ.get(a)) {
        col.set(b, Math.max(col.get(b) || 0, col.get(a) + 1));
        indeg.set(b, indeg.get(b) - 1);
        if (indeg.get(b) === 0) q.push(b);
      }
    }
    let mx = Math.max(0, ...[...col.values()]);
    for (const id of ids) if (!col.has(id)) col.set(id, ++mx);
    return col;
  }

  /* 話題レイアウト：各駅の {x,y}（グリッド）と路線の段を返す */
  function topic(model) {
    const { lines, stations } = model;
    const rows = rowsFor(lines, stations);
    const onLine = [...stations.values()].filter((s) => s.main).map((s) => s.id);
    const col = columns(lines, onLine);
    const pos = new Map();
    for (const id of onLine) {
      const s = stations.get(id);
      pos.set(id, { x: col.get(id), y: rows.get(s.main) || 0 });
    }
    // ひとり駅：路線の下にまとめて置く
    const iso = [...stations.values()].filter((s) => !s.main).sort((a, b) => (a.date || '9').localeCompare(b.date || '9'));
    const maxCol = Math.max(3, ...[...col.values()].map((v) => v + 1));
    const per = U.clamp(Math.ceil(Math.sqrt(iso.length * 2.5)), 3, Math.max(3, maxCol));
    const baseY = lines.length ? lines.length + 0.15 : 0;
    iso.forEach((s, i) => pos.set(s.id, { x: (i % per) * 1.1, y: baseY + Math.floor(i / per) * 0.85 }));
    return { pos, rows };
  }

  /* ---------- 時間モード：投稿順の一本道（蛇行） ---------- */
  function time(model) {
    const st = [...model.stations.values()].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.id < b.id ? -1 : 1));
    const n = st.length;
    const per = U.clamp(Math.ceil(Math.sqrt(n * 2.2)), 4, 14);
    const pos = new Map();
    st.forEach((s, i) => {
      const r = Math.floor(i / per), c = i % per;
      pos.set(s.id, { x: r % 2 ? per - 1 - c : c, y: r * 0.9 });
    });
    return { pos, order: st.map((s) => s.id), per };
  }

  /* ---------- 経路 ---------- */
  // P→Q をクルーズ高さ yc を経由して 水平/45度/垂直 でつなぐ（px座標）
  function jog(P, Q, yc, off) {
    const dx = Q.x - P.x;
    if (dx <= 1) return [Q];
    if (Math.abs(P.y - Q.y) < 0.5 && Math.abs(P.y - yc) < 0.5) return [Q];
    const pts = [];
    const dP = yc - P.y, dQ = yc - Q.y;
    const lim = dx * 0.42;
    const aP = Math.min(Math.abs(dP), lim) * Math.sign(dP);
    const aQ = Math.min(Math.abs(dQ), lim) * Math.sign(dQ);
    const o = off || 0;
    if (dP) {
      pts.push({ x: P.x + Math.abs(aP) + (Math.abs(dP) > Math.abs(aP) ? o : 0), y: P.y + aP });
      if (Math.abs(dP) > Math.abs(aP)) pts.push({ x: P.x + Math.abs(aP) + o, y: yc });
    }
    if (dQ) {
      if (Math.abs(dQ) > Math.abs(aQ)) pts.push({ x: Q.x - Math.abs(aQ) - o, y: yc });
      pts.push({ x: Q.x - Math.abs(aQ) - (Math.abs(dQ) > Math.abs(aQ) ? o : 0), y: Q.y + aQ });
    }
    pts.push(Q);
    return pts;
  }
  // 垂直区間が45度ジョグ点と重なるときの補正：jogの前後で x が戻らないよう単調化
  function monotone(pts) {
    for (let i = 1; i < pts.length - 1; i++) if (pts[i].x < pts[i - 1].x) pts[i] = { x: pts[i - 1].x, y: pts[i].y };
    return pts;
  }

  function roundedPath(pts, r) {
    if (!pts.length) return '';
    const f = (v) => Math.round(v * 10) / 10;
    let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      if (i < pts.length - 1) {
        const a = pts[i - 1], b = pts[i + 1];
        const l1 = Math.hypot(p.x - a.x, p.y - a.y), l2 = Math.hypot(b.x - p.x, b.y - p.y);
        const rr = Math.min(r, l1 / 2, l2 / 2);
        if (rr > 0.5 && l1 > 0 && l2 > 0) {
          const s = { x: p.x - (p.x - a.x) * rr / l1, y: p.y - (p.y - a.y) * rr / l1 };
          const e = { x: p.x + (b.x - p.x) * rr / l2, y: p.y + (b.y - p.y) * rr / l2 };
          d += ` L${f(s.x)} ${f(s.y)} Q${f(p.x)} ${f(p.y)} ${f(e.x)} ${f(e.y)}`;
          continue;
        }
      }
      d += ` L${f(p.x)} ${f(p.y)}`;
    }
    return d;
  }

  function dedupe(pts) {
    const out = [];
    for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.abs(q.x - p.x) > 0.2 || Math.abs(q.y - p.y) > 0.2) out.push(p); }
    // 一直線上の中間点を除く
    for (let i = out.length - 2; i > 0; i--) {
      const a = out[i - 1], b = out[i], c = out[i + 1];
      if (Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) < 0.5) out.splice(i, 1);
    }
    return out;
  }

  /* ---------- 文字配置 ---------- */
  function segRect(a, b, r) { // 線分と矩形の交差（Liang–Barsky）
    let t0 = 0, t1 = 1;
    const dx = b.x - a.x, dy = b.y - a.y;
    const p = [-dx, dx, -dy, dy], q = [a.x - r.x, r.x + r.w - a.x, a.y - r.y, r.y + r.h - a.y];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return false; continue; }
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
    return true;
  }
  const ov = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

  function placeLabels(items, segs, circles) {
    // items: [{id, x, y, r, text, pri}]
    const placed = [];
    const out = new Map();
    const order = items.slice().sort((a, b) => a.pri - b.pri || a.x - b.x);
    for (const it of order) {
      const w = U.measure(it.text, FS, 600) + 4, h = FS + 4;
      const g = it.r + 5;
      const C = [
        ['s', it.x - w / 2, it.y + g, 0], ['n', it.x - w / 2, it.y - g - h, 0.05],
        ['se', it.x + g * 0.6, it.y + g * 0.6, 0.25], ['ne', it.x + g * 0.6, it.y - g * 0.6 - h, 0.25],
        ['sw', it.x - g * 0.6 - w, it.y + g * 0.6, 0.3], ['nw', it.x - g * 0.6 - w, it.y - g * 0.6 - h, 0.3],
        ['e', it.x + g + 2, it.y - h / 2, 0.4], ['w', it.x - g - 2 - w, it.y - h / 2, 0.45],
        ['s2', it.x - w / 2, it.y + g + h + 4, 0.9], ['n2', it.x - w / 2, it.y - g - 2 * h - 4, 0.9],
      ];
      let best = null;
      for (const [k, x, y, pen] of C) {
        const r = { x, y, w, h };
        let cost = pen;
        for (const p of placed) { const o = ov(r, p); if (o) cost += 3 + o / 40; }
        for (const c of circles) { if (c.id === it.id) continue; const o = ov(r, { x: c.x - c.r - 2, y: c.y - c.r - 2, w: 2 * c.r + 4, h: 2 * c.r + 4 }); if (o) cost += 4; }
        for (const s of segs) if (segRect(s.a, s.b, r)) cost += 1.2;
        if (!best || cost < best.cost) best = { k, r, cost };
        if (cost === 0) break;
      }
      placed.push(best.r);
      out.set(it.id, { x: best.r.x + 2, y: best.r.y + FS, w: best.r.w, h: best.r.h, anchor: 'start', k: best.k, cost: best.cost });
    }
    return out;
  }

  /* ---------- 装飾の配置（空き領域・タッチを奪わない） ---------- */
  const DECOR = { trees: [280, 209], town: [280, 184], bridge: [280, 235], station: [280, 223], clouds: [280, 210], train: [280, 220] };
  function placeDecor(bounds, boxes, segs, seed) {
    const cell = 40;
    const pad = 170;
    const bx = bounds.x - pad, by = bounds.y - pad, bw = bounds.w + pad * 2, bh = bounds.h + pad * 2;
    const cols = Math.ceil(bw / cell), rows = Math.ceil(bh / cell);
    if (cols * rows > 400000) return [];
    const occ = new Uint8Array(cols * rows);
    const mark = (x, y, w, h) => {
      const c0 = Math.max(0, Math.floor((x - bx) / cell)), c1 = Math.min(cols - 1, Math.floor((x + w - bx) / cell));
      const r0 = Math.max(0, Math.floor((y - by) / cell)), r1 = Math.min(rows - 1, Math.floor((y + h - by) / cell));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) occ[r * cols + c] = 1;
    };
    boxes.forEach((b) => mark(b.x - 14, b.y - 14, b.w + 28, b.h + 28));
    for (const s of segs) {
      const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y), n = Math.max(1, Math.ceil(L / 20));
      for (let i = 0; i <= n; i++) { const x = s.a.x + (s.b.x - s.a.x) * i / n, y = s.a.y + (s.b.y - s.a.y) * i / n; mark(x - 22, y - 22, 44, 44); }
    }
    const rand = U.rng(seed * 31 + 5);
    const keys = Object.keys(DECOR).sort(() => rand() - 0.5);
    const area = bounds.w * bounds.h;
    const want = U.clamp(Math.round(area / 260000) + 2, 2, 6);
    const out = [];
    const free = (c, r, cw, ch) => {
      if (c < 0 || r < 0 || c + cw > cols || r + ch > rows) return false;
      for (let y = r; y < r + ch; y++) for (let x = c; x < c + cw; x++) if (occ[y * cols + x]) return false;
      return true;
    };
    for (const scale of [0.9, 0.7, 0.55]) {
      for (const k of keys) {
        if (out.length >= want || out.some((o) => o.key === k)) continue;
        const w = DECOR[k][0] * scale, h = DECOR[k][1] * scale;
        const cw = Math.ceil(w / cell), ch = Math.ceil(h / cell);
        const spots = [];
        for (let r = 0; r + ch <= rows; r += 1) for (let c = 0; c + cw <= cols; c += 1) if (free(c, r, cw, ch)) spots.push([c, r]);
        if (!spots.length) continue;
        const [c, r] = spots[Math.floor(rand() * spots.length)];
        const x = bx + c * cell, y = by + r * cell;
        out.push({ key: k, x, y, w, h });
        mark(x - 30, y - 30, w + 60, h + 60);
      }
    }
    return out;
  }

  /* ---------- 全体：描画用ジオメトリ ---------- */
  // model: { mode, lines:[{id,name,color,order}], stations: Map, links, seed }
  // pos: Map sid→{x,y}（グリッド）, rows: Map lineId→row
  function geometry(model, pos, rows, opts) {
    opts = opts || {};
    const st = model.stations;
    const names = [...st.values()].map((s) => U.measure(s.short || '', FS, 600));
    names.sort((a, b) => a - b);
    const med = names.length ? names[Math.floor(names.length / 2)] : 80;
    const S = model.mode === 'time' ? U.clamp(med * 0.9 + 46, 110, 170) : U.clamp(med * 0.75 + 46, 110, 160);
    const HH = model.mode === 'time' ? H * 1.05 : H;
    const P = (id) => { const p = pos.get(id); return { x: p.x * S, y: p.y * HH }; };
    const geo = { S, H: HH, lines: [], stations: [], links: [], labels: null, badges: [], months: [] };
    const segs = [];
    const deg = new Map();
    const lineOf = new Map();
    for (const L of model.lines) for (const id of L.order) { if (!st.has(id)) continue; deg.set(id, (deg.get(id) || 0) + 1); if (!lineOf.has(id)) lineOf.set(id, []); lineOf.get(id).push(L.id); }

    if (model.mode === 'time') {
      const order = opts.order;
      const per = opts.per;
      const pts = [];
      order.forEach((id, i) => {
        const p = P(id);
        if (i > 0 && i % per === 0) {
          const q = P(order[i - 1]);
          const dir = Math.floor((i - 1) / per) % 2 ? -1 : 1;
          const ex = q.x + dir * S * 0.55;
          pts.push({ x: ex, y: q.y }, { x: ex, y: p.y });
        }
        pts.push(p);
      });
      const ppts = dedupe(pts);
      geo.lines.push({ id: 'time', color: '#3b3a36', d: roundedPath(ppts, HH * 0.45), width: 7, pts: ppts });
      for (let i = 1; i < ppts.length; i++) segs.push({ a: ppts[i - 1], b: ppts[i] });
      let lastM = null;
      order.forEach((id) => {
        const s = st.get(id), m = s.date ? s.date.slice(0, 7) : 'unknown';
        if (m !== lastM) { const p = P(id); geo.months.push({ x: p.x, y: p.y - 34, text: m === 'unknown' ? '日付不明' : U.fmtMonth(m), id }); lastM = m; }
      });
    } else {
      model.lines.forEach((L, li) => {
        const ids = L.order.filter((id) => pos.has(id));
        if (!ids.length) return;
        const yc = (rows.get(L.id) || 0) * HH;
        const off = ((li % 4) - 1.5) * 5;
        let pts = [P(ids[0])];
        for (let i = 1; i < ids.length; i++) pts = pts.concat(monotone([pts[pts.length - 1], ...jog(P(ids[i - 1]), P(ids[i]), yc, off)]).slice(1));
        // 路線の両端に少し延長（駅が端でも線として見えるように）
        const a = pts[0], z = pts[pts.length - 1];
        const lead = { x: a.x - S * 0.35, y: a.y }, tail = { x: z.x + S * 0.35, y: z.y };
        const all = dedupe([lead, ...pts, tail]);
        geo.lines.push({ id: L.id, color: L.color, d: roundedPath(all, 22), width: 7, pts: all });
        for (let i = 1; i < all.length; i++) segs.push({ a: all[i - 1], b: all[i], line: L.id });
        geo.badges.push({ id: L.id, x: lead.x, y: lead.y, name: L.name, color: L.color });
      });
    }
    // 意外な乗換（連絡通路）
    for (const k of model.links || []) {
      if (!pos.has(k.a) || !pos.has(k.b)) continue;
      const a = P(k.a), b = P(k.b);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - Math.min(120, Math.abs(b.x - a.x) * 0.25 + 30);
      geo.links.push({ a: k.a, b: k.b, term: k.term, d: `M${a.x} ${a.y} Q${mx} ${my} ${b.x} ${b.y}` });
    }
    // 駅
    const circles = [];
    for (const s of st.values()) {
      if (!pos.has(s.id)) continue;
      const p = P(s.id);
      const inter = (deg.get(s.id) || 0) >= 2;
      const isolated = model.mode !== 'time' && !s.main;
      const r = inter ? 10 : 7.5;
      const L = model.lines.find((x) => x.id === s.main);
      geo.stations.push({ id: s.id, x: p.x, y: p.y, r, inter, isolated, color: model.mode === 'time' ? (s.topicColor || '#3b3a36') : (L ? L.color : '#8c9491'), lines: lineOf.get(s.id) || [] });
      circles.push({ id: s.id, x: p.x, y: p.y, r: r + 2 });
    }
    // 文字
    const first = new Set(), last = new Set();
    model.lines.forEach((L) => { if (L.order.length) { first.add(L.order[0]); last.add(L.order[L.order.length - 1]); } });
    const items = geo.stations.map((s) => {
      const t = st.get(s.id).short || '';
      let pri = 2;
      if (s.inter || first.has(s.id) || last.has(s.id)) pri = 1;
      if (model.mode === 'time' && geo.months.some((m) => m.id === s.id)) pri = 1;
      return { id: s.id, x: s.x, y: s.y, r: s.r, text: t, pri };
    });
    geo.labels = placeLabels(items, segs, circles);
    geo.labels.forEach((l, id) => { l.text = st.get(id).short || ''; l.pri = items.find((i) => i.id === id).pri; });
    // 範囲
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y, w, h) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + (w || 0)); y1 = Math.max(y1, y + (h || 0)); };
    geo.stations.forEach((s) => grow(s.x - 20, s.y - 20, 40, 40));
    geo.labels.forEach((l) => grow(l.x - 2, l.y - FS, l.w, l.h));
    geo.lines.forEach((l) => l.pts.forEach((p) => grow(p.x - 6, p.y - 6, 12, 12)));
    geo.badges.forEach((b) => { const w = U.measure(b.name, 15, 700) + 24; b.w = w; grow(b.x - w - 8, b.y - 16, w + 8, 32); });
    geo.months.forEach((m) => grow(m.x - 40, m.y - 18, 80, 24));
    if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = 400; y1 = 300; }
    geo.bounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const title = { x: geo.bounds.x - 60, y: geo.bounds.y - 175, w: 560, h: 120 };
    const boxes = [title].concat([...geo.labels.values()].map((l) => ({ x: l.x, y: l.y - FS, w: l.w, h: l.h }))
      .concat(geo.stations.map((s) => ({ x: s.x - 16, y: s.y - 16, w: 32, h: 32 })))
      .concat(geo.badges.map((b) => ({ x: b.x - b.w - 8, y: b.y - 16, w: b.w + 8, h: 32 })))
      .concat(geo.months.map((m) => ({ x: m.x - 40, y: m.y - 18, w: 80, h: 24 }))));
    geo.decor = opts.decor === false ? [] : placeDecor(geo.bounds, boxes, segs, model.seed || 1);
    geo.segs = segs;
    geo.FS = FS;
    return geo;
  }

  NT.layout = { topic, time, geometry, roundedPath, jog, segRect, FS, DECOR };
})(globalThis.NT = globalThis.NT || {});
