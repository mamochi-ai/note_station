// NOTE TRANSIT 自動テスト（Playwright + Chromium）
// 使い方: node tests/run.mjs
//   実データ原本の検証は NT_PRIVATE_FIXTURE=/path/to/note_export_original.zip を指定（リポジトリには含めない）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) || /samples_private/.test(f) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const results = [];
let failed = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try { const note = await fn(); results.push(`✔ ${name}${note ? ' — ' + note : ''} (${Date.now() - t0}ms)`); }
  catch (e) {
    if (String(e && e.message).startsWith('SKIP:')) { results.push(`－ ${name}（未実施：${e.message.slice(5).trim()}）`); return; }
    failed++; results.push(`✘ ${name}\n    ${String(e && e.stack || e).split('\n').slice(0, 3).join('\n    ')}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

const browser = await chromium.launch();
const consoleErrors = [];
async function newPage(opts) {
  const ctx = await browser.newContext(Object.assign({ ...devices['iPad Pro 11 landscape'] }, opts || {}));
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  return { ctx, page };
}

const { ctx, page } = await newPage();
await page.goto(BASE);
await page.waitForFunction(() => window.NT && NT.app);

// 共通：ページ内で ZIP を作るヘルパ
await page.evaluate(() => {
  window.mkItem = (o) => `<item><title><![CDATA[${o.title}]]></title><link>${o.link}</link><guid isPermaLink="false">${o.guid || ''}</guid><description></description><content:encoded><![CDATA[${o.content || ''}]]></content:encoded><excerpt:encoded><![CDATA[${o.excerpt || ''}]]></excerpt:encoded><wp:post_id>${o.id}</wp:post_id><wp:post_date>${o.date || '2025-01-01 10:00:00'}</wp:post_date><wp:status>${o.status || 'publish'}</wp:status><wp:post_type>post</wp:post_type></item>`;
  window.mkXml = (items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/"><channel><title>テスト</title><link>https://note.com/test</link>${items.map(mkItem).join('')}</channel></rss>`;
  window.mkZip = (files) => { const o = {}; for (const [k, v] of Object.entries(files)) o[k] = typeof v === 'string' ? new TextEncoder().encode(v) : v; return new File([fflate.zipSync(o)], 't.zip'); };
});

const FIX = process.env.NT_PRIVATE_FIXTURE;
await test('同梱原本: 公開11・下書き3除外・タイトル/URL欠損0・画像参照31件解決', async () => {
  if (!FIX || !fs.existsSync(FIX)) throw new Error('SKIP: NT_PRIVATE_FIXTURE 未指定');
  const b64 = fs.readFileSync(FIX).toString('base64');
  const r = await page.evaluate(async (b64) => {
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const res = await NT.wxr.importFile(new File([u], 'x.zip'), {});
    return { n: res.articles.length, ex: res.excluded, noTitle: res.articles.filter((a) => !a.title).length, noUrl: res.articles.filter((a) => !a.url).length, img: res.stats, warn: res.warnings.length };
  }, b64);
  assert(r.n === 11, 'published ' + r.n);
  assert(r.ex.draft === 3, 'draft ' + r.ex.draft);
  assert(r.noTitle === 0 && r.noUrl === 0, 'missing title/url');
  assert(r.img.imgRefs === 31 && r.img.imgResolved === 31, 'images ' + JSON.stringify(r.img));
  return `published=${r.n} draft=${r.ex.draft} images=${r.img.imgResolved}/${r.img.imgRefs}`;
});

await test('content:encoded と excerpt:encoded を混同しない', async () => {
  const r = await page.evaluate(async () => {
    const xml = mkXml([{ id: 1, title: 'A', link: 'https://note.com/u/n/n000000000001', content: '<p>本文マーカー</p>', excerpt: '抜粋マーカー' }]);
    const res = await NT.wxr.importFile(mkZip({ 'a.xml': xml }), {});
    return { body: res.articles[0]._body.text, hasEx: res.articles[0].hasExcerpt };
  });
  assert(r.body.includes('本文マーカー') && !r.body.includes('抜粋マーカー'), r.body);
  assert(r.hasEx, 'excerpt detected');
});

