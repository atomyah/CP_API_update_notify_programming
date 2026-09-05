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

- [x] `bootstrapCareerStatus()` で `snapshots` シートが埋まる（通知は出ない）
- [x] 検証用レコード（惣流 アスカ ID=18 / 葛城 ミサト ID=17）の項目を CP 画面から1つ変更し、
      **Slack に1通だけ届く**（遷移前後の値が読める形で）
- [ ] コード値がラベルに変換されている（`selectone` / `select` / `search` がコードのまま出ていない）
      → **単体テストのみ。実機では未確認**（実機で変更したのは `CAREER#48002`（国籍・text）で、
        マスタを引く項目ではなかった）
- [x] 同じサイクルを2回動かしても2通目が出ない（冪等除去が効いている）
- [x] 6分の実行時間内に1サイクルが完了する。超えるなら予算を下げて中断・持ち越しが働く
- [x] 通知本文に載る項目が明示的に列挙したものだけである（`rules/40`）

## やらないこと

- 要件2/3・要件4（Phase4 / Phase6）
- トリガーの本設定（Phase5。この Phase では手動実行で確認する）
- 通知の件数上限やサマリ切り替え（Phase5）

## 参照

- 仕様書 3.1（通知条件・処理仕様・通知本文・設定）/ 3.1.5（遅延と流量）/ 11.3
- 仕様書 5.4「⚠️ 全項目監視で受け入れている事項」

---

## 実装状況（2026-09-05）

**実装・実環境での通し確認まで完了。**単体テストは `runAllTests` で 88 件通過
（core 22 / state 33 / watchers 33）。
**残る未確認は「コード値 → ラベル変換」の実機確認1点のみ**（上の完了条件を参照）。

### 入れたもの

| ファイル | 内容 |
|---|---|
| `gas/src/core/schema.js` | schema の取得・項目IDの実在検証・オリつく項目の判別 |
| `gas/src/core/master.js` | コード値 → ラベル。**先読みせず参照時に取得**（仕様書 11.8） |
| `gas/src/core/paging.js` | 検索のページング。`limit` 100 固定・ページ上限で打ち切り |
| `gas/src/templates.js` | 通知本文のテンプレートと表示文言（`(未設定)` / `(記録なし)`） |
| `gas/src/notifiers/slack.js` | Incoming Webhook。**CP のトークンバケットは通さない** |
| `gas/src/notifiers/dispatcher.js` | 冪等除去（通知より先に `notified` へ追記）と dead_letter |
| `gas/src/watchers/careerStatus.js` | 要件1の検知ロジック（差分検知・ブートストラップ） |
| `gas/src/triggers.js` | `runCareerStatus()` / `runCareerStatusDryRun()` / `bootstrapCareerStatus()` / `checkCareerStatus()` |
| `gas/src/tests/test_watchers.js` | Phase3 のテスト 33 件 |

既存ファイルへの変更: `core/config.js`（要件1と Slack の設定）/ `core/sheets.js`（`snapshot_values` シート追加）/
`core/state.js`（生値シートの読み書き）/ `core/events.js`（通知の中間表現）/ `core/runner.js`（ctx に schema・master・通知を追加）/
`setup.js`（`showState` の既定を要件1に）。

### 仕様書に反映した決定

| 決定 | 節 |
|---|---|
| 生値は `snapshot_values` シートに**項目を限定して**持つ（既定8項目。Python 版の全項目保存からの変更） | 11.3.1 |
| schema / マスタのキャッシュは**1回の実行の中だけ**（GAS は実行をまたげない） | 11.8 |
| 3.1.1 の「アスカ1名・8項目」は当初の設定である旨を明記（現在は全求職者・全項目） | 3.1.1 |

### ✅ 実環境での通し確認（2026-09-05）

```
1. clasp push
2. initSheets()              snapshot_values シートを追加
3. checkSetup() / checkCareerStatus() / showSlackChannels()
                             → Webhook 4本とも設定済み（career_status / progress_flow / job_intro / ops）
4. bootstrapCareerStatus()   → 5分間隔の一時トリガーで約20回。bootstrapped: true
5. CP 画面で ID 18（惣流 アスカ）の国籍を変更
6. runCareerStatusDryRun()   → ops に [DRY-RUN] 付きで1通。遷移前後が読める
7. 変更をもう一度 → runCareerStatus() → career_status チャンネルへ1通
8. もう一度 runCareerStatus()  → events_detected: 1 / events_notified: 0。**2通目は出ない**
```

| 確認 | 結果 |
|---|---|
| ブートストラップの再開 | ✅ 220秒で自発的に中断し、`page_offset` を持ち越して続きから進む。**約4,000件を約20回で完走** |
| 通知1通・遷移前後の表示 | ✅ `国籍: 米国 → ◯◯` が読める形で届く |
| 冪等除去（`notified` の UNIQUE 制約の代替） | ✅ 2回目は `events_notified: 0`。**Slack に2通目は出ない** |
| ドライラン | ✅ 本来の宛先を本文に明示して ops へ寄る |
| コード値 → ラベル変換 | ⬜ **実機未確認**（単体テストでは確認済み）。`CAREER#CNSLSTATUS_ID` 等を1つ変えれば確認できる |

### 実機で分かったこと

- **検証テナントの求職者は約4,000件**（設計時の想定3,000件より多い）。
  ブートストラップは1回あたり約200件（220秒・1 req/秒）で、完走に約20回・1.5〜2時間かかる。
  `snapshots` シートは約4,000行 × 230列（約92万セル）になる。
- ブートストラップは `CAREER#UPDATE_DATE` の昇順で走るため、
  **直近に更新したレコード（＝検証用レコード）は最後に来る。**通知テストは完走後にしかできない。
