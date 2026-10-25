/* NOTE TRANSIT — 路線図を走る電車（画面の演出だけ。書き出し・共有には入らない）
 * 路線の線の上をゆっくり往復し、駅で少し止まる。レールの継ぎ目で「ガタン・ゴトン」と小さく揺れる。
 * 「意外な乗換」の点線がある駅では、ときどき点線を渡って寄り道し、また戻ってくる。 */
(function (NT) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const SPEED = 46;     // 地図の単位/秒（駅と駅の間を3秒ほどで）
  const DWELL = 1200;   // 駅で止まる時間（ms）
  const TURN = 2200;    // 終点で折り返すまでの時間（ms）
  const CAR = 34, GAP = 3; // 1両の長さとすき間（絵の単位）
  const SC = 1.8;       // 地図の上での大きさ
  const SPAN = (CAR + GAP) * SC; // 車両の中心どうしの間隔（地図の単位）
  const JOINT = 34;     // レールの継ぎ目の間隔
  const MAX = 8;        // 走らせる路線の数の上限
  const DETOUR = 0.4;   // 点線のある駅で寄り道する確率

  let raf = 0, layer = null, trains = [], last = 0, timer = 0;

  function stop() {
    cancelAnimationFrame(raf); raf = 0; clearTimeout(timer); timer = 0;
    trains = [];
    if (layer) layer.remove();
    layer = null;
  }

  function el(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  // 1両分の絵（運転台は +x 側、中心が原点）。白い車体に路線色の帯。
  // 2両とも運転台つきなので、折り返しても前後を入れ替えるだけで済む
  function car(color, rear) {
    const L = CAR, H = 18, r = 4;
    const x0 = -L / 2, x1 = L / 2, y0 = -H / 2, y1 = H / 2;
    const g = el('g', {});
    const body = el('g', rear ? { transform: 'scale(-1 1)' } : {});
    body.append(el('path', { d: `M${x0 + r} ${y0}H${x1 - 9}Q${x1} ${y0} ${x1} 0Q${x1} ${y1} ${x1 - 9} ${y1}H${x0 + r}Q${x0} ${y1} ${x0} ${y1 - r}V${y0 + r}Q${x0} ${y0} ${x0 + r} ${y0}Z`, fill: '#fffdf8', stroke: '#3b3a36', 'stroke-width': '2.2', 'stroke-linejoin': 'round' }));
    body.append(el('rect', { x: String(x0 + 1.5), y: '3', width: String(L - 11), height: '4', fill: color }));
    for (const x of [-11, -4]) body.append(el('rect', { x: String(x), y: '-6', width: '5.5', height: '6', rx: '1.2', fill: '#3b3a36', opacity: '0.82' }));
    body.append(el('path', { d: `M${x1 - 8} -6.5Q${x1 - 2.5} -6.5 ${x1 - 2} -1H${x1 - 8}Z`, fill: '#3b3a36', opacity: '0.82' }));
    g.append(body);
    return g;
  }

  function samplePath(path, len) {
    const N = Math.max(2, Math.ceil(len / 4));
    const out = [];
    for (let i = 0; i <= N; i++) { const t = (len * i) / N; const p = path.getPointAtLength(t); out.push([t, p.x, p.y]); }
    return out;
  }
  // 駅の位置に近い、線の上の長さ（短い順）
  function stopsOn(path, len, pts) {
    const samples = samplePath(path, len);
    const out = [];
    for (const q of pts) {
      let best = null, bd = 20 * 20;
      for (const s of samples) { const d = (s[1] - q.x) ** 2 + (s[2] - q.y) ** 2; if (d < bd) { bd = d; best = s[0]; } }
      if (best != null) out.push({ t: best, id: q.id });
    }
    out.sort((a, b) => a.t - b.t);
    return out.filter((v, i) => i === 0 || v.t - out[i - 1].t > 6);
  }

  // svg: 描画済みの地図、geo: 配置。delay ms 後に走り出す
  function start(svg, geo, delay) {
    stop();
    if (!svg || !geo || !geo.lines || !geo.lines.length) return;
    const go = () => {
      timer = 0;
      if (!svg.isConnected) return;
      layer = el('g', { class: 'nt-trains', 'pointer-events': 'none', 'aria-hidden': 'true' });
      const labels = svg.querySelector('.nt-labels');
      if (labels) labels.parentNode.insertBefore(layer, labels); else svg.append(layer);
      // 意外な乗換の点線（駅 → 渡れる点線の一覧）
      const linkEls = svg.querySelectorAll('.nt-links path');
      const links = new Map();
      (geo.links || []).forEach((k, i) => {
        const path = linkEls[i];
        if (!path) return;
        const len = path.getTotalLength();
        if (!(len > 20)) return;
        if (!links.has(k.a)) links.set(k.a, []);
        if (!links.has(k.b)) links.set(k.b, []);
        links.get(k.a).push({ path, len, from: 0 });
        links.get(k.b).push({ path, len, from: len });
      });
      const lines = geo.lines.slice().sort((a, b) => (b.pts ? b.pts.length : 0) - (a.pts ? a.pts.length : 0)).slice(0, MAX);
      lines.forEach((l, i) => {
        const g = Array.from(svg.querySelectorAll('.nt-lines > g[data-line]')).find((x) => x.getAttribute('data-line') === l.id);
        const path = g && g.querySelector('path:last-of-type');
        if (!path) return;
        const len = path.getTotalLength();
        if (!(len > SPAN * 2.5)) return;
        const pts = l.id === 'time' ? geo.stations : geo.stations.filter((s) => (s.lines || []).includes(l.id));
        let stops = stopsOn(path, len, pts);
        if (stops.length < 2) stops = [{ t: 0, id: null }, { t: len, id: null }];
        const cars = [car(l.color, false), car(l.color, true)];
        const tg = el('g', {});
        const op = g.getAttribute('opacity');
        if (op) tg.setAttribute('opacity', op);
        tg.append(cars[1], cars[0]);
        layer.append(tg);
        // 路線ごとに出発位置と向きをずらす
        const k = i % stops.length;
        const line = { path, len };
        trains.push({ line, stops, cars, links, cur: line, s: stops[k].t, dir: i % 2 ? -1 : 1, idx: k, wait: 600 + i * 450, odo: 0, prev: null, from: stops[k].t, flip: false, trip: null });
      });
      if (!trains.length) return;
      trains.forEach(place);
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    if (delay > 0) timer = setTimeout(go, delay); else go();
  }

  function tick(now) {
    const dt = Math.min(64, now - last); last = now;
    if (!layer || !layer.isConnected) { stop(); return; }
    for (const t of trains) step(t, dt);
    raf = requestAnimationFrame(tick);
  }

  // 別の線へ乗り移る（後ろの車両はしばらく元の線の上を走る）
  function enter(t, path, len, s, dir) {
    t.prev = { path: t.cur.path, len: t.cur.len, s: t.s, dir: t.dir };
    t.cur = { path, len }; t.s = s; t.dir = dir; t.from = s; t.jx = s;
  }

  // 発車はゆっくり、目標の手前で減速。着いたら true
  function move(t, target, dt) {
    const remain = (target - t.s) * t.dir;
    if (remain <= 0) { t.s = target; return true; }
    const done = Math.abs(t.s - t.from);
    const f = Math.max(0.22, Math.min(1, remain / 50, (done + 6) / 45));
    const ds = SPEED * f * (dt / 1000);
    t.odo += ds; t.moving = true;
    if (ds >= remain) { t.s = target; return true; }
    t.s += t.dir * ds;
    return false;
  }

  function step(t, dt) {
    t.moving = false;
    if (t.wait > 0) { t.wait -= dt; place(t); return; }
    if (t.trip) {
      // 点線を渡って寄り道中
      const tr = t.trip;
      const end = t.dir > 0 ? tr.len : 0;
      if (move(t, end, dt)) {
        if (!tr.back) {
          // 向こうの駅で一休みしてから戻る（前後の車両を入れ替える）
          tr.back = true; t.wait = DWELL * 1.4;
          t.s = end - t.dir * SPAN; t.dir = -t.dir; t.from = t.s; t.prev = null;
        } else {
          enter(t, t.line.path, t.line.len, t.stops[t.idx].t, tr.lineDir);
          t.trip = null; t.wait = DWELL; t.noDetour = true;
        }
      }
      place(t); return;
    }
    let ni = t.idx + t.dir;
    if (ni < 0 || ni >= t.stops.length) {
      // 折り返し：前後の車両を入れ替える（どちらにも運転台がある）
      t.s -= t.dir * SPAN; t.dir = -t.dir; t.from = t.s; t.prev = null;
      ni = t.idx + t.dir;
    }
    if (move(t, t.stops[ni].t, dt)) {
      t.idx = ni; t.from = t.s;
      const end = ni === 0 || ni === t.stops.length - 1;
      t.wait = end ? TURN : DWELL;
      const opts = t.links.get(t.stops[ni].id);
      if (opts && opts.length && !t.noDetour && Math.random() < DETOUR) {
        const k = opts[Math.floor(Math.random() * opts.length)];
        t.trip = { len: k.len, back: false, lineDir: t.dir };
        enter(t, k.path, k.len, k.from, k.from === 0 ? 1 : -1);
        t.wait = DWELL;
      } else t.noDetour = false;
    }
    place(t);
  }

  // レールの継ぎ目：前の台車で「ガタン」、少しおいて後ろの台車で「ゴトン」
  function bump(odo) {
    const p = (odo % JOINT) / JOINT;
    const k = (c) => { const x = (p - c) * 14; return Math.exp(-x * x); };
    return k(0.06) + 0.75 * k(0.3);
  }

  // 先頭から back だけ後ろの位置（乗り移った直後は元の線の上）
  // （乗り移った地点 jx からの距離で決める。駅ごとに戻る from とは別）
  function at(t, back) {
    const ran = Math.abs(t.s - t.jx);
    if (t.prev && back > ran) {
      const p = t.prev;
      return { path: p.path, len: p.len, s: Math.max(0, Math.min(p.len, p.s - p.dir * (back - ran))), dir: p.dir };
    }
    return { path: t.cur.path, len: t.cur.len, s: Math.max(0, Math.min(t.cur.len, t.s - t.dir * back)), dir: t.dir };
  }

  function place(t) {
    // 最後尾まで新しい線に入ったら、元の線は忘れる
    if (t.prev && Math.abs(t.s - t.jx) >= SPAN * (t.cars.length - 1)) t.prev = null;
    const poses = t.cars.map((c, i) => {
      const q = at(t, i * SPAN);
      const a = q.path.getPointAtLength(Math.max(0, q.s - 1)), b = q.path.getPointAtLength(Math.min(q.len, q.s + 1));
      const p = q.path.getPointAtLength(q.s);
      let ang = Math.atan2(b.y - a.y, b.x - a.x);
      if (q.dir < 0) ang += Math.PI;
      return { p, ang };
    });
    // 左へ向かうときは上下を返して、車体が逆さまにならないように（ほぼ真上・真下のときは前の向きのまま）
    const cx = Math.cos(poses[0].ang);
    if (cx < -0.15) t.flip = true; else if (cx > 0.15) t.flip = false;
    const fy = t.flip ? -SC : SC;
    t.cars.forEach((c, i) => {
      const { p, ang } = poses[i];
      const jolt = t.moving ? bump(t.odo + i * 11) : 0;
      c.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${((ang * 180) / Math.PI).toFixed(1)}) scale(${SC} ${fy}) translate(0 ${(-1.1 * jolt).toFixed(2)}) rotate(${(-0.9 * jolt).toFixed(2)})`);
    });
  }

  NT.trains = { start, stop };
})(globalThis.NT = globalThis.NT || {});
