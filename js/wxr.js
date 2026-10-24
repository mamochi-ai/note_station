/* NOTE TRANSIT — noteエクスポート（WXR XML）の解析
 * namespace-aware に DOMParser で解析する。content:encoded と excerpt:encoded を区別する。
 * 本文HTMLは DOMParser(text/html) の不活性ドキュメントとして扱い、スクリプト実行・画像読込をしない。 */
(function (NT) {
  'use strict';
  const U = NT.util;

  const NS = {
    content: 'http://purl.org/rss/1.0/modules/content/',
    excerpt: 'http://wordpress.org/export/1.2/excerpt/',
    dc: 'http://purl.org/dc/elements/1.1/',
  };

  function findWpNs(root) {
    const cands = [];
    for (const a of Array.from(root.attributes || [])) {
      if (/^xmlns(:|$)/.test(a.name) && /wordpress\.org\/export\/1\.\d+\/?$/.test(a.value)) cands.push(a.value);
    }
    return cands.length ? cands : ['http://wordpress.org/export/1.2/', 'http://wordpress.org/export/1.1/', 'http://wordpress.org/export/1.0/'];
  }
  function findExcerptNs(root) {
    for (const a of Array.from(root.attributes || [])) {
      if (/^xmlns:/.test(a.name) && /wordpress\.org\/export\/1\.\d+\/excerpt\/?$/.test(a.value)) return a.value;
    }
    return NS.excerpt;
  }

  // item の直下の子要素だけを (namespace, localName) で探す
  function child(item, ns, local) {
    for (const c of Array.from(item.children || item.childNodes)) {
      if (c.nodeType !== 1) continue;
      if (c.localName === local && (ns === null ? !c.namespaceURI : (Array.isArray(ns) ? ns.includes(c.namespaceURI) : c.namespaceURI === ns))) return c;
    }
    return null;
  }
  const text = (el) => (el ? el.textContent : null);

  // 本文HTMLの解析（不活性）
  function parseBody(html) {
    const res = { text: '', headings: [], paragraphs: [], images: [], externalImages: 0 };
    if (!html) return res;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,iframe,noscript,object,embed').forEach((n) => n.remove());
    doc.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (/^\/?assets\//.test(src)) res.images.push(src.replace(/^\//, ''));
      else if (src) res.externalImages++;
    });
    doc.querySelectorAll('h1,h2,h3,h4').forEach((h) => { const t = h.textContent.trim(); if (t) res.headings.push(t); });
    const blocks = doc.querySelectorAll('p,li,h1,h2,h3,h4,blockquote,figcaption,pre,td,th');
    if (blocks.length) {
      blocks.forEach((b) => { const t = b.textContent.replace(/\s+/g, ' ').trim(); if (t) res.paragraphs.push(t); });
    } else {
      const t = (doc.body ? doc.body.textContent : '').replace(/\s+/g, ' ').trim();
      if (t) res.paragraphs.push(t);
    }
    res.text = res.paragraphs.join('\n');
    return res;
  }

  /* XML文字列 → { site, items:[...] } */
  function parseXml(xmlText, sourceName) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const perr = doc.getElementsByTagName('parsererror')[0];
    if (perr) {
      const msg = (perr.textContent || '').replace(/\s+/g, ' ').slice(0, 160);
      throw new Error(`XMLの解析に失敗しました（${sourceName}）: ${msg}`);
    }
    const root = doc.documentElement;
    if (!root || root.localName !== 'rss') throw new Error(`noteのエクスポートXML（WXR形式）ではないようです: ${sourceName}`);
    const wpNs = findWpNs(root);
    const exNs = findExcerptNs(root);
    const channel = child(root, null, 'channel');
    if (!channel) throw new Error(`channel要素がありません: ${sourceName}`);
    const site = {
      title: (text(child(channel, null, 'title')) || '').trim(),
      link: U.safeUrl(text(child(channel, null, 'link')) || ''),
    };
    const items = [];
    for (const it of Array.from(channel.children)) {
      if (it.localName !== 'item' || it.namespaceURI) continue;
      const contentEl = child(it, NS.content, 'encoded');
      const excerptEl = child(it, exNs, 'encoded');
      items.push({
        title: (text(child(it, null, 'title')) || '').trim(),
        link: (text(child(it, null, 'link')) || '').trim(),
        guid: (text(child(it, null, 'guid')) || '').trim(),
        postId: (text(child(it, wpNs, 'post_id')) || '').trim(),
        postDate: (text(child(it, wpNs, 'post_date')) || '').trim(),
        postDateGmt: (text(child(it, wpNs, 'post_date_gmt')) || '').trim(),
        status: (text(child(it, wpNs, 'status')) || '').trim().toLowerCase(),
        postType: (text(child(it, wpNs, 'post_type')) || 'post').trim().toLowerCase(),
        content: contentEl ? contentEl.textContent : '',
        excerpt: excerptEl ? excerptEl.textContent : '',
        source: sourceName,
      });
    }
    return { site, items };
  }

  function isXmlName(n) { return /\.xml$/i.test(n); }

  /* File（.zip / .xml）を端末内で解析する。
   * 戻り値: { site, articles, excluded, warnings, stats, zip } */
  async function importFile(file, opts) {
    opts = opts || {};
    const progress = opts.onProgress || (() => {});
    const signal = opts.signal;
    const check = () => { if (signal && signal.aborted) throw new U.CancelError(); };
    let zip = null;
    const xmlTexts = [];
    const name = file.name || 'file';
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isZip = head[0] === 0x50 && head[1] === 0x4b;
    if (isZip) {
      progress('ZIPのファイル一覧を読んでいます', 0.02);
      zip = await NT.zip.open(file);
      const xmls = zip.entries.filter((e) => isXmlName(e.name));
      if (!xmls.length) throw new Error('ZIPの中にXMLファイルが見つかりません。noteの「記事のエクスポート」で作ったZIPか確認してください');
      let total = 0;
      for (let i = 0; i < xmls.length; i++) {
        check();
        const e = xmls[i];
        total += e.size;
        if (total > zip.limits.maxXmlTotal) throw new Error('XMLの合計サイズが上限を超えています');
        const bytes = await zip.read(e, {
          maxBytes: zip.limits.maxXmlBytes, signal, yield: true,
          onProgress: (r) => progress(`XMLを展開中（${i + 1}/${xmls.length}）`, 0.05 + 0.45 * ((i + r) / xmls.length)),
        });
        xmlTexts.push({ name: e.name, text: new TextDecoder('utf-8').decode(bytes) });
      }
    } else {
      if (file.size > NT.zip.LIMITS.maxXmlBytes) throw new Error('XMLファイルが大きすぎます');
      progress('XMLを読み込んでいます', 0.1);
      const t = await file.text();
      if (!/^\s*(<\?xml|<rss)/.test(t.slice(0, 200))) throw new Error('XMLファイルではないようです。noteのエクスポートZIPかXMLを選んでください');
      xmlTexts.push({ name, text: t });
    }
    check();
    progress('記事を解析しています', 0.55);
    let site = { title: '', link: null };
    const raw = [];
    for (const x of xmlTexts) {
      const r = parseXml(x.text, x.name);
      if (!site.title && r.site.title) site = r.site;
      raw.push(...r.items);
    }
    await U.sleep(0);
    return buildArticles(raw, { site, zip, progress, signal });
  }

  async function buildArticles(raw, ctx) {
    const { site, zip, progress, signal } = ctx;
    const warnings = [];
    const excluded = { draft: 0, future: 0, pending: 0, private: 0, other: 0, nonPost: 0, duplicate: 0 };
    const articles = [];
    const seen = new Set();
    let imgRefs = 0, imgResolved = 0, imgExternal = 0;
    for (let i = 0; i < raw.length; i++) {
      if (signal && signal.aborted) throw new U.CancelError();
      const it = raw[i];
      if (it.postType && it.postType !== 'post' && it.postType !== 'page') { excluded.nonPost++; continue; }
      if (it.status !== 'publish') {
        if (excluded[it.status] !== undefined && it.status !== 'other') excluded[it.status]++;
        else excluded.other++;
        continue;
      }
      const url = U.safeUrl(it.link);
      const idBase = it.postId || it.guid || url || ('item' + i);
      const id = 'a' + U.hash(String(idBase) + '|' + (url || '')).toString(36);
      if (seen.has(id)) { excluded.duplicate++; continue; }
      seen.add(id);
      const w = [];
      let title = it.title.replace(/\s+/g, ' ').trim();
      if (!title) { w.push('タイトル未設定'); title = ''; }
      if (!url) w.push(it.link ? 'URLが不正（https以外など）' : 'URLがありません');
      else if (!U.isNoteHost(url) && !(NT.demo && url.startsWith(NT.demo.BASE))) w.push('note.com以外のURL');
      const date = U.parseWpDate(it.postDate) || U.parseWpDate(it.postDateGmt);
      if (!date) w.push('日付不明');
      const body = parseBody(it.content);
      const images = [];
      for (const src of body.images) {
        imgRefs++;
        const ok = zip ? zip.byName.has(src) : false;
        if (ok) imgResolved++;
        images.push({ name: src, ok });
      }
      imgExternal += body.externalImages;
      const a = {
        id, postId: it.postId || '', url, title, date,
        status: 'publish',
        images: images.filter((x) => x.ok).map((x) => x.name),
        missingImages: images.filter((x) => !x.ok).length,
        warnings: w,
        hasExcerpt: !!(it.excerpt && it.excerpt.trim()),
      };
      a._body = { text: body.text, headings: body.headings, paragraphs: body.paragraphs };
      articles.push(a);
      if (w.length) warnings.push({ id, title: title || `（無題 #${it.postId || i + 1}）`, issues: w });
      if (i % 20 === 0) { progress && progress('記事を解析しています', 0.55 + 0.4 * (i / raw.length)); await U.sleep(0); }
    }
    articles.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
    const exTotal = Object.values(excluded).reduce((s, v) => s + v, 0);
    progress && progress('完了', 1);
    return {
      site, articles, excluded, excludedTotal: exTotal, warnings,
      stats: { items: raw.length, published: articles.length, imgRefs, imgResolved, imgExternal },
      zip,
    };
  }

  NT.wxr = { parseXml, parseBody, importFile, buildArticles, NS };
})(globalThis.NT = globalThis.NT || {});
