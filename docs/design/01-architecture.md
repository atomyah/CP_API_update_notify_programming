# 01. アーキテクチャ

## 1. 結論

**単一 Python プロセス内に、共通基盤 + 機能別ウォッチャーを置く。** 想定どおりの構成を採用する。

その上で、想定に対して次の3点を補強する。

1. ウォッチャーは**並行実行しない**。逐次実行し、スケジューラが優先度順に1つずつ回す。
2. ウォッチャーは**1サイクルのリクエスト予算**を持ち、使い切ったら中断して次サイクルに持ち越す。
   これがないと、要件4の重い走査が高頻度ウォッチャー（要件2）を長時間ブロックする。
3. 要件2と要件3は**同一ウォッチャーに統合する**（`progress_flow`）。
   ただし統合の可否は実環境検証 V-2 の結果次第で、代替も設計してある。

## 2. なぜ1アプリか

想定されていた「240req/分の流量制御を一箇所に集約するため」が最大の理由であり、正しい。
補足すると、分けられない理由はもう1つある。

**要件2・3・4は同じリソースを参照する。** 進捗の通知には求職者名が要り、
対応履歴の通知にも求職者名が要る。プロセスを分けると同じ `career/select` を
別プロセスが重複して叩くことになる。1プロセスなら求職者・求人・企業の
名前解決キャッシュを共有でき、リクエスト数がそのまま減る。

一方で「機能ごとに独立して起動・停止・実行間隔変更ができる」という要求は
プロセス分割なしで満たせる。設定 YAML の `enabled` と `interval_minutes`、
カーソルの `watcher_id` 分離で足りる。

### 検討したが採らなかった案

| 案 | 不採用の理由 |
|---|---|
| 機能ごとに別プロセス + 共有 Redis でレート制御 | 流量制御は守れるが、Redis という運用対象が増える。PoC の規模（合計 1万数千 req/日）に見合わない |
| 単一プロセス + ウォッチャーを並行スレッド実行 | トークンバケットのロック競合と、どのウォッチャーが予算を食ったかの追跡困難さに見合う利得がない。CP 側もレスポンスが速いとは限らない（504 の記載あり） |
| 収集プロセスと通知プロセスの分離（キュー経由） | 通知失敗時の再送が独立するのは利点だが、PoC では `dead_letter` テーブルで足りる |

## 3. ディレクトリ構成

```
app_root/
├── CLAUDE.md
├── rules/                       # 作業ルール（CLAUDE.md から import）
├── docs/
│   ├── (原典3ファイル)
│   └── design/                  # 本設計書
├── tools/docs_dump/             # 原典の解析スクリプト
│
├── app/                         # ★実装フェーズで作る
│   ├── main.py                  # エントリポイント。スケジューラ起動
│   ├── core/
│   │   ├── auth.py              # トークン取得・キャッシュ・再取得
│   │   ├── ratelimit.py         # グローバルトークンバケット
│   │   ├── client.py            # CP API クライアント（唯一の HTTP 出口）
│   │   ├── schema.py            # /schema/{cat} の取得・キャッシュ・項目ID検証
│   │   ├── master.py            # コードマスタの取得・キャッシュ・ラベル変換
│   │   ├── resolver.py          # career/order/client の名前解決キャッシュ
│   │   ├── store.py             # SQLite（cursors/snapshots/notified/dead_letter）
│   │   ├── timefmt.py           # JST ⇔ CP形式の変換を集約
│   │   └── scheduler.py         # ウォッチャー登録・間隔管理・例外隔離・予算配分
│   ├── watchers/
│   │   ├── base.py                  # Watcher 基底（run(budget) -> CycleResult）
│   │   ├── career_status.py         # 要件1
│   │   ├── progress_flow.py         # 要件2 + 要件3（統合）
│   │   └── career_action_watch.py   # 要件4
│   └── notifiers/
│       ├── slack.py
│       └── mail.py
│
├── config/
│   ├── app.yaml                 # レート・間隔・通知先などの基本設定
│   └── watchers.yaml            # 監視ルール（項目ID・遷移条件・通知先）
└── var/                         # リポジトリ外に置くことを推奨
    ├── state.sqlite3
    └── logs/
```