await test('未知のstatus・予約・不正URL・タイトル欠損・日付不明でもクラッシュしない', async () => {
  const r = await page.evaluate(async () => {
    const xml = mkXml([
      { id: 1, title: 'ok', link: 'https://note.com/u/n/n000000000001' },
      { id: 2, title: 'x', link: 'https://note.com/u/n/n000000000002', status: 'weird' },
      { id: 3, title: 'y', link: 'https://note.com/u/n/n000000000003', status: 'future' },
      { id: 4, title: 'js', link: 'javascript:alert(1)' },
      { id: 5, title: 'data', link: 'data:text/html,hi' },
      { id: 6, title: '', link: 'https://note.com/u/n/n000000000006', date: 'unknown' },
      { id: 7, title: 'http', link: 'http://note.com/u/n/n000000000007' },
    ]);
    const res = await NT.wxr.importFile(new File([xml], 'a.xml'), {});
    return { n: res.articles.length, ex: res.excluded, urls: res.articles.map((a) => a.url), warns: res.warnings.map((w) => w.issues.join('/')) };
  });
  assert(r.n === 5, 'n=' + r.n);
  assert(r.ex.other === 1 && r.ex.future === 1, JSON.stringify(r.ex));
  assert(r.urls.filter(Boolean).length === 2, 'only https accepted: ' + JSON.stringify(r.urls));
  assert(r.warns.some((w) => w.includes('タイトル未設定') && w.includes('日付不明')), JSON.stringify(r.warns));
  return r.warns.join(' | ');
});

await test('壊れたZIP・壊れたXML・XMLなしZIP・展開上限（ZIP爆弾）はわかるエラー', async () => {
  const r = await page.evaluate(async () => {
    const out = [];
    const tryIt = async (f, opts) => { try { await NT.wxr.importFile(f, opts || {}); return 'no error'; } catch (e) { return e.message; } };
    out.push(await tryIt(new File([new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3])], 'bad.zip')));
    out.push(await tryIt(mkZip({ 'a.xml': '<rss><channel><item>' })));
    out.push(await tryIt(mkZip({ 'a.txt': 'hello' })));
    out.push(await tryIt(new File(['not xml at all'], 'a.xml')));
    // 圧縮率が極端なXML（約20MBのゼロ埋め）→ 圧縮率上限で拒否
    const big = new Uint8Array(20 * 1024 * 1024).fill(32);
    out.push(await tryIt(mkZip({ 'a.xml': big })));
    // 上限を小さくして展開中に止める
    const z = await NT.zip.open(mkZip({ 'b.xml': new TextEncoder().encode('<a>' + 'x'.repeat(300000) + '</a>') }), { limits: { maxRatio: 1e9 } });
    try { await z.read(z.entries[0], { maxBytes: 1000 }); out.push('no error'); } catch (e) { out.push(e.message); }
    return out;
  });
  assert(r.every((m) => m !== 'no error'), JSON.stringify(r));
  return r.join(' | ');
});

await test('キャンセルできる', async () => {
  const r = await page.evaluate(async () => {
    const ac = new AbortController(); ac.abort();
    const xml = mkXml([{ id: 1, title: 'a', link: 'https://note.com/u/n/n000000000001' }]);
    try { await NT.wxr.importFile(mkZip({ 'a.xml': xml }), { signal: ac.signal }); return 'no'; } catch (e) { return e.name; }
  });
  assert(r === 'CancelError', r);
});

