/* NOTE TRANSIT — AIを使わない路線分類
 * 共通語（特徴語）を「路線の芯」にして記事を束ねる貪欲クラスタリング。
 * 各路線・各接点は実際に共有された語を根拠に持つ。根拠がない記事は「ひとり駅」として無理につながない。 */
(function (NT) {
  'use strict';
  const U = NT.util;

  const PALETTE = ['#d9653b', '#168c94', '#d9a21b', '#3f5fa0', '#6b9a4f', '#9b4f7d', '#3f97c9', '#8c5b3a', '#df7686', '#55616b', '#b0822f', '#2f7a5c'];

  function targetLines(N, rand, seed) {
    if (N < 2) return 0;
    let k = Math.round(0.9 * Math.sqrt(N) + 0.3);
    k = U.clamp(k, 1, 10);
    if (seed) k = U.clamp(k + Math.floor(rand() * 2), 1, 10);
    return Math.min(k, Math.floor(N / 2));
  }

  function pickWeighted(cands, rand, seed) {
    if (!cands.length) return null;
    if (!seed) return cands[0];
    const top = cands.slice(0, 3);
    const tot = top.reduce((s, c) => s + c.score, 0);
    let r = rand() * tot;
    for (const c of top) { r -= c.score; if (r <= 0) return c; }
    return top[0];
  }

  function firstPos(term, titles) {
    let best = 1e9;
    for (const t of titles) { const i = t.indexOf(term); if (i >= 0 && i < best) best = i; }
    return best;
  }

  function makeName(vocab, members, docsById, articlesById, rand, seed, used) {
    const raw = members.map((id) => articlesById.get(id).title || '');
    const titles = raw.map((t) => NT.text.normalize(t));
    const motif = vocab.slice(0, 2).find((t) => NT.text.MOTIF_LABEL[t] && t !== '予想');
    let A = vocab[0], B = vocab[1];
    // 芯の語を含む長い語（例: 自動 → 自動化）が同じ駅群にあれば、それを名前に使う
    const longer = vocab.slice(1).find((t) => t.includes(A) && t.length <= 8);
    if (longer) { A = longer; B = vocab.find((t) => t !== longer && t !== vocab[0]); }
    let name;
    if (motif) name = motif + '線';
    else if (B && !NT.text.MOTIF_LABEL[B] && !A.includes(B) && !B.includes(A) && (A + B).length <= 7) {
      const [x, y] = firstPos(A, titles) <= firstPos(B, titles) ? [A, B] : [B, A];
      name = NT.text.display(x, raw) + NT.text.display(y, raw) + '線';
    } else name = NT.text.display(A, raw) + '線';
    if (seed && members.length >= 4 && rand() < 0.3) name = name.replace(/線$/, '本線');
    let n = name, i = 2;
    while (used.has(n)) n = name.replace(/(本?線)$/, `第${i++}$1`);
    used.add(n);
    return n;
  }

  /* articles: [{id,title,date}], F: NT.text.features 結果
   * opts: { seed, locked:[{name,color,order,vocab}] } */
  function classify(articles, F, opts) {
    opts = opts || {};
    const seed = opts.seed | 0;
    const rand = U.rng(seed * 7919 + 17);
    const N = articles.length;
    const byId = new Map(articles.map((a) => [a.id, a]));
    const docs = F.byId;
    const lines = [];
    const usedNames = new Set();
    const assign = {};
    articles.forEach((a) => { assign[a.id] = { main: null, sub: null }; });

    // 固定（ロック）された路線は先に配置
    const lockedMembers = new Set();
    for (const L of opts.locked || []) {
      const order = L.order.filter((id) => byId.has(id));
      if (order.length < 1) continue;
      const line = { id: L.id || U.uid('L'), name: L.name, color: L.color, order, vocab: L.vocab || [], locked: true, edited: true };
      lines.push(line); usedNames.add(L.name);
      order.forEach((id) => lockedMembers.add(id));
    }

    const k = targetLines(N, rand, seed) + lines.length;
    // 全体に出すぎる語で全部を1本にしない（ただし4記事以下なら全員に共通する語でもよい）
    const maxDf = N <= 4 ? N : Math.max(2, Math.ceil(N * 0.6));
    const termDocs = new Map();
    for (const [id, d] of docs) {
      if (lockedMembers.has(id)) continue;
      for (const w of d.strong) {
        if (!d.w.has(w)) continue;
        if (!termDocs.has(w)) termDocs.set(w, []);
        termDocs.get(w).push(id);
      }
    }
    const assigned = new Set();
    const usedTerms = new Set();
    let guard = 0;
    const hardMax = Math.min(12, Math.ceil(k * 1.6));
    while (lines.length < hardMax && guard++ < 50) {
      const cands = [];
      for (const [t, ids] of termDocs) {
        if (usedTerms.has(t) || ids.length < 2 || ids.length > maxDf) continue;
        const fresh = ids.filter((id) => !assigned.has(id));
        if (fresh.length < 2) continue;
        let score = 0;
        for (const id of ids) score += docs.get(id).w.get(t) * (assigned.has(id) ? 0.25 : 1);
        score *= Math.log(1 + fresh.length);
        cands.push({ t, ids, score });
      }
      cands.sort((p, q) => q.score - p.score || (p.t < q.t ? -1 : 1));
      // 目標数を超えたら、未所属の記事を2件以上タイトル・見出しの語で束ねられる候補だけ追加
      const pool = lines.length < k ? cands : cands.filter((x) => x.ids.filter((id) => !assigned.has(id)).length >= 2 && x.score >= (cands[0] ? cands[0].score * 0.15 : 0));
      const c = pickWeighted(pool, rand, seed);
      if (!c) break;
      usedTerms.add(c.t);
      // 共起語（同じ記事群に出る語）を路線の語彙に
      const set = new Set(c.ids);
      const co = [];
      for (const [t, ids] of termDocs) {
        if (t === c.t || usedTerms.has(t) || ids.length < 2) continue;
        if (c.t.includes(t) || t.includes(c.t)) { if (ids.every((id) => set.has(id))) usedTerms.add(t); continue; }
        const inter = ids.filter((id) => set.has(id)).length;
        const jac = inter / (ids.length + set.size - inter);
        if (inter >= 2 && jac >= 0.5) co.push({ t, s: jac + inter * 0.01 });
      }
      co.sort((p, q) => q.s - p.s || (p.t < q.t ? -1 : 1));
      const vocab = [c.t, ...co.slice(0, 3).map((x) => x.t)];
      vocab.slice(1).forEach((t) => usedTerms.add(t));
      lines.push({ id: 'L' + (lines.length + 1) + '_' + U.hash(c.t).toString(36).slice(0, 4), vocab, order: [], anchorIds: c.ids });
      c.ids.forEach((id) => assigned.add(id));
    }

    // 記事ごとの路線スコア（語の重みの和。芯の語は1、共起語は0.7）
    const scoreOf = (id, L) => {
      const d = docs.get(id);
      if (!d || L.locked) return 0;
      let s = 0;
      L.vocab.forEach((t, i) => { if (d.strong.has(t) && d.w.has(t)) s += d.w.get(t) * (i === 0 ? 1 : 0.7); });
      return s;
    };
    const subs = [];
    for (const a of articles) {
      if (lockedMembers.has(a.id)) continue;
      const sc = lines.map((L) => ({ L, s: scoreOf(a.id, L) })).filter((x) => x.s > 0).sort((p, q) => q.s - p.s);
      if (!sc.length) continue;
      assign[a.id].main = sc[0].L.id;
      if (sc[1] && sc[1].s >= 0.55 * sc[0].s) subs.push({ id: a.id, L: sc[1].L, r: sc[1].s / sc[0].s });
    }
    // 拡張：未所属の記事は、路線の2駅以上と共有する強い語があればその路線へ（根拠のある語だけ）
    const memberIds = (L) => articles.filter((a) => assign[a.id].main === L.id).map((a) => a.id);
    const support = lines.map((L) => {
      const cnt = new Map();
      for (const id of memberIds(L)) for (const t of docs.get(id).strong) cnt.set(t, (cnt.get(t) || 0) + 1);
      return cnt;
    });
    for (const a of articles) {
      if (assign[a.id].main || lockedMembers.has(a.id)) continue;
      const d = docs.get(a.id);
      let best = -1, bs = 0, bt = [];
      lines.forEach((L, i) => {
        if (L.locked) return;
        const ts = [...d.strong].filter((t) => (support[i].get(t) || 0) >= 2 && (F.df.get(t) || 0) <= maxDf && d.w.has(t));
        const s = ts.reduce((x, t) => x + d.w.get(t), 0);
        if (s > bs) { bs = s; best = i; bt = ts; }
      });
      if (best < 0) continue;
      const L = lines[best];
      assign[a.id].main = L.id;
      for (const t of bt) if (!L.vocab.includes(t) && L.vocab.length < 10) L.vocab.push(t);
    }
    // 乗換駅を抑制：副路線は全体の25%程度まで
    subs.sort((p, q) => q.r - p.r);
    const subCap = Math.max(1, Math.floor(N * 0.25));
    subs.slice(0, subCap).forEach((x) => { assign[x.id].sub = x.L.id; });

    for (const L of lines) {
      if (L.locked) { L.order.forEach((id) => { if (!assign[id].main) assign[id].main = L.id; else if (assign[id].main !== L.id && !assign[id].sub) assign[id].sub = L.id; }); }
    }
    // 2駅未満の路線は解散して再割当
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (const L of lines.slice()) {
        if (L.locked) continue;
        const members = articles.filter((a) => assign[a.id].main === L.id || assign[a.id].sub === L.id);
        if (members.length >= 2) continue;
        lines.splice(lines.indexOf(L), 1);
        changed = true;
        for (const a of members) {
          if (assign[a.id].sub === L.id) { assign[a.id].sub = null; continue; }
          assign[a.id].main = null;
          if (assign[a.id].sub) { assign[a.id].main = assign[a.id].sub; assign[a.id].sub = null; continue; }
          const sc = lines.map((M) => ({ M, s: scoreOf(a.id, M) })).filter((x) => x.s > 0).sort((p, q) => q.s - p.s);
          if (sc.length) assign[a.id].main = sc[0].M.id;
        }
      }
      if (!changed) break;
    }

    // 駅順（原則日付順）、名前、色
    const dateKey = (id) => byId.get(id).date || '9999';
    // 根拠チェック：路線語彙を他の駅と1語も共有しない駅は外す（無理につながない）
    for (const L of lines) {
      if (L.locked) continue;
      const mem = articles.filter((a) => assign[a.id].main === L.id || assign[a.id].sub === L.id).map((a) => a.id);
      for (const id of mem) {
        const d = docs.get(id);
        const ok = L.vocab.some((t) => d.strong.has(t) && mem.some((o) => o !== id && docs.get(o).strong.has(t)));
        if (ok) continue;
        if (assign[id].sub === L.id) assign[id].sub = null;
        else { assign[id].main = assign[id].sub; assign[id].sub = null; }
      }
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const L = lines[i];
      if (L.locked) continue;
      const mem = articles.filter((a) => assign[a.id].main === L.id || assign[a.id].sub === L.id);
      if (mem.length >= 2) continue;
      lines.splice(i, 1);
      mem.forEach((a) => { if (assign[a.id].main === L.id) { assign[a.id].main = assign[a.id].sub; assign[a.id].sub = null; } else assign[a.id].sub = null; });
    }
    let ci = 0;
    for (const L of lines) {
      if (!L.locked) {
        L.order = articles.filter((a) => assign[a.id].main === L.id || assign[a.id].sub === L.id).map((a) => a.id)
          .sort((p, q) => dateKey(p).localeCompare(dateKey(q)) || (p < q ? -1 : 1));
        L.name = makeName(L.vocab, L.order, docs, byId, rand, seed, usedNames);
        // 路線語彙は実際に2駅以上が共有するものだけ残す
        L.vocab = L.vocab.filter((t) => L.order.filter((id) => docs.get(id) && docs.get(id).strong.has(t)).length >= 2);
        L.edited = false;
      }
      delete L.anchorIds;
    }
    const usedColors = new Set(lines.filter((L) => L.color).map((L) => L.color));
    for (const L of lines) {
      if (!L.color) { while (usedColors.has(PALETTE[ci % PALETTE.length]) && ci < PALETTE.length * 2) ci++; L.color = PALETTE[ci % PALETTE.length]; usedColors.add(L.color); ci++; }
    }
    const isolated = articles.filter((a) => !assign[a.id].main).map((a) => a.id);
    const links = surprise(articles, F, lines, assign, rand, seed);
    return { seed, lines, assign, isolated, links };
  }

  /* 意外な乗換：主路線が異なる記事の、珍しい共通語（路線語彙にない語）による接点。根拠がなければ作らない */
  function surprise(articles, F, lines, assign, rand, seed) {
    const N = articles.length;
    const docs = F.byId;
    const vocabOf = new Map(lines.map((L) => [L.id, new Set(L.vocab)]));
    const rareMax = Math.max(2, Math.ceil(N * 0.12));
    const cands = [];
    for (const [t, df] of F.df) {
      if (df < 2 || df > rareMax) continue;
      const ids = articles.filter((a) => docs.get(a.id) && docs.get(a.id).strong.has(t)).map((a) => a.id);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        const la = assign[a].main, lb = assign[b].main;
        if (!la || !lb || la === lb) continue;
        if (assign[a].sub === lb || assign[b].sub === la) continue;
        if (vocabOf.get(la).has(t) || vocabOf.get(lb).has(t)) continue;
        const s = Math.log(1 + N / df) * Math.min(docs.get(a).w.get(t) || 0, docs.get(b).w.get(t) || 0);
        if (s <= 0.02) continue;
        cands.push({ a, b, term: t, s: s * (seed ? 0.7 + rand() * 0.6 : 1) });
      }
    }
    cands.sort((p, q) => q.s - p.s || (p.term < q.term ? -1 : 1));
    const out = [];
    const used = new Map();
    const pairs = new Set();
    const max = Math.min(6, Math.max(1, Math.ceil(N / 8)));
    for (const c of cands) {
      if (out.length >= max) break;
      const key = c.a < c.b ? c.a + c.b : c.b + c.a;
      if (pairs.has(key) || (used.get(c.a) || 0) >= 2 || (used.get(c.b) || 0) >= 2) continue;
      pairs.add(key); used.set(c.a, (used.get(c.a) || 0) + 1); used.set(c.b, (used.get(c.b) || 0) + 1);
      out.push({ a: c.a, b: c.b, term: c.term });
    }
    return out;
  }

  /* 2駅の共通語（根拠表示用） */
  function sharedTerms(F, a, b, limit) {
    const da = F && F.byId.get(a), db = F && F.byId.get(b);
    if (!da || !db) return [];
    const out = [];
    for (const [t, w] of da.w) if (db.w.has(t) && (da.strong.has(t) || db.strong.has(t))) out.push([t, w + db.w.get(t)]);
    out.sort((p, q) => q[1] - p[1]);
    return out.slice(0, limit || 4).map((x) => x[0]);
  }

  NT.classify = { classify, sharedTerms, PALETTE };
})(globalThis.NT = globalThis.NT || {});
