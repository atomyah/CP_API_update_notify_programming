# 実環境検証スクリプト

`docs/design/04-verification-plan.md` の検証を実施する使い捨てスクリプト。
**`app/` の実装ではない。**結果は `docs/design/07-verification-results.md` にまとめてある。

## 前提

- `.env` の `CP_NOTIFY_API_KEY` を読む。**値はログにも例外にも出さない。**
- 全リクエストを **1秒に1回**へ抑える（240req/分の制約に対して十分に安全側）。
- `cpv.py` が共通モジュール。各スクリプトはこれを import する。
- 実行は `tools/verify/` をカレントディレクトリにして行う。

```powershell
cd "C:\Users\atyah\Documents\仕事\ブレイン・ラボ\CP進捗通知\app_root\tools\verify"
py -3 v5_auth_and_permissions.py
```

## スクリプト

| ファイル | 検証 | 状態 |
|---|---|---|
| `v5_auth_and_permissions.py` | V-5 疎通・認可・各リソースの権限 | ✅ 完了 |
| `v5b_token_lifecycle.py` | トークンの多重発行とリフレッシュ時の無効化 | ✅ 完了 |
| `debug_auth.py` | 401 の切り分け（ヘッダ形式・JWTクレーム） | 参考 |
| `v1_schema_diff.py` | V-1 schema と項目一覧xlsx の差分（オリつく項目の発見） | ✅ 完了 |
| `v1b_custom_item_usable.py` | V-1 オリつく項目が select/検索/ソートで使えるか | ✅ 完了 |
| `v6_query_formats.py` | V-6 クエリ形式・limit・sort | ✅ 完了 |
| `v6b_datetime_precision.py` | V-6 秒精度の境界テスト・ネスト条件 | ✅ 完了 |
| `v3_related_resource.py` | V-3a/b 関連リソースの項目が使えるか | ✅ 完了 |
| `v3d_charge_email_and_writeperm.py` | 担当者メールの欠損状況・APIキーの書き込み権限 | ✅ 完了 |
| `v4_v7_masters_and_scale.py` | V-4 マスタ / V-7 規模 | ✅ 完了 |
| `snapshot.py` | **V-2 / V-3c** の前後比較 | ⏸ 画面操作待ち |

## snapshot.py の使い方

V-2（求人紹介OK→新規登録が何を作るか）と V-3c（対応履歴の変更で親の更新日が動くか）は
CP の画面操作が必要。手順は `docs/design/08-ui-operation-request.md`。

```powershell
py -3 snapshot.py before   # 画面操作の前（取得済み: 2026-08-05）
#   ここで CP の画面を操作する
py -3 snapshot.py after    # 画面操作の後
py -3 snapshot.py diff     # 差分を表示
```

差分で分かること:

- 8リソースの件数の変化と、新しく現れた／消えたリソースID
- 惣流アスカ(18) / 葛城ミサト(17) / 牛嶋薫(6) の **232項目すべて**の変化
- 既存の進捗14件それぞれのステータス・更新日・紹介日の変化

1スナップショットあたり約35リクエスト。

## 書き込みについて

`v3d_charge_email_and_writeperm.py` は**意図的に不正なボディ**を送り、
403（権限なし）と 400（権限あり・内容不正）を判別することで書き込み権限の有無を調べる。
**データは作られない**（実行後に進捗14件・進捗履歴25件のまま変化なしを確認済み）。
`DELETE` は一切試していない。

このアプリは CP に書き戻さない設計なので、通常の検証で書き込み系エンドポイントを叩かないこと。

## 出力

`out/` に生成される。

| ファイル | 内容 |
|---|---|
| `out/schema_live.json` | 10リソースの schema 全体（実環境の正） |
| `out/masters.json` | 主要マスタのコード値とラベル |
| `out/snapshot_before.json` | V-2/V-3c の事前スナップショット |
