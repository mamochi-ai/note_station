/* NOTE TRANSIT — 振り返り用の簡単な集計（図と整合し、根拠が明確なものだけ）
 * スキ数・PV・人気・性格などはZIPに無いので扱わない。 */
(function (NT) {
  'use strict';
  const U = NT.util;

  /* view: { lines, stations:[{id,date,main}], } F: features（本人用。共有閲覧では null） */
  function compute(view, F) {
    const st = view.stations;
    const months = new Map();
    let undated = 0;
    for (const s of st) { const k = U.monthKey(s.date); if (k) months.set(k, (months.get(k) || 0) + 1); else undated++; }
    const mk = [...months.keys()].sort();
    // 欠けた月も 0 で埋める
    const monthly = [];
    if (mk.length) {
      let [y, m] = mk[0].split('-').map(Number);
      const [y1, m1] = mk[mk.length - 1].split('-').map(Number);
      let guard = 0;
      while ((y < y1 || (y === y1 && m <= m1)) && guard++ < 600) {
        const k = `${y}-${String(m).padStart(2, '0')}`;
        monthly.push({ k, n: months.get(k) || 0 });
        m++; if (m > 12) { m = 1; y++; }
      }
    }
    const perLine = view.lines.map((L) => ({ id: L.id, name: L.name, color: L.color, n: L.order.length }));
    const memberships = new Map();
    view.lines.forEach((L) => L.order.forEach((id) => memberships.set(id, (memberships.get(id) || 0) + 1)));
    const bridges = st.filter((s) => (memberships.get(s.id) || 0) >= 2).map((s) => ({ id: s.id, short: s.short, n: memberships.get(s.id) }));
    const isolated = st.filter((s) => !memberships.get(s.id)).length;

    // 特徴語（本人用のみ）
    let terms = null;
    if (F) {
      const cnt = new Map();
      for (const d of F.docs) for (const t of d.top.slice(0, 8)) cnt.set(t, (cnt.get(t) || 0) + 1);
      terms = [...cnt].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 16).map(([t, c]) => ({ t, c }));
    }

    // 最近 vs 以前（日付中央で二分）。少数データでは判断しない
    const dated = st.filter((s) => s.date).sort((a, b) => a.date.localeCompare(b.date));
    let trend = { ok: false, reason: '' };
    if (dated.length < 12 || mk.length < 2) {
      trend.reason = `日付のある記事が${dated.length}件・${mk.length}か月分のため、増減は判断できません（目安：12件以上・2か月以上）`;
    } else {
      const half = Math.floor(dated.length / 2);
      const early = new Set(dated.slice(0, half).map((s) => s.id));
      const late = new Set(dated.slice(half).map((s) => s.id));
      const rows = view.lines.map((L) => {
        const e = L.order.filter((id) => early.has(id)).length, l = L.order.filter((id) => late.has(id)).length;
        return { name: L.name, color: L.color, early: e, late: l, diff: l - e };
      }).filter((r) => r.early + r.late >= 3).sort((a, b) => b.diff - a.diff);
      trend = { ok: true, split: dated[half].date, rows, earlyN: early.size, lateN: late.size };
    }
    return { monthly, undated, perLine, unique: st.length, isolated, bridges, terms, trend };
  }

  NT.analysis = { compute };
})(globalThis.NT = globalThis.NT || {});