依存の向き: `watchers/` → `core/`、`watchers/` → `notifiers/`。逆向きの依存を作らない。
`watchers/` 同士は import しない。`notifiers/` は CP のリソースを知らない。

## 4. 共通基盤

### 4.1 `core/ratelimit.py` — トークンバケット

**このアプリで唯一絶対に守る不変条件**: CP への HTTP リクエストは必ずここを通る。

| パラメータ | 既定値 | 根拠 |
|---|---|---|
| 補充レート | **1.0 token/秒（= 60 req/分）** | CP 上限 240 の 25%。組み直した設計では本番想定でも平均 4〜13 req/分に収まるため、これで十分（`03-rate-budget.md` 4.3） |
| バケット容量 | 20 | 検索1回 + select 十数件の連続処理を待たせない程度 |
| 上限（設定変更で到達可能） | 2.0 token/秒（= 120 req/分） | 上限の 50%。既定にはしない |

240 が API キー単位かテナント単位かは不明なまま（`06-open-questions.md` Q-1）。
60 req/分なら 75% の余裕が残るため、他の連携と合算されても危険にならない。

**平常時の実測が 20 req/分を超え続けたら設計を疑う。**
走査量が総件数に比例する実装になっていないかを確認すること
（`03-rate-budget.md` 4章の設計意図）。

トークンが無ければブロックする。捨てない・スキップしない。
1分あたりの実消費数を常時メトリクスに出す。

### 4.2 `core/client.py` — API クライアント

- `search(resource, condition, sort, limit, offset) -> (ids, count)`
- `select(resource, id, item_ids) -> dict[item_id, value]`
- `get_schema(resource) -> list[ItemDef]`
- `get_master(code_name) -> dict[code, label]`

責務:
- トークンバケットの消費
- `Authorization` ヘッダの付与とトークン期限管理（`core/auth.py` に委譲）
- ステータスコードに応じたリトライ（`rules/10-cp-api.md` の表に従う）
- `requestId` のログ記録（ベンダー問い合わせに必須）
- 例外の `CpApiError` への正規化

### 4.3 `core/auth.py` — トークン管理

- 起動時に APIキーで `POST /v1/auth/token` → `accessToken` / `refreshToken` を保持。
- `expiresIn` の 5 分前に `refreshToken` で更新。
- `refreshToken` が失効していたら APIキーからやり直す。
- トークンはメモリ上のみ。SQLite にもログにも書かない。

### 4.4 `core/schema.py` — 項目定義の検証

起動時に、設定 YAML に登場する全リソースの `GET /v1/ext2/schema/{resourceCategory}` を取得する
（11 リソース中、実際に使うのは `career` / `career_action` / `progress` / `progress_history` / `order` / `client` の6つ）。

用途は3つ:

1. **設定に書かれた項目IDが実在するかの検証。** 存在しなければ**起動を失敗させる**。
   項目一覧 xlsx と実環境がずれている可能性（オリつく項目、テナント差、xlsx の誤記）があるため、
   実環境の schema を正とする。
2. **項目タイプの取得。** searchType の妥当性検証、値のパース、通知本文の整形に使う。
3. **オリつく項目の発見。** `career` の schema に項目一覧 xlsx にない `itemId` が現れたら、
   それがオリつく項目である可能性が高い。起動時に差分をログに出す（V-1 の自動化）。

schema は 24 時間キャッシュする。

### 4.5 `core/master.py` — コード値→ラベル

`selectone` / `select` / `search` 型の値はコード値。通知にそのまま出すと読めない。
起動時に必要なマスタだけを取得してキャッシュ（24時間）。

最低限必要なマスタ:
`MST_PROGRESS_STATUS`（進捗ステータス） / `MSTUSER`（担当者） / `MSTTEAM`（チーム） /
`MSTACTION`（アクション） / `MSTREGSTATUS` / `MSTCNSLSTATUS` / `MSTWKSTATUS` / `MSTCONRANK`

