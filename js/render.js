/* NOTE TRANSIT — SVG描画（文字列生成。全テキストはエスケープ）
 * 画面表示・SVG/PNG/HTML書き出しで同じ描画を使う。 */
(function (NT) {
  'use strict';
  const U = NT.util;
  const E = U.esc;

  const C = { bg: '#fbf6ea', ink: '#2f2b26', sub: '#7a7266', paper: '#fffdf7', grid: '#efe6d2' };

  /* geo: NT.layout.geometry の結果
   * opts: { title, subtitle, decorHref:(key)=>url, interactive, selected, focusLine, highlight:Set, dimOthers } */
  function svg(model, geo, opts) {
    opts = opts || {};
    const b = geo.bounds;
    const pad = 70;
    const head = 86;
    const vb = { x: b.x - pad, y: b.y - pad - head, w: b.w + pad * 2, h: b.h + pad * 2 + head };
    const font = E(U.FONT);
    const out = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" width="${Math.round(vb.w)}" height="${Math.round(vb.h)}" font-family="${font}" class="nt-map">`);
    out.push(`<rect class="nt-bg" x="${vb.x - 4000}" y="${vb.y - 4000}" width="${vb.w + 8000}" height="${vb.h + 8000}" fill="${C.bg}"/>`);
    out.push('<g class="nt-viewport">');
    // 方眼（ごく薄く）
    const gstep = 60;
    let grid = '';
    for (let x = Math.ceil(vb.x / gstep) * gstep; x < vb.x + vb.w; x += gstep) grid += `M${x} ${vb.y}V${vb.y + vb.h}`;
    for (let y = Math.ceil(vb.y / gstep) * gstep; y < vb.y + vb.h; y += gstep) grid += `M${vb.x} ${y}H${vb.x + vb.w}`;
    out.push(`<path d="${grid}" stroke="${C.grid}" stroke-width="1" fill="none" opacity="0.55" pointer-events="none"/>`);
    // 装飾（薄く・タッチを奪わない）
    if (opts.decorHref) {
      out.push('<g class="nt-decor" pointer-events="none" opacity="0.3">');
      for (const d of geo.decor || []) out.push(`<image href="${E(opts.decorHref(d.key))}" xlink:href="${E(opts.decorHref(d.key))}" x="${r1(d.x)}" y="${r1(d.y)}" width="${r1(d.w)}" height="${r1(d.h)}" preserveAspectRatio="xMidYMid meet"/>`);
      out.push('</g>');
    }
    // 見出し
    const tx = vb.x + 36, ty = vb.y + 50;
    out.push(`<g class="nt-title" pointer-events="none"><text x="${tx}" y="${ty}" font-size="26" font-weight="800" fill="${C.ink}" letter-spacing="1">${E(opts.title || 'NOTE TRANSIT')}</text>`);
    if (opts.subtitle) out.push(`<text x="${tx}" y="${ty + 24}" font-size="13" fill="${C.sub}">${E(opts.subtitle)}</text>`);
    out.push('</g>');

    const focus = opts.focusLine || null;
    const hl = opts.highlight || null;
    const dimLine = (id) => (focus && id !== focus ? ' opacity="0.18"' : '');
    // 路線
    out.push('<g class="nt-lines">');
    for (const l of geo.lines) {
      out.push(`<g data-line="${E(l.id)}"${dimLine(l.id)}><path d="${l.d}" fill="none" stroke="${C.bg}" stroke-width="${l.width + 6}" stroke-linecap="round" stroke-linejoin="round"/><path d="${l.d}" fill="none" stroke="${E(l.color)}" stroke-width="${l.width}" stroke-linecap="round" stroke-linejoin="round"/></g>`);
    }
    out.push('</g>');
    // 連絡通路（意外な乗換）
    if (geo.links.length) {
      out.push(`<g class="nt-links"${focus ? ' opacity="0.25"' : ''}>`);
      for (const k of geo.links) out.push(`<path d="${k.d}" fill="none" stroke="${C.ink}" stroke-width="3" stroke-dasharray="2 7" stroke-linecap="round" opacity="0.75"/>`);
      out.push('</g>');
    }
    // 路線名バッジ
    out.push('<g class="nt-badges">');
    for (const bd of geo.badges) {
      const w = bd.w;
      out.push(`<g data-line="${E(bd.id)}" class="nt-badge"${dimLine(bd.id)}><rect x="${r1(bd.x - w - 6)}" y="${r1(bd.y - 15)}" width="${r1(w)}" height="30" rx="15" fill="${E(bd.color)}"/><text x="${r1(bd.x - w / 2 - 6)}" y="${r1(bd.y + 5.5)}" text-anchor="middle" font-size="15" font-weight="700" fill="#fff">${E(bd.name)}</text></g>`);
    }
    out.push('</g>');
    // 月の区切り（時間モード）
    if (geo.months.length) {
      out.push('<g class="nt-months" pointer-events="none">');
      for (const m of geo.months) out.push(`<g><rect x="${r1(m.x - 38)}" y="${r1(m.y - 15)}" width="76" height="22" rx="4" fill="${C.paper}" stroke="${C.ink}" stroke-width="1.2"/><text x="${r1(m.x)}" y="${r1(m.y + 1)}" text-anchor="middle" font-size="12" font-weight="700" fill="${C.ink}">${E(m.text)}</text></g>`);
      out.push('</g>');
    }
    // 駅
    out.push('<g class="nt-stations">');
    for (const s of geo.stations) {
      const sm = model.stations.get(s.id);
      const dim = focus && !s.lines.includes(focus) ? ' opacity="0.25"' : (hl && !hl.has(s.id) ? ' opacity="0.35"' : '');
      const sel = opts.selected === s.id;
      const attrs = opts.interactive ? ` tabindex="0" role="button" aria-label="${E((sm.short || '') + '：' + (sm.title || ''))}"` : '';
      out.push(`<g class="nt-st" data-sid="${E(s.id)}"${attrs}${dim}>`);
      if (opts.interactive) out.push(`<circle cx="${r1(s.x)}" cy="${r1(s.y)}" r="22" fill="transparent"/>`);
      if (sel) out.push(`<circle cx="${r1(s.x)}" cy="${r1(s.y)}" r="${s.r + 9}" fill="none" stroke="${C.ink}" stroke-width="2.5" stroke-dasharray="4 3"/>`);
      if (hl && hl.has(s.id)) out.push(`<circle cx="${r1(s.x)}" cy="${r1(s.y)}" r="${s.r + 7}" fill="#f6d77a" opacity="0.7"/>`);
      if (s.isolated) {
        out.push(`<circle cx="${r1(s.x)}" cy="${r1(s.y)}" r="9" fill="${C.paper}" stroke="#8c9491" stroke-width="3" stroke-dasharray="4 4"/>`);
      } else if (s.inter) {
        out.push(`<circle cx="${r1(s.x)}" cy="${r1(s.y)}" r="${s.r + 2}" fill="${C.paper}" stroke="${C.ink}" stroke-width="3"/><circle cx="${r1(s.x)}" cy="${r1(s.y)}" r="${s.r - 3.5}" fill="${C.paper}" stroke="${C.ink}" stroke-width="2.5"/>`);
      } else {
        out.push(`<circle cx="${r1(s.x)}" cy="${r1(s.y)}" r="${s.r}" fill="${C.paper}" stroke="${E(s.color)}" stroke-width="4.5"/>`);
      }
      out.push('</g>');
    }
    out.push('</g>');
    // 駅名
    out.push(`<g class="nt-labels" font-size="${geo.FS}" font-weight="600" fill="${C.ink}" pointer-events="none">`);
    geo.labels.forEach((l, id) => {
      const s = geo.stations.find((x) => x.id === id);
      const dim = focus && s && !s.lines.includes(focus) ? ' opacity="0.25"' : '';
      out.push(`<text class="lod${l.pri}" x="${r1(l.x)}" y="${r1(l.y)}" stroke="${C.bg}" stroke-width="4" stroke-linejoin="round" paint-order="stroke"${dim}>${E(l.text)}</text>`);
    });
    out.push('</g>');
    out.push('</g>');
    out.push(`<text x="${vb.x + vb.w - 24}" y="${vb.y + vb.h - 18}" text-anchor="end" font-size="11" fill="${C.sub}" pointer-events="none">NOTE TRANSIT ・ 駅 ${model.stations.size} ・ 路線 ${model.lines.length}</text>`);
    out.push('</svg>');
    return { svg: out.join(''), viewBox: vb };
  }
  function r1(v) { return Math.round(v * 10) / 10; }

  NT.render = { svg, COLORS: C };
})(globalThis.NT = globalThis.NT || {});
