# docs 解析スクリプト

`docs/` の原典3ファイルを読める形にテキスト化する使い捨てスクリプト。
アプリケーションコードではない。

**`out/` の生成物は原典ではない。**仕様の根拠を述べるときは必ず `docs/` の原典に当たること。

## 依存

```powershell
py -3 -m pip install openpyxl pypdf pymupdf
```

## 再生成

```powershell
$root = "C:\Users\atyah\Documents\仕事\ブレイン・ラボ\CP進捗通知\app_root"

# HTML 仕様書 → タグ除去したプレーンテキスト
py -3 "$root\tools\docs_dump\dump_html.py" "$root\docs\CAREER_PLUS_API_仕様書_v2.0.4 .html" "$root\tools\docs_dump\out\spec.txt"

# xlsx 項目一覧 → 全シートを TSV
py -3 "$root\tools\docs_dump\dump_xlsx.py" "$root\docs\CAREER PLUS_APIv2_項目一覧_v3.14.7.xlsx" "$root\tools\docs_dump\out\xlsx"

# PDF → テキスト抽出を試みる（この PDF はテキストレイヤがないので失敗する）
py -3 "$root\tools\docs_dump\dump_pdf.py" "$root\docs\APIキー作成時の操作許可リスト.pdf" "$root\tools\docs_dump\out\perm.txt"

# PDF → 3倍解像度で PNG にレンダリング（3分割）。目視で読む
py -3 "$root\tools\docs_dump\render_pdf.py" "$root\docs\APIキー作成時の操作許可リスト.pdf" "$root\tools\docs_dump\out\pdfpng" 3.0 3
```

## 各ファイル

| スクリプト | 用途 |
|---|---|
| `dump_html.py` | script/style を除去し、ブロック要素を改行に変換してタグを剥がす |
| `dump_xlsx.py` | 全シートを走査して TSV 化。シート名と行数を標準出力に出す |
| `dump_pdf.py` | pypdf でテキスト抽出。**この PDF は画像のみで、`(no text layer)` になる** |
| `render_pdf.py` | PyMuPDF でページを PNG 化。テキストレイヤがない PDF はこれで読む |
| `extract_pdf_images.py` | PDF に埋め込まれた画像を個別に書き出す（43個のタイルに分割されているため実用性は低い。`render_pdf.py` を使うこと） |

## 出力

| パス | 内容 |
|---|---|
| `out/spec.txt` | API 仕様書のプレーンテキスト（約4,030行） |
| `out/xlsx/*.tsv` | 14シート（改訂履歴・API一覧・各リソースの項目一覧・項目タイプ） |
| `out/pdfpng/page1_{1,2,3}.png` | 操作許可リストのレンダリング画像 |
| `out/perm.txt` | `(no text layer)` とだけ書かれている。PDF が画像であることの記録 |

## 原典で確認済みの主な位置

`out/spec.txt` の行番号（再生成すると変わる可能性がある）。

| 内容 | 行 |
|---|---|
| 240リクエスト/分の制約 | 213 |
| ブラウザ直接実行の禁止 | 201 |
| トークンエンドポイント（60分有効） | 286-329 |
| エラーコード | 361-387 |
| リソース定義（schema）と itemType の説明 | 478-656 |
| 検索クエリ仕様・searchType の対応表 | 662-928 |
| 取得の値の形式（date/datetime のフォーマット） | 1030-1079 |
| 求職者対応履歴のエンドポイント群 | 1755-2010 |
| 進捗のエンドポイント群 | 3299-3546 |
| 進捗履歴のエンドポイント群 | 3548-3810 |
