/* NOTE TRANSIT — SVG描画（文字列生成。全テキストはエスケープ）
 * 画面表示・SVG/PNG/HTML書き出しで同じ描画を使う。 */
(function (NT) {
  'use strict';
  const U = NT.util;
  const E = U.esc;

  const C = { bg: '#fcf8f0', ink: '#24211d', sub: '#6f675b', paper: '#fffdf8', soft: '#ece3cf' };

  /* geo: NT.layout.geometry の結果
   * opts: { transparentBg（画面表示：背景はステージ側）, title, subtitle（指定時のみ図の中に見出しを描く＝書き出し用）, assetHref:(key)=>url（'bg'＝背景）,
   *         vignetteHref:(id)=>url（本人用の画像カード）, interactive, selected, focusLine, highlight:Set } */
  function svg(model, geo, opts) {
    opts = opts || {};
    const b = geo.bounds;
    const pad = 80;
    const head = opts.title ? 120 : 0;
    const vb = { x: b.x - pad, y: b.y - pad - head, w: b.w + pad * 2, h: b.h + pad * 2 + head };
    const out = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" width="${Math.round(vb.w)}" height="${Math.round(vb.h)}" font-family="${E(U.FONT)}" class="nt-map${opts.intro ? ' nt-intro' : ''}">`);
    out.push('<defs>');
    out.push(`<filter id="nt-shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#5a4426" flood-opacity="0.18"/></filter>`);
    geo.vignettes.forEach((v, i) => out.push(`<clipPath id="nt-vc${i}"><rect x="${r1(v.x)}" y="${r1(v.y)}" width="${v.w}" height="${v.h}" rx="14"/></clipPath>`));
    out.push('</defs>');
    if (!opts.transparentBg) out.push(`<rect class="nt-bg" x="${vb.x - 4000}" y="${vb.y - 4000}" width="${vb.w + 8000}" height="${vb.h + 8000}" fill="${C.bg}"/>`);
    // 背景の水彩風景（地図全体を覆う。タッチを奪わない）
    const bg = opts.assetHref && opts.assetHref('bg');
    if (bg) out.push(`<image class="nt-bgimg" href="${E(bg)}" xlink:href="${E(bg)}" x="${r1(vb.x)}" y="${r1(vb.y)}" width="${r1(vb.w)}" height="${r1(vb.h)}" preserveAspectRatio="xMidYMid slice" pointer-events="none"/>`);
    // 見出し（書き出し用）
    if (opts.title) {
      const tx = vb.x + 44, ty = vb.y + 42;
      out.push(`<g class="nt-title" pointer-events="none"><text x="${tx}" y="${ty}" font-size="13" font-weight="700" letter-spacing="4" fill="${C.ink}">NOTE TRANSIT</text>`);
      out.push(`<text x="${tx}" y="${ty + 50}" font-size="44" font-weight="900" fill="${C.ink}">${E(opts.title)}</text>`);
      if (opts.subtitle) out.push(`<text x="${tx + 2}" y="${ty + 82}" font-size="17" fill="${C.sub}" letter-spacing="2">${E(opts.subtitle)}</text>`);
      out.push('</g>');
    }

    // 強調：路線フォーカス（その路線だけ）／駅の選択（所属路線を残して、ほかを少し落ち着かせる）
    const focus = opts.focusLine || null;
    const fset = focus ? new Set([focus]) : (opts.focusLines && opts.focusLines.size ? opts.focusLines : null);
    const dimO = focus ? 0.16 : 0.4;
    const hl = opts.highlight || null;
    const dimLine = (id) => (fset && !fset.has(id) ? ` opacity="${dimO}"` : '');
    const stDim = (s) => (fset && s.id !== opts.selected && !s.lines.some((l) => fset.has(l)) ? ` opacity="${focus ? 0.22 : 0.45}"` : '');
    // 初回の描画演出：駅は左上から順に現れる
    const bx0 = b.x, bw0 = Math.max(1, b.w), by0 = b.y, bh0 = Math.max(1, b.h);
    const delay = (x, y) => (opts.intro ? ` style="--d:${(0.25 + 0.5 * ((x - bx0) / bw0) + 0.25 * ((y - by0) / bh0)).toFixed(2)}s"` : '');
    // 画像カード（本人用・主要駅だけ）
    if (opts.vignetteHref && geo.vignettes.length) {
      out.push(`<g class="nt-vignettes" pointer-events="none"${focus ? ' opacity="0.3"' : ''}>`);
      geo.vignettes.forEach((v, i) => {
        const href = opts.vignetteHref(v.id);
        if (!href) return;
        out.push(`<rect x="${r1(v.x - 5)}" y="${r1(v.y - 5)}" width="${v.w + 10}" height="${v.h + 10}" rx="18" fill="${C.paper}" filter="url(#nt-shadow)"/>`);
        out.push(`<image href="${E(href)}" xlink:href="${E(href)}" x="${r1(v.x)}" y="${r1(v.y)}" width="${v.w}" height="${v.h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#nt-vc${i})"/>`);
      });
      out.push('</g>');
    }
    // 路線
    out.push('<g class="nt-lines">');
    for (const l of geo.lines) {
      // 下地（太い地色）を先に描くので、あとから描く路線が前の路線をわずかに途切れさせ、乗換でない交差と区別できる
      out.push(`<g data-line="${E(l.id)}"${dimLine(l.id)}><path class="nt-path" pathLength="1" d="${l.d}" fill="none" stroke="${C.bg}" stroke-width="${l.width + 9}" stroke-linecap="round" stroke-linejoin="round"/><path class="nt-path" pathLength="1" d="${l.d}" fill="none" stroke="${E(l.color)}" stroke-width="${l.width}" stroke-linecap="round" stroke-linejoin="round"/></g>`);
    }
    // 終点の印（線に直交する短い棒）
    for (const e of geo.ends || []) {
      const px = -e.uy * 13, py = e.ux * 13;
      out.push(`<path class="nt-end"${dimLine(e.line)} d="M${r1(e.x + px)} ${r1(e.y + py)} L${r1(e.x - px)} ${r1(e.y - py)}" stroke="${E(e.color)}" stroke-width="6" stroke-linecap="round"/>`);
    }
    out.push('</g>');
    // 延伸予定（記事ではない）
    if (geo.planned && !focus) {
      const p = geo.planned;
      out.push(`<g class="nt-planned" pointer-events="none"><path d="M${r1(p.from.x)} ${r1(p.from.y)} L${r1(p.x)} ${r1(p.y)}" stroke="${C.sub}" stroke-width="4" stroke-dasharray="0.1 11" stroke-linecap="round" fill="none"/>`);
      out.push(`<circle cx="${r1(p.x)}" cy="${r1(p.y)}" r="14" fill="${C.paper}" stroke="${C.sub}" stroke-width="3.5" stroke-dasharray="5 5"/>`);
      out.push(`<text x="${r1(p.x)}" y="${r1(p.y + 36)}" text-anchor="middle" font-size="14" font-weight="700" fill="${C.ink}" stroke="${C.bg}" stroke-width="4" paint-order="stroke">${E(p.label)}</text>`);
      out.push(`<text x="${r1(p.x)}" y="${r1(p.y + 54)}" text-anchor="middle" font-size="12" fill="${C.sub}" stroke="${C.bg}" stroke-width="3" paint-order="stroke">${E(p.sub)}</text></g>`);
    }
    // 連絡通路（意外な乗換）
    if (geo.links.length) {
      out.push(`<g class="nt-links"${focus ? ' opacity="0.25"' : ''}>`);
      for (const k of geo.links) out.push(`<path d="${k.d}" fill="none" stroke="${C.ink}" stroke-width="3.5" stroke-dasharray="0.1 9" stroke-linecap="round" opacity="0.8"/>`);
      out.push('</g>');
    }
    // 路線名バッジ
    out.push('<g class="nt-badges">');
    for (const bd of geo.badges) {
      const w = bd.w;
      out.push(`<g data-line="${E(bd.id)}" class="nt-badge"${dimLine(bd.id)}><rect x="${r1(bd.cx - w / 2)}" y="${r1(bd.cy - 18)}" width="${r1(w)}" height="36" rx="18" fill="${E(bd.color)}"/><text x="${r1(bd.cx)}" y="${r1(bd.cy + 6)}" text-anchor="middle" font-size="17" font-weight="800" fill="#fff" letter-spacing="0.5">${E(bd.name)}</text></g>`);
    }
    out.push('</g>');
    // 月の区切り（時間モード）
    if (geo.months.length) {
      out.push('<g class="nt-months" pointer-events="none">');
      for (const m of geo.months) out.push(`<g><rect x="${r1(m.x - 44)}" y="${r1(m.y - 16)}" width="88" height="26" rx="13" fill="${C.ink}"/><text x="${r1(m.x)}" y="${r1(m.y + 2)}" text-anchor="middle" font-size="13" font-weight="700" fill="${C.paper}">${E(m.text)}</text></g>`);
      out.push('</g>');
    }
    // 駅
    out.push('<g class="nt-stations">');
    for (const s of geo.stations) {
      const sm = model.stations.get(s.id);
      const dim = stDim(s) || (hl && !hl.has(s.id) ? ' opacity="0.35"' : '');
      const sel = opts.selected === s.id;
      const attrs = opts.interactive ? ` tabindex="0" role="button" aria-label="${E((sm.short || '') + '：' + (sm.title || ''))}"` : '';
      const x = r1(s.x), y = r1(s.y);
      out.push(`<g class="nt-st${sel ? ' is-sel' : ''}" data-sid="${E(s.id)}"${attrs}${dim}${delay(s.x, s.y)}>`);
      // 見た目は小さくても、指で押せる範囲は広く取る
      if (opts.interactive) out.push(`<circle cx="${x}" cy="${y}" r="32" fill="transparent"/>`);
      if (sel) out.push(`<circle class="nt-pulse" cx="${x}" cy="${y}" r="${s.r + 20}" fill="${E(s.color)}" opacity="0.18"/><circle cx="${x}" cy="${y}" r="${s.r + 9}" fill="${E(s.color)}" opacity="0.25"/>`);
      if (hl && hl.has(s.id)) out.push(`<circle cx="${x}" cy="${y}" r="${s.r + 10}" fill="#f2c94c" opacity="0.55"/>`);
      if (s.isolated) {
        out.push(`<circle cx="${x}" cy="${y}" r="12" fill="${C.paper}" stroke="#8c9491" stroke-width="3.5" stroke-dasharray="5 5"/>`);
      } else if (s.inter) {
        out.push(`<circle cx="${x}" cy="${y}" r="${s.r + 3}" fill="${C.paper}" stroke="${C.ink}" stroke-width="2.5" filter="url(#nt-shadow)"/><circle cx="${x}" cy="${y}" r="${s.r - 3}" fill="${C.paper}" stroke="${E(s.color)}" stroke-width="6"/>`);
      } else {
        out.push(`<circle cx="${x}" cy="${y}" r="${s.r}" fill="${C.paper}" stroke="${E(s.color)}" stroke-width="6"/>`);
      }
      out.push('</g>');
    }
    out.push('</g>');
    // 駅名
    out.push(`<g class="nt-labels" font-size="${geo.FS}" font-weight="700" fill="${C.ink}" pointer-events="none">`);
    geo.labels.forEach((l, id) => {
      const s = geo.stations.find((x) => x.id === id);
      const dim = s ? stDim(s) : '';
      const sel = opts.selected === id ? ' is-sel' : '';
      out.push(`<text class="lod${l.pri}${sel}" data-for="${E(id)}" x="${r1(l.x)}" y="${r1(l.y)}" stroke="${C.bg}" stroke-width="5" stroke-linejoin="round" paint-order="stroke"${dim}${s ? delay(s.x, s.y) : ''}>${E(l.text)}</text>`);
    });
    out.push('</g>');
    if (opts.title) out.push(`<text x="${vb.x + vb.w - 30}" y="${vb.y + vb.h - 22}" text-anchor="end" font-size="13" fill="${C.sub}" pointer-events="none">NOTE TRANSIT ・ ${model.stations.size}記事 ・ ${model.lines.length}路線</text>`);
    out.push('</svg>');
    return { svg: out.join(''), viewBox: vb };
  }
  function r1(v) { return Math.round(v * 10) / 10; }

  // 同梱画像のパス（単一HTML版では NT.ASSET_URIS のデータURIを使う）
  function assetPath(k) {
    if (NT.ASSET_URIS && NT.ASSET_URIS[k]) return NT.ASSET_URIS[k];
    if (k === 'bg') return 'assets/bg_landscape.jpg';
    if (k.startsWith('guide')) return `assets/guide/export-${k.slice(5)}.jpg`;
    return `assets/decor/${k}.png`;
  }

  NT.render = { svg, assetPath, COLORS: C };
})(globalThis.NT = globalThis.NT || {});