### 4.6 `core/resolver.py` — 名前解決キャッシュ

通知本文には求職者名・求人名・企業名が要る。これらは変化が遅い。

- `career_id -> (姓, 名, 担当者メール)`: TTL 1時間、LRU 2000件
- `order_id -> (求人名, 企業名)`: TTL 6時間、LRU 1000件

**このキャッシュがリクエスト数に直結する。** 要件2で進捗が動くたびに
`career/select` と `order/select` を叩くと、通知1件あたり4リクエストになる。
キャッシュが効けば2リクエストに落ちる。

TTL 中に求職者名が変わっても通知に古い名前が出るだけで実害は小さい。
逆に `CAREER#CHARGE_EMAIL` は要件4のメール宛先なので、TTL を短く（15分）するか、
要件4だけキャッシュを迂回する。**担当者変更直後に旧担当へ送るのは実害がある。**

### 4.7 `core/store.py` — SQLite

```sql
CREATE TABLE cursors (
  watcher_id   TEXT PRIMARY KEY,
  cursor_value TEXT NOT NULL,     -- 'yyyy-MM-dd HH:mm:ss'(JST) または 'yyyy-MM-dd'
  page_offset  INTEGER NOT NULL DEFAULT 0,  -- 予算切れで中断したときの再開位置
  bootstrapped INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

CREATE TABLE snapshots (
  watcher_id  TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  item_id     TEXT NOT NULL,      -- 全体ハッシュの場合は '#DIGEST'
  value_hash  TEXT NOT NULL,
  value_raw   TEXT,               -- 遷移前後を通知したい項目のみ。既定は NULL
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (watcher_id, resource_id, item_id)
);

CREATE TABLE notified (
  watcher_id   TEXT NOT NULL,
  resource_id  TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  notified_at  TEXT NOT NULL,
  PRIMARY KEY (watcher_id, resource_id, event_type, payload_hash)
);

CREATE TABLE dead_letter (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  watcher_id TEXT NOT NULL,
  payload    TEXT NOT NULL,   -- 通知しようとした内容（個人情報を含むため取り扱い注意）
  error      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

`snapshots.value_raw` は既定 NULL。差分検知にはハッシュで足りる
（`rules/40-secrets-and-security.md`）。

## 5. スケジューラと実行モデル

### 5.1 ウォッチャーのインタフェース

```python
class Watcher:
    id: str
    interval_minutes: int
    priority: int          # 小さいほど優先
    budget_per_cycle: int  # 1サイクルで消費してよいリクエスト数

    def run(self, ctx: Context) -> CycleResult: ...
```

`CycleResult` は少なくとも次を返す:
`ok`（成否） / `requests_used` / `events_detected` / `events_notified` /
`exhausted`（予算切れで中断したか） / `next_cursor`（前進させてよい場合のみ）

### 5.2 メインループ

```
毎秒:
  実行可能なウォッチャー（前回実行から interval 経過 & enabled & 停止されていない）を集める
  priority 昇順で先頭を1つ選ぶ
  budget_per_cycle を渡して run() を呼ぶ
  結果に応じてカーソル・失敗カウンタを更新する
