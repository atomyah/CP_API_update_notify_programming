# Phase 6 — 要件4 `career_action_watch` ＋ メール送信

対応履歴が登録・更新・完了したら、**求職者の担当者にメールを送る。**

## 状態: 実装完了・有効化済み（2026-09-08）

| | |
|---|---|
| 検知ロジック | ✅ 実装済み（`gas/src/watchers/careerAction.js`） |
| メール送信 | ✅ 実装済み（`gas/src/notifiers/mail.js`。`MailApp`）。**実機で送受信を確認** |
| 単体テスト | ✅ `runAllTests` **179件**（Phase6 ぶん 31件）通過 |
| 実環境での通し確認 | ✅ **自動運転で要件1・2・4 の通知が届くことを確認**（2026-09-08。仕様書 11.15節） |
| `enabled` | **`true`**（2026-09-08。`Config.triggers` の `runCareerAction` も `true`）|

**実機で確認できたこと（2026-09-08・ドライラン）:**

```
[DRY-RUN] 本来の宛先: a.yahara@mybrainlab.net
式波 アスカ さんの対応履歴が登録されました。
求職者 : 式波 アスカ (ID 18) / 対応番号 : 1 / 種別 : 電話
```

- 新規登録の検知（`18_1`。**対応番号 0 始まりの連番を正しく扱えている**）
- 宛先の解決（`CAREER#CHARGE_EMAIL` を関連リソース経由で1リクエストで取得）
- コード値のラベル化（`MSTACTION` → 「電話」）
- ドライランの寄せ先（`[DRY-RUN]` の行）

**Python 版のペンディングは GAS では解けている**（仕様書 8.4 / 11.14節）。
保留の理由は「手元 PC から SMTP で送る」前提に由来していた。
`MailApp` は SMTP サーバもアプリパスワードも固定グローバル IP も要らない。

## ⚠️ push した直後に権限の再承認が要る（要件1〜3 の自動運転に影響する）

**`MailApp` を参照するコードを push すると、プロジェクトに新しい OAuth スコープ
（`script.send_mail`）が加わる。**Apps Script はスコープが増えると再承認を求めるため、
**再承認するまで既存の時間主導トリガー（要件1・要件2/3）が
「承認が必要です」で失敗することがある。**

**対処: push したらすぐにエディタで関数を1つ手動実行し、権限ダイアログを承認する。**
`initSheets()` か `checkMail()` でよい（どちらも送信しない）。
承認後はトリガーが元どおり動く。`showTriggers()` と日次サマリで復帰を確認すること。

## ⭐ 有効化の手順（Apps Script エディタで上から順に）

**0〜3 は送信しない。4 で自分宛てに1通だけ送る。**

```
0. initSheets()                (setup.gs)      ⚠️ id_sets シートを作る（既存のシートは触らない）
1. checkMail()                 (checks.gs)     送信上限の残量と管理者アドレスの設定
2. checkCareerAction()         (triggers.gs)   項目・テンプレート・通知先の検証（CPを読むだけ）
3. bootstrapCareerAction()     (triggers.gs)   ⚠️ 基準づくり。通知は出ない
4. sendTestMail()              (checks.gs)     ⚠️ 自分宛てに1通。MailApp が使えるかの確認
5. runCareerActionDryRun()     (triggers.gs)   1サイクル。メールは管理者アドレスへ寄る
6. （ここで CP 画面から対応履歴を1件登録し、5 をもう一度）
7. core/config.js の careerActionWatch.enabled と Config.triggers の
   runCareerAction を true にして clasp push
8. runCareerAction()           (triggers.gs)   ⚠️ **本物の担当者へ届く**
9. createTriggers()            (setup.gs)      自動運転に載せる（冪等）
```

### 先に設定するスクリプトプロパティ

**`.env` ではない。**`.env` は Python 版だけが読む。GAS 版は
Apps Script エディタの ⚙️ プロジェクトの設定 > スクリプト プロパティ から設定する
（`CP_NOTIFY_API_KEY` や `SLACK_WEBHOOK_*` と同じ画面）。

