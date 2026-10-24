# ライセンス

- NOTE TRANSIT 本体のコード：MIT License
- fflate 0.8.2（js/vendor/fflate.min.js）：MIT License, Copyright (c) 2023 Arjun Barrett（全文は js/vendor/fflate.LICENSE.txt）
  - 用途：ZIPの順次展開、共有データの deflate 圧縮。ブラウザ単体で動作（Safari / iOS Safari 対応）。
- 日本語の単語分割：ブラウザ標準の Intl.Segmenter（Safari 14.1 / iOS 14.5 以降）。非対応環境では文字種による分割に自動で切り替え。外部ライブラリは使用していません。
- assets/bg_landscape.jpg：地図の背景の水彩風景（利用者提供の画像。JPEGに変換して同梱）。
- assets/decor_atlas.png ほか装飾画像：NOTE TRANSIT スターターキット同梱素材（画像生成ツールで制作）。assets/decor/*.png は atlas.json の矩形で切り出して縮小したもの。
