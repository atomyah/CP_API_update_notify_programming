# Phase 3 — 要件1 `career_status` ＋ Slack 通知

**最初に動く機能。**求職者の項目が変わったら Slack に通知する。

## 目的

Phase2 の器に最初のウォッチャーを載せ、**実環境で1通の通知を出す**ところまで到達する。
ここまで来れば移植が成立することが実証できる。

## 前提

- Phase2 完了
- 移植元: `app/watchers/resource_watch.py`、`app/core/schema.py` `master.py`、`app/notifiers/slack.py` `dispatcher.py`
- 根拠: 仕様書 3.1節、11.3節、`config/watchers.yaml` の `career_status`

## 作るもの

| ファイル | 責務 |
|---|---|
| `src/core/schema.js` | `GET /v1/ext2/schema/career` の取得と項目定義の検証・24時間キャッシュ |
| `src/core/master.js` | コード値 → ラベル変換（`GET /v1/ext2/master/{codeName}`）。24時間キャッシュ |
| `src/watchers/careerStatus.js` | 要件1の検知ロジック |
| `src/notifiers/slack.js` | Incoming Webhook への送信。**CP のリソースも項目 ID も知らない** |
| `src/templates.js` | 通知本文のテンプレート（`config/templates.yaml` から移す） |
| `src/triggers.js` | `runCareerStatus()` を追加 |

## 仕様（変更しない前提）

- **対象は全求職者。**絞らない。
- **監視項目は schema の全項目 229件**（232 − 除外3）。オリつく項目 `CAREER#48002`（国籍）を含む。
- **値は限定しない。変化したら通知する。**
- 除外: `#UPDATE_DATE` `#INSERT_DATE` サフィックス、`CAREER#LAST_LOGIN`
- 監視リソースは **求職者（`career`）のみ**。企業・求人・進捗・部署・ファイルは監視しない。
- 遷移前後の値を通知する項目のみ `value_raw` を保存する（既定はハッシュのみ）。

## 進め方

1. **ブートストラップを先に作る。**`bootstrapCareerStatus()` を手動実行し、
   通知せずに `snapshots` シートを埋める。**これを飛ばすと全求職者が「変化した」と判定されて Slack が溢れる。**
2. 差分検知を実装する。`getValues()` 1回で全行を読み、メモリ上で比較する（11.3節）。
3. Slack へ1通出す。**まず `--dry-run` 相当（ops チャンネルへ寄せる）で確認してから**本来のチャンネルへ。

## 完了条件

- [ ] `bootstrapCareerStatus()` で `snapshots` シートが埋まる（通知は出ない）
- [ ] 検証用レコード（惣流 アスカ ID=18 / 葛城 ミサト ID=17）の項目を CP 画面から1つ変更し、
      **Slack に1通だけ届く**（遷移前後の値が読める形で）
- [ ] 同じサイクルを2回動かしても2通目が出ない（冪等除去が効いている）
- [ ] コード値がラベルに変換されている（`selectone` / `select` / `search` がコードのまま出ていない）
- [ ] 6分の実行時間内に1サイクルが完了する。超えるなら予算を下げて中断・持ち越しが働く
- [ ] 通知本文に載る項目が明示的に列挙したものだけである（`rules/40`）

## やらないこと

- 要件2/3・要件4（Phase4 / Phase6）
- トリガーの本設定（Phase5。この Phase では手動実行で確認する）
- 通知の件数上限やサマリ切り替え（Phase5）

## 参照

- 仕様書 3.1（通知条件・処理仕様・通知本文・設定）/ 3.1.5（遅延と流量）/ 11.3
- 仕様書 5.4「⚠️ 全項目監視で受け入れている事項」
