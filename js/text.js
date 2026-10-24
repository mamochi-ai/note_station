/* NOTE TRANSIT — 日本語テキスト処理（AIなし）
 * 正規化 → 単語分割（Intl.Segmenter、無ければ文字種ラン）→ 不要語除去 → 特徴語（TF-IDF）。 */
(function (NT) {
  'use strict';

  // 表記ゆれ（汎用的なものだけ）
  const VARIANTS = [
    [/ガチャガチャ|ガシャポン|ガシャガシャ|ガチャポン/g, 'ガチャ'],
    [/子供|こども/g, '子ども'],
    [/個人製作/g, '個人制作'],
    [/ｉｐａｄ|i\s*pad/g, 'ipad'],
    [/ｉｐｈｏｎｅ|i\s*phone/g, 'iphone'],
    [/[✖×✕]️?/g, '×'],
    [/〜|～/g, '～'],
    [/コンピューター/g, 'コンピュータ'],
    [/サーバー/g, 'サーバ'],
    [/ユーザー/g, 'ユーザ'],
  ];

  // 繰り返し表現（モチーフ）。字面の一致だけで付与し、意味を推測しない。
  const MOTIFS = [
    { token: 'つくってみた', label: '作ってみた系の表現', re: /(作|つく)って(み|ま)|作りました|作った|つくった|自作|作らせて/ },
    { token: 'やってみた', label: 'やってみた系の表現', re: /やってみ|試してみ|ためしてみ/ },
    { token: 'いってきた', label: '行ってきた系の表現', re: /行ってき|いってき|訪れ|旅して/ },
    { token: 'たべてみた', label: '食べた系の表現', re: /食べて|食べた|たべた|いただきました/ },
    { token: 'よんでみた', label: '読んだ系の表現', re: /読んで|読んだ|読了|読書/ },
    { token: 'ふりかえり', label: '振り返り系の表現', re: /振り返|ふりかえ|まとめ$/ },
    { token: '予想', label: '予想', re: /予想|予測/ },
  ];
  const MOTIF_LABEL = Object.fromEntries(MOTIFS.map((m) => [m.token, m.label]));

  const STOP = new Set((
    'これ それ あれ どれ ここ そこ こと もの ため よう とき ところ さん くん ちゃん たち ほう ' +
    'です ます でした ました ません ください くださ ない なく なる なり なっ いる いた いう いっ ある あり あっ する して した しま され られ れる せる ' +
    'という といった として について による により における けど けれど でも だけ まで から より など なら ので のに ほど くらい ぐらい ばかり しか ' +
    'また まだ もう とても すごく ちょっと かなり 本当 ほんとう 本当に 実は じつは やっぱり やはり みたい そう こう ああ どう なぜ いつ ' +
    'こんにちは こんばんは おはよう ありがとう ありがとうございます よろしく お願い お願いします 皆さん みなさん 今回 前回 次回 今日 昨日 明日 今週 先日 最近 ' +
    '自分 私 わたし 僕 ぼく 俺 筆者 記事 本記事 note ノート投稿 投稿 内容 感じ 部分 場合 理由 方法 結果 以下 以上 一つ 二つ 今後 最後 最初 ' +
    'フォロー スキ サポート 有料 無料部分 マガジン 購読 コメント シェア 続き 読んで よかっ ぜひ 是非 チップ ' +
    'https http www com jp html php amp nbsp img png jpg jpeg gif ' +
    '配信日 配信 年 月 日 時 分 vol no 第 号 回 件 個 人 つ 的 化 性 者 等 中 用 版 ' +
    '同じ 必要 可能 簡単 大切 大事 一番 全部 普通 一緒 確認 利用 使用 作成 情報 時間 問題 感覚 気持 状態 機能的 意味 全体 一部 以外 自身 前後 他人 本人 ' +
    'one the and for with you your this that are was'
  ).split(/\s+/));

  function normalize(s) {
    let t = String(s || '').normalize('NFKC').toLowerCase();
    for (const [re, rep] of VARIANTS) t = t.replace(re, rep);
    return t;
  }

  function stripNoise(s) {
    return s
      .replace(/https?:\/\/[^\s]+/g, ' ')
      .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g, ' ')
      .replace(/#[^\s#]+/g, (m) => ' ' + m.slice(1) + ' ')
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ');
  }

  const RE_KANJI = /[一-鿿㐀-䶿々〆]/;
  const RE_KATA = /^[゠-ヿー]+$/;
  const RE_HIRA = /^[぀-ゟー]+$/;
  const RE_LATIN = /^[a-z0-9][a-z0-9+#._-]*$/;
  const RE_NUM = /^[0-9０-９.,:\/%-]+$/;

  function charType(ch) {
    if (/[一-鿿㐀-䶿々〆]/.test(ch)) return 'K';
    if (/[゠-ヿー]/.test(ch)) return 'T';
    if (/[぀-ゟ]/.test(ch)) return 'H';
    if (/[a-z0-9]/.test(ch)) return 'L';
    return 'O';
  }

  let seg = null;
  try { if (typeof Intl !== 'undefined' && Intl.Segmenter) seg = new Intl.Segmenter('ja', { granularity: 'word' }); } catch (e) { seg = null; }

  function rawSegments(t) {
    const out = [];
    if (seg) {
      for (const s of seg.segment(t)) if (s.isWordLike) out.push(s.segment);
      return out;
    }
    // フォールバック: 文字種ラン
    let cur = '', ct = '';
    for (const ch of t) {
      const c = charType(ch);
      if (c === ct && c !== 'O') cur += ch;
      else { if (cur && ct !== 'O') out.push(cur); cur = ch; ct = c; }
    }
    if (cur && ct !== 'O') out.push(cur);
    return out;
  }

  function keep(w) {
    if (!w || STOP.has(w)) return false;
    if (RE_NUM.test(w)) return false;
    if (RE_HIRA.test(w)) return w.length >= 4 && !/(いい|ん$|る$|た$|て$|い$|う$|ば$)/.test(w) && !/^(ので|けど|から|ます|まし|でし|ない|ませ|って|ちゃ|じゃ)/.test(w) && !/(ます|ました|ません|でした|ている|ていた|ってる|ちゃう|ない)$/.test(w);
    if (RE_LATIN.test(w)) return w.length >= 2 && !/^[0-9]/.test(w);
    if (RE_KATA.test(w)) return w.replace(/ー/g, '').length >= 2;
    if (/^[\u4E00-\u9FFF々]+[\u3040-\u309F]+$/.test(w)) return false; // 作り・思い 等の活用語
    if (RE_KANJI.test(w)) return w.length >= 2;
    return false;
  }

  /* テキスト → 語の配列（正規化済み）。compounds=true で隣接名詞の結合語も追加 */
  function tokenize(s, compounds) {
    const t = stripNoise(normalize(s));
    const segs = rawSegments(t);
    const out = [];
    let prev = null;
    for (const w0 of segs) {
      const w = w0.trim();
      const ok = keep(w);
      if (ok) out.push(w);
      if (compounds) {
        const noun = ok && (RE_KANJI.test(w) || RE_KATA.test(w)) && !RE_HIRA.test(w);
        if (noun && prev && (prev + w).length <= 8) out.push(prev + w);
        prev = noun ? w : null;
      }
    }
    return out;
  }

  function motifsOf(s) {
    const t = normalize(s);
    return MOTIFS.filter((m) => m.re.test(t)).map((m) => m.token);
  }

  /* 定型フッター等: 記事の過半に出る段落を除外 */
  function boilerplate(articles) {
    const n = articles.length;
    const cnt = new Map();
    if (n < 3) return new Set();
    for (const a of articles) {
      const seen = new Set((a._body && a._body.paragraphs || []).map((p) => p.trim()).filter((p) => p.length >= 6));
      for (const p of seen) cnt.set(p, (cnt.get(p) || 0) + 1);
    }
    const res = new Set();
    for (const [p, c] of cnt) if (c >= Math.max(3, Math.ceil(n * 0.5))) res.add(p);
    return res;
  }

  /* 記事群 → 特徴量。各記事の term→重み と strong（根拠として使える語）と df。
   * タイトル・見出し・本文を別々に正規化して合成（タイトル重視、本文は補助、長文が有利にならない） */
  function features(articles) {
    const bp = boilerplate(articles);
    const docs = [];
    for (const a of articles) {
      const parts = [new Map(), new Map(), new Map()];
      const strong = new Set();
      const add = (m, w) => m.set(w, (m.get(w) || 0) + 1);
      const title = a.title || '';
      for (const w of tokenize(title, true)) { add(parts[0], w); strong.add(w); }
      for (const m of motifsOf(title)) { add(parts[0], m); strong.add(m); }
      const body = a._body || { headings: [], paragraphs: [] };
      for (const h of body.headings || []) {
        if (h === title) continue;
        for (const w of tokenize(h, true)) { add(parts[1], w); strong.add(w); }
      }
      for (const p of body.paragraphs || []) {
        if (bp.has(p.trim())) continue;
        for (const w of tokenize(p, false)) add(parts[2], w);
      }
      for (const [w, c] of parts[2]) if (c >= 2) strong.add(w);
      docs.push({ id: a.id, parts, strong });
    }
    const N = docs.length;
    const df = new Map();
    for (const d of docs) for (const w of d.strong) df.set(w, (df.get(w) || 0) + 1);
    const commonCut = N >= 5 ? 0.5 : 1.01;
    const idf = (w) => { const f = df.get(w) || 1; let v = Math.log(1 + N / f); if (f / N > commonCut) v *= 0.25; return v; };
    const PW = [0.6, 0.25, 0.15];
    for (const d of docs) {
      const vec = new Map();
      d.parts.forEach((m, i) => {
        let norm = 0;
        const tmp = [];
        for (const [w, c] of m) { const v = (1 + Math.log(c)) * idf(w); tmp.push([w, v]); norm += v * v; }
        norm = Math.sqrt(norm);
        if (!norm) return;
        for (const [w, v] of tmp) vec.set(w, (vec.get(w) || 0) + PW[i] * v / norm);
      });
      let norm = 0;
      for (const v of vec.values()) norm += v * v;
      norm = Math.sqrt(norm) || 1;
      const arr = [...vec].map(([w, v]) => [w, v / norm]).sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1)).slice(0, 80);
      d.w = new Map(arr);
      d.top = arr.filter(([w]) => d.strong.has(w)).slice(0, 12).map((x) => x[0]);
      delete d.parts;
    }
    return { docs, df, N, byId: new Map(docs.map((d) => [d.id, d])) };
  }

  /* 語の表示形（タイトル中の元の大文字小文字などを使う） */
  function display(term, titles) {
    if (MOTIF_LABEL[term] || !/[a-z]/.test(term)) return term;
    for (const t of titles) {
      const n = String(t || '').normalize('NFKC');
      const i = n.toLowerCase().indexOf(term);
      if (i >= 0) return n.slice(i, i + term.length);
    }
    return term;
  }

  /* 原題 → 短い駅名（自動案。ユーザーが編集できる） */
  function cutAtBoundary(str, max) {
    const chars = Array.from(str);
    if (chars.length <= max) return str;
    let best = 0;
    for (let i = 1; i <= max && i < chars.length; i++) {
      const a = charType(chars[i - 1].toLowerCase()), b = charType(chars[i].toLowerCase());
      if (a !== b && a !== 'O' && b !== 'O' && !(a === 'K' && b === 'H')) best = i;
      if (/[・ 　]/.test(chars[i])) best = Math.max(best, i);
    }
    if (best < 4) best = max - 1;
    return chars.slice(0, best).join('').replace(/[・\s]+$/, '') + '…';
  }
  function shortName(title, maxLen) {
    maxLen = maxLen || 9;
    let t = String(title || '').normalize('NFKC');
    t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(/[（(][^（）()]*(配信日|更新|追記)[^（）()]*[)）]/g, '');
    const sm = t.match(/(vol\.?\s*\d+|#\s*\d+|第\s*\d+\s*[回話弾号]|part\s*\d+|その\s*\d+)/i);
    const series = sm ? sm[0].replace(/\s+/g, '') : '';
    let main = t.replace(/[～〜][^～〜]*([～〜]|$)/g, ' ');
    if (sm) main = main.replace(sm[0], ' ');
    const brackets = [];
    main = main.replace(/【([^】]*)】/g, (m, x) => { brackets.push(x); return ' '; });
    const quoted = (main.match(/「([^」]{2,})」/) || [])[1];
    main = main.replace(/[「」『』"]/g, '').replace(/\s+/g, ' ').trim();
    if (!main) main = brackets.join(' ') || t;
    const clauses = main.split(/[、。!?！？:：|｜]/).map((x) => x.trim()).filter(Boolean);
    let pick = clauses[0] || main;
    if (pick.length < 6 && clauses[1]) pick = clauses[1];
    if (quoted && pick.length > maxLen) pick = quoted;
    pick = cutAtBoundary(pick, maxLen);
    return ((pick || '（無題）') + (series ? ' ' + series : '')).trim();
  }

  /* 2タイトル間の共通語（公開情報＝タイトルだけから計算。閲覧モード用） */
  function titleTerms(title) {
    return new Set(tokenize(title || '', true).concat(motifsOf(title || '')));
  }

  NT.text = { normalize, tokenize, features, display, shortName, titleTerms, motifsOf, MOTIF_LABEL, boilerplate };
})(globalThis.NT = globalThis.NT || {});
