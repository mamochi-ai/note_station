// 1ファイルで動くプレビュー用HTML（dist/note-transit-standalone.html）を作る。
// CSS/JS/装飾画像をすべてインライン化。実データは含めない（デモは架空記事）。
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = process.argv[2] || path.join(ROOT, 'dist', 'note-transit-standalone.html');
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="([^"]+)" data-nt-inline>/, (m, href) => `<style data-nt-inline>${fs.readFileSync(path.join(ROOT, href), 'utf8')}</style>`);
html = html.replace(/<script src="([^"]+)" data-nt-inline><\/script>/g, (m, src) => `<script data-nt-inline>${fs.readFileSync(path.join(ROOT, src), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`);
const uris = {};
for (const f of fs.readdirSync(path.join(ROOT, 'assets/decor'))) uris[f.replace(/\.png$/, '')] = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'assets/decor', f)).toString('base64');
html = html.replace('<script data-nt-inline>', `<script>globalThis.NT=globalThis.NT||{};NT.DECOR_URIS=${JSON.stringify(uris)};</script>\n<script data-nt-inline>`);
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('wrote', out, Math.round(html.length / 1024) + 'KB');