| プロパティ | 値 | 必須 |
|---|---|---|
| `MAIL_ADMIN_ADDRESS` | **運用担当者の `@mybrainlab.net` アドレス**（現状は `a.yahara@mybrainlab.net`） | ⭐ **要る** |
| `MAIL_FROM_ADDRESS` | 差出人にしたいアドレス | 任意（**空でよい**） |

`MAIL_ADMIN_ADDRESS` は**誤送信を防ぐための受け皿**で、次の3つに使う。

| 場面 | 何が届くか |
|---|---|
| `runCareerActionDryRun()` | **本来なら担当者へ行くメールが全部ここへ寄る。**本文の先頭に本来の宛先が出る |
| `sendTestMail()` | 宛先を省略したときの既定の送信先 |
| 宛先を持たない通知（1サイクルの通知上限を超えたぶんのサマリ） | フォールバック先 |

**未設定だと手順5が `ConfigError` で止まる**（寄せ先が無いまま本物の宛先へ送らせないため）。
**個人の Gmail を入れない。**ドライランでは求職者の氏名と対応履歴のメモがそのまま流れる
（`rules/40-secrets-and-security.md`）。

`MAIL_FROM_ADDRESS` は**未設定なら、スクリプトを承認したアカウントのアドレスが差出人になる。**

**⏸ 当面はこのまま**（2026-09-08。C-12）。受信側には `CP進捗通知 <a.yahara@mybrainlab.net>`
と見える（表示名は設定済み）。**運用上の支障は無い。**

`cp-noreply@mybrainlab.net` にしたくなったら、所有者アカウントの**メールエイリアス**として
追加してもらう（付録C 依頼4。ライセンス不要・**コード変更も不要**）。
**保留の理由は Workspace 管理者が誰か分かっていないこと**（C-19）。
反映されたら `MAIL_FROM_ADDRESS` に設定して `sendTestMail()` を1通送り、差出人を確認する。
**⚠️ 反映される前に設定すると送信時に例外になる**（`dead_letter` 行き）。
`MailApp` の `from` に指定できるのは**送信アカウントの確認済みエイリアスだけ。**

⚠️ **検証用レコード（式波アスカ 18 / 葛城ミサト 17）の `CHARGE_EMAIL` は
`a.yahara@mybrainlab.net`** なので、ドライランでも本番実行でも同じ受信箱に届く。
**見分けは本文先頭の `[DRY-RUN] 本来の宛先: ...` の有無。**
差出人も同じアカウントになる（自分から自分へのメールになる）。

## 着手前に確認するとしていたこと（結果）

- [x] **`MailApp` が組織のポリシーで制限されていないか** → **`sendTestMail()` で確認する。**
      コードは用意した。**実行は人がやる**（外へ1通出るため）
- [x] **1日あたりの送信上限** → `checkMail()` が `getRemainingDailyQuota()` の実測値を返す。
      **推測で埋めない**（C-15 と同じ姿勢）
- [x] **送信元アドレスの扱い** → `MailApp` はスクリプト所有者から送る。
      `cp-notify@mybrainlab.net`（C-12）にするには Gmail の確認済みエイリアスに登録し、
      `MAIL_FROM_ADDRESS` を設定する。**未設定なら所有者のアドレスで送る**
- [x] 仕様書 8.4節 / 10.3節（C-2再・C-11・C-12・C-18）/ 11.14節 に反映済み

## C-11（1日あたりの新規対応履歴件数）の実測結果

**検証テナントでは測れないことが確定した**（2026-09-08。`tools/verify/v9_action_volume.py`）。

| 測ったもの | 結果 |
|---|---|
| `career_action` の総件数 | **2件**（ヒアリングの本番規模「約30,000件」とは別物） |
| 30日窓 / 3日窓 | **2件 / 0件** |
| 直近7日の `ACTION_DATE` 別件数 | **すべて 0件** |

**本番テナントに接続したら同じスクリプトを再実行する。**
走査窓（`discoveryWindowDays` / `changeWindowDays`）と `budgetPerCycle` は設定値なので、
実測後にコードを変えずに調整できる。

## 作ったもの