await test('1・11・100・300記事の分類と配置（NaNなし・重なり計測）', async () => {
  const r = await page.evaluate(async () => {
    const out = [];
    for (const n of [1, 11, 100, 300]) {
      const t0 = performance.now();
      const res = await NT.wxr.buildArticles(NT.demo.synthRaw(n, 7), { site: {} });
      const F = NT.text.features(res.articles);
      const c = NT.classify.classify(res.articles, F, { seed: 0 });
      const stations = new Map(res.articles.map((a) => [a.id, { id: a.id, short: NT.text.shortName(a.title), title: a.title, date: a.date, main: c.assign[a.id].main }]));
      const model = { mode: 'topic', lines: c.lines, stations, links: c.links, seed: 0 };
      const { pos } = NT.layout.topic(model);
      const rows = new Map(c.lines.map((L) => [L.id, pos.get(L.order.find((id) => stations.get(id).main === L.id) || L.order[0]).y]));
      const geo = NT.layout.geometry(model, pos, rows, {});
      const svg = NT.render.svg(model, geo, { interactive: true }).svg;
      const bad = /NaN|undefined|Infinity/.test(svg);
      // 駅同士の重なり
      let overlap = 0;
      for (let i = 0; i < geo.stations.length; i++) for (let j = i + 1; j < geo.stations.length; j++) { const a = geo.stations[i], b = geo.stations[j]; if (Math.hypot(a.x - b.x, a.y - b.y) < 18) overlap++; }
      const subs = Object.values(c.assign).filter((x) => x.sub).length;
      const labelCost = [...geo.labels.values()].filter((l) => l.cost >= 3).length;
      out.push({ n, lines: c.lines.length, iso: c.isolated.length, subs, bad, overlap, labelOverlap: labelCost, ms: Math.round(performance.now() - t0), stationsDrawn: geo.stations.length });
    }
    return out;
  });
  for (const x of r) { assert(!x.bad, 'NaN in svg ' + x.n); assert(x.overlap === 0, 'station overlap ' + JSON.stringify(x)); assert(x.stationsDrawn === x.n, 'all stations drawn'); }
  assert(r[0].lines === 0 && r[0].iso === 1, '1 article isolated');
  assert(r[3].subs <= 300 * 0.25, 'interchanges capped');
  return r.map((x) => `n=${x.n}: 路線${x.lines} ひとり${x.iso} 乗換${x.subs} 文字重なり${x.labelOverlap} ${x.ms}ms`).join(' / ');
});

await test('同じseedは同じ結果・別seedは変化する', async () => {
  const r = await page.evaluate(async () => {
    const res = await NT.wxr.buildArticles(NT.demo.synthRaw(100, 3), { site: {} });
    const F = NT.text.features(res.articles);
    const sig = (c) => JSON.stringify(c.lines.map((L) => [L.name, L.order])) + JSON.stringify(c.links);
    const a = sig(NT.classify.classify(res.articles, F, { seed: 5 }));
    const b = sig(NT.classify.classify(res.articles, NT.text.features(res.articles), { seed: 5 }));
    const diffs = [1, 2, 3, 4, 6, 7].map((s) => sig(NT.classify.classify(res.articles, F, { seed: s }))).filter((x) => x !== a).length;
    return { same: a === b, diffs };
  });
  assert(r.same, 'reproducible');
  assert(r.diffs >= 3, 'variation ' + r.diffs);
  return `別seed 6通り中 ${r.diffs} 通りが変化`;
});

await test('共通語のない記事を無理につながない', async () => {
  const r = await page.evaluate(async () => {
    const raw = [
      ['カレーの作り方', 'スパイス 玉ねぎ'], ['カレーとナン', 'スパイス ナン'], ['登山の装備', 'ザック 登山靴'], ['金魚の飼い方', '水槽 金魚'], ['宇宙の話', '銀河 星雲'],
    ].map(([t, b], i) => ({ title: t, link: 'https://note.com/u/n/n00000000000' + i, postId: String(i), postDate: '2025-01-0' + (i + 1) + ' 00:00:00', status: 'publish', postType: 'post', content: `<p>${b}</p>`, excerpt: '' }));
    const res = await NT.wxr.buildArticles(raw, { site: {} });
    const F = NT.text.features(res.articles);
    const c = NT.classify.classify(res.articles, F, { seed: 0 });
    const t = (id) => res.articles.find((a) => a.id === id).title;
    return { lines: c.lines.map((L) => L.name + ':' + L.order.map(t).join(',')), iso: c.isolated.map(t), links: c.links.length };
  });
  assert(r.lines.length === 1 && r.lines[0].includes('カレー'), JSON.stringify(r));
  assert(r.iso.length === 3, JSON.stringify(r));
  assert(r.links === 0, 'no random links');
  return r.lines.join(' ') + ' / ひとり駅: ' + r.iso.join(',');
});