```

- **1つずつ逐次実行。**同時に走るウォッチャーは常に0か1。
- `run()` が予算を使い切って `exhausted=True` を返したら、カーソルを進めず
  `page_offset` を保存して即座に次サイクル候補に戻す。
  優先度の高いウォッチャーが待っていれば、そちらが先に入る。
- 例外は `run()` の外に出さない。出たらスケジューラが捕捉してログに残し、
  そのウォッチャーの失敗カウンタを増やして次へ進む。他のウォッチャーは影響を受けない。
- 失敗カウンタが 5 に達したらそのウォッチャーを自動停止し、警告を出す。
  壊れたまま回り続けて API 予算を食う方が有害。

### 5.3 優先度と間隔

| ウォッチャー | 要件 | 間隔 | 優先度 | 1サイクル予算 |
|---|---|---|---|---|
| `progress_flow` | 2 + 3 | 5分 | 1 | 60 |
| `career_status` | 1 | 15分 | 2 | 60 |
| `career_action_watch` | 4（新規・完了・日付変更） | 15分 | 3 | 120 |

重いのは `career_action_watch` の `select`（3日窓の全件、W ≒ 36）。
予算 120 を超えたら中断し、`exhausted=True` を返して再スケジュールされる。
その合間に優先度1の `progress_flow` が割り込める。

**全件走査（対応履歴3万件 = 300リクエスト）を行うウォッチャーは存在しない。**
走査量は総件数ではなく直近の活動量に比例する（`03-rate-budget.md` 4章）。
この性質は設計の要であり、実装で崩さないこと。

**この構造が想定アーキテクチャに対する最大の追加点。** これがないと、
要件4の走査（数百リクエスト）が実行される間、要件2の5分間隔が守れなくなる。

### 5.4 グレースフルな停止

- SIGTERM で現在のサイクルを完了させてから終了する。
- 中断が必要なら、カーソルを進めずに終了する（`rules/30-state-and-idempotency.md`）。
- 起動時に前回異常終了の痕跡（`page_offset > 0`）があればそこから再開する。

## 6. 設定

### 6.1 `config/app.yaml`

```yaml
cp_api:
  base_url: "https://api.careerplus.jp"
  api_key_env: "CP_NOTIFY_API_KEY"   # 値そのものは書かない
rate_limit:
  tokens_per_second: 1.5             # = 90 req/分（CP 上限 240 の 37.5%）
  bucket_capacity: 30
  warn_threshold_ratio: 0.8
store:
  path: "var/state.sqlite3"

notifiers:
  slack:
    # Incoming Webhook はチャンネルごとに1本。要件別に分ける
    webhooks:
      career_status:  { url_env: "SLACK_WEBHOOK_CAREER_STATUS" }   # 要件1
      progress_flow:  { url_env: "SLACK_WEBHOOK_PROGRESS_FLOW" }   # 要件2
      job_intro:      { url_env: "SLACK_WEBHOOK_JOB_INTRO" }       # 要件3
      ops:            { url_env: "SLACK_WEBHOOK_OPS" }             # 運用アラート
  mail:
    # Google Workspace 経由。PoC はアプリパスワード、本番は SMTP リレー
    host: "smtp.gmail.com"           # 本番: smtp-relay.gmail.com
    port: 587
    starttls: true
    username_env: "SMTP_USERNAME"    # cp-notify@mybrainlab.net
    password_env: "SMTP_PASSWORD"    # アプリパスワード。SMTP リレーでは不要
    from_address: "cp-notify@mybrainlab.net"
    admin_address: "a.yahara@mybrainlab.net"  # 日次サマリと運用アラートの宛先
    dry_run_redirect_to: null        # 設定するとすべてここに送る
```

Incoming Webhook の URL は**チャンネルを特定する秘密情報**。
環境変数から読み、リポジトリにも設定ファイルにも書かない。

### 6.2 `config/watchers.yaml`

ウォッチャーごとの有効化・間隔・監視ルール。詳細は `docs/design/02-watchers.md`。

非エンジニアが変更する要求は現時点でないため、YAML 直編集とする。
ただし**ルールの読み込みを `core/` の1関数に閉じ、
将来スプレッドシートから読む実装に差し替えられる形にしておく**。
ウォッチャー本体はルールの出所を知らない。

## 7. 実装の順序（検証が通ってから）

1. `core/ratelimit.py` + `core/client.py` + `core/auth.py` — 最初にレート制御を成立させる
2. `core/schema.py` — 項目IDの実在検証。**ここでオリつく項目の有無が判明する**
3. `core/store.py` + `core/scheduler.py`
4. `progress_flow`（要件2）— 最も素直で、進捗ステータスの実データが得られる
5. `career_status`（要件1）
6. `career_action`（要件4）— 検証 V-3 の結果で戦略が分岐する
7. 要件3の判定条件を `progress_flow` に追加（検証 V-2 の結果を反映）

2 と 4 の間に一度立ち止まり、実データを見て設計を見直す。
