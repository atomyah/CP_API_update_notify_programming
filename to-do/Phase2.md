# Phase 2 — 状態管理と実行基盤

SQLite の4テーブルを GAS に置き換え、ウォッチャーを載せる「器」を作る。
**まだ実際のウォッチャーは作らない。**

## 目的

「カーソルが正しく進む／失敗したら進まない」という不変条件を、トランザクションのない環境で成立させる。
ここが緩いと通知漏れ・二重通知が起き、しかも**発覚が遅れる**ので、Phase3 以降より先に固める。

## 前提

- Phase1 完了
- 移植元: `app/core/store.py` `scheduler.py` `budget.py` `events.py` `logging.py`、`app/watchers/base.py`
- 根拠: 仕様書 6.1 / 7章 / 11.2〜11.6節、`rules/30-state-and-idempotency.md`

## 作るもの

| ファイル | 責務 |
|---|---|
| `src/core/state.js` | `State`。カーソル（Properties）とシート3種の読み書き |
| `src/core/sheets.js` | シートの初期化とバッチ読み書き（`getValues` / `setValues`） |
| `src/core/runner.js` | `Runner.execute(watcherId, watcher)`。ロック・予算・コミット点・失敗カウンタ |
| `src/watchers/base.js` | ウォッチャーの契約（`run(ctx)` → `CycleResult`） |
| `src/core/log.js` | 構造化ログ（1行1 JSON）。`watcher_id` `event` `resource_id` `request_id` |
| `src/setup.js` | `initSheets()` — シートを作る。手動実行 |
| `src/tests/test_state.js` | 状態管理のテスト |

## 状態の置き場所（仕様書 11.2 の決定。変えない）

| 元テーブル | 置き場所 |
|---|---|
| `cursors` | **PropertiesService**（`getScriptProperties()`）。`page_offset` `bootstrapped` 連続失敗数も含む |
| `snapshots` | **シート**。1求職者 = 1行、監視項目 = 列（11.3節） |
| `notified` | **シート** |
| `dead_letter` | **シート** |

## ⚠️ この Phase の核心 — コミット点

GAS にトランザクションはない。**カーソルの書き込みを1サイクル最後の単一操作にすることで代替する。**

```
差分判定 → snapshots 書き戻し → notified 追記 → 通知 → 最後にカーソルを1回書く
                                                          ↑ ここがコミット点
```

- **予算切れ・時間切れで中断するときは `snapshots` も書き戻さない。**
  snapshots だけが進むと、次回その差分は「変化なし」と判定されて**通知漏れになる**。
- 1回の実行は最長6分。**リクエスト予算に加えて経過時間でも中断する**（例: 4分で `exhausted`）。
- `LockService` で多重実行を防ぐ。ロックが取れなければ即座に抜ける（待たない）。

## ⚠️ `notified` の UNIQUE 制約が失われる

SQLite の PRIMARY KEY が二重通知を防いでいた。シートに一意制約はない。**アプリ側で持つ。**

- 冪等キーは `(watcher_id, resource_id, event_type, payload_hash)`。**定義は Python 版から変えない。**
- サイクル内の重複は `Set` で除去する。
- 既送信判定は `notified` シートを読み込んで文字列で照合する。
- **「通知より先に `notified` へ追記する」順序を維持する。**逆順にすると送信成功・追記失敗で二重送信になる。

**移植で最も事故になりやすい箇所。**テストを最優先で書く。

## 完了条件

- [ ] `initSheets()` で `snapshots` `notified` `dead_letter` の3シートができる
- [ ] `runCoreTests()` に加えたテストが通る
  - [ ] **失敗を返したサイクルでカーソルが進まない**
  - [ ] 予算切れ（`exhausted`）でカーソルも `snapshots` も進まない
  - [ ] 同じ冪等キーの2回目が除去される
  - [ ] `LockService` が取れないとき何もせず抜ける
- [ ] ダミーのウォッチャー（CP を叩かず固定のイベントを返すもの）を `Runner` で実行し、
      通知の代わりにログへ出して一連の流れが動く
- [ ] 構造化ログが1行1 JSON で出ており、個人情報を含まない

## やらないこと

- 実際のウォッチャーの検知ロジック（Phase3 以降）
- Slack / メール送信（Phase3 / Phase6）
- トリガーの登録（Phase5）
- `notified` の刈り取り（C-16。未決。**シートが伸びることを許容して先に進む**）

## 参照

- 仕様書 6.1（元のスキーマ）/ 7.1〜7.5 / 11.2〜11.6
- `rules/30-state-and-idempotency.md`（末尾に GAS 版の決定がある）