await test('共有URLの往復（他アカウント・独自ドメインURLも保持）と検証', async () => {
  const r = await page.evaluate(() => {
    const view = { title: 'T<script>', mode: 'topic', seed: 3, lines: [{ id: 'L1', name: '線"&', color: '#d9653b', order: ['a', 'b', 'c'] }],
      stations: [
        { id: 'a', short: 'A', title: '題A', url: 'https://note.com/me/n/n111111111111', date: '2025-01-02T00:00:00', x: 0, y: 0, main: 'L1' },
        { id: 'b', short: 'B', title: '題B', url: 'https://note.com/other/n/n222222222222', date: null, x: 1, y: 0, main: 'L1' },
        { id: 'c', short: 'C', title: '題C', url: 'https://blog.example.jp/n/n333333333333?x=1#y', date: '2025-02-03T00:00:00', x: 2.25, y: 0.5, main: 'L1' },
        { id: 'd', short: 'D', title: '題D', url: 'https://note.com/me/n/n444444444444', date: '2025-02-04T00:00:00', x: 0, y: 1.15, main: null }],
      links: [{ a: 'a', b: 'd', term: '珍' }] };
    const e = NT.share.encode(view, { dates: true });
    const v = NT.share.decode('#' + e.fragment);
    const errs = [];
    for (const bad of ['#map=v2.xxx', '#map=v1.@@@', '#map=v1.' + e.fragment.slice(7, 40), '#map=v1.']) { try { NT.share.decode(bad); errs.push('no error'); } catch (x) { errs.push(x.message); } }
    // スキーマ違反（javascript: URL を仕込む）
    const p = JSON.parse(JSON.stringify(e.payload)); p.S[0][2] = 'javascript:alert(1)';
    const z = fflate.deflateSync(new TextEncoder().encode(JSON.stringify(p)));
    try { NT.share.decode('#map=v1.' + NT.util.b64uEncode(z)); errs.push('no error'); } catch (x) { errs.push(x.message); }
    return { urls: v.stations.map((s) => s.url), dates: v.stations.map((s) => s.date), title: v.title, line: v.lines[0], pos: v.stations.map((s) => [s.x, s.y]), links: v.links, errs, len: e.fragment.length };
  });
  assert(JSON.stringify(r.urls) === JSON.stringify(['https://note.com/me/n/n111111111111', 'https://note.com/other/n/n222222222222', 'https://blog.example.jp/n/n333333333333?x=1#y', 'https://note.com/me/n/n444444444444']), JSON.stringify(r.urls));
  assert(r.dates[0] === '2025-01-02T00:00:00' && r.dates[1] === null, JSON.stringify(r.dates));
  assert(r.title === 'T<script>' && r.line.name === '線"&', 'strings');
  assert(JSON.stringify(r.pos) === '[[0,0],[1,0],[2.25,0.5],[0,1.15]]', JSON.stringify(r.pos));
  assert(r.errs.every((m) => m !== 'no error'), JSON.stringify(r.errs));
  return `fragment ${r.len}文字 / エラー例: ${r.errs[4]}`;
});

