# サンプル検証結果（2026-10-24）

提供原本を実際にZIP/XML解析して確認。公開記事のURLへネットアクセスした検証ではない。

- 原本SHA-256：0bd71958dbb1e549588e7dec0fae75294936fa781bb6029c940baa9381c19295
- 原本コピー：バイト一致確認済み。
- XML：note-idtalking-1.xml、97,675 bytes。
- item：14件。wp:status=publish 11件、draft 3件。
- 公開11件すべてタイトル、link、本文、日時あり。
- 全14件linkはnote.comの記事形式で重複なし。ただしdraftのlinkは公開可の根拠ではない。
- 公開記事内img参照31件、すべてZIP内assetsと対応。
- ZIP内はXML1、PNG25、JPG6、Markdown1。
- ハッシュタグ・マガジン・スキ数・PVは取得していない。
- content:encodedとexcerpt:encodedの両方がある。同名のencodedで上書きするパーサーは不可。

共有は公開記事のメタデータのみ。本文・下書き・添付原本はビルドやURLへ含めない。

## 分類の扱い
「ガチャ再販」「AI個人開発」「勉強・教材」は検討用の候補であり、唯一の正解ラベルではない。分類器の実測精度はまだ未検証。

## 参考公式資料
- https://www.help-note.com/hc/ja/articles/16143457500953
- https://www.help-note.com/hc/ja/articles/16143464838681
