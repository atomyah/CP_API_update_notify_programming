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

実装時に追加したもの:

| ファイル | 責務 |
|---|---|
| `src/core/events.js` | `CycleResult`（Python 版 `app/core/events.py` の移植）。Runner がこれだけを見てコミットを決める |
| `src/watchers/dummy.js` | 完了条件のダミーウォッチャー。`runDummyCycle()` / `bootstrapDummyWatcher()` |

`src/core/log.js` は Phase1 で実装済みのため、この Phase では変更していない。

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
差分判定 → notified 追記 → 通知 → snapshots 書き戻し → 最後にカーソルを1回書く
                                                          ↑ ここがコミット点
```

⚠️ **実装では snapshots の書き戻しを通知の後ろに移した**（仕様書 11.4 も更新済み・2026-09-04）。
メモリに溜めて `setValues` 1回で書くので、コミット直前に寄せた方が
「snapshots だけが進む」窓が狭い。`notified` を通知の直前に追記する順序は変えていない。
**この判断をするのは `core/runner.js` の `commit()` だけ。**ウォッチャーはカーソルを書かず、
進めたいカーソルを `CycleResult` に載せて返す（載せなければ前進しない）。

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

- [x] `initSheets()` で `snapshots` `notified` `dead_letter` の3シートができる
      — **GAS 上で確認済み（2026-09-04）。**バインド先スプレッドシートにタブとして3枚できた。
      （＝コンテナバインドであることも実機で確認できた。仕様書 11.2 の前提どおり）
- [x] `runAllTests()`（`runCoreTests` + `runStateTests`）が通る
      — **GAS 上で 55件通過（Phase1 22 / Phase2 33）を確認済み 2026-09-04**
  - [x] **失敗を返したサイクルでカーソルが進まない**（snapshots も書かれない・失敗カウンタが進む）
  - [x] 予算切れ（`exhausted`）でカーソルも `snapshots` も進まない（経過時間切れも同様）
  - [x] 同じ冪等キーの2回目が除去される（サイクル内・サイクルまたぎの両方）
  - [x] `LockService` が取れないとき何もせず抜ける（シートもプロパティも触らない）
  - [x] 通知後にコミットできなくても、次サイクルで二重通知しない
- [x] ダミーのウォッチャー（`watchers/dummy.js`）を `Runner` で実行し、
      通知の代わりにログへ出して一連の流れが動く — **GAS 上で確認済み 2026-09-04**
- [x] 構造化ログが1行1 JSON で出ており、個人情報を含まない

### 実機で確認すること（GAS のエディタで実行する）

1. [x] `initSheets()` → 3シートができる — **確認済み 2026-09-04**
2. [x] `runAllTests()` → 55件通過 — **確認済み 2026-09-04**（`all_tests_passed` total:55 / failed:0）
3. [x] `runDummyCycle()` を1分以上あけて実行 → 2件通知（ログ）・カーソル前進 — **確認済み 2026-09-04**
   （`events_detected:2` / `events_notified:2` / `snapshot_sheets_written:1`）
4. [x] 続けてもう一度 `runDummyCycle()` → 追加の通知が出ない — **確認済み 2026-09-04**
   （`events_detected:0` / `snapshot_sheets_written:0`。**書き戻した snapshots が次の実行で読めている**）
5. [ ] `showState()` → カーソル・失敗カウンタ・行数が読める（未実行。運用補助であり完了条件ではない）

**⚠️ テストの実行ログには `Log.error` が7件・`Log.warn` が2件出るが、これは正常。**
エラー経路（失敗・自動停止・通知後のクラッシュ・ロック競合・壊れた保存値）を
意図的に踏むテストが出しているもの。合否は `all_tests_passed` / `test_failed` だけで判断する。

## やらないこと

- 実際のウォッチャーの検知ロジック（Phase3 以降）
- Slack / メール送信（Phase3 / Phase6）
- トリガーの登録（Phase5）
- `notified` の刈り取り（C-16。未決。**シートが伸びることを許容して先に進む**）

## 参照

- 仕様書 6.1（元のスキーマ）/ 7.1〜7.5 / 11.2〜11.6
- `rules/30-state-and-idempotency.md`（末尾に GAS 版の決定がある）
