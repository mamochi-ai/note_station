/* NOTE TRANSIT — アプリ本体（画面・操作・編集・共有） */
(function (NT) {
  'use strict';
  NT.BOOT_HTML = '<!doctype html>\n' + document.documentElement.outerHTML;
  const U = NT.util;
  const $ = (s) => document.querySelector(s);
  const MAX_VERSIONS = 30;
  const LAYOUT_V = 2; // 配置方式の版（2：乗換駅を軸に八方へ広がる配置）

  const S = {
    project: null, bodies: null, F: null, zip: null,
    mode: 'topic', viewer: null, sel: null, focus: null,
    edit: false, multi: false, multiSel: new Set(),
    undo: [], redo: [], vb: null, full: null, svg: null,
    rev: 0, geoKey: null, geo: null, model: null,
    panel: null, imp: null, impKind: null, abort: null, imgCache: new Map(), drag: null, vigUrls: new Map(), vigTried: new Set(),
  };

  /* ---------- 小さなDOMヘルパ（文字列は常にテキストノード） ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style') el.setAttribute('style', v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }
  const btn = (label, on, cls, attrs) => h('button', Object.assign({ type: 'button', class: 'btn ' + (cls || 'small'), onclick: on }, attrs || {}), label);

  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, ms || 2600);
  }
  function dialog(content, actions) {
    return new Promise((resolve) => {
      const d = $('#dialog'), body = $('#dlg-body'), act = $('#dlg-actions');
      body.replaceChildren(content instanceof Node ? content : h('p', {}, content));
      act.replaceChildren(...actions.map((a) => btn(a.label, () => { d.hidden = true; resolve(a.value); }, (a.primary ? 'primary' : '') + (a.danger ? ' danger' : ''))));
      d.hidden = false;
      const f = act.querySelector('.primary') || act.querySelector('button'); if (f) f.focus({ preventScroll: true });
      d.querySelector('.modal-card').scrollTop = 0;
    });
  }
  function showError(e) {
    if (e && e.name === 'CancelError') { toast('キャンセルしました'); return; }
    console.warn(e);
    dialog(h('div', {}, h('h3', {}, 'うまくいきませんでした'), h('p', {}, (e && e.message) || String(e))), [{ label: '閉じる', value: 1, primary: true }]);
  }
  function show(id) {
    for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== 'screen-' + id;
  }
  function progress(on, msg, r) {
    $('#progress').hidden = !on;
    if (msg) $('#pg-msg').textContent = msg;
    if (r != null) $('#pg-bar').style.width = Math.round(r * 100) + '%';
  }

  /* ---------- 保存 ---------- */
  let saveT = null;
  function save() {
    if (!S.project || S.viewer) return;
    S.project.updatedAt = new Date().toISOString();
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      NT.store.put('project', 'current', S.project).catch((e) => toast('端末内保存に失敗しました：' + e.message, 5000));
    }, 350);
  }
  function snapshot() { return JSON.stringify({ title: S.project.title, articles: S.project.articles, maps: S.project.maps, currentMap: S.project.currentMap }); }
  function restore(s) { Object.assign(S.project, JSON.parse(s)); S.rev++; S.F = null; }
  function pushUndo() { S.undo.push(snapshot()); if (S.undo.length > 60) S.undo.shift(); S.redo = []; }
  function undo() { if (!S.undo.length) return toast('取り消せる操作はありません'); S.redo.push(snapshot()); restore(S.undo.pop()); afterChange(false); }
  function redo() { if (!S.redo.length) return toast('やり直せる操作はありません'); S.undo.push(snapshot()); restore(S.redo.pop()); afterChange(false); }

  /* ---------- プロジェクト ---------- */
  const curMap = () => S.project && S.project.maps.find((m) => m.id === S.project.currentMap);
  const artById = (id) => S.project.articles.find((a) => a.id === id);
  const visibleArticles = () => S.project.articles.filter((a) => !a.hidden);

  function newProject(res, kind, name) {
    const bodies = {};
    const articles = res.articles.map((a) => {
      bodies[a.id] = a._body || null;
      const o = Object.assign({}, a); delete o._body;
      return Object.assign(o, { short: NT.text.shortName(a.title || '（無題）'), shortEdited: false, imageChoice: 0, imageHidden: false, hidden: false });
    });
    const siteTitle = res.site && res.site.title;
    return {
      project: {
        v: 1, id: U.uid('p'), kind, demo: kind === 'demo',
        title: kind === 'demo' ? 'わたしの記事路線図（デモ）' : 'わたしの記事路線図',
        source: { name: name || '', at: new Date().toISOString() },
        site: res.site || {}, articles, excluded: res.excluded || {}, stats: res.stats || {},
        maps: [], currentMap: null,
        settings: { shareLimit: 8000, baseUrl: '', shareDates: true, shareAnalysis: false, shareLinks: true },
        createdAt: new Date().toISOString(),
      },
      bodies,
    };
  }

  function features() {
    if (S.F) return S.F;
    const arts = visibleArticles().map((a) => ({ id: a.id, title: a.title, _body: (S.bodies && S.bodies[a.id]) || null }));
    S.F = NT.text.features(arts);
    return S.F;
  }

  function generate(seed) {
    const prev = curMap();
    const locked = prev ? prev.lines.filter((L) => L.locked).map((L) => U.clone(L)) : [];
    const arts = visibleArticles();
    const c = NT.classify.classify(arts, features(), { seed, locked });
    const m = { id: U.uid('m'), seed, createdAt: new Date().toISOString(), favorite: false, label: '', lines: c.lines, assign: c.assign, links: c.links, pos: {}, manual: {}, fixed: false, layoutV: LAYOUT_V };
    relayoutMap(m, true);
    S.project.maps.push(m);
    S.project.currentMap = m.id;
    // 古い版を整理（お気に入りは残す）
    while (S.project.maps.length > MAX_VERSIONS) {
      const i = S.project.maps.findIndex((x) => !x.favorite && x.id !== m.id);
      if (i < 0) break;
      S.project.maps.splice(i, 1);
    }
    S.rev++;
    return m;
  }

  // 所属の整合：lines.order が所属の正。assign.main/sub をそれに合わせる
  function normalizeMap(m) {
    const ids = new Set(S.project.articles.map((a) => a.id));
    for (const L of m.lines) L.order = L.order.filter((id, i, arr) => ids.has(id) && arr.indexOf(id) === i);
    for (const a of S.project.articles) {
      const has = m.lines.filter((L) => L.order.includes(a.id)).map((L) => L.id);
      const as = m.assign[a.id] || (m.assign[a.id] = { main: null, sub: null });
      if (!has.includes(as.main)) as.main = has[0] || null;
      if (as.sub && (!has.includes(as.sub) || as.sub === as.main)) as.sub = null;
      if (!as.sub) as.sub = has.find((x) => x !== as.main) || null;
      // 3路線以上には所属させない（主1・副1まで）
      for (const L of m.lines) if (L.order.includes(a.id) && L.id !== as.main && L.id !== as.sub) L.order = L.order.filter((x) => x !== a.id);
    }
  }

  function modelFor(mode, mapArg) {
    if (S.viewer) return viewerModel(mode);
    const p = S.project, m = mapArg || curMap();
    normalizeMap(m);
    const vis = visibleArticles();
    const visSet = new Set(vis.map((a) => a.id));
    const lines = m.lines.map((L) => ({ id: L.id, name: L.name, color: L.color, order: L.order.filter((id) => visSet.has(id)), vocab: L.vocab || [] })).filter((L) => L.order.length);
    const lineIds = new Set(lines.map((L) => L.id));
    const colorOf = new Map(lines.map((L) => [L.id, L.color]));
    const stations = new Map();
    for (const a of vis) {
      const as = m.assign[a.id] || {};
      let main = as.main && lineIds.has(as.main) ? as.main : null;
      if (!main) { const L = lines.find((x) => x.order.includes(a.id)); main = L ? L.id : null; }
      stations.set(a.id, { id: a.id, short: a.short, title: a.title || '（無題）', url: a.url, date: a.date, main, sub: as.sub && lineIds.has(as.sub) ? as.sub : null, topicColor: main ? colorOf.get(main) : '#8c9491' });
    }
    return { mode, lines, stations, links: (m.links || []).filter((k) => visSet.has(k.a) && visSet.has(k.b)), seed: m.seed, title: p.title };
  }

  function viewerModel(mode) {
    const v = S.viewer;
    const colorOf = new Map(v.lines.map((L) => [L.id, L.color]));
    const stations = new Map(v.stations.map((s) => [s.id, Object.assign({}, s, { topicColor: s.main ? colorOf.get(s.main) : '#8c9491' })]));
    return { mode, lines: v.lines.map((L) => Object.assign({}, L)), stations, links: v.links, seed: v.seed, title: v.title };
  }

  function relayoutMap(m, all) {
    const { pos } = NT.layout.topic(modelFor('topic', m));
    for (const [id, p] of pos) if (all || !m.manual[id]) m.pos[id] = { x: p.x, y: p.y };
    if (all) m.manual = {};
  }
  function fillMissing(m) {
    const model = modelFor('topic', m);
    const miss = [...model.stations.keys()].filter((id) => !m.pos[id]);
    if (!miss.length) return;
    const { pos } = NT.layout.topic(model);
    for (const id of miss) if (pos.get(id)) m.pos[id] = { x: pos.get(id).x, y: pos.get(id).y };
  }

  /* 編集の共通処理 */
  function mutate(fn, opts) {
    opts = opts || {};
    pushUndo();
    fn();
    afterChange(opts.relayout !== false);
  }
  function afterChange(relayout) {
    if (!S.viewer && S.project && curMap()) {
      const m = curMap();
      normalizeMap(m);
      if (relayout && !m.fixed) relayoutMap(m, false); else fillMissing(m);
    }
    S.rev++;
    save();
    renderMap();
    refreshPanel();
  }

  /* ---------- 取り込み ---------- */
  async function runImport(file) {
    S.abort = new AbortController();
    progress(true, 'ファイルを確認しています', 0);
    try {
      const res = await NT.wxr.importFile(file, { signal: S.abort.signal, onProgress: (m, r) => progress(true, m, r) });
      return res;
    } finally { progress(false); S.abort = null; }
  }

  async function onPickFile(file) {
    if (!file) return;
    try {
      const res = await runImport(file);
      S.imp = res; S.impKind = 'zip'; S.impName = file.name;
      renderImportResult();
      show('import');
    } catch (e) { showError(e); }
  }

  async function onSample() {
    const res = await NT.wxr.buildArticles(NT.demo.demoRaw(), { site: { title: 'デモ（架空の記事）', link: null } });
    S.imp = res; S.impKind = 'demo'; S.impName = 'デモ';
    renderImportResult();
    show('import');
  }

  const STATUS_JA = { draft: '下書き', future: '予約', pending: '承認待ち', private: '非公開', other: '状態不明', nonPost: '記事以外', duplicate: '重複' };
  function excludedText(ex) {
    const parts = Object.entries(ex || {}).filter(([, v]) => v > 0).map(([k, v]) => `${STATUS_JA[k] || k} ${v}件`);
    return parts.length ? parts.join('・') : 'なし';
  }

  function renderImportResult() {
    const r = S.imp;
    const n = r.articles.length;
    $('#imp-headline').textContent = n ? `公開記事 ${n}件 を使います` : '使える公開記事がありませんでした';
    const body = $('#imp-body');
    const kids = [];
    kids.push(h('div', { class: 'stat-grid' },
      h('div', { class: 'stat' }, h('b', {}, n), h('span', {}, '公開記事（採用）')),
      h('div', { class: 'stat' }, h('b', {}, r.excludedTotal), h('span', {}, '除外：' + excludedText(r.excluded))),
      S.impKind === 'demo' ? null : h('div', { class: 'stat' }, h('b', {}, `${r.stats.imgResolved}/${r.stats.imgRefs}`), h('span', {}, '画像参照（ZIP内で対応）')),
    ));
    if (S.impKind === 'demo') kids.push(h('p', { class: 'ok' }, 'デモは架空の日本語記事です。リンク先は example.com の架空URLです。'));
    kids.push(h('p', { class: 'meta' }, '下書き・予約などは路線図にも共有リンクにも入りません。本文は分類のためだけに端末内で使い、共有しません。'));
    if (r.warnings.length) {
      const list = h('ul', { class: 'list' });
      for (const w of r.warnings) {
        const a = r.articles.find((x) => x.id === w.id);
        const li = h('li', {}, h('div', { class: 'li-row' }, h('span', { class: 'grow' }, w.title), h('span', { class: 'meta' }, w.issues.join('・'))));
        if (w.issues.includes('タイトル未設定')) {
          li.append(h('label', { class: 'field' }, h('span', {}, 'タイトルを入力（任意）'), h('input', { type: 'text', value: a.title, placeholder: '（無題）', oninput: (e) => { a.title = e.target.value.trim(); } })));
        }
        list.append(li);
      }
      kids.push(h('div', { class: 'warn' }, h('b', {}, `確認が必要な記事 ${r.warnings.length}件`), h('p', {}, 'タイトル未設定・URL欠損・日付不明でも路線図は作れます。URLが無い記事は「noteで読む」を表示しません。日付不明の記事は最後に並びます。駅名などは後から編集できます。'), list));
    } else if (n) {
      kids.push(h('p', { class: 'ok' }, '公開記事のタイトル・URL・日付はすべて読み取れました。'));
    }
    if (S.project && S.impKind === 'zip' && !S.project.demo) {
      kids.push(h('p', { class: 'warn' }, '端末内に前回の路線図があります。「路線図をつくる」は新しく作り直します。前回の編集を保ったまま記事を追加・更新したいときは、路線図のメニュー →「ZIPを再取り込み」を使ってください。'));
    }
    body.replaceChildren(...kids.filter(Boolean));
    $('#btn-build').disabled = !n;
  }

  async function buildFromImport() {
    const r = S.imp;
    if (S.project && !S.project.demo) {
      const ok = await dialog(h('div', {}, h('h3', {}, '前回の路線図を置き換えますか？'), h('p', {}, '端末内の路線図と編集内容は新しいものに置き換わります。必要ならメニューの「編集用JSONを書き出す」で保存してください。')), [{ label: 'やめる', value: false }, { label: '置き換える', value: true, primary: true }]);
      if (!ok) return;
    }
    const { project, bodies } = newProject(r, S.impKind, S.impName);
    S.project = project; S.bodies = bodies; S.F = null; S.zip = r.zip || null;
    S.undo = []; S.redo = []; S.viewer = null; S.sel = null; S.focus = null;
    generate(0);
    await NT.store.put('private', 'bodies', bodies).catch(() => {});
    await NT.store.put('project', 'current', S.project).catch((e) => toast('端末内保存に失敗：' + e.message));
    NT.store.persist();
    openMap();
  }

  /* ---------- 再取り込み（照合して追加・更新、消えた記事は確認） ---------- */
  async function reimport(file) {
    if (!file) return;
    let res;
    try { res = await runImport(file); } catch (e) { return showError(e); }
    const p = S.project;
    const byId = new Map(p.articles.map((a) => [a.id, a]));
    const byUrl = new Map(p.articles.filter((a) => a.url).map((a) => [a.url, a]));
    const added = [], updated = [], seen = new Set();
    for (const a of res.articles) {
      const old = byId.get(a.id) || (a.url && byUrl.get(a.url));
      if (!old) { added.push(a); continue; }
      seen.add(old.id);
      if (old.title !== a.title || old.date !== a.date || old.url !== a.url) updated.push({ old, a });
      else updated.push({ old, a, same: true });
    }
    const missing = p.articles.filter((a) => !seen.has(a.id));
    const changed = updated.filter((u) => !u.same);
    const checks = new Map();
    const content = h('div', {},
      h('h3', {}, '再取り込みの確認'),
      h('p', {}, `追加 ${added.length}件・更新 ${changed.length}件・変化なし ${updated.length - changed.length}件・ZIPに無い記事 ${missing.length}件`),
      h('p', { class: 'meta' }, '編集した駅名・路線名・所属・位置はそのまま保ちます。追加記事は共通語が合う路線に入り、根拠がなければひとり駅になります。'),
      added.length ? h('div', {}, h('h4', {}, '追加'), h('ul', {}, added.slice(0, 30).map((a) => h('li', {}, a.title || '（無題）')))) : null,
      changed.length ? h('div', {}, h('h4', {}, '更新'), h('ul', {}, changed.slice(0, 30).map((u) => h('li', {}, u.a.title || '（無題）')))) : null,
      missing.length ? h('div', {}, h('h4', {}, '削除候補（チェックしたものだけ図から削除）'), missing.map((a) => { const c = h('input', { type: 'checkbox' }); checks.set(a.id, c); return h('label', { class: 'check' }, c, a.title || a.short); })) : null,
    );
    const ok = await dialog(content, [{ label: 'やめる', value: false }, { label: '反映する', value: true, primary: true }]);
    if (!ok) return;
    mutate(() => {
      for (const u of changed) {
        const o = u.old;
        o.title = u.a.title || o.title; o.date = u.a.date; o.url = u.a.url; o.images = u.a.images; o.warnings = u.a.warnings;
        if (!o.shortEdited) o.short = NT.text.shortName(o.title || '（無題）');
      }
      for (const u of updated) if (u.a._body) S.bodies[u.old.id] = u.a._body;
      const del = missing.filter((a) => checks.get(a.id) && checks.get(a.id).checked).map((a) => a.id);
      p.articles = p.articles.filter((a) => !del.includes(a.id));
      for (const a of added) {
        S.bodies[a.id] = a._body; const o = Object.assign({}, a); delete o._body;
        p.articles.push(Object.assign(o, { short: NT.text.shortName(a.title || '（無題）'), shortEdited: false, imageChoice: 0, imageHidden: false, hidden: false }));
      }
      p.articles.sort((x, y) => (x.date || '9999').localeCompare(y.date || '9999'));
      S.F = null;
      const F = features();
      const m = curMap();
      for (const a of added) {
        const d = F.byId.get(a.id); if (!d) continue;
        let best = null, bs = 0;
        for (const L of m.lines) {
          let s = 0;
          (L.vocab || []).forEach((t, i) => { if (d.strong.has(t) && d.w.has(t)) s += d.w.get(t) * (i ? 0.7 : 1); });
          if (s > bs) { bs = s; best = L; }
        }
        if (best) { insertByDate(best, a.id); m.assign[a.id] = { main: best.id, sub: null }; } else m.assign[a.id] = { main: null, sub: null };
      }
      S.zip = res.zip || S.zip;
      p.excluded = res.excluded; p.stats = res.stats;
    });
    await NT.store.put('private', 'bodies', S.bodies).catch(() => {});
    toast(`反映しました（追加 ${added.length}・更新 ${changed.length}）`);
  }

  function insertByDate(L, id) {
    if (L.order.includes(id)) return;
    const d = (x) => (artById(x) && artById(x).date) || '9999';
    let i = L.order.findIndex((x) => d(x) > d(id));
    if (i < 0) i = L.order.length;
    L.order.splice(i, 0, id);
  }

  /* ---------- 地図画面 ---------- */
  function openMap() {
    show('map');
    S.vb = null;
    const owner = !S.viewer;
    document.querySelectorAll('[data-owner]').forEach((e) => { e.hidden = !owner; });
    document.querySelectorAll('[data-viewer]').forEach((e) => { e.hidden = owner; });
    $('#viewer-badge').hidden = owner;
    document.documentElement.classList.add('on-map');
    S.sel = null; S.focus = null; S.cardOpen = false; S.introPending = true;
    setEdit(false);
    const canTime = owner || S.viewer.opts.dates;
    const canSur = owner || S.viewer.links.length > 0;
    document.querySelector('.seg [data-mode="time"]').disabled = !canTime;
    document.querySelector('.seg [data-mode="surprise"]').disabled = !canSur;
    if (S.mode === 'time' && !canTime) S.mode = 'topic';
    if (S.mode === 'surprise' && !canSur) S.mode = 'topic';
    closePanel();
    renderMap(true);
  }

  function setMode(mode) {
    S.mode = mode; S.focus = null;
    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
    renderMap(true);
    if (mode === 'surprise') openPanel('surprise');
    else if (S.panel && S.panel.kind === 'surprise') closePanel();
  }

  function deriveRows(model, pos) {
    const rows = new Map();
    for (const L of model.lines) {
      const ys = new Map();
      for (const s of model.stations.values()) if (s.main === L.id && pos.has(s.id)) { const y = pos.get(s.id).y; ys.set(y, (ys.get(y) || 0) + 1); }
      let best = null, bc = -1;
      for (const [y, c] of ys) if (c > bc) { bc = c; best = y; }
      if (best == null) { const f = L.order.find((id) => pos.has(id)); best = f ? pos.get(f).y : 0; }
      rows.set(L.id, best);
    }
    return rows;
  }

  function geometry(model) {
    const vig = vignetteIds(model);
    const key = S.rev + '|' + model.mode + '|' + (S.viewer ? 'v' : 'o') + '|' + vig.join(',');
    if (S.geoKey === key && S.geo) return S.geo;
    let pos, opts = {};
    if (model.mode === 'time') {
      const t = NT.layout.time(model);
      pos = t.pos; opts.order = t.order; opts.per = t.per;
    } else if (S.viewer) {
      pos = new Map(S.viewer.stations.map((s) => [s.id, { x: s.x, y: s.y }]));
    } else {
      const m = curMap();
      fillMissing(m);
      pos = new Map([...model.stations.keys()].filter((id) => m.pos[id]).map((id) => [id, m.pos[id]]));
    }
    // 行（段）は位置から導く（所有者・閲覧者で同じ描画になるように）
    const rows = new Map([...deriveRows(model, pos)].map(([k, y]) => [k, y]));
    opts.vignettes = vig;
    const geo = NT.layout.geometry(model, pos, rows, opts);
    S.geo = geo; S.geoKey = key;
    return geo;
  }

  /* 主要駅（乗換駅・終点・始発）の見出し画像候補を小さなカードで添える（本人用・最大4枚・1枚ずつ読み込み） */
  function vignetteIds(model) {
    if (S.viewer) return model.mode === 'time' || !S.viewerThumbs ? [] : [...S.viewerThumbs.keys()].filter((id) => model.stations.has(id));
    if (model.mode === 'time' || !S.project || S.project.settings.showVignettes === false) return [];
    const deg = new Map();
    model.lines.forEach((L) => L.order.forEach((id) => deg.set(id, (deg.get(id) || 0) + 1)));
    const ends = new Set();
    model.lines.forEach((L) => { if (L.order.length) { ends.add(L.order[L.order.length - 1]); ends.add(L.order[0]); } });
    const cands = [...model.stations.keys()].filter((id) => { const a = artById(id); return a && a.images && a.images.length && !a.imageHidden; })
      .map((id) => ({ id, p: (deg.get(id) >= 2 ? 0 : ends.has(id) ? 1 : 2), d: model.stations.get(id).date || '' }))
      .filter((c) => c.p < 2).sort((x, y) => x.p - y.p || y.d.localeCompare(x.d)).slice(0, 4).map((c) => c.id);
    const ready = cands.filter((id) => S.vigUrls.has(id));
    const todo = cands.filter((id) => !S.vigUrls.has(id) && !S.vigTried.has(id));
    // 初回の描画演出の最中は描き直さない（演出が終わってから画像を読む）
    const wait = (S.introUntil || 0) - performance.now();
    if (todo.length && wait > 0) { clearTimeout(S.vigT); S.vigT = setTimeout(() => renderMap(), wait + 50); return ready; }
    if (todo.length) {
      todo.forEach((id) => S.vigTried.add(id));
      Promise.all(todo.map((id) => loadImage(artById(id)).then((u) => { if (u) S.vigUrls.set(id, u); }).catch(() => {})))
        .then(() => { if (todo.some((id) => S.vigUrls.has(id))) renderMap(); });
    }
    return ready;
  }

  const decorHref = (k) => NT.render.assetPath(k);

  function subtitle(model) {
    const dates = [...model.stations.values()].map((s) => s.date).filter(Boolean).sort();
    const span = dates.length ? `${U.fmtMonth(dates[0].slice(0, 7))}〜${U.fmtMonth(dates[dates.length - 1].slice(0, 7))}` : '';
    const modeJa = { topic: '話題でつなぐ', time: '時間でたどる', surprise: '意外な乗換' }[model.mode];
    return [modeJa, `駅 ${model.stations.size}`, `路線 ${model.lines.length}`, span, `seed ${model.seed}`].filter(Boolean).join(' ・ ');
  }

  function highlightSet(model) {
    if (S.multi && S.multiSel.size) return S.multiSel;
    if (S.search && S.search.size) return S.search;
    if (model.mode === 'surprise') { const s = new Set(); model.links.forEach((k) => { s.add(k.a); s.add(k.b); }); return s.size ? s : null; }
    return null;
  }

  function renderMap(fit) {
    if ($('#screen-map').hidden) return;
    const model = modelFor(S.mode);
    if (model.mode !== 'surprise') model.links = [];
    S.model = model;
    $('#map-title').textContent = model.title;
    $('#site-name').textContent = S.viewer ? '' : ((S.project.site && S.project.site.title) || '');
    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === S.mode)));
    const geo = geometry(model);
    // 選んだ駅の所属路線を残して、ほかの路線を少し落ち着かせる
    const selLines = S.sel && !S.focus ? new Set(model.lines.filter((L) => L.order.includes(S.sel)).map((L) => L.id)) : null;
    const intro = !!(fit && S.introPending && !REDUCED.matches);
    S.introPending = false;
    if (intro) S.introUntil = performance.now() + 1600;
    const r = NT.render.svg(model, geo, {
      interactive: true, selected: S.sel, intro,
      focusLine: S.focus, focusLines: selLines, highlight: highlightSet(model), transparentBg: true, vignetteHref: (id) => S.vigUrls.get(id) || (S.viewerThumbs && S.viewerThumbs.get(id)) || '',
    });
    const host = $('#svg-host');
    host.innerHTML = r.svg; // render.svg はすべての文字列をエスケープ済み
    S.svg = host.firstElementChild;
    S.lodKey = null;
    S.svg.removeAttribute('width'); S.svg.removeAttribute('height');
    S.full = r.viewBox;
    renderChips(model);
    if (fit || !S.vb) fitTo(S.full, true, true); else applyVB();
  }

  function legendMark(c) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '36'); svg.setAttribute('height', '16'); svg.setAttribute('aria-hidden', 'true');
    const ln = document.createElementNS(NS, 'path');
    ln.setAttribute('d', 'M3 8H33'); ln.setAttribute('stroke', c); ln.setAttribute('stroke-width', '7'); ln.setAttribute('stroke-linecap', 'round');
    const ci = document.createElementNS(NS, 'circle');
    ci.setAttribute('cx', '18'); ci.setAttribute('cy', '8'); ci.setAttribute('r', '5'); ci.setAttribute('fill', '#fffdf8'); ci.setAttribute('stroke', c); ci.setAttribute('stroke-width', '3');
    svg.append(ln, ci);
    return svg;
  }
  function renderChips(model) {
    const c = $('#chips');
    const kids = [];
    if (model.mode === 'time') kids.push(h('span', { class: 'leg-total' }, '駅の色＝話題の路線'), h('span', { class: 'leg-sep' }));
    const col = (x) => (/^#[0-9a-f]{6}$/i.test(x) ? x : '#888');
    for (const L of model.lines) {
      kids.push(h('button', { type: 'button', class: 'leg', 'aria-pressed': String(S.focus === L.id), onclick: () => focusLine(L.id), 'aria-label': `${L.name}（${L.order.length}駅）を表示` },
        legendMark(col(L.color)), L.name));
    }
    const iso = [...model.stations.values()].filter((s) => !s.main).length;
    if (iso && model.mode !== 'time') kids.push(h('span', { class: 'leg', title: '共通語の根拠がない記事は無理につなぎません' }, h('span', { class: 'iso' }), 'ひとり駅', h('small', {}, `${iso}`)));
    kids.push(h('span', { class: 'leg-sep' }), h('span', { class: 'leg-total' }, `${model.stations.size}記事 ・ ${model.lines.length}路線`));
    c.replaceChildren(...kids);
  }

  function focusLine(id) {
    S.focus = S.focus === id ? null : id;
    renderMap();
    if (S.focus) {
      const g = S.geo; const L = S.model.lines.find((x) => x.id === id);
      const pts = g.stations.filter((s) => L.order.includes(s.id));
      if (pts.length) {
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        fitTo({ x: Math.min(...xs) - 160, y: Math.min(...ys) - 110, w: Math.max(...xs) - Math.min(...xs) + 320, h: Math.max(...ys) - Math.min(...ys) + 220 });
      }
      openPanel('line', id);
    }
  }

  /* ---------- パン・ピンチ ---------- */
  function stageSize() { const r = $('#stage').getBoundingClientRect(); return { w: Math.max(1, r.width), h: Math.max(1, r.height), left: r.left, top: r.top }; }
  // 見出し（上）と凡例（下）が重なる分を除いた領域に収める
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');
  const WIDE = window.matchMedia('(min-width: 900px) and (orientation: landscape), (min-width: 1100px)');
  const isWide = () => WIDE.matches;
  // 見出し（上）・凡例（下）・ズームボタン（右）・記事カード（下）が重なる分を除いた、地図の見える領域
  function insets() {
    const s = stageSize();
    const top = Math.max(0, ($('#topstack').getBoundingClientRect().bottom || 0) - s.top - 6);
    let bottom = 0;
    const pn = $('#panel');
    if (!pn.hidden && !isWide()) bottom = Math.max(0, s.top + s.h - pn.getBoundingClientRect().top) + 8;
    else {
      // 凡例と、その上の小さなズームボタン列の分
      const tl = $('.map-tools').getBoundingClientRect(), lg = $('#chips').getBoundingClientRect();
      const topOf = Math.min(tl.height ? tl.top : Infinity, lg.height ? lg.top : Infinity);
      bottom = isFinite(topOf) ? Math.max(0, s.top + s.h - topOf) + 6 : 0;
    }
    return { top, bottom, right: 8, left: 8 };
  }
  // rect を見える領域に収める。overview=true の自動表示では、小さくなりすぎるなら読める倍率で中心の乗換駅へ
  function fitTo(rect, auto, overview) {
    const s = stageSize();
    const ins = insets();
    const aw = Math.max(80, s.w - ins.left - ins.right), ah = Math.max(80, s.h - ins.top - ins.bottom);
    let k = Math.max(rect.w / aw, rect.h / ah) * 1.04;
    let cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    // 30駅までは全体を見渡す。それより多くて小さくなりすぎる時は、読める倍率で中心の乗換駅（なければ地図の中央付近）へ
    if (overview && 1 / k < 0.36 && S.geo && S.geo.stations.length > 30) {
      k = 1 / 0.62;
      const mx = rect.x + rect.w / 2, my = rect.y + rect.h / 2;
      const hub = S.geo.stations.slice().sort((a, b) => b.lines.length - a.lines.length || Math.hypot(a.x - mx, a.y - my) - Math.hypot(b.x - mx, b.y - my))[0];
      cx = hub.x; cy = hub.y;
    }
    // 見える領域の中心が cx,cy になるように
    const offX = ((ins.left - ins.right) / 2) * k, offY = ((ins.top - ins.bottom) / 2) * k;
    S.vb = { x: cx - (s.w * k) / 2 - offX, y: cy - (s.h * k) / 2 - offY, w: s.w * k, h: s.h * k };
    S.autoFit = !!auto;
    applyVB();
  }
  // 滑らかに表示位置を変える（動きを減らす設定では即座に）
  function animateVB(target, ms) {
    if (!S.vb) { S.vb = target; applyVB(); return; }
    cancelAnimationFrame(S.anim || 0);
    if (REDUCED.matches) { S.vb = target; applyVB(); return; }
    const from = Object.assign({}, S.vb), t0 = performance.now(), dur = ms || 340;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      S.vb = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, w: from.w + (target.w - from.w) * e, h: from.h + (target.h - from.h) * e };
      applyVB();
      if (t < 1) S.anim = requestAnimationFrame(step);
    };
    S.anim = requestAnimationFrame(step);
  }
  // 駅が見える領域に入るよう移動。center=true なら見える領域の中央へ（読みやすい倍率まで寄る）
  function bringIntoView(id, center) {
    if (!S.geo || !S.vb) return;
    const st = S.geo.stations.find((x) => x.id === id);
    if (!st) return;
    const s = stageSize(), ins = insets();
    let v = Object.assign({}, S.vb);
    let k = v.w / s.w;
    if (center && 1 / k < 0.6) { k = 1 / 0.75; v = { x: v.x, y: v.y, w: s.w * k, h: s.h * k }; }
    const sx = (st.x - v.x) / k, sy = (st.y - v.y) / k;
    const L = ins.left + 30, R = s.w - ins.right - 30, T = ins.top + 30, B = s.h - ins.bottom - 40;
    let dx = 0, dy = 0;
    if (center) { dx = sx - (L + R) / 2; dy = sy - (T + B) / 2; } else {
      if (sx < L) dx = sx - L; else if (sx > R) dx = sx - R;
      if (sy < T) dy = sy - T; else if (sy > B) dy = sy - B;
    }
    if (!dx && !dy && v.w === S.vb.w) return;
    S.autoFit = false;
    animateVB({ x: v.x + dx * k, y: v.y + dy * k, w: v.w, h: v.h });
  }
  function applyVB() {
    if (!S.svg || !S.vb) return;
    const v = S.vb;
    S.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    S.lastW = stageSize().w; S.lastH = stageSize().h;
    const ppu = S.lastW / v.w;
    // 遠景で出す重要な駅名は、画面上でおよそ10px以上になるよう少し大きく
    S.svg.style.setProperty('--lf', U.clamp(10.5 / ppu, 17, 44).toFixed(1) + 'px');
    S.svg.classList.toggle('far', ppu < 0.55);
    const lodKey = (ppu < 0.55 ? 'f' : 'n') + Math.round(U.clamp(10.5 / ppu, 17, 44));
    if (S.lodKey !== lodKey) { S.lodKey = lodKey; declutter(); }
    S.svg.classList.toggle('veryfar', ppu < 0.14);
    $('#lod-hint').hidden = !(ppu < 0.55);
  }
  // 遠景では大きめにした重要な駅名どうしが重ならないよう、優先順（乗換駅→始終点）に置けるものだけ表示
  function declutter() {
    if (!S.svg) return;
    const texts = [...S.svg.querySelectorAll('.nt-labels text.lod1')];
    texts.forEach((t) => t.classList.remove('nt-hid'));
    if (!S.svg.classList.contains('far')) return;
    const inter = new Set(S.geo ? S.geo.stations.filter((x) => x.inter).map((x) => x.id) : []);
    const order = texts.map((t, i) => ({ t, i, w: t.classList.contains('is-sel') ? 0 : inter.has(t.getAttribute('data-for')) ? 1 : 2 })).sort((a, b) => a.w - b.w || a.i - b.i);
    const kept = [];
    for (const o of order) {
      let b; try { b = o.t.getBBox(); } catch (e) { continue; }
      const r = { x: b.x - 6, y: b.y - 3, w: b.width + 12, h: b.height + 6 };
      if (kept.some((k) => r.x < k.x + k.w && k.x < r.x + r.w && r.y < k.y + k.h && k.y < r.y + r.h)) o.t.classList.add('nt-hid');
      else kept.push(r);
    }
  }
  function zoomAt(f, cx, cy) {
    S.autoFit = false;
    const s = stageSize();
    const v = S.vb;
    const ppu = s.w / v.w;
    const nppu = U.clamp(ppu * f, 0.04, 4);
    f = nppu / ppu;
    const mx = v.x + (cx / s.w) * v.w, my = v.y + (cy / s.h) * v.h;
    const nw = v.w / f, nh = v.h / f;
    S.vb = { x: mx - (cx / s.w) * nw, y: my - (cy / s.h) * nh, w: nw, h: nh };
    applyVB();
  }
  function toMap(clientX, clientY) {
    const s = stageSize(), v = S.vb;
    return { x: v.x + ((clientX - s.left) / s.w) * v.w, y: v.y + ((clientY - s.top) / s.h) * v.h };
  }

  function setupGestures() {
    const stage = $('#stage');
    const ptrs = new Map();
    let start = null, pinch = null, moved = false, downTarget = null, t0 = 0;
    stage.addEventListener('pointerdown', (e) => {
      // 凡例・ズームボタンの上では地図を動かさない（凡例は自分で横スクロール）
      if (e.target.closest('.map-tools, .legend')) return;
      stage.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 1) {
        moved = false; t0 = Date.now();
        start = { x: e.clientX, y: e.clientY, vb: Object.assign({}, S.vb) };
        downTarget = e.target.closest ? e.target.closest('[data-sid],[data-line]') : null;
        const sid = downTarget && downTarget.getAttribute('data-sid');
        if (sid && S.edit && !S.multi && S.mode !== 'time' && !S.viewer) {
          const m = curMap();
          const p0 = m.pos[sid] ? Object.assign({}, m.pos[sid]) : null;
          S.drag = p0 ? { sid, p0, m0: toMap(e.clientX, e.clientY), active: false } : null;
        } else S.drag = null;
      } else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        S.drag = null; moved = true;
      }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const s = stageSize();
      if (ptrs.size >= 2 && pinch) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        // パン（中点の移動）＋ズーム
        S.vb.x -= ((cx - pinch.cx) / s.w) * S.vb.w; S.vb.y -= ((cy - pinch.cy) / s.h) * S.vb.h;
        zoomAt(d / Math.max(1, pinch.d), cx - s.left, cy - s.top);
        pinch = { d, cx, cy };
        return;
      }
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) > 7) moved = true;
      if (!moved) return;
      if (S.drag) {
        const m = curMap(), p = toMap(e.clientX, e.clientY), g = S.geo;
        if (!S.drag.active) { pushUndo(); S.drag.active = true; }
        m.pos[S.drag.sid] = { x: S.drag.p0.x + (p.x - S.drag.m0.x) / g.S, y: S.drag.p0.y + (p.y - S.drag.m0.y) / g.H };
        if (!S.drag.raf) S.drag.raf = requestAnimationFrame(() => { if (S.drag) S.drag.raf = 0; S.rev++; renderMap(); });
        return;
      }
      S.autoFit = false;
      S.vb = Object.assign({}, start.vb, { x: start.vb.x - (dx / s.w) * start.vb.w, y: start.vb.y - (dy / s.h) * start.vb.h });
      applyVB();
    });
    const end = (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (ptrs.size === 1) { const [a] = [...ptrs.values()]; start = { x: a.x, y: a.y, vb: Object.assign({}, S.vb) }; pinch = null; return; }
      if (ptrs.size > 0) return;
      pinch = null;
      if (S.drag && S.drag.active) {
        const m = curMap(), id = S.drag.sid, p = m.pos[id];
        m.pos[id] = { x: Math.round(p.x * 4) / 4, y: Math.round(p.y * 4) / 4 };
        m.manual[id] = true;
        S.drag = null;
        afterChange(false);
        start = null;
        return;
      }
      S.drag = null;
      if (!moved && e.type === 'pointerup' && Date.now() - t0 < 700) onTap(downTarget);
      start = null;
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('wheel', (e) => {
      if (e.target.closest('.legend')) return;
      e.preventDefault();
      const s = stageSize();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - s.left, e.clientY - s.top);
    }, { passive: false });
    // iOS Safari の独自ジェスチャ（ページ拡大）を抑止
    stage.addEventListener('gesturestart', (e) => e.preventDefault());
    stage.addEventListener('keydown', (e) => {
      const t = e.target.closest && e.target.closest('[data-sid]');
      if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onTap(t); }
    });
    // 回転・パネル開閉で表示領域が変わっても、中心と縮尺を保つ
    const onResize = () => {
      if ($('#screen-map').hidden || !S.vb || !S.lastW) return;
      const s = stageSize();
      if (Math.abs(s.w - S.lastW) < 1 && Math.abs(s.h - S.lastH) < 1) return;
      if (S.autoFit && S.full) { fitTo(S.full, true); return; }
      const k = S.vb.w / S.lastW, c = { x: S.vb.x + S.vb.w / 2, y: S.vb.y + S.vb.h / 2 };
      S.vb = { x: c.x - (s.w * k) / 2, y: c.y - (s.h * k) / 2, w: s.w * k, h: s.h * k };
      applyVB();
    };
    const topH = () => { document.documentElement.style.setProperty('--top-h', Math.round($('#topstack').getBoundingClientRect().height) + 'px'); };
    if (window.ResizeObserver) { new ResizeObserver(onResize).observe(stage); new ResizeObserver(() => { topH(); onResize(); }).observe($('#topstack')); }
    else window.addEventListener('resize', () => { topH(); onResize(); });
    topH();
  }

  function onTap(el) {
    if (!el) { if (S.sel) closePanel(); return; }
    const sid = el.getAttribute('data-sid');
    if (sid) {
      if (S.multi) {
        if (S.multiSel.has(sid)) S.multiSel.delete(sid); else S.multiSel.add(sid);
        renderMap(); openPanel('multi'); return;
      }
      selectStation(sid); return;
    }
    const lid = el.getAttribute('data-line');
    if (lid && lid !== 'time') focusLine(lid);
  }

  function selectStation(id, center) {
    const changed = S.sel !== id;
    S.sel = id;
    S.autoFit = false; // カードが開いて表示領域が変わっても、全体表示に戻して視点を飛ばさない
    if (changed) S.cardOpen = !!(center && S.cardOpen);
    renderMap();
    openPanel('station', id);
    // カードの高さが決まってから、隠れる場合だけ最小限動かす（「次の駅」などは中央へ滑らかに）
    requestAnimationFrame(() => bringIntoView(id, !!center));
    // キーボード操作時はフォーカスを維持
    const g = S.svg && S.svg.querySelector(`[data-sid="${CSS.escape(id)}"]`);
    if (g && document.activeElement && document.activeElement.closest && document.activeElement.closest('#stage')) g.focus();
  }

  /* ---------- パネル ---------- */
  function openPanel(kind, arg) {
    S.panel = { kind, arg };
    const pn = $('#panel');
    pn.hidden = false;
    pn.classList.toggle('tall', kind !== 'station');
    pn.classList.toggle('expanded', kind === 'station' && !!S.cardOpen);
    $('#screen-map').classList.add('card-open');
    refreshPanel();
  }
  // カードを閉じて地図の閲覧に戻る（選んでいた駅の強調も解く）
  function closePanel() {
    const wasStation = S.panel && S.panel.kind === 'station';
    S.panel = null; S.cardOpen = false;
    const pn = $('#panel');
    pn.hidden = true; pn.classList.remove('expanded', 'tall');
    $('#screen-map').classList.remove('card-open');
    if (wasStation && S.sel) { S.sel = null; renderMap(); }
  }
  function setCardExpanded(v) {
    if (!S.panel || S.panel.kind !== 'station') return;
    S.cardOpen = !!v;
    $('#panel').classList.toggle('expanded', S.cardOpen);
    refreshPanel();
    $('#panel-body').scrollTop = 0;
    requestAnimationFrame(() => bringIntoView(S.sel, false));
  }
  function refreshPanel() {
    if (!S.panel) return;
    const { kind, arg } = S.panel;
    const fn = { station: panelStation, line: panelLine, multi: panelMulti, share: panelShare, analysis: panelAnalysis, menu: panelMenu, history: panelHistory, search: panelSearch, surprise: panelSurprise }[kind];
    if (!fn) return;
    const r = fn(arg);
    if (!r) { closePanel(); return; }
    $('#panel-title').textContent = r.title;
    $('#panel-body').replaceChildren(...[].concat(r.body).filter(Boolean));
  }

  function lineChip(L, extra) {
    return h('button', { type: 'button', class: 'pill', style: `background:${L.color}`, onclick: () => focusLine(L.id) }, L.name, extra ? h('small', {}, extra) : null);
  }
  const ART = ['station', 'train', 'bridge', 'town', 'trees', 'clouds'];
  const artFor = (id) => ART[U.hash(String(id)) % ART.length];

  function sharedReason(a, b) {
    if (!S.viewer) {
      const t = NT.classify.sharedTerms(features(), a, b, 4);
      return t.map((x) => NT.text.MOTIF_LABEL[x] || x);
    }
    const A = NT.text.titleTerms(S.model.stations.get(a).title), B = NT.text.titleTerms(S.model.stations.get(b).title);
    return [...A].filter((x) => B.has(x)).slice(0, 4).map((x) => NT.text.MOTIF_LABEL[x] || x);
  }

  const q = (arr) => arr.map((t) => `『${t}』`).join('');
  // 「このつながりの理由」：実際に共通する語だけを短い文で（意味を推測した説明はしない）
  function reasonSentences(id, lines) {
    const out = [];
    const model = S.model;
    for (const L of lines) {
      const i = L.order.indexOf(id);
      const full = !S.viewer && curMap().lines.find((x) => x.id === L.id);
      if (full && full.vocab && full.vocab.length) {
        const d = features().byId.get(id);
        const mine = full.vocab.filter((t) => d && d.strong.has(t)).slice(0, 3).map((t) => NT.text.MOTIF_LABEL[t] || t);
        if (mine.length) out.push(`${L.name}は、${q(mine)}などの言葉でつながっています。`);
      }
      for (const [nb, label] of [[L.order[i - 1], '前の駅'], [L.order[i + 1], '次の駅']]) {
        if (!nb) continue;
        const t = sharedReason(id, nb).slice(0, 3);
        const name = model.stations.get(nb).short;
        out.push(t.length ? `${label}「${name}」とは、${q(t)}という言葉が共通しています。` : `${label}「${name}」とは直接の共通語はなく、路線の言葉でつながっています。`);
      }
    }
    if (!lines.length) out.push('ほかの記事と共通する特徴的な言葉が見つからなかったので、無理につながず「ひとり駅」にしています。');
    const links = (S.mode === 'surprise' ? model.links : []).filter((k) => k.a === id || k.b === id);
    for (const k of links) {
      const o = model.stations.get(k.a === id ? k.b : k.a).short;
      out.push(k.term ? `「${o}」とは、全体ではめずらしい${q([NT.text.MOTIF_LABEL[k.term] || k.term])}という言葉が共通しています（意外な乗換）。` : `「${o}」と意外な乗換でつながっています（共通語はタイトルの外にあるため表示しません）。`);
    }
    if (S.viewer) out.push('閲覧モードでは、共有されたタイトルだけから共通語を探しています。');
    return out;
  }

  function panelStation(id) {
    const model = S.model; const s = model && model.stations.get(id);
    if (!s) return null;
    const a = S.viewer ? null : artById(id);
    const lines = model.lines.filter((L) => L.order.includes(id));
    const full = isWide() || S.cardOpen;
    const body = [];
    // 1) 小さなカード：正式タイトルを主役に、路線は小さなタグで
    body.push(h('div', { class: 'st-tags' }, lines.length
      ? lines.map((L) => h('button', { type: 'button', class: 'tag', style: `background:${L.color}`, onclick: () => transferTo(L.id), 'aria-label': `${L.name}を見る` }, L.name))
      : h('span', { class: 'tag iso' }, 'ひとり駅')));
    body.push(h('h2', { class: 'card-title' }, s.title));
    const date = s.date ? U.fmtDate(s.date) : (S.viewer && !S.viewer.opts.dates ? '公開日は共有されていません' : '公開日不明');
    body.push(h('p', { class: 'card-date' }, date));
    const demo = s.url && s.url.startsWith(NT.demo.BASE);
    const read = s.url && !demo
      ? h('a', { class: 'btn read-btn', href: s.url, target: '_blank', rel: 'noopener noreferrer' }, 'noteで読む', h('span', { 'aria-hidden': 'true' }, '↗'))
      : h('span', { class: 'read-btn disabled' }, demo ? 'デモ記事のためリンクはありません' : '元記事のURLがありません');
    body.push(h('div', { class: 'card-row' }, read,
      isWide() ? null : h('button', { type: 'button', class: 'more-btn', 'aria-expanded': String(!!S.cardOpen), onclick: () => setCardExpanded(!S.cardOpen) }, S.cardOpen ? 'たたむ' : '詳しく見る')));
    if (!full) return { title: '', body };
    // 2) 詳細：前後の駅・乗り換え・理由
    const det = h('div', { class: 'card-detail' });
    for (const L of lines) {
      const i = L.order.indexOf(id);
      const prev = L.order[i - 1], next = L.order[i + 1];
      det.append(h('p', { class: 'nav-line' }, h('i', { style: `background:${L.color}` }), `${L.name}（${i + 1} / ${L.order.length}駅）`));
      det.append(h('div', { class: 'nav-row' },
        prev ? btn(`‹ ${model.stations.get(prev).short}`, () => selectStation(prev, true), 'small', { 'aria-label': `前の駅：${model.stations.get(prev).short}` }) : h('span', { class: 'btn small', style: 'visibility:hidden;flex:1' }, '・'),
        next ? btn(`${model.stations.get(next).short} ›`, () => selectStation(next, true), 'small next', { 'aria-label': `次の駅：${model.stations.get(next).short}` }) : h('span', { class: 'meta', style: 'flex:1;text-align:right;align-self:center' }, '終点')));
    }
    if (lines.length > 1) {
      det.append(h('h4', {}, 'この駅で乗り換え'), h('div', { class: 'pills' }, lines.map((L) => h('button', { type: 'button', class: 'pill', style: `background:${L.color}`, onclick: () => transferTo(L.id) }, `${L.name}へ`))));
    }
    const why = h('details', { class: 'why' }, h('summary', {}, 'このつながりの理由'), reasonSentences(id, lines).map((t) => h('p', {}, t)));
    det.append(why);
    if (s.short && s.short !== s.title) det.append(h('p', { class: 'meta' }, `地図での駅名：${s.short}`));
    if (a && a.warnings && a.warnings.length) det.append(h('p', { class: 'warn' }, '注意：' + a.warnings.join('・')));
    // 見出し画像候補（本人用）
    if (a && a.images && a.images.length) {
      det.append(h('h4', {}, '見出し画像候補'));
      if (!a.imageHidden) {
        const art = h('div', { class: 'art' });
        loadImage(a).then((url) => { if (url) art.replaceChildren(h('img', { src: url, alt: '見出し画像候補' }), h('span', { class: 'art-note' }, '本人だけに表示')); else art.remove(); });
        det.append(art);
      }
      det.append(h('p', { class: 'meta' }, a.imageHidden ? '非表示にしています。' : `本文の${a.imageChoice % a.images.length + 1}番目の画像（全${a.images.length}枚）。正式な見出し画像とは限りません。共有・書き出しには含めません。`));
      det.append(h('div', { class: 'row' },
        a.images.length > 1 && !a.imageHidden ? btn('別の候補', () => { a.imageChoice = (a.imageChoice + 1) % a.images.length; S.vigUrls.delete(a.id); S.vigTried.delete(a.id); save(); renderMap(); refreshPanel(); }) : null,
        btn(a.imageHidden ? '表示する' : '非表示にする', () => { a.imageHidden = !a.imageHidden; save(); renderMap(); refreshPanel(); })));
    }
    if (S.edit && a) det.append(editStation(a, s));
    body.push(det);
    return { title: '', body };
  }
  // 乗り換え：その路線を強調して見渡す（記事カードは開いたまま）
  function transferTo(lineId) {
    S.focus = S.focus === lineId ? null : lineId;
    renderMap();
    renderChips(S.model);
  }

  function editStation(a, s) {
    const m = curMap();
    const as = m.assign[a.id] || { main: null, sub: null };
    const opts = (cur, none) => [h('option', { value: '' }, none)].concat(m.lines.map((L) => h('option', { value: L.id, selected: L.id === cur }, L.name)));
    const mainSel = h('select', {}, opts(as.main, '（ひとり駅）'));
    const subSel = h('select', {}, opts(as.sub, '（なし）'));
    const apply = () => mutate(() => setMembership(m, a.id, mainSel.value || null, subSel.value || null));
    mainSel.addEventListener('change', apply); subSel.addEventListener('change', apply);
    const name = h('input', { type: 'text', value: a.short, maxlength: '30' });
    name.addEventListener('change', () => { if (name.value.trim() === a.short) return; mutate(() => { a.short = name.value.trim() || NT.text.shortName(a.title); a.shortEdited = true; }, { relayout: false }); });
    const title = h('input', { type: 'text', value: a.title, maxlength: '300' });
    title.addEventListener('change', () => title.value.trim() !== a.title && mutate(() => { a.title = title.value.trim(); a.warnings = (a.warnings || []).filter((w) => w !== 'タイトル未設定' || !a.title); }, { relayout: false }));
    const mainLine = m.lines.find((L) => L.id === as.main);
    return h('div', {},
      h('h4', {}, '編集'),
      h('label', { class: 'field' }, h('span', {}, '駅名（短い名前）'), name),
      !a.title || (a.warnings || []).includes('タイトル未設定') ? h('label', { class: 'field' }, h('span', {}, '原題'), title) : null,
      h('label', { class: 'field' }, h('span', {}, '主路線'), mainSel),
      h('label', { class: 'field' }, h('span', {}, '副路線（乗換）'), subSel),
      mainLine ? h('div', { class: 'row' }, h('span', { class: 'meta' }, `${mainLine.name}での順番`), btn('← 前へ', () => mutate(() => moveInLine(mainLine, a.id, -1))), btn('次へ →', () => mutate(() => moveInLine(mainLine, a.id, 1)))) : null,
      h('div', { class: 'row' }, btn('駅名を自動に戻す', () => mutate(() => { a.short = NT.text.shortName(a.title || '（無題）'); a.shortEdited = false; }, { relayout: false })),
        btn('図から外す', () => mutate(() => { a.hidden = true; S.F = null; S.sel = null; closePanel(); }), 'small danger')),
      h('p', { class: 'meta' }, '図から外した記事は共有・書き出しにも入りません。メニューから戻せます。'));
  }

  function setMembership(m, id, main, sub) {
    if (sub === main) sub = null;
    for (const L of m.lines) {
      const should = L.id === main || L.id === sub;
      const has = L.order.includes(id);
      if (should && !has) { insertByDate(L, id); L.edited = true; }
      if (!should && has) { L.order = L.order.filter((x) => x !== id); L.edited = true; }
    }
    m.assign[id] = { main, sub };
  }
  function moveInLine(L, id, d) {
    const i = L.order.indexOf(id), j = i + d;
    if (i < 0 || j < 0 || j >= L.order.length) return;
    [L.order[i], L.order[j]] = [L.order[j], L.order[i]];
    L.edited = true;
  }

  const SWATCHES = NT.classify.PALETTE;
  function panelLine(id) {
    const model = S.model; const L = model && model.lines.find((x) => x.id === id);
    if (!L) return null;
    const full = S.viewer ? null : curMap().lines.find((x) => x.id === id);
    const body = [];
    body.push(h('p', { class: 'st-name' }, h('span', { class: 'swatch', style: `display:inline-block;vertical-align:middle;margin-right:8px;background:${L.color}` }), L.name));
    body.push(h('p', { class: 'meta' }, `${L.order.length}駅（日付順が基本）`));
    if (full && full.vocab && full.vocab.length) body.push(h('p', { class: 'reason' }, '共通語：', h('b', {}, full.vocab.map((t) => NT.text.MOTIF_LABEL[t] || t).join('・'))));
    if (full && full.locked) body.push(h('p', { class: 'ok' }, '固定中：「別の路線図にする」でもこの路線は保たれます。'));
    if (S.edit && full) {
      const name = h('input', { type: 'text', value: full.name, maxlength: '30' });
      name.addEventListener('change', () => { if (name.value.trim() === full.name) return; mutate(() => { full.name = name.value.trim() || full.name; full.edited = true; }, { relayout: false }); });
      body.push(h('label', { class: 'field' }, h('span', {}, '路線名'), name));
      body.push(h('div', { class: 'swatches', role: 'group', 'aria-label': '路線の色' }, SWATCHES.map((c) => h('button', { type: 'button', 'aria-label': '色 ' + c, 'aria-pressed': String(full.color === c), style: `background:${c}`, onclick: () => mutate(() => { full.color = c; full.edited = true; }, { relayout: false }) }))));
      body.push(h('div', { class: 'row' },
        btn(full.locked ? '固定を解除' : 'この路線を固定', () => mutate(() => { full.locked = !full.locked; }, { relayout: false })),
        btn('日付順に並べ直す', () => mutate(() => { const d = (x) => (artById(x) && artById(x).date) || '9999'; full.order.sort((p, q) => d(p).localeCompare(d(q))); full.edited = true; })),
        btn('路線を削除', async () => {
          const ok = await dialog('この路線を削除しますか？主路線だった駅はひとり駅（または副路線）になります。取り消しで戻せます。', [{ label: 'やめる', value: false }, { label: '削除', value: true, danger: true }]);
          if (ok) mutate(() => { const m = curMap(); m.lines = m.lines.filter((x) => x.id !== id); S.focus = null; });
        }, 'small danger')));
    }
    const list = h('ul', { class: 'list' });
    L.order.forEach((sid, i) => {
      const st = model.stations.get(sid);
      list.append(h('li', {}, h('div', { class: 'li-row' },
        h('button', { type: 'button', class: 'btn link grow', style: 'justify-content:flex-start', onclick: () => selectStation(sid, true) }, `${i + 1}. ${st.short}`),
        h('span', { class: 'meta' }, st.date ? st.date.slice(0, 10) : ''),
        S.edit && full ? [btn('↑', () => mutate(() => moveInLine(full, sid, -1)), 'small', { 'aria-label': '上へ' }), btn('↓', () => mutate(() => moveInLine(full, sid, 1)), 'small', { 'aria-label': '下へ' })] : null)));
    });
    body.push(h('h4', {}, '駅の一覧'), list);
    return { title: '路線', body };
  }

  function panelMulti() {
    if (!S.multi) return null;
    const m = curMap();
    const ids = [...S.multiSel];
    const body = [h('p', {}, `${ids.length}駅を選択中。駅をタップして追加・解除します。`)];
    if (ids.length) {
      body.push(h('p', { class: 'meta' }, ids.map((id) => S.model.stations.get(id) && S.model.stations.get(id).short).filter(Boolean).join('、')));
      const sel = h('select', {}, [h('option', { value: '' }, '（ひとり駅にする）')].concat(m.lines.map((L) => h('option', { value: L.id }, L.name))));
      body.push(h('label', { class: 'field' }, h('span', {}, 'まとめて主路線を変更'), sel));
      body.push(h('div', { class: 'row' },
        btn('移動する', () => mutate(() => { for (const id of ids) { const as = m.assign[id] || {}; setMembership(m, id, sel.value || null, as.sub === sel.value ? null : as.sub || null); } }), 'small primary'),
        btn('副路線に追加', () => { if (!sel.value) return toast('路線を選んでください'); mutate(() => { for (const id of ids) { const as = m.assign[id] || {}; if (as.main && as.main !== sel.value) setMembership(m, id, as.main, sel.value); else if (!as.main) setMembership(m, id, sel.value, null); } }); })));
      const nm = h('input', { type: 'text', placeholder: '新しい路線名（空欄なら共通語から）' });
      body.push(h('label', { class: 'field' }, h('span', {}, '選んだ駅で新しい路線をつくる'), nm));
      body.push(h('div', { class: 'row' },
        btn('新しい路線にする', () => {
          if (ids.length < 2) return toast('2駅以上選んでください');
          mutate(() => {
            let name = nm.value.trim();
            const F = features();
            const terms = ids.length ? [...(F.byId.get(ids[0]) || { strong: new Set() }).strong].filter((t) => ids.every((id) => F.byId.get(id) && F.byId.get(id).strong.has(t))) : [];
            if (!name) name = terms.length ? (NT.text.MOTIF_LABEL[terms[0]] ? terms[0] : NT.text.display(terms[0], ids.map((id) => artById(id).title))) + '線' : '新しい路線';
            const used = new Set(m.lines.map((L) => L.color));
            const L = { id: U.uid('L'), name, color: SWATCHES.find((c) => !used.has(c)) || SWATCHES[m.lines.length % SWATCHES.length], order: [], vocab: terms.slice(0, 3), edited: true, locked: false };
            m.lines.push(L);
            for (const id of ids) setMembership(m, id, L.id, null);
          });
        }, 'small primary'),
        btn('図から外す', () => mutate(() => { ids.forEach((id) => { artById(id).hidden = true; }); S.multiSel.clear(); S.F = null; }), 'small danger'),
        btn('選択を解除', () => { S.multiSel.clear(); renderMap(); refreshPanel(); })));
    }
    return { title: 'まとめて編集', body };
  }

  function panelSurprise() {
    const model = S.model;
    if (!model) return null;
    const body = [h('p', { class: 'meta' }, '主路線がちがう記事のうち、全体ではめったに出ない共通語を持つ組み合わせだけを点線でつなぎます。根拠がない組み合わせは作りません。')];
    if (!model.links.length) body.push(h('p', { class: 'reason' }, '意外な乗換は見つかりませんでした。'));
    for (const k of model.links) {
      const A = model.stations.get(k.a), B = model.stations.get(k.b);
      body.push(h('div', { class: 'reason' }, h('div', {}, `${A.short} ↔ ${B.short}`), k.term ? h('div', {}, '珍しい共通語：', h('b', {}, NT.text.MOTIF_LABEL[k.term] || k.term)) : null,
        h('div', { class: 'row' }, btn(A.short, () => selectStation(k.a, true)), btn(B.short, () => selectStation(k.b, true)))));
    }
    return { title: '意外な乗換', body };
  }

  function panelSearch() {
    const input = h('input', { type: 'text', placeholder: '駅名・タイトルで検索', 'aria-label': '検索語' });
    const list = h('ul', { class: 'list' });
    const run = () => {
      const q = NT.text.normalize(input.value.trim());
      list.replaceChildren();
      S.search = null;
      if (!q) { renderMap(); return; }
      const hits = [...S.model.stations.values()].filter((s) => NT.text.normalize(s.short + ' ' + s.title).includes(q));
      S.search = new Set(hits.map((s) => s.id));
      renderMap();
      for (const s of hits.slice(0, 80)) list.append(h('li', {}, h('button', { type: 'button', onclick: () => selectStation(s.id, true) }, h('span', { class: 'grow' }, s.short), h('span', { class: 'meta' }, s.date ? s.date.slice(0, 10) : ''))));
      if (!hits.length) list.append(h('li', {}, h('div', { class: 'li-row meta' }, '見つかりませんでした')));
    };
    input.addEventListener('input', run);
    setTimeout(() => input.focus(), 50);
    return { title: '駅を検索', body: [input, list] };
  }

  /* ---------- 共有 ---------- */
  function isPermanentHere() {
    if (location.protocol !== 'https:') return false;
    const host = location.hostname;
    if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(host) || host.endsWith('.local')) return false;
    if (/claude|anthropic|usercontent|ngrok|trycloudflare|loca\.lt|localhost\.run|csb\.app|stackblitz|webcontainer|githubpreview|gitpod|codespaces|app\.github\.dev/.test(host)) return false;
    return true;
  }
  function publicBase() {
    const s = S.project && S.project.settings.baseUrl;
    if (s && U.safeUrl(s)) return U.safeUrl(s).split('#')[0];
    if (isPermanentHere()) return location.origin + location.pathname;
    return '';
  }

  function shareView(scope) {
    const model = modelFor('topic');
    const m = curMap();
    let ids = [...model.stations.keys()];
    let lines = model.lines;
    if (scope.line) {
      const L = lines.find((x) => x.id === scope.line);
      ids = L ? L.order.slice() : [];
      lines = L ? [L] : [];
    }
    if (scope.recent) {
      const sorted = ids.slice().sort((a, b) => (model.stations.get(b).date || '').localeCompare(model.stations.get(a).date || ''));
      ids = sorted.slice(0, scope.recent);
    }
    const keep = new Set(ids);
    lines = lines.map((L) => ({ id: L.id, name: L.name, color: L.color, order: L.order.filter((id) => keep.has(id)) })).filter((L) => L.order.length);
    const lineIds = new Set(lines.map((L) => L.id));
    const stations = ids.map((id) => {
      const s = model.stations.get(id);
      const p = m.pos[id] || { x: 0, y: 0 };
      let main = s.main && lineIds.has(s.main) ? s.main : (lines.find((L) => L.order.includes(id)) || {}).id || null;
      return { id, short: s.short, title: s.title, url: s.url, date: s.date, x: p.x, y: p.y, main };
    });
    // 接点の語は、両方のタイトルに出る（＝公開情報の）ときだけ含める
    const links = S.project.settings.shareLinks ? (m.links || []).filter((k) => keep.has(k.a) && keep.has(k.b)).map((k) => {
      const A = NT.text.titleTerms(model.stations.get(k.a).title), B = NT.text.titleTerms(model.stations.get(k.b).title);
      return { a: k.a, b: k.b, term: A.has(k.term) && B.has(k.term) ? k.term : '' };
    }) : [];
    return { title: S.project.title, mode: S.mode, seed: m.seed, lines, stations, links };
  }

  function panelShare(scopeArg) {
    if (S.viewer) return null;
    const st = S.project.settings;
    const scope = scopeArg || {};
    const view = shareView(scope);
    const enc = NT.share.encode(view, { dates: st.shareDates, analysis: st.shareAnalysis });
    const base = publicBase();
    const url = base ? NT.share.buildUrl(base, enc.fragment) : '';
    const len = url ? url.length : enc.fragment.length + 40;
    const over = len > st.shareLimit;
    const body = [];
    body.push(h('div', { class: 'stat-grid' },
      h('div', { class: 'stat' }, h('b', {}, view.stations.length), h('span', {}, '共有する記事')),
      h('div', { class: 'stat' }, h('b', {}, view.lines.length), h('span', {}, '路線')),
      h('div', { class: 'stat' }, h('b', {}, len.toLocaleString()), h('span', {}, `URL文字数（目安 ${st.shareLimit.toLocaleString()}）`))));
    body.push(h('div', { class: 'reason' },
      h('div', {}, h('b', {}, '含めるもの：'), '駅名・原題・元記事URL・路線・駅順・配置・seed' + (st.shareDates ? '・公開日' : '') + (st.shareLinks ? '・意外な乗換' : '') + (st.shareAnalysis ? '・振り返り（月別数・路線別数）' : '')),
      h('div', {}, h('b', {}, '含めないもの：'), '本文・抜粋・下書き・図から外した記事・画像・添付・原本ZIP・本文由来の共通語')));
    body.push(h('p', { class: 'meta' }, '圧縮は暗号化ではありません。リンクを知っている人は上の内容を見られます。共有データは「#」より後ろにあり、サーバーへは送られません。'));
    const chk = (label, key) => { const c = h('input', { type: 'checkbox', checked: !!st[key] }); c.addEventListener('change', () => { st[key] = c.checked; save(); openPanel('share', scope); }); return h('label', { class: 'check' }, c, label); };
    body.push(chk('公開日を含める', 'shareDates'), chk('意外な乗換を含める', 'shareLinks'), chk('振り返り（月別投稿数・路線別記事数）を含める', 'shareAnalysis'));
    // 範囲
    const scopeSel = h('select', {}, h('option', { value: '' }, 'すべての路線'), S.model.lines.map((L) => h('option', { value: 'line:' + L.id, selected: scope.line === L.id }, `路線のみ：${L.name}`)),
      [10, 30, 60, 100].filter((n) => n < S.model.stations.size).map((n) => h('option', { value: 'recent:' + n, selected: scope.recent === n }, `最近の${n}記事だけ`)));
    scopeSel.addEventListener('change', () => { const v = scopeSel.value; openPanel('share', v.startsWith('line:') ? { line: v.slice(5) } : v.startsWith('recent:') ? { recent: +v.slice(7) } : {}); });
    body.push(h('label', { class: 'field' }, h('span', {}, '共有する範囲'), scopeSel));
    if (!base) {
      const inp = h('input', { type: 'url', placeholder: 'https://（公開したこのアプリのURL）', value: st.baseUrl || '' });
      inp.addEventListener('change', () => { const u = U.safeUrl(inp.value); if (inp.value && !u) return toast('https のURLを入力してください'); st.baseUrl = u ? u.split('#')[0] : ''; save(); openPanel('share', scope); });
      body.push(h('div', { class: 'warn' }, h('p', {}, `いま開いているページ（${location.protocol === 'file:' ? 'ファイル' : location.host || location.protocol}）は一時的なアドレスなので、ほかの人は開けません。このアプリを公開しているアドレスを入力してください（例：https://mamochi-ai.github.io/note_station/）。`), inp));
    } else if (st.baseUrl) {
      body.push(h('p', { class: 'meta' }, '共有リンクの先頭アドレス：' + base + '（メニューで変更できます）'));
    }
    if (over) {
      body.push(h('div', { class: 'warn' }, h('b', {}, `URLが目安（${st.shareLimit.toLocaleString()}文字）を超えています。`),
        h('p', {}, '共有先によっては途中で切れて開けなくなります。次の方法を選んでください。'),
        h('div', { class: 'row' },
          S.model.lines[0] ? btn('路線ごとに共有する', () => openPanel('share', { line: S.model.lines[0].id })) : null,
          btn('記事を絞る（最近30件）', () => openPanel('share', { recent: 30 })),
          btn('閲覧用HTMLを保存', () => exportHtml(view)))));
    }
    if (url) {
      const ta = h('textarea', { readonly: true, 'aria-label': '共有URL' }, url);
      body.push(ta);
      body.push(h('div', { class: 'row' },
        btn('URLをコピー', () => copyText(url, ta), 'small primary'),
        navigator.share ? btn('共有シート', () => navigator.share({ url, title: S.project.title }).catch(() => {})) : null,
        h('a', { class: 'btn small', href: url, target: '_blank', rel: 'noopener noreferrer' }, '閲覧画面で確認 ↗')));
      body.push(h('p', { class: 'meta' }, 'URLの長さの上限はブラウザや共有先（SNS・メッセージアプリ）ごとに異なり、一律の保証はできません。届いたリンクが開けるか、一度確かめてください。'));
    }
    return { title: '共有', body };
  }

  async function copyText(text, ta) {
    try { await navigator.clipboard.writeText(text); toast('コピーしました'); }
    catch (e) { if (ta) { ta.focus(); ta.select(); try { document.execCommand('copy'); toast('コピーしました'); return; } catch (x) { /* ignore */ } } toast('コピーできませんでした。テキストを長押ししてコピーしてください'); }
  }

  /* ---------- 振り返り ---------- */
  function panelAnalysis() {
    const model = modelFor('topic');
    const view = { lines: model.lines, stations: [...model.stations.values()] };
    if (S.viewer && !S.viewer.opts.dates) view.stations = view.stations.map((s) => Object.assign({}, s, { date: null }));
    const A = NT.analysis.compute(view, S.viewer ? null : features());
    const body = [];
    body.push(h('div', { class: 'stat-grid' },
      h('div', { class: 'stat' }, h('b', {}, A.unique), h('span', {}, 'ユニーク記事数')),
      h('div', { class: 'stat' }, h('b', {}, model.lines.length), h('span', {}, '路線')),
      h('div', { class: 'stat' }, h('b', {}, A.bridges.length), h('span', {}, '複数テーマをつなぐ記事')),
      h('div', { class: 'stat' }, h('b', {}, A.isolated), h('span', {}, 'ひとり駅'))));
    if (A.monthly.length) {
      const mx = Math.max(...A.monthly.map((x) => x.n), 1);
      body.push(h('h4', {}, '月別の投稿数'), h('div', { class: 'bars' }, A.monthly.map((x) => h('div', { class: 'barrow' }, h('span', {}, U.fmtMonth(x.k)), h('div', { class: 'b', style: `width:${(x.n / mx) * 100}%` }), h('span', {}, x.n)))));
      if (A.undated) body.push(h('p', { class: 'meta' }, `日付不明 ${A.undated}件は含みません。`));
    } else body.push(h('p', { class: 'meta' }, '日付がないため月別の集計はできません。'));
    const mxl = Math.max(...A.perLine.map((x) => x.n), 1);
    body.push(h('h4', {}, '路線ごとの記事数'), h('div', { class: 'bars' }, A.perLine.map((x) => h('div', { class: 'barrow' }, h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, x.name), h('div', { class: 'b', style: `width:${(x.n / mxl) * 100}%;background:${x.color}` }), h('span', {}, x.n)))));
    body.push(h('p', { class: 'meta' }, `乗換駅は所属するすべての路線で数えています（合計はユニーク記事数 ${A.unique}件と一致しません）。`));
    if (A.terms) body.push(h('h4', {}, 'よく登場する特徴語'), h('div', {}, A.terms.map((t) => h('span', { class: 'term' }, `${NT.text.MOTIF_LABEL[t.t] || t.t} ${t.c}`))), h('p', { class: 'meta' }, '各記事の上位の特徴語が、何記事に出たか。'));
    body.push(h('h4', {}, '最近と以前の比較'));
    if (!A.trend.ok) body.push(h('p', { class: 'reason' }, A.trend.reason));
    else {
      body.push(h('p', { class: 'meta' }, `${U.fmtDate(A.trend.split)}を境に、以前${A.trend.earlyN}件・最近${A.trend.lateN}件で比べた路線ごとの記事数`));
      body.push(h('ul', { class: 'list' }, A.trend.rows.map((r) => h('li', {}, h('div', { class: 'li-row' }, h('span', { class: 'swatch', style: `background:${r.color}` }), h('span', { class: 'grow' }, r.name), h('span', {}, `${r.early} → ${r.late}`), h('b', {}, r.diff > 0 ? `+${r.diff}` : String(r.diff)))))));
    }
    if (A.bridges.length) {
      body.push(h('h4', {}, '複数テーマをつなぐ記事'));
      body.push(h('div', { class: 'row' }, A.bridges.slice(0, 20).map((b) => btn(b.short, () => { if (S.mode === 'time') setMode('topic'); selectStation(b.id, true); }))));
    }
    body.push(h('p', { class: 'meta' }, 'スキ数・PV・読者の反応はZIPに含まれないため扱いません。性格や能力の診断はしません。' + (S.viewer ? '' : ' この画面は本人用です（共有には既定で含めません）。')));
    return { title: '振り返り', body };
  }

  /* ---------- 履歴 ---------- */
  function panelHistory() {
    if (S.viewer) return null;
    const p = S.project;
    const list = h('ul', { class: 'list' });
    p.maps.slice().reverse().forEach((m) => {
      const cur = m.id === p.currentMap;
      const edited = m.lines.some((L) => L.edited) || Object.keys(m.manual || {}).length;
      list.append(h('li', {}, h('div', { class: 'li-row' },
        btn(m.favorite ? '★' : '☆', () => { m.favorite = !m.favorite; save(); refreshPanel(); }, 'small', { 'aria-label': 'お気に入り' }),
        h('span', { class: 'grow' }, `${m.label || m.lines.map((L) => L.name).slice(0, 3).join('・') || '路線なし'}`, h('br'), h('span', { class: 'meta' }, `seed ${m.seed} ・ ${new Date(m.createdAt).toLocaleString('ja-JP')}${edited ? ' ・ 編集あり' : ''}${cur ? ' ・ 表示中' : ''}`)),
        cur ? null : btn('開く', () => switchMap(m.id)))));
    });
    return { title: '図の履歴', body: [h('p', { class: 'meta' }, '「別の路線図にする」で作った図はここに残ります。編集した図が上書きされることはありません。★でお気に入りにすると自動整理されません。'), list] };
  }
  function switchMap(id) {
    pushUndo();
    S.project.currentMap = id; S.rev++; S.sel = null; S.focus = null;
    save(); renderMap(true); refreshPanel();
  }

  /* ---------- メニュー ---------- */
  function panelMenu() {
    const body = [];
    const prevDisabled = !S.project || S.viewer || S.project.maps.findIndex((m) => m.id === S.project.currentMap) <= 0;
    body.push(h('div', { class: 'menu-list' },
      S.viewer ? null : btn('路線図を編集', () => { setEdit(!S.edit); closePanel(); toast(S.edit ? '編集モード：駅をタップして名前や所属を変えられます' : '編集を終えました'); }, 'small', { id: 'btn-edit', 'aria-pressed': String(S.edit) }),
      btn('画像で保存', () => exportImage('png'), 'small', { id: 'btn-save-img' }),
      S.viewer ? null : btn('別の路線図にする', () => { closePanel(); regen(); }, 'small'),
      S.viewer ? null : btn('前の図に戻る', () => { closePanel(); prevMap(); }, 'small', { id: 'btn-prev-map', disabled: prevDisabled }),
      S.viewer && !S.viewer.opts.analysis ? null : btn('振り返り', () => openPanel('analysis'), 'small', { id: 'btn-analysis' }),
      btn('駅を検索', () => openPanel('search'), 'small'),
      S.viewer ? null : btn('図の履歴', () => openPanel('history'), 'small')));
    body.push(h('h4', {}, '書き出し'));
    if (!S.viewer) {
      const ex = h('input', { type: 'checkbox', checked: !!S.project.settings.exportThumbs });
      ex.addEventListener('change', () => { S.project.settings.exportThumbs = ex.checked; save(); });
      body.push(h('label', { class: 'check' }, ex, h('span', {}, '「画像で保存」と「閲覧用HTML」に、地図上の画像カード（主要駅の見出し画像候補）も入れる',
        h('br'), h('small', { class: 'meta' }, '記事の本文にある先頭の画像が、そのまま人に見えます。見せたくない画像は、駅のカードの「詳しく見る」→「非表示にする」で外してください。共有URLには画像は入りません。'))));
    }
    body.push(h('div', { class: 'row' },
      btn('SVG（図）', () => exportImage('svg')),
      btn('PNG（画像）', () => exportImage('png')),
      S.viewer ? null : btn('閲覧用HTML', () => exportHtml(shareView({})))));
    body.push(h('p', { class: 'meta' }, 'PNG/SVGは図の画像です。駅をタップして記事を開くことはできません。閲覧用HTMLは1ファイルで動き、本文を含みません（iPhone/iPadでHTMLファイルを開けるかは環境によるため、共有は主にURLで行ってください）。'));
    if (S.viewer) {
      body.push(h('h4', {}, 'このリンク'), h('div', { class: 'row' }, btn('このURLをコピー', () => copyText(location.href)), btn('自分用にコピーして編集', copyToOwn, 'small primary')));
      body.push(about());
      return { title: 'メニュー', body };
    }
    const withBody = h('input', { type: 'checkbox' });
    body.push(h('h4', {}, '保存と復元'));
    body.push(h('p', { class: 'meta' }, '路線図はこの端末のブラウザ内（IndexedDB）に自動保存します。ブラウザのデータ削除や容量不足で消えることがあるので、ときどき編集用JSONを書き出してください。'));
    body.push(h('label', { class: 'check' }, withBody, '本文も含める（本人用。含めると有料記事の本文なども入ります。他人に渡さないでください）'));
    body.push(h('div', { class: 'row' },
      btn('編集用JSONを書き出す', () => exportJson(withBody.checked)),
      btn('JSONから復元', () => $('#file-restore2').click()),
      btn('ZIPを再取り込み', () => $('#file-reimport').click())));
    body.push(h('h4', {}, '図'));
    body.push(h('div', { class: 'row' }, btn('図の履歴・お気に入り', () => openPanel('history')), btn('検索', () => openPanel('search'))));
    const title = h('input', { type: 'text', value: S.project.title, maxlength: '60' });
    title.addEventListener('change', () => { if (title.value.trim() === S.project.title) return; mutate(() => { S.project.title = title.value.trim() || S.project.title; }, { relayout: false }); });
    body.push(h('label', { class: 'field' }, h('span', {}, '路線図のタイトル'), title));
    const hidden = S.project.articles.filter((a) => a.hidden);
    if (hidden.length) body.push(h('div', {}, h('p', { class: 'meta' }, `図から外した記事 ${hidden.length}件`), h('div', { class: 'row' }, hidden.map((a) => btn('戻す：' + a.short, () => mutate(() => { a.hidden = false; S.F = null; }))))));
    body.push(h('h4', {}, '設定'));
    const seedIn = h('input', { type: 'number', value: String(curMap().seed), min: '0', max: '999999', inputmode: 'numeric' });
    body.push(h('label', { class: 'field' }, h('span', {}, 'seed（同じ記事と同じseedなら同じ図）'), seedIn), h('div', { class: 'row' }, btn('このseedで作る', () => regen(Math.max(0, parseInt(seedIn.value, 10) || 0)))));
    const lim = h('input', { type: 'number', value: String(S.project.settings.shareLimit), min: '1000', max: '100000', step: '500', inputmode: 'numeric' });
    lim.addEventListener('change', () => { S.project.settings.shareLimit = U.clamp(parseInt(lim.value, 10) || 8000, 1000, 100000); save(); });
    body.push(h('label', { class: 'field' }, h('span', {}, '共有URLの長さの目安（文字）'), lim));
    const base = h('input', { type: 'url', value: S.project.settings.baseUrl || '', placeholder: isPermanentHere() ? location.origin + location.pathname + '（自動）' : 'https://…' });
    base.addEventListener('change', () => { const u = U.safeUrl(base.value); if (base.value && !u) return toast('https のURLを入力してください'); S.project.settings.baseUrl = u ? u.split('#')[0] : ''; save(); });
    body.push(h('label', { class: 'field' }, h('span', {}, '共有リンクの先頭アドレス（ふつうは空欄のままでOK）'), base));
    body.push(h('p', { class: 'meta' }, '共有リンクは「このアドレス＋路線図のデータ」でできています。空欄なら、いま開いているこのアプリのアドレスが使われます。アプリを別の場所へ引っ越したときだけ入力してください。'));
    const vig = h('input', { type: 'checkbox', checked: S.project.settings.showVignettes !== false });
    vig.addEventListener('change', () => { S.project.settings.showVignettes = vig.checked; save(); renderMap(); });
    body.push(h('label', { class: 'check' }, vig, '主要駅のそばに見出し画像候補を小さく表示する（本人の画面だけ。共有・書き出しには入りません）'));
    body.push(h('h4', {}, 'リセット'));
    body.push(h('div', { class: 'row' }, btn('端末内のデータをすべて消す', resetAll, 'small danger')));
    body.push(about());
    return { title: 'メニュー', body };
  }
  function about() {
    return h('div', {}, h('h4', {}, 'このアプリについて'),
      h('p', { class: 'meta' }, '分類はAIを使わず、日本語の単語分割（ブラウザ標準のIntl.Segmenter）・表記ゆれの正規化・TF-IDFによる特徴語・共通語での束ね（貪欲クラスタリング）で行います。性格や能力の診断はしません。'),
      h('p', { class: 'meta' }, '同梱ライブラリ：fflate 0.8.2（MIT License, © 2023 Arjun Barrett）— ZIP展開と共有データの圧縮に使用。装飾画像はスターターキット同梱の水彩素材。'));
  }

  async function resetAll() {
    const ok = await dialog('端末内の路線図・本文・画像の保存をすべて削除します。取り消せません。', [{ label: 'やめる', value: false }, { label: '削除する', value: true, danger: true }]);
    if (!ok) return;
    await Promise.all(['project', 'private', 'thumbs'].map((s) => NT.store.clear(s).catch(() => {})));
    S.project = null; S.bodies = null; S.F = null; S.zip = null;
    goHome();
  }

  /* ---------- 書き出し ---------- */
  // 画像カード用：表示中の見出し画像候補を小さなJPEGのデータURIに（書き出しに埋め込む）
  async function thumbDataUri(id) {
    const a = artById(id);
    if (!a || a.imageHidden) return '';
    const url = S.vigUrls.get(id) || await loadImage(a);
    if (!url) return '';
    // blob: は fetch できない（CSP の connect-src）ので、img 要素で読み込んで縮小する
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const w = img.naturalWidth, hgt = img.naturalHeight;
    if (!w || !hgt) return '';
    const k = Math.min(1, 360 / Math.max(w, hgt));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(hgt * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  }
  async function exportThumbs(ids) {
    const out = new Map();
    if (S.viewer || !S.project.settings.exportThumbs) return out;
    for (const id of ids) { try { const u = await thumbDataUri(id); if (u) out.set(id, u); } catch (e) { /* 画像なしで続ける */ } }
    return out;
  }
  async function exportImage(kind) {
    try {
      const model = modelFor(S.mode); if (model.mode !== 'surprise') model.links = [];
      const geo = geometry(model);
      const opts = { title: model.title, subtitle: '書いてきたことが、つながって見える。' };
      // 選んだときだけ、地図上の画像カードも入れる（閲覧モードでは共有された画像カードをそのまま）
      const thumbs = S.viewer ? (S.viewerThumbs || new Map()) : await exportThumbs(geo.vignettes.map((v) => v.id));
      if (thumbs.size) opts.vignetteHref = (id) => thumbs.get(id) || '';
      const base = (model.title || 'note-transit').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
      if (kind === 'svg') {
        const blob = await NT.exporter.toSvgBlob(model, geo, opts);
        await NT.exporter.deliver(blob, base + '.svg');
      } else {
        progress(true, 'PNGを作っています', 0.5);
        const r = await NT.exporter.toPngBlob(model, geo, opts).finally(() => progress(false));
        await NT.exporter.deliver(r.blob, base + '.png');
        toast(`PNG ${r.width}×${r.height}px（駅はクリックできません）`, 4000);
      }
    } catch (e) { showError(e); }
  }
  async function exportHtml(view) {
    try {
      progress(true, '閲覧用HTMLを作っています', 0.5);
      const st = S.project.settings;
      const p = NT.share.payload(view, { dates: st.shareDates, analysis: st.shareAnalysis });
      // 画像カード（選んだときだけ）：閲覧用HTMLの駅番号 s0, s1… に合わせて同梱
      const ids = vignetteIds(modelFor('topic')).filter((id) => view.stations.some((x) => x.id === id));
      const th = await exportThumbs(ids);
      const thumbs = {};
      view.stations.forEach((x, i) => { if (th.has(x.id)) thumbs['s' + i] = th.get(x.id); });
      const html = await NT.exporter.viewerHtml(JSON.stringify(p), S.project.title, thumbs);
      progress(false);
      const base = (S.project.title || 'note-transit').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
      await NT.exporter.deliver(new Blob([html], { type: 'text/html' }), base + '_閲覧用.html');
    } catch (e) { progress(false); showError(e); }
  }
  async function exportJson(withBody) {
    const data = { format: 'note-transit-edit', version: 1, exportedAt: new Date().toISOString(), includesBody: !!withBody, project: S.project };
    if (withBody) data.bodies = S.bodies;
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    await NT.exporter.deliver(blob, `note-transit-edit${withBody ? '-with-body' : ''}.json`);
  }
  async function restoreJson(file) {
    if (!file) return;
    try {
      if (file.size > 80 * 1024 * 1024) throw new Error('ファイルが大きすぎます');
      const data = JSON.parse(await file.text());
      if (!data || data.format !== 'note-transit-edit' || data.version !== 1 || !data.project || !Array.isArray(data.project.articles) || !Array.isArray(data.project.maps)) throw new Error('NOTE TRANSIT の編集用JSONではありません');
      for (const a of data.project.articles) {
        if (typeof a.id !== 'string' || typeof a.title !== 'string') throw new Error('記事データが不正です');
        a.url = a.url ? U.safeUrl(a.url) : null;
        a.short = String(a.short || NT.text.shortName(a.title)).slice(0, 60);
      }
      for (const m of data.project.maps) for (const L of m.lines) if (!/^#[0-9a-f]{6}$/i.test(L.color)) L.color = '#55616b';
      if (S.project) {
        const ok = await dialog('端末内の路線図をこのJSONの内容で置き換えます。', [{ label: 'やめる', value: false }, { label: '置き換える', value: true, primary: true }]);
        if (!ok) return;
      }
      S.project = data.project; S.bodies = data.bodies || {}; S.F = null; S.viewer = null; S.zip = null;
      S.project.settings = Object.assign({ shareLimit: 8000, baseUrl: '', shareDates: true, shareAnalysis: false, shareLinks: true }, S.project.settings || {});
      if (!curMap()) generate(0);
      await NT.store.put('project', 'current', S.project);
      await NT.store.put('private', 'bodies', S.bodies);
      S.undo = []; S.redo = []; S.rev++;
      clearHash();
      openMap();
      toast('復元しました' + (data.includesBody ? '' : '（本文なし：再生成はタイトルだけで行います。ZIPの再取り込みで本文を補えます）'), 5000);
    } catch (e) { showError(e); }
  }

  /* ---------- 画像（選択駅だけ・1枚ずつ） ---------- */
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  async function loadImage(a) {
    const name = a.images[a.imageChoice % a.images.length];
    const key = a.id + '|' + name;
    if (S.imgCache.has(key)) return S.imgCache.get(key);
    let blob = null;
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (S.zip && S.zip.byName.has(name) && MIME[ext]) {
      try {
        const bytes = await S.zip.read(S.zip.byName.get(name), {});
        blob = new Blob([bytes], { type: MIME[ext] });
        thumbnail(blob).then((t) => t && NT.store.put('thumbs', key, t)).catch(() => {});
      } catch (e) { blob = null; }
    }
    if (!blob) { try { blob = await NT.store.get('thumbs', key); } catch (e) { blob = null; } }
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    S.imgCache.set(key, url);
    if (S.imgCache.size > 40) { const [k0, u0] = S.imgCache.entries().next().value; URL.revokeObjectURL(u0); S.imgCache.delete(k0); }
    return url;
  }
  async function thumbnail(blob) {
    if (!window.createImageBitmap) return null;
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, 480 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.8));
  }

  /* ---------- 再生成・編集モード ---------- */
  async function regen(seed) {
    if (S.viewer) return;
    const m = curMap();
    if (seed == null) { seed = Math.floor(Math.random() * 99999) + 1; if (seed === m.seed) seed++; }
    pushUndo();
    generate(seed);
    S.sel = null; S.focus = null;
    save(); renderMap(true); refreshPanel();
    const kept = curMap().lines.filter((L) => L.locked).length;
    toast(`seed ${seed} の図にしました。前の図は「前の図」や履歴から戻せます${kept ? `（固定した${kept}路線は保持）` : ''}`, 4200);
  }
  function prevMap() {
    const p = S.project; const i = p.maps.findIndex((m) => m.id === p.currentMap);
    if (i > 0) switchMap(p.maps[i - 1].id);
  }
  function setEdit(on) {
    S.edit = on && !S.viewer;
    $('#editbar').hidden = !S.edit;
    if (!S.edit) { S.multi = false; S.multiSel.clear(); $('#btn-multi').setAttribute('aria-pressed', 'false'); }
    if (S.edit && curMap()) $('#btn-fix').setAttribute('aria-pressed', String(!!curMap().fixed));
  }

  /* ---------- 閲覧モード ---------- */
  function clearHash() { if (location.hash) history.replaceState(null, '', location.pathname + location.search); }
  function loadViewer(v) {
    S.viewer = v; S.mode = v.mode; S.sel = null; S.focus = null; S.rev++;
    openMap();
  }
  async function copyToOwn() {
    const v = S.viewer;
    if (S.project) {
      const ok = await dialog('この路線図を自分用にコピーして編集できるようにします。端末内にある自分の路線図は置き換わります（必要ならメニューの「編集用JSONを書き出す」で先に保存してください）。', [{ label: 'やめる', value: false }, { label: 'コピーする', value: true, primary: true }]);
      if (!ok) return;
    }
    const idOf = (s, i) => 'a' + U.hash((s.url || '') + '|' + s.title + '|' + i).toString(36);
    const map = new Map(v.stations.map((s, i) => [s.id, idOf(s, i)]));
    const articles = v.stations.map((s) => ({ id: map.get(s.id), postId: '', url: s.url, title: s.title, date: s.date, status: 'publish', images: [], missingImages: 0, warnings: [], short: s.short, shortEdited: true, imageChoice: 0, imageHidden: false, hidden: false }));
    const lines = v.lines.map((L) => ({ id: U.uid('L'), name: L.name, color: L.color, order: L.order.map((x) => map.get(x)), vocab: [], edited: true, locked: false }));
    const lid = new Map(v.lines.map((L, i) => [L.id, lines[i].id]));
    const assign = {}, pos = {};
    v.stations.forEach((s) => {
      const id = map.get(s.id);
      const mem = v.lines.filter((L) => L.order.includes(s.id)).map((L) => lid.get(L.id));
      const main = s.main ? lid.get(s.main) : mem[0] || null;
      assign[id] = { main, sub: mem.find((x) => x !== main) || null };
      pos[id] = { x: s.x, y: s.y };
    });
    const m = { id: U.uid('m'), seed: v.seed, createdAt: new Date().toISOString(), favorite: true, label: 'コピー元の図', lines, assign, links: v.links.map((k) => ({ a: map.get(k.a), b: map.get(k.b), term: k.term })), pos, manual: {}, fixed: true };
    S.project = {
      v: 1, id: U.uid('p'), kind: 'copy', demo: false, title: v.title || '共有された路線図', source: { name: '共有リンク', at: new Date().toISOString() },
      site: {}, articles, excluded: {}, stats: {}, maps: [m], currentMap: m.id,
      settings: { shareLimit: 8000, baseUrl: '', shareDates: v.opts.dates, shareAnalysis: v.opts.analysis, shareLinks: true }, createdAt: new Date().toISOString(),
    };
    S.bodies = {}; S.F = null; S.viewer = null; S.undo = []; S.redo = [];
    await NT.store.put('project', 'current', S.project).catch(() => {});
    await NT.store.put('private', 'bodies', {}).catch(() => {});
    clearHash();
    openMap();
    toast('自分用にコピーしました。「編集」から変更できます（配置は固定中。「図を固定」で解除）', 5000);
  }

  /* ---------- noteからZIPを受け取る手順 ---------- */
  function showExportGuide() {
    const step = (n, title, ...body) => h('li', { class: 'guide-step' }, h('b', {}, `${n}. ${title}`), ...body);
    const img = (k, alt) => h('img', { class: 'guide-img', src: NT.render.assetPath(k), alt });
    const content = h('div', { class: 'guide' },
      h('h3', {}, 'noteからZIPを受け取る手順'),
      h('p', { class: 'meta' }, 'iPhone・iPadのSafariでできます。アプリは不要です。'),
      h('ol', {},
        step(1, 'noteにログインして「記事」を開く', h('p', {}, 'Safariで note.com を開き、右上の自分のアイコン →「記事」を選びます。「自分の記事」の一覧が出ます。')),
        step(2, '「エクスポート」を押す', h('p', {}, '一覧の上にある「エクスポート」を押し、確認が出たらエクスポートを開始します。'), img('guide1', 'noteの記事画面。右上の「エクスポート」ボタンに印')),
        step(3, 'メールが届くのを待つ', h('p', {}, '準備ができると、noteに登録したメールアドレスにお知らせが届きます。数分〜数時間かかることがあります。届かないときは迷惑メールフォルダも確認してください。')),
        step(4, 'メールのリンクから「ダウンロード」', h('p', {}, '「エクスポートファイルのダウンロード」画面で「ダウンロード」を押します。ダウンロードは3回まで・期限つきです。'), img('guide2', 'エクスポートファイルのダウンロード画面。「ダウンロード」ボタンに印')),
        step(5, 'このアプリでZIPを選ぶ', h('p', {}, '保存されたZIPは「ファイル」アプリの「ダウンロード」にあります。展開（解凍）せず、そのまま「noteのZIPを選ぶ」から選んでください。'))),
      h('div', { class: 'warn' }, 'ZIPには有料記事を含む本文や下書きも入っています。ZIPそのものは人に渡さないでください。このアプリは端末の中だけで読み、共有リンクには公開記事のタイトルとURLなどだけを入れます。'));
    return dialog(content, [{ label: '閉じる', value: 1, primary: true }]);
  }

  /* ---------- 起動 ---------- */
  function goHome() {
    document.documentElement.classList.remove('on-map');
    S.viewer = null; clearHash(); closePanel();
    $('#btn-resume').hidden = !S.project;
    show('start');
  }

  function bind() {
    $('#file-zip').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; onPickFile(f); });
    $('#file-restore').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; restoreJson(f); });
    $('#file-restore2').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; restoreJson(f); });
    $('#file-reimport').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; reimport(f); });
    $('#btn-sample').addEventListener('click', () => onSample().catch(showError));
    $('#btn-guide').addEventListener('click', showExportGuide);
    $('#btn-resume').addEventListener('click', () => {
      S.viewer = null; openMap();
      if (S.oldLayoutNote) { S.oldLayoutNote = false; toast('手で動かした配置を残しています。新しい配置にするには「路線図を編集」→「再配置」', 6000); }
    });
    $('#btn-build').addEventListener('click', () => buildFromImport().catch(showError));
    $('#btn-imp-back').addEventListener('click', goHome);
    $('#btn-cancel').addEventListener('click', () => { if (S.abort) S.abort.abort(); });
    $('#btn-home').addEventListener('click', goHome);
    document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    $('#btn-regen').addEventListener('click', () => regen());
    $('#btn-share').addEventListener('click', () => openPanel('share', {}));
    $('#btn-edit-done').addEventListener('click', () => { setEdit(false); refreshPanel(); });
    // カードの引き上げ・引き下げ（ボタンでも開閉できる）
    $('#btn-grip').addEventListener('click', () => { if (S.panel && S.panel.kind === 'station') setCardExpanded(!S.cardOpen); });
    let dragY = null;
    $('#panel-head').addEventListener('pointerdown', (e) => { dragY = e.clientY; });
    $('#panel-head').addEventListener('pointerup', (e) => {
      if (dragY == null) return;
      const dy = e.clientY - dragY; dragY = null;
      if (!S.panel || Math.abs(dy) < 30) return;
      if (dy < 0 && S.panel.kind === 'station') setCardExpanded(true);
      else if (dy > 0) { if (S.cardOpen) setCardExpanded(false); else closePanel(); }
    });
    $('#btn-copy-own').addEventListener('click', copyToOwn);
    $('#btn-menu').addEventListener('click', () => openPanel('menu'));
    $('#btn-panel-close').addEventListener('click', () => { closePanel(); if (S.search) { S.search = null; renderMap(); } });
    $('#btn-zoom-in').addEventListener('click', () => { const s = stageSize(); zoomAt(1.4, s.w / 2, s.h / 2); });
    $('#btn-zoom-out').addEventListener('click', () => { const s = stageSize(); zoomAt(1 / 1.4, s.w / 2, s.h / 2); });
    $('#btn-fit').addEventListener('click', () => { S.focus = null; renderMap(); fitTo(S.full, true); });
    $('#btn-search').addEventListener('click', () => openPanel('search'));
    $('#btn-undo').addEventListener('click', undo);
    $('#btn-redo').addEventListener('click', redo);
    $('#btn-multi').addEventListener('click', () => { S.multi = !S.multi; S.multiSel.clear(); $('#btn-multi').setAttribute('aria-pressed', String(S.multi)); renderMap(); if (S.multi) openPanel('multi'); else closePanel(); });
    $('#btn-relayout').addEventListener('click', async () => {
      const ok = await dialog('駅の位置を自動で配置し直します（手で動かした位置もリセット。取り消しで戻せます）。', [{ label: 'やめる', value: false }, { label: '再配置', value: true, primary: true }]);
      if (ok) mutate(() => { const m = curMap(); m.fixed = false; relayoutMap(m, true); $('#btn-fix').setAttribute('aria-pressed', 'false'); });
    });
    $('#btn-fix').addEventListener('click', () => { const m = curMap(); m.fixed = !m.fixed; $('#btn-fix').setAttribute('aria-pressed', String(m.fixed)); save(); toast(m.fixed ? '図を固定しました（所属を変えても配置は変わりません）' : '固定を解除しました'); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { if (!$('#dialog').hidden) return; closePanel(); }
    });
    window.addEventListener('hashchange', () => { if (/^#map=/.test(location.hash)) bootHash(); });
    setupGestures();
  }

  function bootHash() {
    try {
      const v = NT.share.decode(location.hash);
      loadViewer(v);
      return true;
    } catch (e) {
      show('start');
      dialog(h('div', {}, h('h3', {}, '共有リンクを開けませんでした'), h('p', {}, e.message), h('p', { class: 'meta' }, 'リンクが途中で切れていないか確認してください。長いリンクは共有先で切れることがあります。')), [{ label: '閉じる', value: 1, primary: true }]);
      return false;
    }
  }

  // 閲覧用HTMLに同梱された画像カード（形式・件数・大きさを確かめてから使う）
  function readEmbeddedThumbs(v) {
    const out = new Map();
    const el = document.getElementById('nt-embedded-thumbs');
    if (!el) return out;
    try {
      const o = JSON.parse(el.textContent);
      for (const [k, u] of Object.entries(o || {}).slice(0, 8)) {
        if (!/^s\d+$/.test(k) || !v.stations.some((x) => x.id === k)) continue;
        if (typeof u !== 'string' || u.length > 400000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(u)) continue;
        out.set(k, u);
      }
    } catch (e) { /* 画像なしで表示 */ }
    return out;
  }

  async function boot() {
    bind();
    // 地図の背景：水彩の風景を画面いっぱいに敷き、その上で路線図を動かす
    $('#stage').style.backgroundImage = `url("${NT.render.assetPath('bg')}")`;
    // 閲覧用HTMLに埋め込まれた共有データ
    const emb = document.getElementById('nt-embedded');
    if (emb) {
      try {
        const v = NT.share.validate(JSON.parse(emb.textContent));
        S.viewerThumbs = readEmbeddedThumbs(v);
        loadViewer(v);
      } catch (e) { show('start'); showError(e); }
      return;
    }
    try {
      const p = await NT.store.get('project', 'current');
      if (p && p.v === 1 && Array.isArray(p.maps)) {
        S.project = p;
        S.project.settings = Object.assign({ shareLimit: 8000, baseUrl: '', shareDates: true, shareAnalysis: false, shareLinks: true }, p.settings || {});
        S.bodies = (await NT.store.get('private', 'bodies')) || {};
        // 旧い配置（路線ごとに横一列）の図は、手で動かした位置や固定がなければ新しい配置に直す
        let kept = 0;
        for (const m of S.project.maps) {
          if (m.layoutV === LAYOUT_V) continue;
          if (m.fixed || Object.keys(m.manual || {}).length) { kept++; continue; }
          relayoutMap(m, true); m.layoutV = LAYOUT_V;
        }
        if (kept) S.oldLayoutNote = true;
        save();
      }
    } catch (e) { /* 端末内保存が使えない環境でも閲覧はできる */ }
    if (/^#map=/.test(location.hash)) { bootHash(); return; }
    $('#btn-resume').hidden = !S.project;
    show('start');
  }

  NT.app = { S, boot, modelFor, regen, shareView, curMap, renderMap, selectStation, setMode, openPanel, fitTo };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(globalThis.NT = globalThis.NT || {});
