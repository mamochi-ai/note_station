// 公開用ファイルだけを _site/ にコピー（tests・docs・原本は含めない）
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, '_site');
fs.rmSync(OUT, { recursive: true, force: true });
const copy = (rel) => {
  const src = path.join(ROOT, rel), dst = path.join(OUT, rel);
  if (fs.statSync(src).isDirectory()) { for (const f of fs.readdirSync(src)) copy(path.join(rel, f)); return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
};
for (const rel of ['index.html', 'css', 'js', 'assets/decor', 'assets/UI_SYMBOLS.svg', 'LICENSES.md']) copy(rel);
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
// 念のため：原本や本文らしきファイルが混入していないか確認
const bad = [];
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(zip|xml|md)$/i.test(f) && f !== 'LICENSES.md') bad.push(p); } };
walk(OUT);
if (bad.length) { console.error('公開ビルドに含めてはいけないファイル:', bad); process.exit(1); }
console.log('built', OUT);