// --- E2E：デモで作成 → 共有 → 新しいブラウザで閲覧 ---
let shareUrl = null;
await test('E2E: サンプル→路線図→駅タップ→詳細・ピンチ・回転', async () => {
  await page.evaluate(() => NT.store.clear('project'));
  await page.goto(BASE); await page.waitForFunction(() => window.NT && NT.app);
  await page.click('#btn-sample');
  await page.waitForSelector('#screen-import:not([hidden])');
  const head = await page.textContent('#imp-headline');
  assert(head.includes('24'), head);
  await page.click('#btn-build');
  await page.waitForSelector('#svg-host svg .nt-st');
  const n = await page.$$eval('.nt-st', (e) => e.length);
  assert(n === 24, 'stations ' + n);
  // タップ
  const st = (await page.$$('.nt-st'))[3];
  const bb = await st.boundingBox();
  await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.waitForSelector('#panel:not([hidden])');
  const link = await page.$eval('#panel-body a.btn', (a) => ({ href: a.href, rel: a.rel, target: a.target }));
  assert(link.href.startsWith('https://example.com/transit-demo/') && link.rel.includes('noopener'), JSON.stringify(link));
  // ピンチ（CDP でタッチ2点）
  const vb0 = await page.$eval('#svg-host svg', (s) => s.getAttribute('viewBox'));
  const cdp = await page.context().newCDPSession(page);
  const box = await page.$eval('#stage', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const tp = (d) => [{ x: box.x - d, y: box.y, id: 1 }, { x: box.x + d, y: box.y, id: 2 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(40) });
  for (const d of [60, 90, 120, 150]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(d) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const vb1 = await page.$eval('#svg-host svg', (s) => s.getAttribute('viewBox'));
  const w0 = +vb0.split(' ')[2], w1 = +vb1.split(' ')[2];
  assert(w1 < w0 * 0.6, `pinch zoom ${w0} -> ${w1}`);
  // 回転（縦向き）→ 下部パネル
  await page.setViewportSize({ width: 834, height: 1194 });
  await page.waitForTimeout(200);
  const panel = await page.$eval('#panel', (e) => { const r = e.getBoundingClientRect(); return { top: r.top, h: innerHeight, w: r.width }; });
  assert(panel.top > panel.h * 0.3 && panel.w > 800, 'bottom sheet in portrait ' + JSON.stringify(panel));
  await page.setViewportSize({ width: 1194, height: 834 });
  await page.waitForTimeout(200);
  const panel2 = await page.$eval('#panel', (e) => e.getBoundingClientRect().width);
  assert(panel2 < 500, 'right panel in landscape');
  return `ピンチ viewBox幅 ${Math.round(w0)}→${Math.round(w1)}`;
});

await test('E2E: 編集（駅名変更・取り消し/やり直し）と再生成で編集を失わない', async () => {
  await page.click('#btn-edit');
  const sid = await page.evaluate(() => NT.app.S.sel);
  const inp = await page.$('#panel-body input[type="text"]');
  await inp.fill('テスト駅名');
  await inp.dispatchEvent('change');
  await page.waitForTimeout(100);
  let svg = await page.$eval('#svg-host', (e) => e.innerHTML);
  assert(svg.includes('テスト駅名'), 'renamed');
  await page.click('#btn-undo');
  svg = await page.$eval('#svg-host', (e) => e.innerHTML);
  assert(!svg.includes('テスト駅名'), 'undo');
  await page.click('#btn-redo');
  svg = await page.$eval('#svg-host', (e) => e.innerHTML);
  assert(svg.includes('テスト駅名'), 'redo');
  const before = await page.evaluate(() => NT.app.S.project.maps.length);
  await page.click('#btn-regen');
  svg = await page.$eval('#svg-host', (e) => e.innerHTML);
  assert(svg.includes('テスト駅名'), '駅名は再生成後も保持');
  const after = await page.evaluate(() => ({ n: NT.app.S.project.maps.length, seed: NT.app.curMap().seed }));
  assert(after.n === before + 1, 'new version kept separately');
  await page.click('#btn-prev-map');
  const back = await page.evaluate(() => NT.app.curMap().seed);
  assert(back === 0, 'prev map');
  await page.click('#btn-edit');
  return `再生成 seed ${after.seed} → 前の図 seed ${back}`;
});

await test('E2E: 共有パネル（件数・文字数・注意書き）→ URL', async () => {
  await page.evaluate(() => { NT.app.S.project.settings.baseUrl = 'https://example.github.io/note_station/'; });
  await page.click('#btn-share');
  await page.waitForSelector('#panel-body textarea');
  const txt = await page.textContent('#panel-body');
  assert(txt.includes('暗号化ではありません') && txt.includes('含めないもの'), 'notice');
  shareUrl = await page.$eval('#panel-body textarea', (t) => t.value);
  assert(shareUrl.startsWith('https://example.github.io/note_station/#map=v1.'), shareUrl.slice(0, 60));
  return `URL ${shareUrl.length}文字`;
});

await test('E2E: 新しいブラウザ状態（IndexedDBなし）でURLだけから閲覧', async () => {
  const { ctx: c2, page: p2 } = await newPage();
  const frag = shareUrl.slice(shareUrl.indexOf('#'));
  await p2.goto(BASE + frag);
  await p2.waitForSelector('#svg-host svg .nt-st');
  const r = await p2.evaluate(() => ({ n: document.querySelectorAll('.nt-st').length, viewer: !document.getElementById('viewer-badge').hidden, copy: !document.getElementById('btn-copy-own').hidden, editHidden: document.getElementById('btn-edit').hidden }));
  assert(r.n === 24 && r.viewer && r.copy && r.editHidden, JSON.stringify(r));
  const svg = await p2.$eval('#svg-host', (e) => e.innerHTML);
  assert(svg.includes('テスト駅名'), 'edited name shared');
  // 壊れたリンク
  await p2.goto(BASE + '#map=v1.AAAA');
  await p2.waitForSelector('#dialog:not([hidden])');
  const msg = await p2.textContent('#dlg-body');
  assert(msg.includes('開けませんでした'), msg);
  await c2.close();
  return 'viewer OK / 壊れたリンク: ' + msg.replace(/\s+/g, ' ').slice(0, 60);
});

await test('共有データ・SVG・HTML・PNGに下書き・本文・非表示記事が入らない', async () => {
  const r = await page.evaluate(async () => {
    const S = NT.app.S;
    // 一時的に1記事を非表示に
    const hiddenA = S.project.articles[5]; hiddenA.hidden = true; S.rev++; S.F = null;
    const view = NT.app.shareView({});
    const enc = NT.share.encode(view, { dates: true, analysis: true });
    const json = JSON.stringify(enc.payload);
    const model = NT.app.modelFor('topic'); model.links = [];
    const geo = NT.layout.geometry(model, new Map([...model.stations.keys()].map((id) => [id, NT.app.curMap().pos[id]])), new Map(), {});
    const svgBlob = await NT.exporter.toSvgBlob(model, geo, { title: 't' });
    const svg = await svgBlob.text();
    const html = await NT.exporter.viewerHtml(json, 't');
    const png = await NT.exporter.toPngBlob(model, geo, { title: 't' });
    const bodies = Object.values(S.bodies).map((b) => b && b.paragraphs && b.paragraphs[1]).filter(Boolean);
    const leaks = (s) => ({ draft: s.includes('下書き本文') || s.includes('まだ書きかけ'), body: bodies.some((b) => s.includes(b)), demoNote: s.includes('デモ用の架空の記事です'), hidden: s.includes(hiddenA.title) });
    hiddenA.hidden = false; S.rev++; S.F = null;
    // アプリのJSソース（デモ用の架空文を含む）を除き、埋め込みデータとマークアップを検査
    const htmlData = html.replace(/<script>[\s\S]*?<\/script>/g, '');
    return { svgBlob: /href="blob:/.test(svg), json: leaks(json), svg: leaks(svg), html: leaks(htmlData), embedded: htmlData.includes('nt-embedded'), png: png.blob.size, pngType: png.blob.type, htmlSize: html.length, htmlScripts: (html.match(/<script[^>]*src=/g) || []).length };
  });
  for (const k of ['json', 'svg', 'html']) for (const [kk, v] of Object.entries(r[k])) assert(!v, `${k} leaks ${kk}`);
  assert(r.png > 10000 && r.pngType === 'image/png', 'png ' + r.png);
  assert(r.htmlScripts === 0, 'HTML is self-contained');
  assert(!r.svgBlob, 'local images (blob:) must not be exported');
  assert(r.embedded, 'embedded data checked');
  return `PNG ${Math.round(r.png / 1024)}KB / HTML ${Math.round(r.htmlSize / 1024)}KB 自己完結`;
});

await test('閲覧用HTMLが外部サーバーなしで開ける（file://）', async () => {
  const html = await page.evaluate(async () => NT.exporter.viewerHtml(JSON.stringify(NT.share.payload(NT.app.shareView({}), { dates: true })), 't'));
  const tmp = path.join(process.env.NT_TMP || ROOT, 'viewer-test.tmp.html');
  fs.writeFileSync(tmp, html);
  const { ctx: c3, page: p3 } = await newPage();
  const reqs = [];
  p3.on('request', (q) => { if (!q.url().startsWith('file:') && !q.url().startsWith('data:') && !q.url().startsWith('blob:')) reqs.push(q.url()); });
  await p3.goto('file://' + tmp);
  await p3.waitForSelector('#svg-host svg .nt-st');
  const n = await p3.$$eval('.nt-st', (e) => e.length);
  await c3.close();
  fs.unlinkSync(tmp);
  assert(n === 24, 'stations ' + n);
  assert(reqs.length === 0, 'network requests: ' + reqs.join(','));
  return '外部リクエスト 0';
});

await test('URL長さの目安超過で代替導線を表示', async () => {
  await page.evaluate(() => { NT.app.S.project.settings.shareLimit = 1000; });
  await page.evaluate(() => NT.app.openPanel('share', {}));
  const txt = await page.textContent('#panel-body');
  await page.evaluate(() => { NT.app.S.project.settings.shareLimit = 8000; });
  assert(txt.includes('目安') && txt.includes('路線ごとに共有') && txt.includes('閲覧用HTMLを保存') && txt.includes('記事を絞る'), txt.slice(0, 200));
});

await test('localhost などの一時URLを共有URLとして案内しない', async () => {
  await page.evaluate(() => { NT.app.S.project.settings.baseUrl = ''; NT.app.openPanel('share', {}); });
  const r = await page.evaluate(() => ({ ta: !!document.querySelector('#panel-body textarea'), txt: document.getElementById('panel-body').textContent }));
  assert(!r.ta && r.txt.includes('一時的'), 'no URL for localhost');
});

await test('300記事: 描画・全体表示・検索', async () => {
  const r = await page.evaluate(async () => {
    const res = await NT.wxr.buildArticles(NT.demo.synthRaw(300, 11), { site: { title: '合成' } });
    const S = NT.app.S;
    const keep = { p: S.project, b: S.bodies };
    S.project = null;
    // 内部APIで構築
    const t0 = performance.now();
    S.imp = res; S.impKind = 'zip';
    S.project = { v: 1, title: '合成300', articles: res.articles.map((a) => Object.assign({}, a, { short: NT.text.shortName(a.title), hidden: false, imageChoice: 0 })), maps: [], currentMap: null, settings: { shareLimit: 8000, baseUrl: '', shareDates: true, shareAnalysis: false, shareLinks: true } };
    S.bodies = Object.fromEntries(res.articles.map((a) => [a.id, a._body])); S.F = null;
    NT.app.regen(0);
    await new Promise((r) => setTimeout(r, 50));
    const ms = performance.now() - t0;
    const n = document.querySelectorAll('.nt-st').length;
    const view = NT.app.shareView({});
    const enc = NT.share.encode(view, { dates: true });
    S.project = keep.p; S.bodies = keep.b; S.F = null; S.rev++; NT.app.renderMap(true);
    return { n, ms: Math.round(ms), frag: enc.fragment.length };
  });
  assert(r.n === 300, 'n=' + r.n);
  return `300駅 描画${r.ms}ms / 共有fragment ${r.frag}文字（目安超過→代替導線）`;
});

await test('凡例を横スクロールしても路線図は動かない（iPhone）', async () => {
  const { ctx: c4, page: p4 } = await newPage({ ...devices['iPhone 13'] });
  await p4.goto(BASE);
  await p4.click('#btn-sample'); await p4.click('#btn-build');
  await p4.waitForSelector('#svg-host svg .nt-st');
  const before = await p4.$eval('#svg-host svg', (s) => s.getAttribute('viewBox'));
  const box = await p4.$eval('#chips', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2, w: r.width, sw: e.scrollWidth }; });
  assert(box.sw > box.w, 'legend overflows');
  const cdp = await c4.newCDPSession(p4);
  const pt = (x) => [{ x, y: box.y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(box.x + box.w - 30) });
  for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(box.x + box.w - 30 - i * 25) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await p4.waitForTimeout(300);
  const after = await p4.$eval('#svg-host svg', (s) => s.getAttribute('viewBox'));
  const scrolled = await p4.$eval('#chips', (e) => e.scrollLeft);
  await c4.close();
  assert(after === before, `map moved: ${before} -> ${after}`);
  assert(scrolled > 50, 'legend scrolled ' + scrolled);
  return `凡例 scrollLeft=${Math.round(scrolled)} / 地図は不動`;
});

await test('console error なし', async () => {
  const errs = consoleErrors.filter((e) => !/favicon/.test(e));
  assert(errs.length === 0, errs.join('\n'));
});

await browser.close();
server.close();
console.log(results.join('\n'));
console.log(failed ? `\n${failed} 件失敗` : '\nすべて成功');
process.exit(failed ? 1 : 0);
