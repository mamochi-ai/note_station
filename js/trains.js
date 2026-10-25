/* NOTE TRANSIT — 路線図を走る電車（画面の演出だけ。書き出し・共有には入らない）
 * 路線の線の上をゆっくり往復し、駅で少し止まる。レールの継ぎ目で「ガタン・ゴトン」と小さく揺れる。 */
(function (NT) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const SPEED = 42;     // 地図の単位/秒（駅と駅の間を3秒ほどで）
  const DWELL = 1200;   // 駅で止まる時間（ms）
  const TURN = 2200;    // 終点で折り返すまでの時間（ms）
  const CAR = 34, GAP = 3; // 1両の長さとすき間
  const SC = 1.35;      // 地図の上での大きさ
  const JOINT = 30;     // レールの継ぎ目の間隔
  const MAX = 8;        // 走らせる路線の数の上限

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

  // 1両分の絵（進行方向は +x、中心が原点）。白い車体に路線色の帯
  function car(color, front) {
    const g = el('g', {});
    const L = CAR, H = 18, r = 4;
    const x0 = -L / 2, x1 = L / 2, y0 = -H / 2, y1 = H / 2;
    const d = front
      ? `M${x0 + r} ${y0}H${x1 - 9}Q${x1} ${y0} ${x1} 0Q${x1} ${y1} ${x1 - 9} ${y1}H${x0 + r}Q${x0} ${y1} ${x0} ${y1 - r}V${y0 + r}Q${x0} ${y0} ${x0 + r} ${y0}Z`
      : `M${x0 + r} ${y0}H${x1 - r}Q${x1} ${y0} ${x1} ${y0 + r}V${y1 - r}Q${x1} ${y1} ${x1 - r} ${y1}H${x0 + r}Q${x0} ${y1} ${x0} ${y1 - r}V${y0 + r}Q${x0} ${y0} ${x0 + r} ${y0}Z`;
    g.append(el('path', { d, fill: '#fffdf8', stroke: '#3b3a36', 'stroke-width': '2.2', 'stroke-linejoin': 'round' }));
    // 路線色の帯（車体の片側）
    g.append(el('rect', { x: String(x0 + 1.5), y: '3', width: String(L - (front ? 11 : 3)), height: '4', fill: color }));
    // 窓
    const wins = front ? [-11, -4] : [-11, -4, 3];
    for (const x of wins) g.append(el('rect', { x: String(x), y: '-6', width: '5.5', height: '6', rx: '1.2', fill: '#3b3a36', opacity: '0.82' }));
    if (front) g.append(el('path', { d: `M${x1 - 8} -6.5Q${x1 - 2.5} -6.5 ${x1 - 2} -1H${x1 - 8}Z`, fill: '#3b3a36', opacity: '0.82' }));
    return g;
  }

  // 駅の位置に近い、線の上の長さ（短い順）
  function stopsOn(path, len, pts) {
    const N = Math.max(2, Math.ceil(len / 4));
    const samples = [];
    for (let i = 0; i <= N; i++) { const t = (len * i) / N; const p = path.getPointAtLength(t); samples.push([t, p.x, p.y]); }
    const out = [];
    for (const q of pts) {
      let best = null, bd = 20 * 20;
      for (const s of samples) { const d = (s[1] - q.x) ** 2 + (s[2] - q.y) ** 2; if (d < bd) { bd = d; best = s[0]; } }
      if (best != null) out.push(best);
    }
    out.sort((a, b) => a - b);
    return out.filter((v, i) => i === 0 || v - out[i - 1] > 6);
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
      const lines = geo.lines.slice().sort((a, b) => (b.pts ? b.pts.length : 0) - (a.pts ? a.pts.length : 0)).slice(0, MAX);
      lines.forEach((l, i) => {
        const g = Array.from(svg.querySelectorAll('.nt-lines > g[data-line]')).find((x) => x.getAttribute('data-line') === l.id);
        const path = g && g.querySelector('path:last-of-type');
        if (!path) return;
        const len = path.getTotalLength();
        if (!(len > CAR * SC * 3)) return;
        const pts = l.id === 'time' ? geo.stations : geo.stations.filter((s) => (s.lines || []).includes(l.id));
        let stops = stopsOn(path, len, pts);
        if (stops.length < 2) stops = [0, len];
        const cars = [car(l.color, true), car(l.color, false)];
        const tg = el('g', {});
        const op = g.getAttribute('opacity');
        if (op) tg.setAttribute('opacity', op);
        tg.append(cars[1], cars[0]);
        layer.append(tg);
        // 路線ごとに出発位置と向きをずらす
        const k = i % stops.length;
        trains.push({ path, len, stops, cars, s: stops[k], dir: i % 2 ? -1 : 1, idx: k, wait: 600 + i * 450, odo: 0 });
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

  function step(t, dt) {
    if (t.wait > 0) { t.wait -= dt; t.moving = false; place(t); return; }
    let ni = t.idx + t.dir;
    if (ni < 0 || ni >= t.stops.length) { t.dir = -t.dir; ni = t.idx + t.dir; }
    const from = t.stops[t.idx], to = t.stops[ni];
    const remain = Math.abs(to - t.s), done = Math.abs(t.s - from);
    // 発車はゆっくり、駅の手前で減速
    const f = Math.max(0.22, Math.min(1, remain / 45, (done + 6) / 40));
    const ds = SPEED * f * (dt / 1000);
    t.odo += ds; t.moving = true;
    if (ds >= remain) {
      t.s = to; t.idx = ni;
      const end = ni === 0 || ni === t.stops.length - 1;
      t.wait = end ? TURN : DWELL;
    } else t.s += t.dir * ds;
    place(t);
  }

  // レールの継ぎ目：前の台車で「ガタン」、少しおいて後ろの台車で「ゴトン」
  function bump(odo) {
    const p = (odo % JOINT) / JOINT;
    const k = (c) => { const x = (p - c) * 14; return Math.exp(-x * x); };
    return k(0.06) + 0.75 * k(0.3);
  }

  function place(t) {
    const flip = t.dir < 0;
    t.cars.forEach((c, i) => {
      const s = Math.max(0, Math.min(t.len, t.s - t.dir * i * (CAR + GAP) * SC));
      const a = t.path.getPointAtLength(Math.max(0, s - 1)), b = t.path.getPointAtLength(Math.min(t.len, s + 1));
      const p = t.path.getPointAtLength(s);
      let ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      if (flip) ang += 180;
      const jolt = t.moving ? bump(t.odo + i * 9) : 0;
      c.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${ang.toFixed(1)}) translate(0 ${(-1.8 * jolt).toFixed(2)}) rotate(${(-1.2 * jolt).toFixed(2)}) scale(${SC})`);
    });
  }

  NT.trains = { start, stop };
})(globalThis.NT = globalThis.NT || {});
