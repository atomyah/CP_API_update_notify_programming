# Phase 1 — 共通基盤（`core/`）

CP API を安全に叩けるところまで。**ウォッチャーも通知も作らない。**

## 目的

「CP に読み取りリクエストが1本通り、それが必ずトークンバケットを経由している」状態を作る。
ここが全機能の土台になるので、後から差し替えが効かない部分（流量制御・認可・時刻形式）を先に固める。

## 前提

- `gas/` の clasp 環境は構築済み（`clasp push` が通る）
- 移植元: `app/core/config.py` `timefmt.py` `ratelimit.py` `auth.py` `client.py` `errors.py`
- 根拠: 仕様書 4章（CP API 連携仕様）、11.1 / 11.7節、`rules/10` `rules/20`

## 作るもの

| ファイル | 責務 |
|---|---|
| `src/core/config.js` | 設定値。`Config` オブジェクト |
| `src/core/errors.js` | `CpApiError`（`statusCode`, `requestId` を持つ） |
| `src/core/timefmt.js` | JST 文字列 ⇔ CP 形式の変換。**ここ以外で日付を整形しない** |
| `src/core/ratelimit.js` | トークンバケット。**永続化する**（下記） |
| `src/core/auth.js` | アクセストークンの取得とキャッシュ |
| `src/core/client.js` | `UrlFetchApp` を包む唯一の HTTP 入口 |
| `src/checks.js` | `checkSetup()` — 疎通・権限・項目IDの検証（`--check` 相当） |
| `src/tests/assert.js` | 最小のアサーション（GAS にテスト framework はない） |
| `src/tests/test_core.js` | `runCoreTests()` から呼ぶテスト群 |

## 決めること（実装前に確定させる）

**1. 設定ファイルの形式** — GAS に YAML パーサはない。`config/app.yaml` `config/watchers.yaml` を
そのまま持ち込めない。**JS のオブジェクトリテラル（`config.js`）に移す**のを既定とする。
値の意味と既定値は YAML から変えない。

**2. 秘密情報の置き場所** — スクリプトプロパティに手で設定する。**コードにも clasp にも入れない。**

| プロパティ名 | 内容 |
|---|---|
| `CP_NOTIFY_API_KEY` | CP の API キー |
| `SLACK_WEBHOOK_*` | Slack Webhook 4本（Phase3 で使う。この Phase では不要） |

## ⚠️ 流量制御 — Python 版から変わる唯一の重要な点

Python は常駐プロセスなのでバケットがメモリ上にあった。**GAS はトリガー実行ごとに状態が消える。**
3本のトリガーがそれぞれ 60 req/分 を使えると考えると合計 180 req/分 になる。

- **残トークンと最終補充時刻を PropertiesService に1キーで保存する。**実行開始時に読み、消費のたびに更新する。
- 補充は経過時間から計算する（`tokens_per_second: 1.0`＝60 req/分、`bucket_capacity: 20`）。
- トークンが無いときは `Utilities.sleep()` で待つ。
- **同時実行の排他（`LockService`）は Phase2 で入れる。**この Phase では単独実行のみを前提にしてよいが、
  バケットの永続化は必ずここで済ませる。

## 完了条件

- [ ] `clasp push` 後、エディタから `checkSetup()` を実行して成功する
  - [ ] アクセストークンが取得できる（`Authorization: Bearer` の大文字小文字に注意。`bearer` は 401）
  - [ ] `GET /v1/ext2/schema/career` が取得でき、監視対象229項目が実在することを検証できる
  - [ ] 401 を受けたとき、1回だけ再取得してリトライする（2回目は設定不備として止まる）
- [ ] `runCoreTests()` が全て通る。最低限、次の4つを検証する（`rules/50-code-style.md`）
  - [ ] トークンバケットが 60 req/分 を超えない
  - [ ] バケットの状態が**実行をまたいで**保持される（プロパティを読み書きしている）
  - [ ] `datetime` の形式変換（`YYYY/MM/DD HH:MM:SS`。`HH:MM` は 400 になる形式なので生成しないこと）
  - [ ] `date` の形式変換（`YYYY/MM/DD`）
- [ ] `UrlFetchApp` を呼んでいる箇所が `core/client.js` の1箇所だけである（grep で確認）
- [ ] ログに API キー・トークン・レスポンスボディが出ていない

## やらないこと

- ウォッチャー・通知・シートへの書き込み（Phase2 以降）
- トリガーの登録（Phase5）
- リトライの作り込み以上のこと。500/504 の指数バックオフまで。それ以外はリトライしない

## 参照

- 仕様書 4.2（認可・⚠️ リフレッシュで旧トークンが即死する）/ 4.5（⚠️ 値の形式は原典の記載が誤り）/ 4.8（エラーコード）
- 仕様書 11.7（GAS のクォータは未確認。`UrlFetchApp` の日次上限を確認する — C-15）
- `rules/10-cp-api.md` / `rules/20-rate-limit.md`
