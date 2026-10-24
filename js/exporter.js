/* NOTE TRANSIT — 書き出し（SVG / PNG / 閲覧用HTML / 編集用JSON）
 * どれも本文・抜粋・下書き・ローカル画像を含めない（編集用JSONは本文を明示選択した時のみ）。 */
(function (NT) {
  'use strict';
  const U = NT.util;


  const decorCache = {};
  async function decorDataUri(key) {
    if (decorCache[key]) return decorCache[key];
    const src = (NT.DECOR_URIS && NT.DECOR_URIS[key]) || `assets/decor/${key}.png`;
    if (src.startsWith('data:')) return (decorCache[key] = src);
    const blob = await (await fetch(src)).blob();
    const uri = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
    return (decorCache[key] = uri);
  }
  async function decorMap(geo) {
    const m = {};
    for (const d of geo.decor || []) {
      try { m[d.key] = await decorDataUri(d.key); } catch (e) { /* 装飾なしでも描ける */ }
    }
    return m;
  }

  async function svgString(model, geo, opts) {
    const m = await decorMap(geo);
    const r = NT.render.svg(model, geo, Object.assign({}, opts, {
      interactive: false, selected: null, focusLine: null, highlight: null,
      decorHref: (k) => m[k] || '',
    }));
    return r;
  }

  async function toSvgBlob(model, geo, opts) {
    const r = await svgString(model, geo, opts);
    return new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + r.svg], { type: 'image/svg+xml' });
  }

  async function toPngBlob(model, geo, opts) {
    const r = await svgString(model, geo, opts);
    const vb = r.viewBox;
    const maxPx = 16000000;
    const scale = Math.min(2, Math.sqrt(maxPx / (vb.w * vb.h)), 8000 / vb.w, 8000 / vb.h);
    const W = Math.max(1, Math.floor(vb.w * scale)), H = Math.max(1, Math.floor(vb.h * scale));
    const svg = r.svg.replace(/^<svg ([^>]*?)width="[^"]*" height="[^"]*"/, `<svg $1width="${W}" height="${H}"`);
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.decoding = 'sync';
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('画像の生成に失敗しました')); img.src = url; });
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = NT.render.COLORS.bg; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      if (!blob) throw new Error('PNGの生成に失敗しました（画像が大きすぎる可能性）');
      return { blob, width: W, height: H };
    } finally { URL.revokeObjectURL(url); }
  }

  async function fetchText(url) { const r = await fetch(url); if (!r.ok) throw new Error('読み込み失敗: ' + url); return r.text(); }

  /* 閲覧用HTML：アプリ一式＋共有データ（URL共有と同じ内容）を自己完結で埋め込む */
  async function viewerHtml(payloadJson, title) {
    const doc = new DOMParser().parseFromString(NT.BOOT_HTML || '', 'text/html');
    doc.querySelectorAll('script#nt-embedded').forEach((n) => n.remove());
    for (const el of Array.from(doc.querySelectorAll('[data-nt-inline]'))) {
      if (el.tagName === 'LINK') {
        const css = await fetchText(el.getAttribute('href'));
        const st = doc.createElement('style'); st.textContent = css; el.replaceWith(st);
      } else if (el.tagName === 'SCRIPT' && el.getAttribute('src')) {
        const js = await fetchText(el.getAttribute('src'));
        const s = doc.createElement('script'); s.textContent = js.replace(/<\/script/gi, '<\\/script'); el.replaceWith(s);
      }
    }
    // 装飾画像をデータURIで同梱
    const uris = {};
    for (const k of Object.keys(NT.layout.DECOR)) { try { uris[k] = await decorDataUri(k); } catch (e) { /* なしでよい */ } }
    const decor = doc.createElement('script');
    decor.textContent = 'globalThis.NT=globalThis.NT||{};NT.DECOR_URIS=' + JSON.stringify(uris).replace(/</g, '\\u003c') + ';';
    const first = doc.querySelector('script');
    first.parentNode.insertBefore(decor, first);
    const data = doc.createElement('script');
    data.type = 'application/json'; data.id = 'nt-embedded';
    data.textContent = payloadJson.replace(/</g, '\\u003c');
    first.parentNode.insertBefore(data, first);
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
    if (csp) csp.setAttribute('content', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
    doc.title = (title || 'NOTE TRANSIT') + '（閲覧用）';
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
  }

  async function deliver(blob, filename) {
    // iOS では共有シート（ファイルに保存 等）が使いやすい。使えなければダウンロード
    try {
      const file = new File([blob], filename, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document) {
        await navigator.share({ files: [file], title: filename });
        return 'shared';
      }
    } catch (e) { if (e && e.name === 'AbortError') return 'aborted'; }
    U.download(blob, filename);
    return 'downloaded';
  }

  NT.exporter = { toSvgBlob, toPngBlob, viewerHtml, deliver, svgString };
})(globalThis.NT = globalThis.NT || {});