| ファイル | 責務 |
|---|---|
| `gas/src/watchers/careerAction.js` | 要件4の検知ロジック（戦略B） |
| `gas/src/notifiers/mail.js` | `MailApp` での送信。**CP のリソースも項目 ID も知らない** |
| `gas/src/tests/test_career_action.js` | 単体テスト31件 |
| `gas/src/core/config.js` | `careerActionWatch` / `mail` の設定 |
| `gas/src/templates.js` | `action_created` / `action_updated` / `action_completed` |
| `gas/src/core/sheets.js` / `core/state.js` | `id_sets` シート（`S30_prev` の置き場所） |
| `gas/src/checks.js` | `checkMail()` / `sendTestMail()` |
| `gas/src/triggers.js` | `runCareerAction()` / `runCareerActionDryRun()` / `bootstrapCareerAction()` / `checkCareerAction()` |
| `tools/verify/v9_action_volume.py` | C-11 の実測（本番接続時に再実行する） |

## 仕様（変更していない）

- **トリガーは `ACTION_DATE` / `COMPLETE_DATE` / `NEXTACTION_DATE` の3日付のみ。**本文の変更は通知しない
- **戦略B（ID集合の差分 ＋ 日付窓）。**V-3c で「対応履歴を足しても親の更新日は動かない」と判明済み
- 走査窓: 新規検知 **30日** / 変更検知 **3日**
- **全件走査はしない。**走査量は総件数ではなく直近の活動量に比例する（単体テストで固定）
- 宛先は `CAREER#CHARGE_EMAIL`。**対応の担当（`ACTIONCHARGE_ID`）ではない**（別人でありうる）
- **⚠️ 宛先は空になりうる。空なら送らず、件数を数えて日次サマリで報告する。黙って捨てない**
- 通知本文: アクション種別・メモ本文・求職者名・変化した日付

## GAS で決めたこと（仕様書 11.14節）

- `S30_prev` は **`id_sets` シート**（`snapshots` と同じレイアウト・同じコミット点）
- **走査窓の検索が打ち切られたサイクルでは何も書かない。**
  `S30_prev` を中途半端に書き換えると、見えなかった ID が次サイクルで
  「新規登録」に化けて**誤送信**になる
- 冪等キーには日付の**前と後の両方**を入れる（「A → B → A」で2通目が消えないように）
- `enabled: false` の間は `execute()` が `skipped` で抜ける（**失敗カウンタは進めない**）

## 残っていること

- [x] `MailApp` の日次上限 = **1,500通**（2026-09-08 実測。仕様書 11.14節に記載）
- [x] `MailApp` の呼び出しが組織のポリシーで止められていないこと
      （テスト送信で残量が 1500 → 1499 に減った）
- [x] **テストメールの受信確認**（2026-09-08。`sendTestMail()` の1通が実際に届いた）。
      ⚠️ `MailApp` は送信者の「送信済み」にコピーを残さないため、受信側でしか確認できない
- [x] 検証用レコードに対応履歴を1件登録し、通知が届くことの確認（ドライラン）
- [x] **`createTriggers()` による自動運転の確認**（トリガー4本・重複なし。仕様書 11.15節）
- [ ] 「対応完了」（完了日を入れる）と「更新」の文面の確認
- [ ] 担当者メールが空の求職者で、送信されず件数が日次サマリに出ることの確認
- [ ] ⏸ **差出人を `cp-noreply@mybrainlab.net` にする**（C-12・付録C 依頼4）。
      **保留。Workspace 管理者が不明**（C-19）。分かったら依頼文を送り、
      エイリアス追加 → `MAIL_FROM_ADDRESS` を設定 → `sendTestMail()` で確認
- [ ] 本番接続後に C-11 を再実測し、走査窓と予算を見直す（C-18 も同時に）

## やらないこと

- 全件走査（**設計違反**）
- 送信可否の確認が取れていない状態での有効化（`enabled: false` のまま）

## 参照

- 仕様書 3.3節 / 8.4節（**GAS 版は `MailApp`**）/ 10.3（C-2再・C-11・C-12・C-18）/ **11.14節**
