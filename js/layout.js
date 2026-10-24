/* NOTE TRANSIT — 路線図レイアウト
 * 座標はグリッド単位（x=列, y=段）。描画時に px へ変換。
 * 線は 水平・垂直・45度 の折れ線を丸い角でつなぐ。乗換は同一記事の単一駅。交差点には駅を置かない。 */
(function (NT) {
  'use strict';
  const U = NT.util;

  const FS = 17;          // 駅名フォントサイズ
  const H = 190;          // 段の間隔(px)

  /* ---------- 話題モード：乗換駅を軸に、路線が八方へ広がる街の配置 ----------
   * 1. 駅を共有する路線どうしを「まとまり」にする（共有駅＝乗換駅は同じ記事の単一駅）
   * 2. まとまりの中で乗換の多い路線を幹にし、ほかの路線は乗換駅を通る向きを 8方向から選ぶ
   *    （重なり・交差・密集を避け、全体が小さくまとまる向きを採点で選ぶ）
   * 3. まとまり同士・独立路線・ひとり駅を、ほぼ正方形に詰めて並べる
   * 関係のない路線同士を見た目のために線でつなぐことはしない（並べるだけ）。 */
  const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const rot = (i, k) => (i + k + 8) % 8;
  const RUN = 4; // 折り返すまでの直線の駅数

  // 方向列：短ければ直進、長ければ U 字に折り返す（幹・独立路線）か、ゆるい階段（枝）
  function shape(n, d0, mode, side) {
    const ds = [];
    // 中くらいの長さ：途中で 45度 下って戻る、ゆるい段差（地下鉄らしいうねり）
    if (mode === 'snake' && n >= 3 && n <= 6) {
      const pat = [0, 0, side, side, 0, 0].map((k) => rot(d0, k));
      const start = n <= 4 ? 1 : 0;
      return pat.slice(start, start + n);
    }
    if (mode === 'snake' && n > RUN + 1) {
      let d = d0, run = 0;
      while (ds.length < n) {
        if (run < RUN) { ds.push(d); run++; continue; }
        // 45度×2 で向きを反転（丸い U ターン）
        ds.push(rot(d, side)); if (ds.length < n) ds.push(rot(d, side * 3));
        d = rot(d, 4); run = 0; side = -side;
      }
      return ds.slice(0, n);
    }
    for (let i = 0; i < n; i++) ds.push(n > 5 && i % 5 === 4 ? rot(d0, side) : d0);
    return ds;
  }

  function orient(a, b, c) { return Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])); }
  function onSeg(a, b, p) { return Math.min(a[0], b[0]) - 1e-9 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-9; }
  const same = (p, q) => p[0] === q[0] && p[1] === q[1];
  // 0: 交わらない（端点共有を含む） 1: 交差 2: 同一直線上で重なる
  function segRel(a, b, c, d) {
    const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
    if (o1 === 0 && o2 === 0) {
      const ax = a[0] !== b[0] ? 0 : 1;
      const lo = Math.max(Math.min(a[ax], b[ax]), Math.min(c[ax], d[ax])), hi = Math.min(Math.max(a[ax], b[ax]), Math.max(c[ax], d[ax]));
      return hi - lo > 1e-9 ? 2 : 0;
    }
    if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return 0;
    if (o1 !== o2 && o3 !== o4) return 1;
    return 0;
  }

  function layoutComponent(lines, side0) {
    const pos = new Map();
    const cell = new Map();
    const segs = [];
    const put = (id, p) => { pos.set(id, p); cell.set(p[0] + ',' + p[1], id); };
    const addSegs = (order, lineId) => {
      for (let i = 1; i < order.length; i++) if (pos.has(order[i - 1]) && pos.has(order[i])) segs.push({ a: pos.get(order[i - 1]), b: pos.get(order[i]), line: lineId });
    };
    const sorted = lines.slice().sort((A, B) => {
      const sh = (L) => L.order.filter((id) => lines.some((M) => M !== L && M.order.includes(id))).length;
      return sh(B) - sh(A) || B.order.length - A.order.length || (A.id < B.id ? -1 : 1);
    });
    const trunk = sorted.shift();
    const ds = shape(trunk.order.length - 1, 0, 'snake', side0 || 1);
    let cur = [0, 0];
    put(trunk.order[0], cur);
    trunk.order.slice(1).forEach((id, i) => { cur = [cur[0] + DIRS[ds[i]][0], cur[1] + DIRS[ds[i]][1]]; put(id, cur); });
    addSegs(trunk.order, trunk.id);
    const rest = sorted;
    while (rest.length) {
      rest.sort((A, B) => B.order.filter((id) => pos.has(id)).length - A.order.filter((id) => pos.has(id)).length || B.order.length - A.order.length);
      const L = rest.shift();
      const k = L.order.findIndex((id) => pos.has(id));
      if (k < 0) continue;
      let best = null;
      const cx = [...pos.values()].reduce((s, p) => s + p[0], 0) / pos.size, cy = [...pos.values()].reduce((s, p) => s + p[1], 0) / pos.size;
      // 乗換駅にすでに出入りしている向き
      const used = new Set();
      for (const s of segs) {
        const A = L.order[k];
        const P = pos.get(A);
        for (const [p, q] of [[s.a, s.b], [s.b, s.a]]) if (same(p, P)) { const dx = Math.sign(q[0] - p[0]), dy = Math.sign(q[1] - p[1]); used.add(DIRS.findIndex((v) => v[0] === dx && v[1] === dy)); }
      }
      for (let dA = 0; dA < 8; dA++) for (const bend of [4, 3, 5]) for (const side of [1, -1]) {
        const dB = rot(dA, bend);
        const res = new Map();
        const walk = (from, to, step, dirs) => {
          let c = pos.get(L.order[from]); let j = 0;
          for (let i = from + step; step > 0 ? i < to : i > to; i += step) {
            const id = L.order[i];
            if (pos.has(id)) { c = pos.get(id); continue; }
            const d = DIRS[dirs[j++]]; c = [c[0] + d[0], c[1] + d[1]]; res.set(id, c);
          }
        };
        walk(k, L.order.length, 1, shape(L.order.length, dA, 'stair', side));
        walk(k, -1, -1, shape(k + 1, dB, 'stair', -side));
        let s = (bend === 4 ? 0 : 6) + (side === 1 ? 0 : 0.5);
        const hasA = L.order.length - 1 > k, hasB = k > 0;
        if (used.has(dA) && hasA) s += 120;
        if (used.has(dB) && hasB) s += 120;
        // 乗換駅で相手の線の延長方向へまっすぐ続くと1本の線に見えるので避け、角度をつけて分かれる
        for (const u of used) {
          if (hasA && dA === rot(u, 4)) s += 45;
          if (hasB && dB === rot(u, 4)) s += 45;
          if (hasA && (dA === rot(u, 1) || dA === rot(u, -1))) s += 8;
          if (hasB && (dB === rot(u, 1) || dB === rot(u, -1))) s += 8;
        }
        const seen = new Set();
        for (const [, p] of res) {
          const key = p[0] + ',' + p[1];
          if (cell.has(key) || seen.has(key)) s += 400;
          seen.add(key);
          for (const d of DIRS) if (cell.has((p[0] + d[0]) + ',' + (p[1] + d[1]))) s += 7;
          s += 0.6 * Math.hypot(p[0] - cx, p[1] - cy);
        }
        const P = (id) => res.get(id) || pos.get(id);
        for (let i = 1; i < L.order.length; i++) {
          const a = P(L.order[i - 1]), b = P(L.order[i]);
          if (!a || !b || (!res.has(L.order[i - 1]) && !res.has(L.order[i]))) continue;
          for (const e of segs) { const r = segRel(a, b, e.a, e.b); if (r === 2) s += 300; else if (r === 1) s += 14; }
          for (const [id, q] of pos) if (id !== L.order[i - 1] && id !== L.order[i] && orient(a, b, q) === 0 && onSeg(a, b, q)) s += 250;
        }
        if (!best || s < best.s) best = { s, res };
      }
      // どの向きでもぶつかる場合の保険：重なった駅だけ、近くの空いたマスへずらす（駅を重ねて描かない）
      for (const [id, p0] of best.res) {
        let p = p0;
        if (cell.has(p[0] + ',' + p[1])) {
          search: for (let r = 1; r <= 4; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const q = [p0[0] + dx, p0[1] + dy];
            if (!cell.has(q[0] + ',' + q[1])) { p = q; break search; }
          }
        }
        put(id, p);
      }
      addSegs(L.order, L.id);
    }
    return pos;
  }

  function topic(model) {
    const { lines, stations } = model;
    const live = lines.map((L) => ({ id: L.id, order: L.order.filter((id) => stations.has(id)) })).filter((L) => L.order.length);
    // まとまり（駅を共有する路線の連結成分）
    const comp = new Map(live.map((L) => [L.id, L.id]));
    const find = (x) => { while (comp.get(x) !== x) x = comp.get(x); return x; };
    const owner = new Map();
    for (const L of live) for (const id of L.order) {
      if (owner.has(id)) { const a = find(owner.get(id)), b = find(L.id); if (a !== b) comp.set(b, a); } else owner.set(id, L.id);
    }
    const groups = new Map();
    for (const L of live) { const r = find(L.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(L); }
    const blocks = [];
    let gi = 0;
    const gs = [...groups.values()].sort((A, B) => B.reduce((s, L) => s + L.order.length, 0) - A.reduce((s, L) => s + L.order.length, 0) || (A[0].id < B[0].id ? -1 : 1));
    for (const g of gs) {
      const p = layoutComponent(g, gi++ % 2 ? -1 : 1);
      blocks.push({ pos: p, weight: g.reduce((s, L) => s + L.order.length, 0) });
    }
    // ひとり駅：小さな区画にまとめる
    const iso = [...stations.values()].filter((s) => !owner.has(s.id)).sort((a, b) => (a.date || '9').localeCompare(b.date || '9'));
    if (iso.length) {
      const cols = Math.max(2, Math.ceil(Math.sqrt(iso.length)));
      const p = new Map(iso.map((s, i) => [s.id, [i % cols, Math.floor(i / cols)]]));
      blocks.push({ pos: p, weight: -1, iso: true });
    }
    // 各区画の外接矩形
    for (const b of blocks) {
      const xs = [...b.pos.values()].map((p) => p[0]), ys = [...b.pos.values()].map((p) => p[1]);
      b.x0 = Math.min(...xs); b.y0 = Math.min(...ys); b.w = Math.max(...xs) - b.x0; b.h = Math.max(...ys) - b.y0;
    }
    // ほぼ正方形になるよう棚詰め（大きいまとまりから）
    const GAP = 1.6, GAPX = 2.7; // 横は路線名の札のぶん広めに
    blocks.sort((a, b) => (a.iso ? 1 : 0) - (b.iso ? 1 : 0) || b.weight - a.weight || b.w - a.w);
    const area = blocks.reduce((s, b) => s + (b.w + GAPX) * (b.h + GAP), 0);
    const W = Math.max(...blocks.map((b) => b.w), Math.sqrt(area) * 1.05);
    let x = 0, y = 0, rowH = 0;
    const pos = new Map();
    for (const b of blocks) {
      if (x > 0 && x + b.w > W + 0.01) { x = 0; y += rowH + GAP + 0.4; rowH = 0; }
      for (const [id, p] of b.pos) pos.set(id, { x: p[0] - b.x0 + x, y: p[1] - b.y0 + y });
      x += b.w + GAPX; rowH = Math.max(rowH, b.h);
    }
    return { pos, rows: new Map() };
  }

  /* ---------- 経路：水平・垂直・45度で2駅を結ぶ（px） ---------- */
  function octi(A, B) {
    const dx = B.x - A.x, dy = B.y - A.y, ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < 0.5 || ay < 0.5 || Math.abs(ax - ay) < 0.5) return [B];
    const sx = Math.sign(dx), sy = Math.sign(dy);
    if (ax > ay) { const st = (ax - ay) / 2; return [{ x: A.x + sx * st, y: A.y }, { x: B.x - sx * st, y: B.y }, B]; }
    const st = (ay - ax) / 2; return [{ x: A.x, y: A.y + sy * st }, { x: B.x, y: B.y - sy * st }, B];
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

  function placeLabels(items, segs, circles, pre) {
    // items: [{id, x, y, r, text, pri}]、pre: 先に置いた文字の矩形
    const placed = (pre || []).slice();
    const out = new Map();
    const order = items.slice().sort((a, b) => a.pri - b.pri || a.x - b.x);
    for (const it of order) {
      const w = U.measure(it.text, FS, 700) + 4, h = FS + 5;
      const g = it.r + 6;
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

  /* ---------- 空き領域グリッド（装飾・画像カードの配置用） ---------- */
  function occupancy(bounds, boxes, segs, pad) {
    const cell = 30;
    const bx = bounds.x - pad, by = bounds.y - pad, bw = bounds.w + pad * 2, bh = bounds.h + pad * 2;
    const cols = Math.ceil(bw / cell), rows = Math.ceil(bh / cell);
    if (cols * rows > 600000) return null;
    const occ = new Uint8Array(cols * rows);
    const mark = (x, y, w, h) => {
      const c0 = Math.max(0, Math.floor((x - bx) / cell)), c1 = Math.min(cols - 1, Math.floor((x + w - bx) / cell));
      const r0 = Math.max(0, Math.floor((y - by) / cell)), r1 = Math.min(rows - 1, Math.floor((y + h - by) / cell));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) occ[r * cols + c] = 1;
    };
    const isFree = (x, y, w, h) => {
      const c0 = Math.floor((x - bx) / cell), c1 = Math.floor((x + w - bx) / cell);
      const r0 = Math.floor((y - by) / cell), r1 = Math.floor((y + h - by) / cell);
      if (c0 < 0 || r0 < 0 || c1 >= cols || r1 >= rows) return false;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (occ[r * cols + c]) return false;
      return true;
    };
    boxes.forEach((b) => mark(b.x - 12, b.y - 12, b.w + 24, b.h + 24));
    for (const s of segs) {
      const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y), n = Math.max(1, Math.ceil(L / 15));
      for (let i = 0; i <= n; i++) { const x = s.a.x + (s.b.x - s.a.x) * i / n, y = s.a.y + (s.b.y - s.a.y) * i / n; mark(x - 22, y - 22, 44, 44); }
    }
    return { cell, bx, by, cols, rows, mark, isFree };
  }

  // 駅カードの挿絵に使う水彩素材（地図の背景は assets/bg_landscape.jpg）
  const DECOR = { trees: [280, 209], town: [280, 184], bridge: [280, 235], station: [280, 223], clouds: [280, 210], train: [280, 220] };

  /* ---------- 主要駅の画像カード（本人用・少数だけ） ---------- */
  function placeVignettes(G, stations, ids) {
    const out = [];
    if (!G) return out;
    const W = 156, Hh = 108;
    for (const id of ids) {
      const s = stations.find((x) => x.id === id);
      if (!s) continue;
      const C = [];
      for (const dy of [-Hh - 52, 52, -Hh - 90, 90, -Hh - 130, 130]) for (const dx of [-W / 2, -W - 10, 10, -W - 70, 70]) C.push([dx, dy]);
      C.sort((p, q) => Math.hypot(p[0] + W / 2, p[1] + Hh / 2) - Math.hypot(q[0] + W / 2, q[1] + Hh / 2));
      for (const [dx, dy] of C) {
        const x = s.x + dx, y = s.y + dy;
        if (G.isFree(x, y, W, Hh)) { out.push({ id, x, y, w: W, h: Hh }); G.mark(x - 10, y - 10, W + 20, Hh + 20); break; }
      }
    }
    return out;
  }

  /* ---------- 全体：描画用ジオメトリ ---------- */
  // model: { mode, lines:[{id,name,color,order}], stations: Map, links, seed }
  // pos: Map sid→{x,y}（グリッド）, rows: Map lineId→段（グリッド）
  // opts: { order, per（時間モード）, vignettes:[id], planned:boolean }
  function geometry(model, pos, rows, opts) {
    opts = opts || {};
    const st = model.stations;
    const names = [...st.values()].map((s) => U.measure(s.short || '', FS, 700));
    names.sort((a, b) => a - b);
    const med = names.length ? names[Math.floor(names.length / 2)] : 80;
    // 話題モードは正方グリッド（1マス＝駅間）。駅名が隣と重なりにくく、スマホでも読める倍率に収まる幅
    const S = model.mode === 'time' ? U.clamp(med * 0.62 + 44, 112, 168) : U.clamp(med * 0.38 + 58, 96, 124);
    const HH = model.mode === 'time' ? 150 : S;
    const P = (id) => { const p = pos.get(id); return { x: p.x * S, y: p.y * HH }; };
    const geo = { S, H: HH, lines: [], stations: [], links: [], labels: null, badges: [], ends: [], months: [], planned: null, vignettes: [] };
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
          const ex = q.x + dir * S * 0.6;
          pts.push({ x: ex, y: q.y }, { x: ex, y: p.y });
        }
        pts.push(p);
      });
      const ppts = dedupe(pts);
      geo.lines.push({ id: 'time', color: '#3b3a36', d: roundedPath(ppts, HH * 0.45), width: 11, pts: ppts });
      for (let i = 1; i < ppts.length; i++) segs.push({ a: ppts[i - 1], b: ppts[i] });
      let lastM = null;
      order.forEach((id) => {
        const s = st.get(id), m = s.date ? s.date.slice(0, 7) : 'unknown';
        if (m !== lastM) { const p = P(id); geo.months.push({ x: p.x, y: p.y - 44, text: m === 'unknown' ? '日付不明' : U.fmtMonth(m), id }); lastM = m; }
      });
    } else {
      // 延伸予定：最も新しい記事を含む路線の終点に点線を足す（記事ではない遊びの表示）
      let newest = null;
      if (opts.planned !== false) {
        let best = '';
        for (const L of model.lines) { const z = L.order[L.order.length - 1]; const d = z && st.get(z) && st.get(z).date; if (d && d > best) { best = d; newest = L.id; } }
      }
      // 同じ2駅の間を複数の路線が通る区間は、少しずらして並走させる
      const shared = new Map();
      const keyOf = (x, y) => (x < y ? x + '|' + y : y + '|' + x);
      model.lines.forEach((L) => { const ids = L.order.filter((id) => pos.has(id)); for (let i = 1; i < ids.length; i++) { const k = keyOf(ids[i - 1], ids[i]); if (!shared.has(k)) shared.set(k, []); shared.get(k).push(L.id); } });
      const unit = (a, b) => { const l = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };
      model.lines.forEach((L) => {
        const ids = L.order.filter((id) => pos.has(id));
        if (!ids.length) return;
        let pts = [P(ids[0])];
        for (let i = 1; i < ids.length; i++) {
          const A = P(ids[i - 1]), B = P(ids[i]);
          const arr = shared.get(keyOf(ids[i - 1], ids[i]));
          const route = octi(A, B);
          if (arr.length > 1) {
            const u = unit(A, B), k = (arr.indexOf(L.id) - (arr.length - 1) / 2) * 8;
            const o = { x: -u.y * k, y: u.x * k };
            pts.push({ x: A.x + o.x, y: A.y + o.y });
            route.forEach((p) => pts.push({ x: p.x + o.x, y: p.y + o.y }));
            pts.push(B);
          } else pts = pts.concat(route);
        }
        // 始点・終点のひげ（始点に路線名、終点に終端の印）
        const a = pts[0], z = pts[pts.length - 1];
        const u0 = pts.length > 1 ? unit(pts[1], a) : { x: -1, y: 0 };
        const u1 = pts.length > 1 ? unit(pts[pts.length - 2], z) : { x: 1, y: 0 };
        // 乗換駅で終わる路線は、ひげと終端印を付けずに駅で止める（乗換駅のまわりをすっきり）
        const endInter = (deg.get(ids[ids.length - 1]) || 0) >= 2;
        const lead = { x: a.x + u0.x * S * 0.42, y: a.y + u0.y * S * 0.42 };
        const tail = endInter ? { x: z.x, y: z.y } : { x: z.x + u1.x * S * 0.34, y: z.y + u1.y * S * 0.34 };
        const all = dedupe([lead, ...pts, tail]);
        geo.lines.push({ id: L.id, color: L.color, d: roundedPath(all, S * 0.38), width: 11, pts: all });
        for (let i = 1; i < all.length; i++) segs.push({ a: all[i - 1], b: all[i], line: L.id });
        const bw = U.measure(L.name, 17, 800) + 30;
        const horiz = Math.abs(u0.x) >= Math.abs(u0.y);
        const reach = horiz ? bw / 2 + 2 : 20;
        geo.badges.push({ id: L.id, cx: lead.x + u0.x * reach, cy: lead.y + u0.y * reach, w: bw, name: L.name, color: L.color });
        if (!endInter) geo.ends.push({ x: tail.x, y: tail.y, ux: u1.x, uy: u1.y, color: L.color, line: L.id });
        if (L.id === newest) {
          const q = { x: tail.x + u1.x * S * 0.9, y: tail.y + u1.y * S * 0.9 };
          geo.planned = { line: L.id, from: tail, x: q.x, y: q.y, color: L.color };
          segs.push({ a: tail, b: q, line: L.id });
        }
      });
    }
    // 意外な乗換（連絡通路）
    for (const k of model.links || []) {
      if (!pos.has(k.a) || !pos.has(k.b)) continue;
      const a = P(k.a), b = P(k.b);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - Math.min(140, Math.abs(b.x - a.x) * 0.25 + 40);
      geo.links.push({ a: k.a, b: k.b, term: k.term, d: `M${a.x} ${a.y} Q${mx} ${my} ${b.x} ${b.y}` });
    }
    // 駅
    const circles = [];
    for (const s of st.values()) {
      if (!pos.has(s.id)) continue;
      const p = P(s.id);
      const inter = (deg.get(s.id) || 0) >= 2;
      const isolated = model.mode !== 'time' && !s.main;
      const r = inter ? 13 : 10;
      const L = model.lines.find((x) => x.id === s.main);
      geo.stations.push({ id: s.id, x: p.x, y: p.y, r, inter, isolated, color: model.mode === 'time' ? (s.topicColor || '#3b3a36') : (L ? L.color : '#8c9491'), lines: lineOf.get(s.id) || [] });
      circles.push({ id: s.id, x: p.x, y: p.y, r: r + 3 });
    }
    if (geo.planned) circles.push({ id: '__planned', x: geo.planned.x, y: geo.planned.y, r: 16 });
    // 路線名・延伸予定の文字は先に置いて、駅名がそこを避けるようにする
    const pre = geo.badges.map((b) => ({ x: b.cx - b.w / 2, y: b.cy - 18, w: b.w, h: 36 }));
    let pBox = null;
    if (geo.planned) {
      const p = geo.planned;
      p.label = '次につくるもの'; p.sub = '延伸予定';
      const w = U.measure(p.label, 14, 700) + 4;
      pBox = { x: p.x - w / 2, y: p.y + 20, w, h: 38 };
      pre.push(pBox);
    }
    // 文字
    const first = new Set(), last = new Set();
    model.lines.forEach((L) => { if (L.order.length) { first.add(L.order[0]); last.add(L.order[L.order.length - 1]); } });
    // 地図では駅名を短く（全文は記事カードで読む）
    const mapName = (t) => { const a = Array.from(t || ''); return a.length > 11 ? a.slice(0, 10).join('') + '…' : a.join(''); };
    const items = geo.stations.map((s) => {
      const t = mapName(st.get(s.id).short);
      let pri = 2;
      if (s.inter || first.has(s.id) || last.has(s.id)) pri = 1;
      if (model.mode === 'time' && geo.months.some((m) => m.id === s.id)) pri = 1;
      return { id: s.id, x: s.x, y: s.y, r: s.r, text: t, pri };
    });
    geo.labels = placeLabels(items, segs, circles, pre);
    geo.labels.forEach((l, id) => { const it = items.find((i) => i.id === id); l.text = it.text; l.pri = it.pri; });
    // 範囲
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y, w, h) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + (w || 0)); y1 = Math.max(y1, y + (h || 0)); };
    geo.stations.forEach((s) => grow(s.x - 24, s.y - 24, 48, 48));
    geo.labels.forEach((l) => grow(l.x - 2, l.y - FS, l.w, l.h));
    geo.lines.forEach((l) => l.pts.forEach((p) => grow(p.x - 8, p.y - 8, 16, 16)));
    pre.forEach((b) => grow(b.x - 4, b.y - 4, b.w + 8, b.h + 8));
    geo.months.forEach((m) => grow(m.x - 44, m.y - 18, 88, 26));
    if (geo.planned) grow(geo.planned.x - 20, geo.planned.y - 20, 40, 40);
    if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = 400; y1 = 300; }
    geo.bounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const boxes = [...geo.labels.values()].map((l) => ({ x: l.x, y: l.y - FS, w: l.w, h: l.h }))
      .concat(geo.stations.map((s) => ({ x: s.x - 20, y: s.y - 20, w: 40, h: 40 })))
      .concat(pre)
      .concat(geo.months.map((m) => ({ x: m.x - 44, y: m.y - 18, w: 88, h: 26 })));
    if (opts.titleBox) boxes.push({ x: geo.bounds.x - 60, y: geo.bounds.y - 175, w: 560, h: 120 });
    const G = occupancy(geo.bounds, boxes, segs, 190);
    geo.vignettes = placeVignettes(G, geo.stations, opts.vignettes || []);
    geo.segs = segs;
    geo.FS = FS;
    return geo;
  }

  NT.layout = { topic, time, geometry, roundedPath, octi, segRect, FS, DECOR };
})(globalThis.NT = globalThis.NT || {});
