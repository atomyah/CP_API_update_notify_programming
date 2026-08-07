# CP進捗通知 システム仕様書

| | |
|---|---|
| 版 | 1.0 |
| 作成日 | 2026-08-07 |
| 対象システム | CP進捗通知（CAREER PLUS API v2 連携による状態変化通知） |
| フェーズ | 実環境検証完了・実装着手前 |
| 位置づけ | **実装の唯一の根拠**。`docs/design/00`〜`08` を統合したもの |

## この文書の読み方

- 本書は `docs/design/` の設計書一式と `rules/` を統合した**実装仕様**である。
  実装時は本書だけを読めば足りるように書いてある。個別の検討経緯は各設計書を参照。
- **CAREER PLUS（以下 CP）の仕様に関する記述は、原典よりも実測を正とする。**
  原典（`docs/CAREER_PLUS_API_仕様書_v2.0.4 .html` 他）の記載が実測と食い違う箇所が複数あり、
  該当箇所には「⚠️ 原典の記載は誤り」と明記した。根拠は `docs/design/07-verification-results.md`。
- 本書と個別設計書が食い違う場合は**本書を正**とする。差異の一覧は付録Bに記載した。

---

# 1. 概要・スコープ

## 1.1 目的

CP の API v2 を定期的にポーリングし、求職者に関する状態変化を検知して
Slack またはメールで関係者に通知する。CP には一切書き戻さない。

## 1.2 対象要件

| # | 要件 | 通知先 | 実現可否 |
|---|---|---|---|
| 1 | 特定の求職者の項目（デフォルト項目およびオリつく項目）のステータスが変わったら通知 | Slack | ✅ 実測で確定 |
| 2 | 求職者の進捗が、はじめから内定までのフロー全体について進行するごとに通知 | Slack | ✅ 実測で確定 |
| 3 | 「求人紹介OK」→「新規登録」で次の進捗に移った時点で通知 | Slack | ✅ 実測で確定（要件2と同一データソース） |
| 4 | 対応履歴が登録・更新・完了した時、その求職者の担当者へ通知 | メール | ✅ 実測で確定 |

**要件2と要件3は同一のデータソース（`progress_history` の追加）であり、1つのウォッチャーで扱う。**
要件3は「新しいリソースが作られるイベント」ではなく、
進捗ステータスが `社内確認中(16)` → `応募意思確認中(求人)(11)` へ遷移するイベントだった（実測）。

## 1.3 スコープ外（意図的に対応しないこと）

| 内容 | 理由 |
|---|---|
| リアルタイム通知 | CP に Webhook / イベント通知が存在しない。全要件がポーリングであり、最短でも間隔ぶんの遅延が乗る |
| CP への書き込み | 通知専用。API キーに作成・更新・削除権限を付与しない設計とし、事故の可能性を消す |
| 進捗・対応履歴の**削除**の検知 | 削除されたレコードは検索結果に現れない。検知には全件の定期照合が必要でコストが見合わない |
| 対応履歴の**本文**変更の通知 | 業務側の決定。トリガーは日付3項目のみ（本文は通知の表示内容としては載せる） |
| 非エンジニア向けの設定 UI | 現時点で要求がない。ルール読み込みを1箇所に閉じ、将来差し替え可能にしておく |
| ウォッチャーの並行実行 | トークンバケットの競合と可観測性の悪化に見合う利得がない |

## 1.4 決定済みの前提

| 項目 | 決定 |
|---|---|
| 実行環境 | Python 3.11 以上 / **単一プロセス**。<br>**PoC は手元の Windows PC（本機または上司の PC）で実行する。常時起動しない**（9.5節） |
| 状態管理 | SQLite（単一ファイル） |
| 監視ルールの設定 | YAML 設定ファイルの直編集（エンジニアが変更） |
| 許容遅延 | 要件ごとに個別設定（要件2/3: 5分、要件1: 15分、要件4: 15分） |
| CP への書き込み | 一切しない。読み取り専用の API キーで運用 |
| 想定流量 | **約 5,000 req/日（平均 3.5 req/分）**。CP 上限 240 req/分 の 1.5% |

---

# 2. 用語と前提

## 2.1 用語

| 用語 | 意味 |
|---|---|
| **オリつく項目** | CP のオリジナル項目作成機能で追加された項目。itemId が `{PREFIX}#{数値}` 形式（例 `CAREER#48002`）。標準項目は英字の記号名（例 `CAREER#LASTNAME`）なので、正規表現 `^[A-Z_]+#\d+$` で機械的に判別できる |
| **ウォッチャー** | 1つの監視ルールを実行する単位。カーソル・予算・実行間隔を個別に持つ |
| **カーソル** | ウォッチャーごとの前回実行位置（時刻または日付） |
| **スナップショット** | 差分検知用の前回値。既定はハッシュのみ保存 |
| **走査窓 / 窓** | 日付条件で有界化した検索範囲。要件4で使用（新規検知30日 / 変更検知3日） |
| **冪等キー** | 同一イベントの二重通知を防ぐための一意キー |
| **関連リソース** | CP の仕組み。`career_action` の関連リソースは `career` であり、検索条件・取得項目・ソートキーに親の項目 ID を混在させられる |
| **枝番** | `{親ID}_{連番}` 形式の ID の後半。`career_action` は 0 始まり、`progress_history` は 1 始まり（**リソースごとに起点が違う**） |

## 2.2 リソース一覧（CP の 11 リソース）

| resourceCategory | 日本語 | 関連リソース | 本システムでの使用 |
|---|---|---|---|
| `career` | 求職者 | なし | ✅ 要件1 |
| `career_action` | 求職者対応履歴 | **求職者** | ✅ 要件4 |
| `progress` | 進捗 | なし | ✅ 要件2/3 |
| `progress_history` | 進捗履歴 | なし | ✅ 要件2/3 |
| `order` | 求人 | 企業、部署 | ✅ 通知本文の名前解決 |
| `client` | 企業 | なし | ✅ 通知本文の名前解決 |
| `career_workexperience` | 求職者職歴 | 求職者 | 未使用 |
| `client_action` | 企業対応履歴 | 企業 | 未使用 |
| `department` | 部署 | 企業 | 未使用 |
| `wrkcareer` | 求職者候補 | なし | 未使用 |
| `file` | ファイル | なし | 未使用 |

## 2.3 検証済みレコード（検証テナント）

| 求職者 | ID | `CAREER#48002`（国籍） | `CHARGE_ID` | `CHARGE_EMAIL` |
|---|---:|---|---:|---|
| **惣流 アスカ** | **18** | 米国 | 7 | a.yahara@mybrainlab.net |
| 葛城 ミサト | 17 | 日本 | 7 | a.yahara@mybrainlab.net |

---

# 3. 機能仕様

## 3.0 全ウォッチャー一覧

### 3.0.1 項目変化ウォッチャー（`ResourceWatcher`）— 実装済み

**監視対象は求職者（`career`）のみ**（業務側の決定 2026-08-07）。
実装はリソース非依存の汎用クラスで、要件1はその 1 インスタンスとして動く。

| ウォッチャー ID | リソース | 対象レコード | 監視項目数 | 間隔 | 優先度 | 予算 | 通知先 |
|---|---|---|---:|---:|---:|---:|---|
| `career_status` | `career` 求職者 | **全求職者** | **229**（232 − 除外3） | 15分 | 2 | 60 | `career_status` |

- **対象求職者を絞らない。**当初の「惣流アスカ（ID 18）のみ」から拡大した。
  絞りたくなったら `target.condition` を足すだけでよい（コード変更は不要）。
- **項目は schema の全項目。**オリつく項目 `CAREER#48002`（国籍）を含む。
  項目リストを YAML に列挙しないので、**CP 側で項目が増減しても追随する。**
- 除外は 3 件のみ: `CAREER#UPDATE_DATE` / `CAREER#INSERT_DATE`（保存のたびに動く）、
  `CAREER#LAST_LOGIN`（マイページのログインで動く）。

### 3.0.2 監視対象外のリソース

企業（`client`）/ 求人（`order`）/ 進捗（`progress`）/ 進捗履歴（`progress_history`）/
部署（`department`）/ ファイル（`file`）は**業務側の決定により監視しない**（2026-08-07）。

技術的には**同じ `ResourceWatcher` で監視できることを実環境で確認済み**なので、
必要になれば `config/watchers.yaml` にブロックを足すだけでよい。参考値:

| リソース | 監視可能な項目数 | レコード数（実測） |
|---|---:|---:|
| `client` 企業 | 80 | **9,845** |
| `department` 部署 | 62 | **14,565** |
| `order` 求人 | 167 | 8 |
| `progress` 進捗 | 24 | 16 |
| `progress_history` 進捗履歴 | 18 | 29 |
| `file` ファイル | 10 | 0 |

`client` と `department` を足す場合、ブートストラップに約 6.8 時間かかる（60 req/分）。

### 3.0.3 ⚠️ この方式で監視できない 4 リソース

**`UPDATE_DATE` / `INSERT_DATE` を持たないリソースは、変更を検知する手段が無い**
（実測 2026-08-07）。仮に対象に加えたくなっても、同じ仕組みでは実現できない。

| リソース | 項目数 | 代替手段 |
|---|---:|---|
| `career_action` 求職者対応履歴 | 14 | 要件4の戦略B（ID集合の差分＋全件走査）。⏸ ペンディング |
| `career_workexperience` 求職者職歴 | 18 | 同上。未着手 |
| `client_action` 企業対応履歴 | 9 | 同上。未着手 |
| `wrkcareer` 求職者候補 | 409 | 同上。未着手 |

親リソースの `UPDATE_DATE` で代用することはできない
（子リソースを操作しても親は動かない。V-3c で実測確定）。

### 3.0.4 その他のウォッチャー

| ウォッチャー ID | 要件 | 間隔 | 優先度 | 予算 | 通知手段 | 状態 |
|---|---|---:|---:|---:|---|---|
| `progress_flow` | 2 + 3 | 5分 | 1 | 60 | Slack | ⬜ 未実装。`progress_history` の**追加**を検知する（項目変化とは別の仕組み） |
| `career_action_watch` | 4 | 15分 | 3 | 120 | メール | ⏸ メール送信がペンディング（8.4節） |

優先度は小さいほど先に実行される。**同時に走るウォッチャーは常に0か1**（3.5節）。

---

## 3.1 要件1 — `career_status`（求職者項目の変化）

### 3.1.1 通知条件

**監視対象項目の値が前回値と変われば通知する。遷移先の値による絞り込みはしない。**

- 対象求職者: **惣流アスカ（求職者ID 18）のみ**。`CAREER#CAREER_ID EQ 18` で絞る
- 監視項目: オリつく項目1つ + ステータス系7項目

| 項目ID | ラベル | 型 | 参照マスタ |
|---|---|---|---|
| **`CAREER#48002`** | **国籍（氏名・生年月日）** ※オリつく項目 | text | — |
| `CAREER#REGSTATUS_ID` | 登録ステータス | selectone | `MSTREGSTATUS` |
| `CAREER#CNSLSTATUS_ID` | 面談ステータス | selectone | `MSTCNSLSTATUS` |
| `CAREER#WKSTATUS_ID` | 現在の状況 | selectone | `MSTWKSTATUS` |
| `CAREER#RANK_ID` | ランク | selectone | `MSTCONRANK` |
| `CAREER#MYPAGE_STATUS` | マイページステータス | selectone | `MSTMYPAGECHK` |
| `CAREER#CHARGE_ID` | 担当者 | selectone | `MSTUSER` |
| `CAREER#CHARGETEAM_ID` | 担当チーム | selectone | `MSTTEAM` |

このテナントのオリつく項目は「国籍」1つのみ（schema 全走査で確認済み）。

### 3.1.2 処理仕様

```
1. POST /v1/ext2/career/search
     condition: AND [ CAREER#CAREER_ID EQ "18",
                      CAREER#UPDATE_DATE GE <カーソル − オーバーラップ60秒> ]
     sort:      CAREER#UPDATE_DATE asc
     limit:     100
   → 変化した求職者の ID 一覧

2. 各 ID について POST /v1/ext2/career/select/{id}
     itemIds: 監視対象8項目 + CAREER#CAREER_ID + CAREER#LASTNAME + CAREER#FIRSTNAME

3. snapshots の前回値と比較。異なる項目だけを通知イベントにする
   - 前回値が snapshots に無い求職者（初めて見た）は通知しない

4. コード値をマスタでラベルに変換し、Slack へ送信

5. snapshots を更新し、カーソルを前進（失敗が1件でもあれば前進させない）
```

### 3.1.3 通知本文

**変化前後の値をマスタでラベル化して載せる**（例: 面談ステータス `1` → `3` を「未対応 → 面談待ち」）。
このため `watched_items` に列挙した項目のみ `snapshots.value_raw` に生値を保存する
（他の項目はハッシュのみ。7.3節）。

### 3.1.4 設定

```yaml
watchers:
  career_status:
    enabled: true
    interval_minutes: 15
    priority: 2
    budget_per_cycle: 60
    overlap_seconds: 60
    target:
      condition:
        compoundType: and
        items:
          - itemId: "CAREER#CAREER_ID"
            searchType: "EQ"
            value: "18"              # 惣流アスカ
    watched_items:
      - item_id: "CAREER#48002"          # オリつく項目「国籍（氏名・生年月日）」
        label_override: "国籍"
      - item_id: "CAREER#REGSTATUS_ID"
      - item_id: "CAREER#CNSLSTATUS_ID"
      - item_id: "CAREER#WKSTATUS_ID"
      - item_id: "CAREER#RANK_ID"
      - item_id: "CAREER#MYPAGE_STATUS"
      - item_id: "CAREER#CHARGE_ID"
      - item_id: "CAREER#CHARGETEAM_ID"
    notify:
      channel_key: "career_status"
      template: "career_item_changed"
```

**対象を広げるときは `target.condition` を書き換えるだけでよい**（担当チーム・登録ステータス・
ランク等の条件に差し替え可能）。**絞り込まないと全社の求職者更新を拾う**ので、
本番展開時は必ず条件を入れること。

将来「特定の値になったときだけ通知したい」という要望が出た場合に備え、
`watched_items` の各要素に `from` / `to` フィルタを足せる構造にしておく。既定はフィルタなし。

### 3.1.5 遅延と流量

| | |
|---|---|
| 最大遅延 | 15分 + 処理時間 |
| 1サイクル | 検索1〜2 + 変化した求職者数ぶんの select |
| 想定 | 約2 req/サイクル、約190 req/日 |

---

## 3.2 要件2 / 要件3 — `progress_flow`（進捗フローの進行）

### 3.2.1 業務フロー（実測で判明した範囲）

```
                    [求人紹介OK]
  社内確認中(16) ──────────────────→ 応募意思確認中(求人)(11)
        ↑                                    │
        │                                    ├─[応募OK（求人照会）]──→ ?
        │                                    ├─[応募NG（求人照会）]──→ ?
        └────[再面談（社内確認中へ）]────────┘
```

**このフローは後戻りする。**「再面談」で `11` → `16` に戻る経路があり、
**後戻りも進捗履歴の追加として記録される**（実測: `21_3` が追加され `21_2` は残った）。
よって後戻りも通常の遷移と同じ経路で検知できる。

### 3.2.2 通知条件

**進捗履歴が1行増えたら「フローが進行した」とみなす。**
CP はステータス変更を進捗履歴 API 経由で行う設計であり、進捗の新規作成も
枝番の最初（`21_1`）の進捗履歴として記録される（実測）。

**モードA（全遷移を通知）で開始する。**
マスタの返却順が業務フロー順ではないことが実測で判明している
（実際の遷移 `16 → 11` はマスタ順 `16 → 25 → 11` の `25 説明会` を飛ばしている）。
フロー定義を推測で埋めると通知漏れになるため、まず全遷移を流し、実データを見てから絞る。

**要件3は、モードAの全遷移通知の上に「特定の遷移だけ文面とチャンネルを変える」形で乗せる。**
要件2と要件3で別々に API を叩くことはしない。

| 要件3の判定 | `PROGRESS_HISTORY#PROGRESS_STATUS_ID == "11"`（応募意思確認中(求人)）<br>`from_status == "16"`（社内確認中）を併用すると誤検知が減る |
|---|---|

### 3.2.3 処理仕様

```
1. POST /v1/ext2/progress_history/search
     condition: PROGRESS_HISTORY#INSERT_DATE GE <カーソル − オーバーラップ60秒>
     sort:      PROGRESS_HISTORY#INSERT_DATE asc
     limit:     100
   → 新しく作られた進捗履歴の ID 一覧（形式 "{progressId}_{枝番}"）

2. ID を文字列分解して progressId と枝番を取り出す（API 呼び出し不要）
   ※ progress_history の枝番は 1 始まり（実測）。ただし親IDごとの最小枝番を
      基準に判定し、起点に依存しない実装にすること

3. POST /v1/ext2/progress_history/select/{id}
     itemIds: PROGRESS_HISTORY#PROGRESS_STATUS_ID,
              PROGRESS_HISTORY#PROGRESS_DATE,
              PROGRESS_HISTORY#CAREER_CHARGE_ID,
              PROGRESS_HISTORY#ORDER_CHARGE_ID
   → 遷移先ステータス

4. POST /v1/ext2/progress/select/{progressId}
     itemIds: PROGRESS#CAREER_ID, PROGRESS#ORDER_ID, PROGRESS#STATUS_ID,
              PROGRESS#PROGRESS_CHARGE_ID
   → 誰の・どの求人か

5. resolver で求職者名・求人名・企業名を解決（キャッシュヒット時は0リクエスト）

6. マスタでステータスコードをラベルに変換して Slack へ送信

7. snapshots は不要（履歴の追加そのものがイベント）。カーソルを前進
```

**`PROGRESS#INTRODUCTION_DATE`（紹介日）は要件3の判定に使えない。**
「求人紹介OK」実行後も `None` のままだった（実測）。

**`PROGRESS#PROGRESS_CHARGE_ID`（進捗の担当者）は項目一覧 xlsx に存在しないが実環境には存在する。**
通知本文に使える。

### 3.2.4 冪等キーの注意

フローが後戻りしうるため、**冪等キーには必ず枝番を含める。**

```
(watcher_id, resource_id="21_3", event_type="status_changed", payload_hash)
```

`resource_id` に進捗履歴 ID（枝番を含む）を使えば足りる。
`progressId + ステータス値` で冪等キーを作ると、`16 → 11 → 16` と往復したときに
2回目の `16` が重複扱いされて通知が消える（`21_1` と `21_3` は同じステータス値 `16`）。

### 3.2.5 拾えないもの

| 事象 | 拾えるか | 理由 |
|---|---|---|
| ステータスの前進 | ○ | 進捗履歴の追加として記録される（実測） |
| 進捗の新規作成 | ○ | 枝番の最初の進捗履歴（実測） |
| 「求人紹介OK」（要件3） | ○ | `PROGRESS_STATUS_ID = "11"` への遷移（実測） |
| 後戻りの遷移（再面談） | ○ | 履歴の追加として記録される（実測） |
| 進捗履歴の**編集**（日付の直し等） | △ | `PROGRESS_HISTORY#UPDATE_DATE` を別途見れば可能。既定では見ない |
| 進捗履歴の**削除** | **×** | 削除は検索に現れない |
| 進捗そのものの削除 | **×** | 同上 |

削除・巻き戻しの通知が必要になった場合は「日次で全進捗のステータスを棚卸しする
低頻度ウォッチャー」を足す設計になる。**今回は作らない（明示的な判断）。**

### 3.2.6 進捗ステータス（`MST_PROGRESS_STATUS`・18件）

| コード | ラベル | | コード | ラベル |
|---:|---|---|---:|---|
| 16 | 社内確認中 | | 5 | 成約処理中 |
| 25 | 説明会 | | 6 | 入社確認待ち |
| 11 | 応募意思確認中(求人) | | 14 | 請求処理中 |
| 12 | 書類提出待ち | | 10 | 完了 |
| 1 | 書類結果待ち | | 8 | 企業へNG連絡中 |
| 2 | 面接設定中 | | 7 | 求職者へNG連絡中 |
| 3 | 面接結果待ち | | 17 | NG終了 |
| **21** | **内定** | | 9 | 辞退終了 |
| 4 | 入社意思確認中(内定) | | 13 | 削除終了 |

**この並びはマスタ API の返却順であり、業務上の遷移順ではない**（実測で裏づけ済み）。
CP の「進捗ステータス設定」に定義された遷移グラフは API から取得できない。
正確な順序は業務側への確認事項（10章 B-4）だが、**モードAで開始するため実装の前提にはならない。**

### 3.2.7 設定

```yaml
watchers:
  progress_flow:
    enabled: true
    interval_minutes: 5
    priority: 1
    budget_per_cycle: 60
    overlap_seconds: 60

    notify_all_transitions: true    # モードA（既定）
    watched_statuses: []            # モードB用（notify_all_transitions が false のとき有効）

    notify:
      channel_key: "progress_flow"
      template: "progress_transition"

    # 要件3: 特定の遷移だけ別チャンネル・別文面にする
    special_transitions:
      - name: "求人紹介OK"
        to_status: "11"             # 応募意思確認中(求人)。実測で確定
        from_status: "16"           # 社内確認中（省略可。指定すると誤検知が減る）
        notify:
          channel_key: "job_intro"
          template: "job_intro_ok"
```

### 3.2.8 遅延と流量

| | |
|---|---|
| 最大遅延 | 5分 + 処理時間 |
| 1サイクル | 検索1 + 遷移件数 ×（履歴select 1 + 進捗select 1 + 名前解決 0〜2） |
| 想定 | 約3 req/サイクル、約860 req/日 |

---

## 3.3 要件4 — `career_action_watch`（対応履歴の登録・更新・完了）

### 3.3.1 前提となる制約

**`career_action` には `INSERT_DATE` も `UPDATE_DATE` も存在しない。**
持っている日付は次の3つで、いずれも**ユーザが入力した業務上の日付であり、
レコードの変更時刻ではない**。

| 項目ID | ラベル | 型 |
|---|---|---|
| `CAREER_ACTION#ACTION_DATE` | 対応日 | **date**（時刻なし） |
| `CAREER_ACTION#COMPLETE_DATE` | 完了日 | **date**（時刻なし） |
| `CAREER_ACTION#NEXTACTION_DATE` | 次回コンタクト日 | datetime |

さらに、**対応履歴を操作しても親の `CAREER#UPDATE_DATE` は動かない**（実測で確定）。
新規登録・内容更新・完了日入力のいずれでも、求職者レコードの232項目は一切変化しなかった。

**→ 「いつ変更されたか」を CP に問い合わせる手段が存在しない。**
このため、ID 集合の差分と日付窓を組み合わせた方式（戦略B）を採る。

### 3.3.2 通知条件（トリガーは日付3項目のみ）

業務側の決定により、**トリガーは `ACTION_DATE` / `COMPLETE_DATE` / `NEXTACTION_DATE` の
3つの日付の変化のみ**とする。本文（メモ等）の変更は通知しない。

| 要件の文言 | 実装上の定義 |
|---|---|
| 新規対応が**登録された時** | 30日窓の ID 集合に、前回サイクルに無かった ID が現れた |
| **更新された時** | 3つの日付項目のいずれかが前回値と変化した |
| **対応完了した時** | `COMPLETE_DATE` が null → 値 に変化した（上の特殊ケース） |

**「対応完了」は「日付が変化した」の一種**なので検知機構は1つで足りる。文面だけを出し分ける。

### 3.3.3 母集団の絞り込み（走査量を直接決める最重要の設定）

**担当者が未設定の求職者には通知しない。それなら走査もしない。**

```
condition に AND で追加:
  CAREER#CHARGE_ID  ENTERED  ""     ← 関連リソース条件。実測で動作確認済み
```

検証テナントでは求職者18人中5人（28%）しか担当者が設定されていなかった。
本番でも同程度なら、**これだけで走査量が約 1/3 になる。**

必要なら `CAREER#REGSTATUS_ID NOT_EQ "5"` で登録抹消済みの求職者も除外できる（動作確認済み）。

> ⚠️ **`CAREER#CHARGE_EMAIL` は検索条件に使えない**（400 `itemIdが定義されていません`）。
> 取得はできる。絞り込みには `CAREER#CHARGE_ID ENTERED` を使うこと。

### 3.3.4 処理仕様

**窓の幅を用途ごとに変える。ID 集合の比較は安いので窓を広く、`select` は高いので窓を狭く。**

```
A. POST /v1/ext2/career_action/search   ← 30日窓（新規検知の広い網）
     condition:
       and:
         - CAREER#CHARGE_ID  ENTERED  ""                      ← 通知対象の母集団に限定
         - or:
             - CAREER_ACTION#ACTION_DATE      GE <今日 − 30日>
             - CAREER_ACTION#COMPLETE_DATE    GE <今日 − 30日>
             - CAREER_ACTION#NEXTACTION_DATE  GE <今日 − 30日> 00:00:00
     sort:  [ CAREER_ACTION#CAREER_ID asc, CAREER_ACTION#HISTSEQ asc ]
     limit: 100（ページング）
   → ID 集合 S30                                    …… 約4 req

B. S30 に前回サイクル（S30_prev）で無かった ID = 「新規登録」の候補

C. POST /v1/ext2/career_action/search   ← 3日窓（A と同じ形、窓だけ狭い）
   → ID 集合 S3                                     …… 約1 req

D. (S3 ∪ 新規候補) の各 ID について
   POST /v1/ext2/career_action/select/{id}
     itemIds:
       CAREER_ACTION#ACTION_DATE          ← トリガー
       CAREER_ACTION#COMPLETE_DATE        ← トリガー
       CAREER_ACTION#NEXTACTION_DATE      ← トリガー
       CAREER_ACTION#ACTION_ID            ← 通知本文（アクション種別）
       CAREER_ACTION#ACTIONMEMO           ← 通知本文（メモ）
       CAREER_ACTION#ACTIONCHARGE_ID      ← 通知本文（対応担当）
       CAREER#LASTNAME / CAREER#FIRSTNAME ← 通知本文（求職者名）
       CAREER#CHARGE_EMAIL                ← 宛先
   → 1リクエストで判定材料・本文・宛先がすべて揃う（実測で確認済み）
                                                     …… 約36 req

E. snapshots の日付3項目と比較して分類
     snapshots に日付がある:
         COMPLETE_DATE が null → 値            → 「対応完了」
         それ以外で日付3項目のいずれかが変化   → 「更新」
     snapshots に無い:
         S30_prev にも居なかった               → 「新規登録」
         S30_prev には居た                     → 「更新」（日付が最近の値に変わって窓に入った）

F. 該当分をメール送信（宛先が空ならスキップして件数を計上）

G. snapshots を日付3項目だけで更新（本文は保存しない）。カーソル／S30 を保存
```

**30日窓（A）を残す理由**: 安全網の全件走査を廃止したため、新規検知の網を広くしておきたい。
ID だけなら 1日40件・担当者設定率30% で S30 ≒ 360 → **4リクエスト**にしかならない。安い保険。

**3日窓（C）に絞る理由**: `select` は 1リクエスト＝1レコードで高い。日付変更の検知はここに限定する。

**分類に `S30_prev` を使う理由**: 古いレコードの日付が変更されて窓に入ってきたとき、
snapshots に無いため「新規登録」と誤通知してしまう。前回の30日窓の ID 集合と突き合わせれば
**追加コストゼロで**正しく分類できる。

**ソートは必ず2キーで指定する。** `HISTSEQ` は求職者ごとの連番でグローバルには一意にならない。
`CAREER_ID asc` + `HISTSEQ asc` の複数キーソートが動作することは実測済みで、これでページングが安定する。
なお **`HISTSEQ` は 0 始まり**（実測 `6_0` / `18_0`）。1 始まりを前提にしないこと。

### 3.3.5 宛先

**`CAREER#CHARGE_EMAIL`（求職者の担当者メールアドレス）。**
対応履歴側の `CAREER_ACTION#ACTIONCHARGE_ID`（対応の担当）ではない。

実測で「対応の担当（`ACTIONCHARGE_ID = 8`）と求職者の担当（`CHARGE_ID = 7`）が別人」の
ケースを確認している。**この2つを取り違えると誤送信になる。**

担当者変更直後に旧担当へ送るのを避けるため、`CHARGE_EMAIL` はキャッシュせず
毎回 `career_action/select` で取り直す（同一リクエストなので追加コストはゼロ）。

### 3.3.6 ⚠️ 宛先は空になりうる（実測）

項目一覧 xlsx では「必須●」だが、**検証テナントでは 18人中13人が空だった。**

| `CHARGE_ID` | 人数 | `CHARGE_EMAIL` |
|---|---:|---|
| 7（矢原） | 3 | a.yahara@mybrainlab.net |
| 1（川端） | 2 | kawabata@mybrainlab.net |
| **0**（未設定を表す値） | 12 | **空** |
| **`None`** | 1 | **空** |

**`CHARGE_ID = 0` と `CHARGE_ID = None` の2種類の「未設定」がある。どちらも「担当者なし」として扱う。**

処理仕様（業務側の決定）:

1. 宛先が空・不正なら**通知メールを送らない**（`on_missing_address: skip`）
2. ただし**黙って捨てない**。「宛先なしでスキップした」ことを構造化ログに残す
   （求職者ID と対応履歴ID。メールアドレス自体はログに出さない）
3. スキップ件数を集計し、**日次で管理者に1通サマリを送る**
   （「本日 N 件の対応履歴が担当者未設定のため通知されませんでした」）
4. `snapshots` は宛先の有無に関わらず更新する。担当者が後から設定されても過去分は遡って通知しない

**理由**: 本番でも同じ割合なら通知の大半が消える。黙ってスキップすると
「動いているのに通知が来ない」状態に気づけない。

### 3.3.7 通知本文

トリガーは日付だが、**本文にはアクション種別とメモを載せる**（業務側の指定）。
`select` で同時に取得済みなので追加コストはない。

```
件名: [CP] 惣流アスカ さんの対応履歴が更新されました

求職者   : 惣流 アスカ (ID 18)
対応番号 : 0
種別     : 電話                        ← ACTION_ID を MSTACTION でラベル化
対応担当 : 【BL】矢原アトム              ← ACTIONCHARGE_ID を MSTUSER でラベル化

変更内容 :
  完了日        : (未設定) → 2026/08/05  ← 変化した日付だけを列挙
  次回コンタクト : 2026/08/09 → 2026/08/12

内容:
  ご本人からお電話ありました。
  メールもありました。
```

「変更内容」には**変化した日付だけ**を出す。新規登録時は3つの日付の初期値を出す。

### 3.3.8 検知できるもの・できないもの

**検知される（日付が最近の値になる操作はすべて捕まえられる）**

| ケース | 理由 |
|---|---|
| 新規登録（対応日が当日前後） | 30日窓に現れる |
| 対応完了（完了日に当日が入る） | 3日窓に入る |
| 次回コンタクト日を近い日付に変更 | 3日窓に入る |
| **何年前の対応履歴でも、日付を最近の値に変更** | **窓に入ってくる** |

窓は3つの日付の **OR 和集合**なので、「窓の外にある**間は**見えない」だけで永久ではない。

**残る穴**

| ケース | 実害 |
|---|---|
| 日付を「古い値」から「別の古い値」に変更（例: 20日前 → 25日前） | 30日窓には居続けるが変更検知窓（3日）に入らないため気づけない。業務上ほぼ無意味な操作 |
| 3つの日付を1つも入力せず、その後も一度も入れない | そもそも通知すべき日付が存在しない |
| 日付を30日以上前の値に変更して窓から出る | 時間経過による自然な窓落ちと区別できない |
| 対応履歴の**削除** | 削除は検索に現れない（要件外）。ただし30日窓の ID 集合から消えることは検知でき、将来必要になれば追加コストなしで実装できる |

必要になれば日次の全件走査（約300 req/日）を後から足せる構造は残しておく。

なお **`ACTION_DATE` は未来日を取りうる**（実測 `2026-08-06`）。
窓は `GE <今日 − N日>` なので未来日は常に含まれる。**下限だけを気にすればよい。**

### 3.3.9 設定

```yaml
watchers:
  career_action_watch:
    # ⏸ メール送信がペンディングのため、既定は false（8.4節）
    #    検知ロジックの実装・テストは通知経路と独立して進められる
    enabled: false
    interval_minutes: 15
    priority: 3
    budget_per_cycle: 120       # 超えたら中断して次サイクルへ持ち越す

    # 走査量を直接決める最重要の設定。通知しない求職者は走査もしない
    population:
      condition:
        compoundType: and
        items:
          - itemId: "CAREER#CHARGE_ID"
            searchType: "ENTERED"
            value: ""
          # 必要なら抹消済みを除外（動作確認済み）
          # - itemId: "CAREER#REGSTATUS_ID"
          #   searchType: "NOT_EQ"
          #   value: "5"

    # OR 和集合。1リクエストで取れることを実測済み
    window_items:
      - "CAREER_ACTION#ACTION_DATE"
      - "CAREER_ACTION#COMPLETE_DATE"
      - "CAREER_ACTION#NEXTACTION_DATE"
    discovery_window_days: 30   # 新規検知の網。ID だけなので広くても安い
    change_window_days: 3       # 日付変更の検知。select するのでコストに直結
                                # 参考: 7日=5.6 / 14日=11 / 30日=24 req/分

    # 変化を検知する項目。ここに無い項目が変わっても通知しない（＝本文は対象外）
    trigger_items:
      - "CAREER_ACTION#ACTION_DATE"
      - "CAREER_ACTION#COMPLETE_DATE"
      - "CAREER_ACTION#NEXTACTION_DATE"

    # 通知本文に載せる項目。トリガーではない
    body_items:
      - "CAREER_ACTION#ACTION_ID"        # アクション種別（MSTACTION でラベル化）
      - "CAREER_ACTION#ACTIONMEMO"       # メモ本文
      - "CAREER_ACTION#ACTIONCHARGE_ID"  # 対応担当（MSTUSER でラベル化）

    notify:
      to_item: "CAREER#CHARGE_EMAIL"     # 求職者の担当者。ACTIONCHARGE_ID ではない
      on_missing_address: "skip"         # 送らない。ただし件数を集計して日次で管理者へ報告
      templates:
        created:   "action_created"
        completed: "action_completed"
        updated:   "action_updated"
```

### 3.3.10 遅延と流量

| イベント | 最大遅延 | 取りこぼし |
|---|---|---|
| 新規登録 | 15分 | 3つの日付を1つも入力しない場合のみ |
| 対応完了 | 15分 | 完了日を変更検知窓の外の日付にした場合のみ |
| 更新（日付3項目の変化） | 15分 | 「古い値 → 別の古い値」の変更のみ |
| 本文（メモ）の変更 | — | **通知しない**（スコープ外） |

**要件4は約 3,940 req/日（平均 2.7 req/分）。**
走査が15分に収まらない場合も**通知は失われない**。予算切れで中断してカーソルを据え置き、
次サイクルで続きを処理する。遅延が伸びるだけ。

---

## 3.4 通知チャンネル・宛先の割り当て

| 用途 | 手段 | 宛先 |
|---|---|---|
| 要件1 | Slack Incoming Webhook | `SLACK_WEBHOOK_CAREER_STATUS` |
| 要件2 | Slack Incoming Webhook | `SLACK_WEBHOOK_PROGRESS_FLOW` |
| 要件3 | Slack Incoming Webhook | `SLACK_WEBHOOK_JOB_INTRO` |
| 要件4 | メール（SMTP）<br>**PoC はローカル SMTP（`localhost:1025`）へ送る**（8.4節） | `CAREER#CHARGE_EMAIL` |
| 運用アラート・日次サマリ | Slack + メール | `SLACK_WEBHOOK_OPS` / `admin_address` |

Incoming Webhook はチャンネルごとに1本必要。**URL はチャンネルを特定する秘密情報**であり、
環境変数から読む（8章）。

---

## 3.5 スケジューラの実行モデル

### 3.5.1 メインループ

```
毎秒:
  実行可能なウォッチャー（前回実行から interval 経過 & enabled & 自動停止されていない）を集める
  priority 昇順で先頭を1つ選ぶ
  budget_per_cycle を渡して run() を呼ぶ
  結果に応じてカーソル・失敗カウンタを更新する
```

- **1つずつ逐次実行。同時に走るウォッチャーは常に0か1。**
- `run()` が予算を使い切って `exhausted=True` を返したら、カーソルを進めず `page_offset` を保存し、
  即座に次サイクル候補へ戻す。優先度の高いウォッチャーが待っていればそちらが先に入る。
- 例外は `run()` の外に出さない。スケジューラが捕捉してログに残し、失敗カウンタを増やして次へ進む。
  **1つのウォッチャーの失敗が他を巻き込まない。**
- 失敗カウンタが **5** に達したらそのウォッチャーを自動停止し、警告を出す。
  壊れたまま回り続けて API 予算を食い潰す方が有害。

### 3.5.2 インタフェース

```python
class Watcher:
    id: str
    interval_minutes: int
    priority: int          # 小さいほど優先
    budget_per_cycle: int  # 1サイクルで消費してよいリクエスト数

    def run(self, ctx: Context) -> CycleResult: ...
```

`CycleResult` は少なくとも次を返す:
`ok` / `requests_used` / `events_detected` / `events_notified` /
`exhausted`（予算切れで中断したか） / `next_cursor`（前進させてよい場合のみ）

### 3.5.3 なぜチャンク実行が必要か

要件4の走査（数十〜数百リクエスト）が一気に走ると、その間 要件2 の5分間隔が守れなくなる。
**予算による中断と再スケジュールが、この構造の要である。**

**全件走査（対応履歴3万件 = 300リクエスト）を行うウォッチャーは存在しない。**
走査量は総件数ではなく直近の活動量に比例する。**この性質を実装で崩さないこと。**

---

# 4. CP API 連携仕様

> **本章は実測（`docs/design/07-verification-results.md`）を正とする。**
> 原典の記載と食い違う箇所には ⚠️ を付けた。

## 4.1 エンドポイント

- FQDN は **`https://api.careerplus.jp`** 固定
- 業務リソースは `/v1/ext2/` 配下。認可のみ `/v1/auth/token`
- 全リクエストに `Authorization: Bearer <アクセストークン>` を付ける（`/v1/auth/token` を除く）

| エンドポイント | 用途 |
|---|---|
| `POST /v1/auth/token` | トークン取得 |
| `POST /v1/ext2/{resource}/search` | 検索（ID 集合と件数のみ返る） |
| `POST /v1/ext2/{resource}/select/{id}` | 取得（1リクエスト = 1リソース） |
| `GET /v1/ext2/schema/{resourceCategory}` | 項目定義の取得 |
| `GET /v1/ext2/master/list` | マスタ一覧 |
| `GET /v1/ext2/master/{codeName}` | コード値とラベル |

登録（`POST /v1/ext2/{resource}/`）・更新（`PUT`）・削除（`DELETE`）は**使用しない。**
API キーにも権限を付与しない。

## 4.2 認可・トークン管理

| 項目 | 仕様 |
|---|---|
| 有効期限 | 60分（`expiresIn: 3600`） |
| トークンの実体 | RS256 の JWT（`iss=careerplus.jp` / `aud=conson`） |
| 取得手段 | API キー（`grantType: "api_key"`）または refreshToken（`grantType: "refresh_token"`） |
| 更新タイミング | **有効期限の5分前**に再取得 |
| ヘッダ | `Authorization: Bearer <token>`。**`bearer`（小文字）は 401** |
| 保持場所 | **メモリ上のみ。**SQLite にもログにも書かない |

> ⚠️ **トークンエンドポイントのレスポンスには `code` / `result` の共通ラッパが無い。**
> `{accessToken, refreshToken, expiresIn}` のフラットな JSON が返る。
> 他のエンドポイントと同じパーサを使い回さないこと。

> ⚠️ **リフレッシュすると旧アクセストークンが即座に死ぬ**（実測。原典に記載なし）。
> `refresh_token` でトークンを取り直すと、**同じ系列の直前のアクセストークンが
> その瞬間に無効化される。猶予期間はない。**
> - トークンの差し替えは**原子的**に行う。「新トークンを取得してから差し替える」の間に
>   旧トークンを使うコードパスを作らない。
> - **将来ウォッチャーを並行実行する場合の重大な制約になる。**
>   逐次実行の単一プロセス設計ならこの問題は自然に回避される。
> - なお API キーから複数回取得したトークンは別系列として扱われ、同時に有効。「1キー1トークン」ではない。

401 を受けたら**1回だけ**トークンを再取得してリトライする。
2回目の 401 は設定不備として扱い、リトライループに入らない。

## 4.3 検索（`POST /v1/ext2/{resource}/search`）

| 項目 | 仕様 |
|---|---|
| レスポンス | **ID の配列（`ids`）と総件数（`count`）のみ。項目値は返らない** |
| `limit` | 最大 **100**、未指定時 20。**必ず 100 を明示指定する**（101 は 400） |
| `sort` | 未指定時の順序は保証されない。**常に一意に定まるソートキーを指定する** |
| 深い offset | タイムアウトの可能性あり。1回の検索で辿るページ数に上限を設け、超えたら次サイクルに持ち越す |
| `value` の `null` | **指定できない。**未入力判定は `NOT_ENTERED` + 空文字 |
| ネストした condition | ✅ 動作（AND の中に OR を入れられる） |
| 複数キーのソート | ✅ 動作 |
| 関連リソースの項目を条件に使う | ✅ 動作（`career_action/search` で `CAREER#*` を指定できる） |

`count` は総ヒット件数なので、**値が要らず件数だけ欲しい場面は 1 リクエストで済む。**

### searchType と項目タイプの対応（〇が使用可）

| 項目タイプ | GT | LT | GE | LE | EQ | NOT_EQ | LIKE | NOT_LIKE | START_WITH | END_WITH | ENTERED | NOT_ENTERED |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| text | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 |
| textarea | | | | | | | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 |
| number | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | | | | | 〇 | 〇 |
| select | | | | | | | | | | | 〇 | 〇 |
| selectone | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 |
| search | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 |
| date | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | | | | | 〇 | 〇 |
| datetime | 〇 | 〇 | 〇 | 〇 | 〇 | 〇 | | | | | 〇 | 〇 |

## 4.4 取得（`POST /v1/ext2/{resource}/select/{id}`）

- **1リクエスト = 1リソース。N 件欲しければ N 回叩く。ここが流量の主因。**
- リクエストボディの `itemIds` に必要な項目だけを列挙する。
  「とりあえず全項目」を取らない（レスポンスサイズとタイムアウトのリスク）。
- **関連リソースの項目 ID を `itemIds` に混ぜられる**（実測で確認済み）。
  `career_action/select` の `itemIds` に `CAREER#LASTNAME` `CAREER#CHARGE_EMAIL` を含めると
  同一レスポンスに値が返る。**要件4はこれにより `career/select` が不要になっている。**

## 4.5 ⚠️ 値の形式（原典の記載は誤り）

**リクエストとレスポンスで形式が違う。読んだ値をそのまま検索条件に渡せない。**

### レスポンス（取得時の値）

| 項目タイプ | 実際の形式 | 例 | 原典の記載 |
|---|---|---|---|
| `text` / `selectone` / `search` | 文字列そのまま | `"米国"` | 一致 |
| `textarea` | 改行が `\n` | | 一致 |
| `select` | 文字列の配列 | `["8","9"]` | 一致 |
| `date` | **ISO 8601** | `2026-08-05` | `yyyy/MM/dd`（誤り） |
| `datetime` | **ISO 8601・秒あり** | `2026-08-05T15:20:48` | `yyyy/MM/dd HH:mm`（誤り） |
| `number` | **JSON の数値**（文字列ではない） | `18` | 記載なし |

### リクエスト（検索条件の `value`）

| 項目タイプ | 受け付ける形式 | 拒否される形式 |
|---|---|---|
| `date` | **`YYYY/MM/DD`** のみ | ISO 8601（ハイフン区切り） |
| `datetime` | **`YYYY/MM/DD HH:MM:SS`** または `YYYY/MM/DD`（後者は `00:00:00` 扱い） | **`YYYY/MM/DD HH:MM`（原典の記載そのもの）**、ISO 8601、ハイフン区切り |

400 のメッセージが形式を明示している:
> `itemTypeがdatetimeの場合はYYYY/MM/DD形式またはYYYY/MM/DD HH:MM:SS形式で入力してください。`

**形式変換は `core/timefmt.py` の1箇所に集約する。各所で `strftime` を書かない。**

### 秒精度は実際に効く（境界テスト）

`UPDATE_DATE = 2026-08-05T15:20:48` のレコードに対して:

| 条件 | ヒット |
|---|---|
| `GE 2026/08/05 15:20:47` | ✅ |
| `GE 2026/08/05 15:20:48` | ✅（GE なので境界を含む） |
| `GE 2026/08/05 15:20:49` | ❌ |

**カーソルは秒粒度で持てる。**ただしオーバーラップと冪等除去は引き続き必須（7.2節）。

## 4.6 コード値とマスタ

`selectone` / `select` / `search` 型の値はコード値であり、そのまま通知に出すと意味が読めない。
`GET /v1/ext2/master/{codeName}` でラベルに変換してから通知本文に載せる。

**起動時に取得し、24時間キャッシュする。**マスタ総数は 89。

| マスタ | 件数 | 用途 |
|---|---:|---|
| `MST_PROGRESS_STATUS` | 18 | 進捗ステータス（要件2/3） |
| `MSTUSER` | 12 | 担当者名（要件1/2/4） |
| `MSTTEAM` | — | 担当チーム（要件1） |
| `MSTACTION` | 8 | 対応履歴アクション種別（要件4）<br>1面談 / 2面接 / 3面接指導 / 4クロージング / 5退職指導 / 6メール / 7電話 / 9その他 |
| `MSTREGSTATUS` | 7 | 登録ステータス（要件1）<br>1仮登録 / 2本登録 / 3自社決定 / 4他社決定 / 5登録抹消 / 6自社登録抹消 / 9個人情報削除 |
| `MSTCNSLSTATUS` | 5 | 面談ステータス（要件1）<br>1未対応 / 2呼び込み中 / 3面談待ち / 4面談済み / 5見送り |
| `MSTWKSTATUS` | 2 | 現職区分（要件1）1現職 / 2離職 |
| `MSTCONRANK` | 4 | ランク（要件1）1S / 2A / 3B / 4C |
| `MSTMYPAGECHK` | — | マイページステータス（要件1） |

## 4.7 項目 ID の扱い

- **項目 ID をコードに直書きしない。**YAML 設定か定数モジュールに集約する。
- 起動時に `GET /v1/ext2/schema/{resourceCategory}` を取得し、
  **設定に書かれた項目 ID が実在するかを検証する。存在しなければ起動を失敗させる。**
- **項目一覧 xlsx ではなく実環境の schema を正とする。**両者に乖離があることを実測で確認済み:

| リソース | schema | xlsx | 差分の例 |
|---|---:|---:|---|
| career | 232 | 230 | `CAREER#PARTNERCOUNTRY_ID` が xlsx にない |
| progress | 26 | 24 | **`PROGRESS#PROGRESS_CHARGE_ID`（進捗の担当者）** が xlsx にない |
| order | 169 | 166 | 3項目が xlsx にない |
| client | 82 | 81 | `CLIENT#PARTNERCOUNTRY_ID` |
| wrkcareer | 409 | 364 | 45項目 |
| department | 64 | 64 | **xlsx は `CLT_CHARGE_Email1〜5`、実環境は `CLT_CHARGE_EMAIL1〜5`（大小文字違い）** |
| career_action / progress_history / career_workexperience / file | 一致 | 一致 | 差分なし |

- 起動時に schema を走査し、`^[A-Z_]+#\d+$` に一致する**オリつく項目の一覧をログに出す。**
  新しいオリつく項目が追加されたときに気づける。

> ⚠️ **原典の項目 ID に誤記がある。** `progress/select` のリクエスト例に
> `PROGRESS#STATSU_ID` とあるが正しくは **`PROGRESS#STATUS_ID`**。
> 誤記のほうは実測で 400 になることを確認済み。**原典のサンプルをコピペしないこと。**

## 4.8 エラーコードとリトライ

| コード | 扱い |
|---|---|
| 400 | リクエスト不正。**リトライしない。**設定不備としてログに残し、そのイベントを `dead_letter` に落とす |
| 401 | トークンを再取得して**1回だけ**リトライ |
| 403 | API キーの権限不足。**リトライしない。**起動時チェックで早期に検出する |
| 404 | エンドポイント誤り。**リトライしない** |
| 500 | 指数バックオフで最大3回リトライ |
| 504 | 指数バックオフで最大3回リトライ。リクエスト内容の見直しもログに促す |

- **リトライも必ずトークンバケットを消費する。**「リトライだから」と迂回させない。
- バックオフ中も他ウォッチャーを止めない。
- `requestId` はレスポンスに必ず含まれる。**ベンダー問い合わせのために必ず記録する。**
- CP API 由来のエラーは `CpApiError`（`status_code`, `request_id` を持つ）に包む。
  リトライ可否は例外の型で判断し、呼び出し側でステータスコードを分岐させない。

> ⚠️ **400 は権限の有無を示さない。** CP は「ボディ検証 → 認可」の順に処理するため、
> 必須パラメータが不正だと権限が無くても 400 が返る。権限の有無の判定に 400/403 を使う場合は、
> **itemId だけを不正にしたボディ**で対照実験すること（それなら権限不足は 403 になる）。

---

# 5. アーキテクチャ

## 5.1 なぜ単一プロセスか

1. **240 req/分の流量制御を1箇所に集約するため**（最大の理由）
2. 要件2・3・4が同じリソースを参照する。プロセスを分けると同じ `career/select` を
   別プロセスが重複して叩く。1プロセスなら名前解決キャッシュを共有でき、リクエスト数がそのまま減る

「機能ごとに独立して起動・停止・実行間隔変更ができる」という要求は、
設定 YAML の `enabled` / `interval_minutes` と、カーソルの `watcher_id` 分離で満たせる。

### 検討したが採らなかった案

| 案 | 不採用の理由 |
|---|---|
| 機能ごとに別プロセス + 共有 Redis でレート制御 | 流量制御は守れるが Redis という運用対象が増える。PoC の規模（約5,000 req/日）に見合わない |
| 単一プロセス + ウォッチャーを並行スレッド実行 | トークンバケットのロック競合と、どのウォッチャーが予算を食ったかの追跡困難さに見合う利得がない。**加えてトークンのリフレッシュが並行実行と相性が悪い**（4.2節） |
| 収集プロセスと通知プロセスの分離（キュー経由） | 通知失敗時の再送が独立するのは利点だが、PoC では `dead_letter` テーブルで足りる |

## 5.2 ディレクトリ構成

```
app_root/
├── CLAUDE.md
├── rules/                       # 作業ルール
├── docs/
│   ├── (原典3ファイル)
│   ├── CP進捗通知_システム仕様書.md   # 本書
│   └── design/                  # 検討経緯を含む個別設計書
├── tools/
│   ├── docs_dump/               # 原典の解析スクリプト
│   └── verify/                  # 実環境検証の使い捨てスクリプト
│
├── app/                         # ★実装フェーズで作る
│   ├── main.py                  # エントリポイント。スケジューラ起動
│   ├── core/
│   │   ├── auth.py              # トークン取得・キャッシュ・再取得
│   │   ├── ratelimit.py         # グローバルトークンバケット
│   │   ├── client.py            # CP API クライアント（唯一の HTTP 出口）
│   │   ├── schema.py            # schema の取得・キャッシュ・項目ID検証
│   │   ├── master.py            # コードマスタの取得・キャッシュ・ラベル変換
│   │   ├── resolver.py          # career/order/client の名前解決キャッシュ
│   │   ├── store.py             # SQLite
│   │   ├── timefmt.py           # JST ⇔ CP形式の変換を集約
│   │   └── scheduler.py         # ウォッチャー登録・間隔管理・例外隔離・予算配分
│   ├── watchers/
│   │   ├── base.py                  # Watcher 基底
│   │   ├── career_status.py         # 要件1
│   │   ├── progress_flow.py         # 要件2 + 要件3
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

**依存の向き**: `watchers/` → `core/`、`watchers/` → `notifiers/`。逆向きの依存を作らない。

- `watchers/` 同士は import しない。共有したいものは `core/` に上げる。
- `notifiers/` は「誰に何を送るか」だけを知る。**CP のリソースや項目 ID を知らない。**
  ウォッチャーが通知用の中間表現（イベント）を組み立てて渡す。

## 5.3 共通基盤

### `core/ratelimit.py` — トークンバケット

**このアプリで唯一絶対に守る不変条件: CP への HTTP リクエストは必ずここを通る。**

| パラメータ | 既定値 | 根拠 |
|---|---|---|
| 補充レート | **1.0 token/秒（= 60 req/分）** | CP 上限 240 の 25% |
| バケット容量 | **20** | 検索1回 + select 十数件の連続処理を待たせない程度 |
| 上限（設定変更で到達可能） | 2.0 token/秒（= 120 req/分） | 上限の 50%。既定にはしない |

トークンが無ければ**ブロックする。捨てない・スキップしない。**

### `core/client.py` — API クライアント

```
search(resource, condition, sort, limit, offset) -> (ids, count)
select(resource, id, item_ids) -> dict[item_id, value]
get_schema(resource) -> list[ItemDef]
get_master(code_name) -> dict[code, label]
```

責務: トークンバケットの消費 / `Authorization` ヘッダの付与とトークン期限管理（`core/auth.py` に委譲）/
ステータスコードに応じたリトライ / `requestId` のログ記録 / 例外の `CpApiError` への正規化。

**ウォッチャーや通知モジュールから `requests` / `httpx` を直接呼ばない。**

### `core/schema.py` — 項目定義の検証

起動時に、設定 YAML に登場する全リソースの schema を取得する
（11リソース中、実際に使うのは `career` / `career_action` / `progress` / `progress_history` /
`order` / `client` の6つ）。用途は3つ:

1. 設定に書かれた項目 ID の実在検証 → **無ければ起動を失敗させる**
2. 項目タイプの取得（searchType の妥当性検証、値のパース、通知本文の整形）
3. オリつく項目の発見（4.7節）

24時間キャッシュ。

### `core/resolver.py` — 名前解決キャッシュ

通知本文には求職者名・求人名・企業名が要る。これらは変化が遅い。

| キャッシュ | TTL | サイズ |
|---|---|---|
| `career_id -> (姓, 名)` | 1時間 | LRU 2000 |
| `order_id -> (求人名, 企業名)` | 6時間 | LRU 1000 |

**このキャッシュがリクエスト数に直結する。**要件2で進捗が動くたびに `career/select` と
`order/select` を叩くと通知1件あたり4リクエストになる。キャッシュが効けば2リクエストに落ちる。

> ⚠️ **`CAREER#CHARGE_EMAIL` はキャッシュしない。**要件4の宛先であり、
> 担当者変更直後に旧担当へ送るのは実害がある。要件4では `career_action/select` で毎回取り直す
> （同一リクエストなので追加コストはゼロ）。

## 5.4 実装の状況と順序

| # | 対象 | 状態 |
|---|---|---|
| 1 | `core/ratelimit.py` + `core/client.py` + `core/auth.py` + `core/budget.py` | ✅ 実装済み |
| 2 | `core/schema.py`（項目 ID の実在検証）+ `core/master.py` | ✅ 実装済み |
| 3 | `core/store.py` + `core/scheduler.py` + `notifiers/`（Slack） | ✅ 実装済み |
| 4 | **`career_status`（要件1）** | ✅ **実装済み・実環境で動作確認** |
| 5 | `progress_flow`（要件2+3） | ⬜ 未着手 |
| 6 | `career_action_watch`（要件4） | ⏸ メール送信がペンディング（8.4節） |
| 7 | 実データを見て `special_transitions`（要件3）と通知文面を調整 | ⬜ 5 の後 |

**5 に着手する前に、要件1 の実データ（実際に飛んだ通知）を見て設計を見直す。**

### 実装済みの範囲で確認できていること（2026-08-07）

| 確認 | 結果 |
|---|---|
| `--check` の起動時チェック | ✅ 認可・schema・マスタ取得。監視項目 **229 件**を確定 |
| 項目 ID の実在検証 | ✅ 実際に**誤った項目 ID を起動時に検出して失敗**させた（拡張検討時に `DEPARTMENT#DEPARTMENTNAME` 等を検出） |
| オリつく項目の自動検出 | ✅ `CAREER#48002` を `^[A-Z_]+#\d+$` で検出しログ出力 |
| マスタ名の自動解決 | ✅ `validationRule.codeName` から解決（YAML への手書き不要） |
| `--bootstrap` | ✅ 求職者18名 × 229項目 = **4,122行**のスナップショットを構築。**通知は出ない** |
| `--once`（変化なし） | ✅ カーソル − オーバーラップ60秒で検索。候補0件・通知0件（**1 req**） |
| 未ブートストラップ時の保護 | ✅ スナップショットが無い状態では**実行を拒否**（一斉通知を防ぐ） |
| 単体テスト | ✅ **81 件**すべて成功（`py -3 -m pytest tests -q`） |
| **Slack への実送信** | ✅ **確認済み。**常駐（`interval_minutes: 1`）で CP 画面から項目を変更し、1分以内に `cp通知要件1` へ着信。検索 → 取得 → 差分検出 → マスタ変換 → 送信まで通し |
| 誤検知の有無 | ✅ 変更した項目だけが通知される。`change_without_visible_difference` の警告 0 件 |

### 実送信で判明して修正した 2 件（2026-08-07）

| 症状 | 原因 | 対処 |
|---|---|---|
| `都道府県: 0(コード不明) → 神奈川県`<br>`郵便番号: (未設定) → 2250013(コード不明)` | `0` は「未設定」だがマスタに載っていない。`MSTZIPCODE` は列挙を返さないマスタで、値はコードではなくデータ | ラベル変換の解決順を整理（4.6節）。マスタで解決できない値は**注釈を付けずそのまま表示**し、解決失敗はログにのみ残す |
| **1項目直しただけで25件の変化が通知され、うち15件が `(未設定) → (未設定)`** | **CP は保存時に未入力の選択項目を `None` → `0` に書き換える。**ハッシュ比較が `None ≠ "0"` を変化と判定していた | 差分検知の前に値を正規化（7.3節）。安全網として、表示が前後で同一になったら警告ログを出す |

### ⚠️ 全項目監視で受け入れている事項

| 事項 | 内容 |
|---|---|
| **個人情報が SQLite に平文で入る** | 遷移前後を通知するため `snapshots.value_raw` に生値を保存する。`rules/40-secrets-and-security.md` は「ハッシュを既定とし、生値は YAML で明示した項目のみ」としており、**全項目監視はこの既定から外れる。**`keep_raw_values: false` にすると前後の値を出さない代わりにハッシュのみになる |
| **個人情報が Slack に流れる** | 氏名・連絡先・年収などが変更されると、その値が本文に載る。**チャンネルの参加者を絞ること** |
| **通知量** | 求職者に対する任意の更新が通知になる。1サイクル 50 件を超えるとサマリに切り替わる |
| **SQLite の行数** | 229項目 × 求職者数。検証テナント（18名）で 4,122 行 |

---

# 6. データ仕様

## 6.1 SQLite スキーマ

```sql
CREATE TABLE cursors (
  watcher_id   TEXT PRIMARY KEY,
  cursor_value TEXT NOT NULL,     -- 'yyyy-MM-dd HH:mm:ss'(JST) または 'yyyy-MM-dd'
  page_offset  INTEGER NOT NULL DEFAULT 0,  -- 予算切れで中断したときの再開位置
  bootstrapped INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

CREATE TABLE snapshots (
  watcher_id   TEXT NOT NULL,
  resource_id  TEXT NOT NULL,
  item_id      TEXT NOT NULL,     -- 全体ハッシュの場合は '#DIGEST'
  value_hash   TEXT NOT NULL,
  value_raw    TEXT,              -- 遷移前後を通知したい項目のみ。既定は NULL
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

- **ORM を入れない。**テーブルは4つしかない。生の SQL で足りる。
- `snapshots.value_raw` は既定 NULL。差分検知にはハッシュで足りる（8.3節）。
- 要件4は `S30_prev`（前回サイクルの30日窓 ID 集合）をウォッチャーの状態として保持する。
  `snapshots` に `item_id = '#IN_S30'` として持つか、専用テーブルを追加する。

## 6.2 `config/app.yaml`

```yaml
cp_api:
  base_url: "https://api.careerplus.jp"
  api_key_env: "CP_NOTIFY_API_KEY"   # 値そのものは書かない

rate_limit:
  tokens_per_second: 1.0             # = 60 req/分（CP 上限 240 の 25%）
  bucket_capacity: 20
  warn_threshold_ratio: 0.8

store:
  path: "var/state.sqlite3"

notifiers:
  slack:
    # Incoming Webhook はチャンネルごとに1本。要件別に分ける
    webhooks:
      career_status: { url_env: "SLACK_WEBHOOK_CAREER_STATUS" }   # 要件1
      progress_flow: { url_env: "SLACK_WEBHOOK_PROGRESS_FLOW" }   # 要件2
      job_intro:     { url_env: "SLACK_WEBHOOK_JOB_INTRO" }       # 要件3
      ops:           { url_env: "SLACK_WEBHOOK_OPS" }             # 運用アラート
  mail:
    # PoC はローカルの Mailpit へ送る。外部へは1通も出ない（8.4節）
    transport: "smtp"                # "smtp" | "gmail_api" | "slack" | "file"
    host: "localhost"                # 本番: smtp-relay.gmail.com
    port: 1025                       # 本番: 587
    starttls: false                  # 本番: true
    auth: "none"                     # "none" | "password" | "xoauth2"
    username_env: "SMTP_USERNAME"    # auth != none のときのみ使用
    password_env: "SMTP_PASSWORD"
    from_address: "cp-notify@mybrainlab.net"
    admin_address: "a.yahara@mybrainlab.net"   # 日次サマリと運用アラートの宛先
    dry_run_redirect_to: null        # 設定するとすべてここに送る

limits:
  max_notifications_per_cycle: 50    # 超えたらサマリ通知に切り替える

catchup:
  # 断続起動（PoC）からの再開時の挙動。9.5節
  catchup_max_window_days: 30        # 要件4の変更検知窓を広げる上限
  notify_gap_to_ops: true            # 起動時に「前回実行からの経過」を ops へ1通出す
```

## 6.3 `config/watchers.yaml`

ウォッチャーごとの有効化・間隔・監視ルール。内容は 3.1.4 / 3.2.7 / 3.3.9 に記載。

**ルールの読み込みを `core/` の1関数に閉じ、将来スプレッドシート等から読む実装に
差し替えられる形にしておく。**ウォッチャー本体はルールの出所を知らない。

## 6.4 通知テンプレート

**通知本文の文言は YAML のテンプレートに置く。コードに直書きしない。**

| テンプレート ID | 用途 |
|---|---|
| `career_item_changed` | 要件1: 求職者項目の変化 |
| `progress_transition` | 要件2: 進捗の遷移（全般） |
| `job_intro_ok` | 要件3: 求人紹介OK |
| `action_created` | 要件4: 対応履歴の新規登録 |
| `action_updated` | 要件4: 対応履歴の日付更新 |
| `action_completed` | 要件4: 対応完了 |
| `daily_skip_summary` | 宛先未設定でスキップした件数の日次サマリ |

---

# 7. 状態管理と冪等性

## 7.1 カーソル

- `cursors` の主キーは `watcher_id`。**ウォッチャー間でカーソルを共有しない。**
  これにより、1つのウォッチャーを停止・再開・巻き戻ししても他に影響しない。
- カーソルは **JST の秒粒度**（`yyyy-MM-dd HH:mm:ss`）で保存する。
  検索条件に渡すときに CP 形式（`YYYY/MM/DD HH:MM:SS`）へ変換する。
- **失敗時はカーソルを進めない。**
  1サイクルの処理を SQLite のトランザクションで囲み、
  **イベントを1件でも処理しきれなかったら、そのサイクルではカーソルを前進させない。**
- 予算切れで中断した場合も同様。`page_offset` だけを保存して次サイクルで再開する。

## 7.2 オーバーラップ

`datetime` は秒精度で検索できるが、**オーバーラップは引き続き必要**である。
理由は秒精度の不足ではなく、次の2つが残るため。

- CP 側で `UPDATE_DATE` が確定してから検索結果に反映されるまでのラグ（大きさ不明）
- 同一秒に複数レコードが更新されうること

**取りこぼしは通知漏れであり、重複通知より重い。**

| ウォッチャー | オーバーラップ幅 |
|---|---|
| `career_status` | 60秒 |
| `progress_flow` | 60秒 |
| `career_action_watch` | 1日（`date` 型でしか絞れないため） |

カーソルには「前回サイクルの開始時刻 − オーバーラップ幅」を使う。
**取得したイベントは必ず重複を含む。冪等キーで除去してから通知する。**

## 7.2.1 値の正規化（差分検知の前提）

**比較の前に値を正規化する。**しないと、保存操作そのものが変化として検知される。

| 扱い | 対象 |
|---|---|
| `None` / 空文字 / 空白のみ / 空配列 → すべて「未設定」 | 全項目タイプ |
| **`0` / `"0"` → 「未設定」** | **`selectone` / `select` / `search` のみ**。CP は保存時に未入力の選択項目を `None` から `0` に書き換える（実測） |
| `0` は正当な値のまま | `number`。潰すと本当の変化を見逃す |
| `18` / `18.0` / `"18"` → 同一 | CP は number を JSON 数値で返すため |

実装は `core/store.py` の `canonical_value()`。**`put_snapshot` と比較の両方で
同じ `item_type` を渡すこと。**片方だけだと全項目が変化に見える。

安全網として、変換後の表示が前後で同一になった場合に
`change_without_visible_difference` を警告ログに出す。正規化の漏れに気づくため。

## 7.3 冪等キー

```
(watcher_id, resource_id, event_type, payload_hash)
```

| 要素 | 内容 |
|---|---|
| `resource_id` | CP のリソース ID（例 `21_3`、`18_0`）。**枝番を含む形をそのまま使う** |
| `event_type` | `item_changed` / `status_changed` / `created` / `updated` / `completed` |
| `payload_hash` | 通知本文を決定づける項目値を正規化して取った SHA-256 |

`notified` テーブルにこの4つ組で UNIQUE 制約を張り、**INSERT が成功したときだけ通知を送る。**
INSERT が競合したら既送信として黙って捨てる。

> **通知送信より先に `notified` へ INSERT する。**
> 送信後に INSERT すると、送信成功・INSERT 失敗のときに二重送信する。
> 逆順なら最悪1件落ちるだけで、落ちたことは `dead_letter` で検出できる。

## 7.4 ブートストラップ

初回起動時（カーソルが存在しないとき）は**スナップショットを作るだけで通知しない。**

差分検知は「前回値」があって初めて成立する。前回値がない状態で通知を出すと、
既存の全レコードが「変化した」と誤判定されて Slack が溢れる。

- 明示的に `--bootstrap` で起動したときのみスナップショットを構築する
- ブートストラップ完了を `cursors.bootstrapped` に記録し、以降の通常起動では通知を出す
- ブートストラップ自体も流量予算に従う。完了までに複数サイクルかかることを許容する

想定コスト: 要件1 は対象1名なので数リクエスト。要件4 は窓内件数ぶんの select。
60 req/分なら実用上問題にならない。

## 7.5 スナップショットの寿命

`snapshots` は放置すると無限に増える。

- **要件1**: 監視対象求職者に限定して保持する。対象外になったら削除
- **要件4**: 走査窓を外れたレコードも**削除しない**。削除した ID が再び窓に入ると
  「新規」と誤判定するため。`last_seen_at` で古いものを別テーブルへ退避する方が安全。
  **PoC では削除せず、件数が問題になってから対処する**（保存するのは日付3項目だけなので軽い）

## 7.6 時刻の扱い

- CP が返す `datetime` はタイムゾーン情報を持たない。**JST として扱う**
- SQLite に保存する時刻は **JST の `yyyy-MM-dd HH:mm:ss` 文字列**で統一する。
  UTC 混在は差分検知のバグの温床になる
- CP に渡す検索値への変換は **`core/timefmt.py` の1箇所に閉じる**

## 7.7 グレースフルな停止

- SIGTERM で現在のサイクルを完了させてから終了する
- 中断が必要ならカーソルを進めずに終了する
- 起動時に前回異常終了の痕跡（`page_offset > 0`）があればそこから再開する

---

# 8. 非機能仕様

## 8.1 流量制御

### 制約

原典「概要 > 利用方法」に次の記載がある。

> 1分間あたり240リクエストを超える場合、APIサービスを停止させて頂く可能性がございます。

**これは性能上の目安ではなくサービス停止のトリガであり、超えると全要件が同時に死ぬ。**
設計上の最重要制約として扱う。

### 予算配分

| 区分 | 値 | 上限比 |
|---|---|---|
| CP の上限 | 240 req/分 | 100% |
| **平常時の設計上限** | **60 req/分** | 25% |
| バースト（トークンバケット容量） | 20 | — |
| 緊急時の最大（設定変更でのみ到達） | 120 req/分 | 50% |

75% の余裕を残す理由:

1. **240 が API キー単位かテナント単位かの記載がない**（10章 Q-1）。
   テナント単位なら他の連携・別の API キーの消費と合算される
2. 突発的な一括更新（データ移行、一括インポート）で変化件数が跳ねる
3. リトライ（500/504）がリクエスト数を増やす
4. 「超えたら停止」の判定条件（瞬間か平均か、超過何回でか）が不明

### 見積り（変更検知窓3日 / 1日40件・担当者設定率30% を仮定）

| 処理 | 1サイクル | 1日 |
|---|---:|---:|
| `progress_flow`（要件2+3） | 約3 | 約860 |
| `career_status`（要件1・1名） | 約2 | 約190 |
| 要件4: 新規検知（30日窓・ID のみ） | 約4 | 約380 |
| 要件4: 変更候補の抽出（3日窓・ID のみ） | 約1 | 約100 |
| **要件4: 日付比較のための `select`（3日窓）** | **約36** | **約3,460** |
| schema / master の再取得 | 15 | 15 |
| **合計** | | **約 5,000 req/日** |

平均 **3.5 req/分（CP 上限 240 の 1.5%）**。

### 1日あたり件数による変動（窓3日固定）

| 1日件数 | W | 合計/日 | 平均 req/分 |
|---:|---:|---:|---:|
| 20 | 18 | 約3,300 | 2.3 |
| **40（想定）** | **36** | **約5,000** | **3.5** |
| 100 | 90 | 約10,200 | 7.1 |
| 200 | 180 | 約18,800 | 13.1 |

**1日200件でも 13 req/分**（CP 上限の 5.5%）。

### 変更検知窓によるコスト

支配的なのは `select`。`W = 1日件数 × 変更検知窓 × 担当者設定率`。

| 変更検知窓 | W | 平均 req/分 | 合計/日 | 検知できない編集 |
|---:|---:|---:|---:|---|
| **3日（採用）** | **36** | **2.4** | **約3,500** | 4日以上前の日付の書き換え |
| 7日 | 84 | 5.6 | 約9,600 | 8日以上前 |
| 14日 | 168 | 11 | 約16,200 | 15日以上前 |
| 30日 | 360 | 24 | 約34,600 | 31日以上前 |

### 重いと判断した場合の選択肢

| 手段 | 効果 | 失うもの |
|---|---|---|
| 変更検知の窓を狭める（3日 → 1日） | `select` が 1/3 | 2日以上前の日付変更を検知しない |
| 変更検知の間隔を延ばす（15分 → 30分） | `select` が 1/2 | 更新通知が最大30分遅れる |
| 母集団をさらに絞る（登録ステータス・担当チーム等） | 絞った割合ぶん | 対象外の求職者を通知しない |
| 日付を `EQ` でバケット化する方式に切り替える | **W > 200 なら有利** | 実装が複雑。`NEXTACTION_DATE` が未来方向に無制限でバケット数が読めない |

### やってはいけないこと

- 検索の `limit` を小さくしてページ数を増やす（リクエスト数が増える）。**常に 100 を指定する**
- **「念のため」の全件走査。**走査範囲は必ず時刻・日付・ID の窓で有界にする
- 通知の再送のためにイベントを再取得する。**通知本文は最初の取得時に組み立てて保存する**
- **パフォーマンステスト目的の連続リクエスト**（原典で明示的に禁止されている）

## 8.2 可用性

| 事象 | 挙動 |
|---|---|
| 1つのウォッチャーが例外を投げた | スケジューラが捕捉。ログに残し、失敗カウンタ +1。**他のウォッチャーは影響を受けない** |
| 連続失敗が5回 | そのウォッチャーを自動停止し、警告を出す |
| 予算切れ | カーソルを据え置き、`page_offset` を保存して次サイクルへ持ち越す。**通知は遅れるが落ちない** |
| プロセス異常終了 | 起動時に `page_offset > 0` を検出して再開。カーソルは進んでいないので取りこぼさない |
| 一括更新で数百件の変更 | 1サイクルの通知件数上限（既定50件）を超えたら「N件の変更が検出されました」というサマリ通知に切り替える |
| メール送信失敗 | 3回までリトライし、諦めたら `dead_letter` に落とす。**自動再送はしない** |
| SQLite の消失 | スナップショットが失われると全件が「新規」に見える。**復旧手順はブートストラップの再実行** |
| **プロセスが長時間止まっていた**（PoC の通常状態） | カーソルから再開し、止まっていた期間ぶんを次のサイクルで拾う。**要件2/3は取りこぼさない。要件1/4は中間の変化が失われ、最後の状態のみ通知される**（9.5節） |
| ネットワーク断（スリープ復帰直後など） | 接続エラーは 500 系と同じく指数バックオフで3回リトライ。失敗してもカーソルは進まない |

## 8.3 セキュリティ

### API キー

- **リポジトリに置かない。**環境変数（`CP_NOTIFY_API_KEY`）から読む
- **ログ・エラーメッセージ・通知本文に出さない。**
  例外のスタックトレースにリクエストボディが載る実装にしない
- 原典に「ブラウザから直接 API を実行しないようお願い致します」と明記されている。
  **API キーがブラウザに渡る構成を作らない**（フロントから直接叩く、キーを含む URL を発行する等）
- CP の API キー管理画面で **IP アドレス制限（CIDR）**を設定できる。
  **PoC では設定しない。**手元 PC の回線は固定グローバル IP を持たないため、
  制限をかけると IP が変わるたびに疎通が切れる。
  **本番移行時に固定 IP を取得し、`/32` で登録する**（9.5節）。
  IP 制限が無いぶん、`.env` の管理が唯一の防御線になる。**共有・コミット・スクリーンショットに注意する**

### 権限

**API キーには作成・更新・削除を一切付与しない。**
実測により、現在の API キーが読み取り専用で正しく作成されていることを確認済み
（進捗系の `PUT` が 403 を返す。検証中にデータは一切作られていない）。

実装の都合で書き込みが必要になったと感じたら、**それは設計の誤り**なので
権限を足す前に設計を見直す。

### 個人情報

CP が扱うのは求職者の氏名・連絡先・年収などの個人情報。

- **通知本文に載せる項目は YAML で明示的に列挙したものだけにする。**
  「取得したものを全部出す」実装にしない
- **ログにレスポンスボディをそのまま吐かない。**
  デバッグ時も項目 ID とリソース ID のみ、値はマスクする
- `snapshots` には**値そのものではなくハッシュ**を保存することを既定とする。
  例外は「遷移前後の値を通知したい」項目（要件1）のみで、対象は YAML で明示させる
- **SQLite ファイルと設定ファイルはリポジトリ外の、パーミッションを絞ったディレクトリに置く**

### 通知先

- Slack の Webhook URL / Bot トークンも秘密情報として同様に扱う
- 要件4の宛先が空・不正なときに**送信をスキップして黙らない**（3.3.6 節）
- 誤送信の影響が大きいので、本番相当のデータで動かす前に
  **全通知をフォールバック宛先にリダイレクトするドライラン設定**（`dry_run_redirect_to`）で確認する
- **`From` を実在の担当者アドレスに詐称しない**（SPF/DMARC に引っかかる）

## 8.4 メール送信方式

自前の SMTP サーバは立てない。宛先も送信元も Google Workspace（`@mybrainlab.net`）内で完結させる。

### ⚠️ 現状（2026-08-07）: パスワード方式は組織ポリシーで全滅している

| 案 | 方式 | 判定 |
|---|---|---|
| ~~A~~ | 専用アカウント + **アプリパスワード**（`smtp.gmail.com:587`） | ❌ **不可。管理者が組織全体でアプリパスワードを無効化している** |
| ~~B~~ | SMTP リレー（`smtp-relay.gmail.com:587`）+ SMTP AUTH | ❌ **不可。**Google は 2024年に「安全性の低いアプリ」のパスワード認証を廃止しており、SMTP AUTH もアプリパスワードを要求する。A が塞がれていれば B も塞がれている |
| ~~B'~~ | SMTP リレー + **IP 許可リスト**（認証なし） | ❌ **PoC では不可。**固定グローバル IP が要る（実行環境は手元 PC・C-1） |

**パスワードを使う経路は残っていない。OAuth2 に移行するか、メール以外の経路を使う。**

### 残っている選択肢

| 案 | 方式 | 必要な準備 | 評価 |
|---|---|---|---|
| **C** | **Gmail API + OAuth2（インストール型アプリ）**<br>送信用アカウントが1回だけ同意し、リフレッシュトークンを保存 | 社内 GCP プロジェクト + OAuth クライアント ID（内部アプリ）。<br>管理者が「アプリのアクセス制御」でクライアント ID を許可する必要がある場合あり | **本命。**パスワードを使わない。固定 IP も不要。トークンは無期限に近い（無操作6か月で失効） |
| **C'** | **SMTP + XOAUTH2**（`smtp.gmail.com:587`） | C と同じ OAuth 設定。**SMTP のコードパスを維持したまま**認証だけ OAuth2 にする | C とほぼ同じ手間。将来 B（IP 許可の SMTP リレー）へ戻しやすい |
| **C''** | Gmail API + **サービスアカウント（ドメイン全体の委任）** | GCP プロジェクト + Admin console でスコープを委任 | 本番向けの正攻法。人の同意が不要。**管理者作業が最も重い** |
| **D** | GAS を送信専用の中継にする | 送信用アカウントで GAS Web App を1本デプロイし、Python から共有シークレット付きで POST。GAS 側は `GmailApp.sendEmail` | GCP 不要で最も軽い。ただし**Web App の外部アクセスが管理者に制限されている可能性**があり、C と同程度に確認が要る |
| **E** | 外部メール送信サービス（SendGrid / Amazon SES 等） | 送信元ドメインの SPF/DKIM 設定（DNS 権限） | Workspace のポリシーに依存しない。**DNS 変更の権限と外部サービス利用の承認が要る** |
| **F** | **PoC の間はメールを使わず Slack に出す**（暫定） | 要件4用の Incoming Webhook を1本追加するだけ | **依存ゼロで今すぐ動く。**通知本文に「本来の宛先: `<CHARGE_EMAIL>`」を併記すれば、検知・分類・本文組み立て・宛先解決まで**要件4のロジックはすべて検証できる。**未検証で残るのは送信経路だけ |
| **G** | **ローカルのテスト用 SMTP サーバ**（**Mailpit**）<br>実際には配送せず、受信内容をブラウザで確認する | 実行ファイル1つ（`mailpit.exe`）。インストーラ不要 | **開発時のテストに最適。本番と同じ SMTP コードパスをそのまま検証できる**（F は Slack なので SMTP を通らない）。外部へは1通も出ないので誤送信事故が起きない |

### ⚠️ 自前の SMTP サーバから直接メールを送ることはできない

「簡易的な SMTP サーバを立てて `@mybrainlab.net` 宛に配送する」構成は、
**手元 PC からでは技術的に成立しない。**理由は3つあり、いずれも回避できない。

| 障壁 | 内容 |
|---|---|
| **OP25B（送信ポート25ブロック）** | 一般回線は ISP が外向き TCP 25 を遮断している。Gmail の MX へ直接繋げない |
| **逆引き（PTR）レコードが無い** | Google は送信元 IP に PTR があり、かつ正引きが一致することを要求する。動的 IP には PTR を設定できない。`550-5.7.1 ... does not have a PTR record setup` で拒否される |
| **SPF / DMARC で落ちる** | `mybrainlab.net` の SPF は Google（`include:_spf.google.com`）を許可している。手元 PC の IP から `@mybrainlab.net` を名乗ると **SPF fail → DMARC fail**。回避には DNS 変更権限と固定 IP の両方が要る |

**「送信サーバを自前で用意する」方向は、固定グローバル IP + DNS 権限が揃って初めて意味を持つ。**
それが揃うなら、自前 SMTP を立てるより **B'（Workspace の SMTP リレー + IP 許可リスト）** を使うほうが
はるかに簡単で確実（認証不要・SPF も自動的に通る）。

**したがって「自前 SMTP」は G（ローカルのテスト用）としてのみ採用する。**

### ⭐ 先に確認すべきこと: オフィス回線は固定グローバル IP か

**固定グローバル IP が1つあれば、B'（SMTP リレー + IP 許可リスト）が使える。**
この経路は**パスワードもアプリパスワードも OAuth も要らない**ため、
アプリパスワードが無効化されている今の状況で**最も依頼が軽い解**になる。

管理者作業は「Admin console → アプリ → Gmail → ルーティング → SMTP リレー サービス」で
IP を1つ登録するだけ。GCP プロジェクトも OAuth クライアントも不要。

- 法人回線は固定 IP オプションを契約していることが多い。**まず回線契約を確認する価値がある**
- 上司の PC がオフィス回線なら、その回線の固定 IP を登録すればよい
- 確認方法: 対象の PC で `curl ifconfig.me` を数日おきに実行し、IP が変わらないかを見る
  （契約書で確認するのが確実）

### ⏸ 方針: ペンディング（2026-08-07 決定）

**要件4のメール送信は保留とする。**送信経路の決着も、ローカル SMTP でのテストも、
現時点では着手しない。

**保留がブロックしないもの:**

- 要件1・要件2・要件3（すべて Slack）の実装とテスト。**通知先は4本とも設定済みで、今すぐ着手できる**
- 要件4の**検知ロジック**（`career_action_watch`）。
  ウォッチャーは「宛先・件名・本文」を持つイベントを組み立てて `notifiers/` に渡すだけで、
  送信手段を知らない（5.2節の依存の向き）。**通知経路が決まっていなくても実装できる**

**保留の間の扱い:**

- `config/watchers.yaml` の `career_action_watch.enabled` は **`false` を既定**にする（3.3.9節）。
  有効にすると送信先の無い通知が発生するため
- 実装順序（5.4節）では要件4が最後なので、**当面この保留は進行を妨げない**

**再開するとき**は、下記の「ローカル SMTP の構成」から始め、
並行して**付録C**の依頼で本番経路を決める。以下の記述はそのときのために残してある。

<details>
<summary>再開時の手順（保留中は参照不要）</summary>

**PoC は G（ローカルのテスト用 SMTP サーバ）を既定とする。**
本番の送信経路は、**まずオフィス回線の固定 IP を確認し、
あれば B'（SMTP リレー + IP 許可）、無ければ C（Gmail API + OAuth2）**を管理者に依頼する。

| 時期 | 通知経路 | `transport` |
|---|---|---|
| **PoC（既定）** | **ローカル SMTP（`localhost:1025`）。外部へは1通も出ない** | `"smtp"` |
| （任意）業務側に見せるとき | Slack `cp通知要件4` チャンネルへ暫定出力 | `"slack"` |
| 本番・第1候補 | Workspace の SMTP リレー + IP 許可（`smtp-relay.gmail.com:587`） | `"smtp"` |
| 本番・第2候補 | Gmail API + OAuth2 | `"gmail_api"` |

**PoC で G を選ぶ利点**: `notifiers/mail.py` の **SMTP コードパスが本番とまったく同じになる。**
本番移行時に変わるのは `host` / `port` / 認証設定だけで、コードは変わらない。
Slack 暫定出力（F）では SMTP を1行も通らないため、この検証ができない。

**外部へ1通も出ないので、誤送信事故が起きない。**
検証テナントの担当者メールは実在アドレス（`a.yahara@` / `kawabata@`）なので、
これは実質的な安全策でもある。

### ローカル SMTP の構成

**Mailpit を使う。**（MailHog の後継。MailHog は実質メンテナンスが止まっている）

| | |
|---|---|
| 入手元 | https://github.com/axllent/mailpit （MIT ライセンス）の Releases から `mailpit-windows-amd64.zip` |
| 実体 | **単一の実行ファイル `mailpit.exe`。**インストーラ不要・レジストリ変更なし。zip を展開して置くだけ |
| 既定ポート | SMTP **1025** / Web UI **8025**（MailHog と同じ） |
| メールの保存 | **既定はメモリ上のみ。**終了すると消える（`--database` を指定したときだけファイルに永続化される） |

### 起動

```powershell
# ⚠️ 待ち受けは必ず 127.0.0.1 に明示的に絞る（既定は全インタフェース）
.\mailpit.exe --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025
```

**`--listen` / `--smtp` の明示は必須とする。**
Mailpit の既定は全インタフェースへのバインドで、**同じ LAN の他端末から受信箱を開けてしまう。**
受信箱には求職者の氏名と対応履歴のメモが載る（`rules/40-secrets-and-security.md`）。

確認は ブラウザで `http://localhost:8025` を開く。
**受信箱の UI で宛先・件名・本文をそのまま読める**ので、
「担当者が違う2人の求職者に、それぞれ正しい宛先で届いているか」を目で確認しやすい。

Mailpit には実際の SMTP サーバへ中継する機能（SMTP リレー）があるが、
**PoC では使わない。設定しない限り外部へは1通も出ない。**

### 補助的な確認手段

| 用途 | 手段 |
|---|---|
| テストの期待値比較・差分確認 | `notifiers/mail.py` に `transport: "file"` を用意し、`var/mail/{timestamp}_{宛先}.eml` に保存する |

```yaml
notifiers:
  mail:
    transport: "smtp"
    host: "localhost"          # PoC。本番は smtp-relay.gmail.com
    port: 1025                 # Mailpit の SMTP 受け口。本番は 587
    starttls: false            # ローカルなので不要。本番は true
    auth: "none"               # "none" | "password" | "xoauth2"
    from_address: "cp-notify@mybrainlab.net"
    admin_address: "a.yahara@mybrainlab.net"
    dry_run_redirect_to: null
```

**宛先の解決ロジックは本番と同一にする。**
`CAREER#CHARGE_EMAIL` を取得し、空なら「宛先未設定」として扱って送信をスキップし、
件数を計上する（3.3.6節）。ローカル SMTP だからといって全員に送るような近道をしない。
**この分岐こそ PoC で確認したい挙動である**（検証テナントでは 18人中13人が宛先未設定）。

</details>

管理者への依頼内容は**付録C**にまとめた（保留中は着手不要）。

## 8.5 ログ

- **構造化ログ（1行1 JSON）。**最低限 `watcher_id`, `event`, `resource_id`, `request_id` を含める
- **個人情報を出さない**（8.3節）
- 各サイクルの終わりに「何件取得して何件通知したか」を1行で出す。
  **これが読めないと流量とカーソルの妥当性を追えない**
- **ログメッセージは英語、コメントとドキュメントは日本語**

## 8.6 監視メトリクス

以下を常時記録し、設計との乖離を検出する。

| メトリクス | 閾値・判断 |
|---|---|
| 直近1分・5分・60分の実リクエスト数 | 設計上限 60/分 の 80% を5分継続で超えたら警告 |
| ウォッチャー別・エンドポイント別の累積リクエスト数 | 見積り（8.1節）と乖離したら設計を見直す |
| 各サイクルの `requests_used` / `events_detected` / `events_notified` / `exhausted` | — |
| **カーソルの遅れ（現在時刻 − カーソル値）** | **単調増加していたら最も危険なシグナル。**予算不足か変化件数の想定違い |
| 宛先未設定でスキップした件数 | 日次で管理者にサマリ送信 |

**平常時の実測が 20 req/分を超え続けたら設計を疑う。**
走査量が総件数に比例する実装になっていないかを確認すること。

## 8.7 テスト方針

- **CP API はモックする。実 API を叩くテストを CI に置かない**（流量制約に反する）
- 優先してテストを書く対象（目視で確認しづらく、壊れると事故になるもの）:
  1. トークンバケット（レートを超えないこと）
  2. カーソル前進の条件（**失敗時に進まないこと**）
  3. 冪等キーによる重複除去（特に**枝番の異なる同一ステータス**が別イベントになること）
  4. `datetime` / `date` の形式変換（リクエストとレスポンスの非対称性）
  5. 要件4の新規/更新の分類（`S30_prev` による判定）

---

# 9. 運用仕様

## 9.1 起動時のチェック

順に実行し、いずれかが失敗したら**起動を中止する。**

1. 必須の環境変数が揃っているか（`CP_NOTIFY_API_KEY`, Slack Webhook, SMTP 認証情報）
2. `POST /v1/auth/token` でトークンを取得できるか
3. 設定 YAML に登場する全リソースの schema を取得できるか（権限チェックを兼ねる）
4. **設定に書かれた項目 ID がすべて実在するか** → 無ければ起動失敗
5. 必要なマスタをすべて取得できるか
6. SQLite ファイルを開けるか。スキーマが最新か

起動時に、schema を走査して**オリつく項目の一覧をログに出す**（4.7節）。

## 9.2 起動モードとコマンドライン

**PoC は手元 PC で断続的に動かし、動作確認が主目的**（9.5節）。
そのため常駐前提のモードだけでなく、**1サイクルだけ回して結果を見る**手段を用意する。

| モード | 挙動 | 主な用途 |
|---|---|---|
| （引数なし） | 常駐。各ウォッチャーを間隔どおりに実行し、通知を送る | 通常運用 |
| `--check` | 起動時チェック（9.1節）だけ実行して終了。**API を読むだけで通知は出さない** | 疎通・権限・項目IDの確認 |
| `--once` | 全ウォッチャーを**1サイクルだけ**実行して終了 | 動作確認 |
| `--watcher <id>` | 指定したウォッチャーだけ実行（`--once` と併用） | 個別テスト |
| `--since "<yyyy-MM-dd HH:mm:ss>"` | カーソルを指定時刻に**強制設定**してから実行 | 過去のイベントを再現してテストする |
| `--dry-run` | すべての通知をフォールバック宛先へリダイレクト（Slack → `ops`、メール → `admin_address`）。`dry_run_redirect_to` と同義 | 本番相当データでの試験 |
| `--bootstrap` | スナップショットを構築するのみ。**通知を送らない**（7.4節） | 初回・SQLite 復旧時 |

`--since` は `cursors` を書き換えるため、**冪等キーによる重複除去が効いて同じ通知は再送されない。**
再送させたい場合は `notified` の該当行も削除する必要がある（テスト時のみ）。

### テスト手順の例

```powershell
# 1. 疎通・権限・項目IDの検証だけ（通知は出ない）
py -3 -m app.main --check

# 2. スナップショットを作る（通知は出ない）
py -3 -m app.main --bootstrap

# 3. 要件2/3 だけを1サイクル、通知先を ops に寄せて確認
py -3 -m app.main --once --watcher progress_flow --dry-run

# 4. 本来のチャンネルへ1サイクルだけ流す
py -3 -m app.main --once --watcher progress_flow

# 5. 要件4（メール）のテスト。先に別ウィンドウで Mailpit を起動しておく
#    .\mailpit.exe --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025
py -3 -m app.main --once --watcher career_action_watch
#    → ブラウザで http://localhost:8025 を開き、宛先・件名・本文を確認する

# 6. 常駐させる（Ctrl+C で停止。SIGTERM と同じくサイクル完了後に終了）
py -3 -m app.main
```

CP 画面で対象データを操作 → `--once` で1サイクル回す、という流れで
**ポーリング間隔を待たずに通知を確認できる。**

## 9.3 日次バッチ

| 処理 | 内容 |
|---|---|
| 宛先未設定サマリ | 「本日 N 件の対応履歴が担当者未設定のため通知されませんでした」を管理者へ1通 |
| `dead_letter` の件数報告 | 0件でなければ管理者へ通知（自動再送はしない） |

## 9.4 運用手順

| 状況 | 手順 |
|---|---|
| 監視対象の求職者を変える | `config/watchers.yaml` の `target.condition` を編集して再起動 |
| 通知が多すぎる | `notify_all_transitions: false` にして `watched_statuses` を指定（要件2）。または `target.condition` を絞る |
| 特定のウォッチャーを止める | `enabled: false` にして再起動。**他のウォッチャーには影響しない** |
| ウォッチャーを巻き戻す | `cursors` の該当行の `cursor_value` を書き換える。**冪等キーがあるので重複通知は出ない** |
| 通知が止まった | まず**カーソルの遅れ**を確認（8.6節）。次に失敗カウンタによる自動停止の有無を確認 |
| SQLite が壊れた | ファイルを退避し、`--bootstrap` で再構築。**再構築中の変化は通知されない** |
| API キーを再発行した | `.env` を差し替えて再起動 |

## 9.5 断続起動の扱い（PoC の実行環境）

**PoC の実行環境は手元の Windows PC（本機または上司の PC）で、常時起動しない。**
夜間・休日・スリープ中はプロセスが止まる。ここでは停止期間を **G** と書く。

### 9.5.1 アーキテクチャは変わらない

単一プロセス・逐次実行・トークンバケット・カーソルという構造は**そのまま使える。**
カーソル方式は「前回どこまで見たか」を SQLite に持つので、
**停止して再開しても、止まっていた期間ぶんを次の1サイクルで拾いにいく。**
常駐前提の設計を作り直す必要はない。

`interval_minutes` の判定は壁時計で行い、**次回実行予定時刻を保存する。**
起動直後は全ウォッチャーが「間隔を過ぎている」状態なので、優先度順に順次実行される。

### 9.5.2 ⚠️ 停止期間中の中間の変化は失われる（要件1・要件4）

**これは断続起動の本質的な制約であり、実装では回避できない。**

| ウォッチャー | 停止期間 G の変化を拾えるか |
|---|---|
| **`progress_flow`（要件2/3）** | ✅ **すべて拾える。**`progress_history` は追記型で、遷移が1件1レコードとして残る。再開時に `INSERT_DATE GE <カーソル>` でまとめて取得できる |
| **`career_status`（要件1）** | ⚠️ **最後の状態しか拾えない。**`career` は現在値のみを持ち、変化の履歴がない。G の間に `1 → 3 → 5` と変わっても、通知は「1 → 5」の1件になる |
| **`career_action_watch`（要件4）** | ⚠️ 同上。日付が2回変わっても「停止前の値 → 現在値」の1件 |

要件1・4は**「変化があったこと」と「現在値」は必ず通知される。**失われるのは中間の経過だけ。
PoC の目的（通知が届くことの確認）には支障がないが、**本番で常時起動にする理由の1つ**として記録しておく。

### 9.5.3 ⚠️ G > 3日 で要件4の日付変更を取りこぼす

要件4の変更検知窓は **3日**（`change_window_days`）。
4日止まっていると、停止中に日付が変わったレコードが再開時点で窓の外にあり、検知できない。

**対策: 再開時にキャッチアップとして窓を一時的に広げる。**

```
起動時:
    G = 今 − cursors.updated_at
    effective_change_window = min( change_window_days + ceil(G の日数),
                                   catchup_max_window_days )   # 既定 30
    キャッチアップの1サイクルだけこの窓を使い、以降は通常の 3日 に戻す
```

コストは窓日数に比例する（8.1節の表）。上限 30日で頭打ちにする。
30日を超える停止からの再開は、**取りこぼしを受け入れるか `--bootstrap` からやり直す。**

新規検知の窓は 30日なので、**G ≤ 30日なら新規登録は取りこぼさない。**

### 9.5.4 再開時の通知洪水

長く止まってから起動すると、溜まった変化が最初の数サイクルで一気に流れる。

- 1サイクルの通知件数が `max_notifications_per_cycle`（既定 50）を超えたら
  **サマリ通知に切り替える**（8.2節）。この仕組みがそのまま効く
- 起動時に **G を計算して ops チャンネルへ1通出す**
  （「前回実行から 3日 6時間 経過しています。キャッチアップを開始します」）。
  **通知が来ない原因が「止まっていたから」なのか「壊れたから」なのかを区別できるようにする**
- 通知が多すぎることが分かっている再開では、`--dry-run` で件数だけ確認してから本番投入する

### 9.5.5 スリープ・休止からの復帰

- 復帰後は壁時計が飛ぶ。次回実行予定時刻を過ぎているので**即座に実行される。**これでよい
- 復帰直後は Wi-Fi が繋がっておらず、最初のリクエストが接続エラーになりうる。
  **接続エラーは 500 系と同じく指数バックオフでリトライする**（3回）。
  3回失敗しても失敗カウンタが増えるだけで、カーソルは進まないので取りこぼさない
- スリープ中にアクセストークンは期限切れ（60分）になる。復帰後に取り直す。
  **`expiresIn` からの経過時間ではなく絶対時刻で期限を判定する**（スリープ時間が計算に入らないため）

### 9.5.6 Windows での起動

| 方式 | 内容 |
|---|---|
| 手動 | PowerShell で `py -3 -m app.main`。ウィンドウを閉じるまで動く。**PoC の既定** |
| タスクスケジューラ | 「ログオン時に起動」+「失敗時に再起動」。PC を開いている間だけ動く |
| （非推奨）Windows サービス化 | PoC には重い。常時起動が要るなら先にサーバの設置を決めるべき |

- `var/state.sqlite3` と `var/logs/` はプロジェクト直下でよい（`.gitignore` 済み）。
  ただし**個人情報を含む**ので、PC を他人と共有する場合は取り扱いに注意する（8.3節）
- **上司の PC で動かす場合、`.env` をそのままコピーすると API キーと Webhook が複製される。**
  どちらの PC で動かすかを決めてから配置する。両方で同時に動かすと、
  **別々の SQLite を持つため同じ通知が2回飛ぶ**（冪等キーはプロセス間で共有されない）

### 9.5.7 日次バッチの扱い

宛先未設定サマリ（9.3節）は「日付が変わったら実行」だが、
**その時刻に PC が起動しているとは限らない。**

- 起動中に日付が変わったら実行する
- 起動していなかった日ぶんは、**次に起動したときにまとめて1通出す**
  （「8/5〜8/7 の3日間で N 件をスキップしました」）
- 最後に日次バッチを実行した日付を `cursors` に `watcher_id = 'daily_summary'` として持つ

---

# 10. 未決事項

**本書の内容は、以下が未決のままでも実装を進められる。**
ただし ★ の2件は運用開始前に確定させる必要がある。

## 10.1 CP ベンダーへの確認

| ID | 内容 | 影響 |
|---|---|---|
| **Q-1** | 「1分間あたり240リクエスト」は API キー単位か契約テナント単位か。超過の判定は瞬間値か平均値か | 流量予算の余裕の取り方。**実測で確かめる行為そのものが危険**なので必ず問い合わせる |
| Q-5 | Webhook / イベント通知の提供予定はあるか | あるなら設計が根本的に変わる（全通知の遅延がなくなる） |
| Q-6 | 進捗ステータスの遷移グラフ（進捗ステータス設定）の内容 | 要件2の「はじめから内定まで」の定義。API から取得できない |
| Q-8 | 検索の `offset` に上限はあるか。深いページングでタイムアウトする閾値 | 検証テナントは18件でページングが発生せず未検証 |
| Q-9 | 項目一覧 xlsx の「API一覧」シートに進捗・進捗履歴・ファイルが載っていないのは更新漏れか | ドキュメントの信頼度の確認 |

## 10.2 業務側への確認

| ID | 内容 | 影響 |
|---|---|---|
| B-4 | 「はじめから内定まで」の各段階の名称と正確な遷移順 | **モードAで開始するため実装の前提にはならない。**実データを見てから絞る |
| B-5 | 進捗の巻き戻し・取り消し（辞退・不合格・削除）も通知対象か | 削除は API から検知できない。対象なら別の設計が要る |
| B-7 | 対応履歴を登録するとき「対応日」を必ず入れる運用か | 3つの日付がすべて空だと窓に入らず取りこぼす |
| B-8 | 対応履歴が編集されるのは登録から何日以内が大半か | 変更検知窓（既定3日）の妥当性 |
| B-12 | 通知本文に載せてよい個人情報の範囲 | 現状は氏名 + 求職者ID + 対応内容。明示的な承認が要る |
| B-15 | 「応募OK（求人照会）」「応募NG（求人照会）」の遷移先ステータス | 通知文面の出し分け。モードAで開始するため前提にはならない |
| 要件1 | 監視項目（`CAREER#48002` + ステータス系7項目）で過不足ないか | 3.1.1 の項目リストの確認 |

## 10.3 社内の技術的な未決事項

| ID | 内容 |
|---|---|
| ~~C-1~~ | ~~常時起動サーバをどこに立てるか~~ ✅ **解決（2026-08-07）。PoC は手元の Windows PC（本機または上司の PC）。常時起動しない。**動作確認ができれば足りる。設計上の影響は 9.5節 に記載。**本番移行時に改めて設置先と固定 IP を決める** |
| ★ **C-11** | **1日あたりの新規対応履歴件数。**要件4の走査量 `W` を決める唯一の未確定パラメータ。本番接続時に `career_action/search { ACTION_DATE GE 昨日, limit:1 }` の `count` を7日ぶん取れば分かる |
| C-3 | Slack の連携方式（Incoming Webhook で足りる。4本取得済み） |
| ~~C-4~~ | ~~プロセスの起動・監視方法~~ ✅ **PoC は手動起動（`py -3 -m app.main`）。**必要ならタスクスケジューラで「ログオン時に起動」（9.5.6節）。**本番移行時に systemd 等を検討する** |
| C-5 | アプリ自身の死活監視・アラート先。**PoC では「起動時に前回実行からの経過を ops チャンネルへ出す」で代替する**（9.5.4節）。常時起動でないため「カーソルが進まない＝異常」とは言えず、本番移行時に改めて設計する |
| C-6 | ログの保存先と保持期間（個人情報を含みうる）。PoC は `var/logs/`（`.gitignore` 済み） |
| C-7 | SQLite ファイルのバックアップ。PoC は `var/state.sqlite3` を手動コピーで足りる |
| C-8 | PoC の評価基準と期間 |
| ⏸ **C-2 再** | **要件4のメール送信 — ペンディング（2026-08-07）。**アプリパスワードが組織全体で無効化されており、当初の案A・案Bはいずれも不可（8.4節）。**再開時は ⭐ まずオフィス回線が固定グローバル IP かを確認する。**あれば B'（SMTP リレー + IP 許可、認証不要）で最も軽く済む。無ければ C（Gmail API + OAuth2）。依頼文は付録C。<br>**要件1〜3 の実装と、要件4の検知ロジックの実装はブロックしない** |
| C-12 | 送信用アカウント `cp-notify@mybrainlab.net` の作成。**PoC では不要**（ローカル SMTP は認証しない）。本番の送信元アドレスとして必要 |
| ~~C-13~~ | ~~Slack Incoming Webhook の取得（4本）~~ ✅ **完了**（2026-08-07）。要件1／要件2／要件3／運用アラートの4本すべてを `.env` に設定済み |
| C-14 | 本番テナントの規模の実測（`tools/verify/v4_v7_masters_and_scale.py` の再実行） |

---

# 付録A. 実測で判明した「原典と違うこと」一覧

実装時に踏みやすい罠。**すべて実測（2026-08-05）で確認済み。**

| # | 内容 | 原典の記載 | 実際 |
|---|---|---|---|
| 1 | `datetime` のレスポンス形式 | `yyyy/MM/dd HH:mm` | **ISO 8601・秒あり**（`2026-08-05T15:20:48`） |
| 2 | `date` のレスポンス形式 | `yyyy/MM/dd` | **ISO 8601**（`2026-08-05`） |
| 3 | `datetime` の検索条件の形式 | `yyyy/MM/dd HH:mm` | **`YYYY/MM/DD HH:MM:SS` または `YYYY/MM/DD`。原典の形式は 400** |
| 4 | `number` のレスポンス | 記載なし | **JSON の数値**（文字列ではない） |
| 5 | トークンのレスポンス | 共通ラッパを想像しがち | **`code`/`result` のラッパが無い**フラットな JSON |
| 6 | トークンのリフレッシュ | 記載なし | **同系列の旧アクセストークンが即座に無効化される（猶予なし）** |
| 7 | `PROGRESS#STATSU_ID` | サンプルにこの綴り | **誤記。`PROGRESS#STATUS_ID` が正**（誤記のほうは 400） |
| 8 | `CAREER#CHARGE_EMAIL` の必須性 | xlsx で「必須●」 | **空になりうる**（18人中13人が空） |
| 9 | 項目一覧 xlsx の完全性 | — | **実環境の schema と乖離**。`PROGRESS#PROGRESS_CHARGE_ID` 等が xlsx にない |
| 10 | `career_action` の枝番 | — | **0 始まり**（`18_0`）。`progress_history` は **1 始まり**（`21_1`）。**リソースごとに違う** |
| 11 | `CAREER#CHARGE_EMAIL` を検索条件に | — | **使えない**（400 `itemIdが定義されていません`）。取得はできる |
| 12 | 子リソース操作時の親の `UPDATE_DATE` | 記載なし | **動かない。**対応履歴を登録・更新・完了しても `CAREER#UPDATE_DATE` は不変 |
| 13 | 400 と 403 の区別 | — | **CP は「ボディ検証 → 認可」の順に処理する。**必須パラメータが不正だと権限が無くても 400 |
| 14 | `ACTION_DATE` の値域 | — | **未来日を取りうる**（実測 `2026-08-06`） |
| 17 | **`itemIds` の重複** | 記載なし | **400 で拒否される**（`itemIdが重複しています`）。全項目監視では identity 項目が必ず重複するので、必ず一意化してから渡す |
| 18 | **`itemIds` の件数上限** | 記載なし | **上限は無い。**`career` の全 232 項目を 1 リクエストで取得できることを実測 |
| 19 | **項目の参照マスタ名** | 項目一覧 xlsx の「参照マスタ」列にしかないと思っていた | **schema の `validationRule.codeName` に入っている。**YAML へ手書きする必要がない（例: `CAREER#CHARGE_ID` → `MSTUSER`） |
| 20 | `UPDATE_DATE` を持つリソース | `00-findings.md` 3.3 は career / career_action / progress / progress_history / file のみ列挙 | **`client` / `department` / `order` にも存在する。**逆に `career_workexperience` / `client_action` / `wrkcareer` には**無い** |
| 21 | 検証テナントの規模 | `07-verification-results.md` は「企業 4 / 求人 8」 | **企業 9,845 / 部署 14,565**（2026-08-07 実測）。設計時の想定と桁が違う |
| 22 | `department` に部署名の項目 | — | **存在しない。**識別は `DEPARTMENT#CLIENT_ID` + `DEPARTMENT#CLIENTSUB_ID`（部署番号） |
| 23 | `order` に求人名の項目 | — | **存在しない。**`ORDER#POSITIONNAME`（ポジション名）が最も近い |
| 24 | **画面で保存したときの未入力項目** | 記載なし | **`selectone` / `select` / `search` の未入力値が `None` → `0` に書き換わる。**差分検知でこれを吸収しないと、1項目直すだけで未入力の選択項目が軒並み誤検知される（実送信で判明） |
| 25 | **`0` の意味** | 記載なし | `selectone` の `0` は「未設定」。**マスタには載っていない**（`MSTPREF` は 48 件だが `0` を含まない）。`CAREER#CHARGE_ID = 0` が担当者なしを表すのと同じ |
| 26 | **列挙を返さないマスタ** | 記載なし | `CAREER#ZIP_ID`（郵便番号）は `codeName: MSTZIPCODE` を持つが、**このマスタは 0 件を返す。**値はコードではなくデータなので、ラベル変換に失敗しても注釈を付けずそのまま表示する |
| 15 | `progress/select` の必要権限 | **記載漏れ** | 「進捗(読み取り)」で動作 |
| 16 | マスタの返却順 | — | **業務フロー順ではない**（実際の遷移 `16 → 11` が `25` を飛ばす） |

# 付録B. 個別設計書との差異（本書で解決したもの）

本書作成時点で、個別設計書に古い記述が残っている箇所。**本書を正とする。**

| 箇所 | 個別設計書の記述 | 本書での扱い |
|---|---|---|
| レート設定値 | `01-architecture.md` 6.1 の `app.yaml` 例が `tokens_per_second: 1.5`（90 req/分）、`bucket_capacity: 30` | **`1.0`（60 req/分）/ 容量 20 が正。**同ファイル 4.1 と `03-rate-budget.md` 4章の結論（「既定は 60 req/分に戻す」）に合わせた |
| 要件4のウォッチャー構成 | `02-watchers.md` に `career_action_new` / `career_action_diff` / `career_action_sweep` / `career_action_digest` / `career_action_reconcile` の記述が残存 | **`career_action_watch` 1本に統合済み。**トリガーが日付3項目だけになり、検知機構を分ける理由が消えた |
| 要件4の内容更新（ハッシュ比較） | `02-watchers.md`「`career_action_diff`（内容更新）」節に本文ハッシュ比較の手順が残存 | **廃止。**本文の変更は通知しない（業務側の決定）。`snapshots` に保存するのは日付3項目のみ |
| datetime の粒度 | `00-findings.md` 2.6「datetime に秒がない。カーソルの下限は分」 | **誤り。秒精度で検索できる**（実測）。オーバーラップは 5分 → 60秒 |
| 要件4の総件数 | `02-watchers.md`「全ID走査のコスト」表と `03-rate-budget.md` 5章の 73,000 req/日 見積り | **撤回済み。**全件走査は行わない。走査量は総件数ではなく直近の活動量に比例する |
| `CLAUDE.md` の「実装前に確定が要るもの」 | 「本番テナントの対応履歴の総件数」「担当者未設定の求職者への通知先」 | **どちらも解消済み**（総件数≒30,000 のヒアリング回答、未設定時は送らず日次サマリ） |
| メール送信方式 | `02-watchers.md`「メール送信」節が案A（アプリパスワード）を PoC 推奨としている | **案A・案Bとも不可**（アプリパスワードが組織全体で無効化）。**PoC はローカル SMTP、本番は B'（IP 許可）または C（Gmail API）**（8.4節） |

---

# 付録C. 管理者への依頼文

要件4のメール送信に関する依頼。**現在ペンディング中のため、再開時に使う**（8.4節）。
以下の番号は本書 10.3節 の C-1 / C-2 とは無関係（依頼の通し番号）。

| 依頼 | 対象 | 必要になる時期 |
|---|---|---|
| **依頼0** | 開発 PC で Mailpit を実行する許可 | PoC（要件4の実装を再開するとき） |
| 依頼1・2 | Workspace の SMTP リレー + IP 許可 | 本番。**回線が固定グローバル IP の場合** |
| 依頼3 | Gmail API + OAuth2 クライアント | 本番。**固定 IP が無い場合** |

---

## 依頼0. Mailpit の実行許可（PoC / IT 管理者向け）

> 開発中のアプリケーションが送信するメールを**外部に出さずに手元で確認する**ため、
> 開発 PC で **Mailpit** というオープンソースのメールテストツールを実行する許可をお願いします。
>
> | 項目 | 内容 |
> |---|---|
> | 名称 / 入手元 | Mailpit — https://github.com/axllent/mailpit （MIT ライセンス） |
> | 実体 | **単一の実行ファイル（`mailpit.exe`）。**インストーラ不要、レジストリ変更なし、管理者権限不要 |
> | 動作 | ローカルの SMTP 受け口として待ち受け、受け取ったメールを**ローカルの Web 画面に表示するだけ** |
> | **外部通信** | **一切行いません。**受け取ったメールを外部へ転送・送信することはありません |
> | 待ち受けポート | TCP **1025**（SMTP）/ TCP **8025**（Web 画面）。**いずれも `127.0.0.1`（自分自身）のみにバインドします** |
> | データの保存 | **メモリ上のみ。**アプリを終了すると消えます（ディスクに永続化しません） |
> | ファイアウォール | 外向き通信・LAN からの着信ともに発生しないため、受信規則の追加は不要です |
>
> 目的は「実際にメールを送ってしまう事故を防ぎながら、宛先や本文が正しいかを確認する」ことです。
> 本番の送信経路（別途ご相談）が整うまでの検証用途に限って使用します。

**補足（社内向け）**: 受信箱には求職者の氏名・対応履歴のメモが表示される。
`127.0.0.1` へのバインドを必ず明示し、PC を他人と共有しない（8.3節）。

---

## 依頼1. まず確認してほしいこと（本番経路の前提）

> **オフィス回線（アプリを動かす PC が繋がる回線）は、固定グローバル IP 契約か。**

これが Yes なら、以下の依頼は **依頼2 だけ**で済む。No なら 依頼3 が必要になる。

確認方法: 対象の PC で `curl ifconfig.me` を数日おきに実行して IP が変わらないかを見る。
確実なのは回線の契約内容を確認すること。

## 依頼2. 固定 IP がある場合 —— SMTP リレーの有効化（最も軽い）

Google Workspace 管理者へ:

> **Admin console → アプリ → Google Workspace → Gmail → ルーティング → 「SMTP リレー サービス」**
> に、次の設定で1件追加してください。
>
> | 項目 | 値 |
> |---|---|
> | 許可する送信者 | 「ドメイン内のユーザーのみ」 |
> | 認証 | **「次の IP アドレスからのみメールを受け付ける」にチェックし、`<オフィスの固定IP>/32` を登録** |
> | | 「SMTP 認証を要求する」は**チェックしない**（アプリパスワードが使えないため） |
> | TLS 暗号化 | 要求する |
>
> あわせて、送信用アカウント **`cp-notify@mybrainlab.net`** の作成をお願いします
> （送信元アドレスとして使います。ログインは不要です）。

これで**パスワードもアプリパスワードも OAuth も不要**になる。
アプリ側の設定は `host: smtp-relay.gmail.com` / `port: 587` / `starttls: true` / `auth: none` の変更だけ。

## 依頼3. 固定 IP が無い場合 —— Gmail API + OAuth2

Google Workspace / GCP 管理者へ:

> 社内 GCP プロジェクトに、次の OAuth クライアントを作成してください。
>
> | 項目 | 値 |
> |---|---|
> | プロジェクト | 新規または既存の社内プロジェクト |
> | 有効にする API | **Gmail API** |
> | OAuth 同意画面 | **内部（Internal）** |
> | クライアントの種類 | **デスクトップ アプリ** |
> | スコープ | **`https://www.googleapis.com/auth/gmail.send` のみ**（読み取り権限は不要） |
>
> あわせて、送信用アカウント **`cp-notify@mybrainlab.net`** の作成をお願いします。
>
> Admin console で「アプリのアクセス制御」が有効な場合は、
> 作成したクライアント ID を**信頼済みとして許可**してください。

発行された `client_id` / `client_secret` を受け取り、
送信用アカウントで1回だけブラウザ同意を行ってリフレッシュトークンを取得する。
以降はトークンで送信でき、**パスワードを一切保持しない。**
リフレッシュトークンは `.env`（`GMAIL_REFRESH_TOKEN`）に保存する。

## 依頼が通らなかった場合の代替

| 代替 | 内容 |
|---|---|
| D（GAS 中継） | 送信用アカウントで GAS Web App を1本デプロイし、Python から共有シークレット付きで POST。GCP 不要。**Web App の外部アクセスが管理者に制限されていないかの確認が要る** |
| F（Slack 出力） | 要件4もメールをやめて Slack へ出す。**要件の妥協になるため、業務側の了承が要る** |
| E（外部送信サービス） | SendGrid / Amazon SES 等。`mybrainlab.net` の SPF/DKIM に DNS レコード追加が必要 |
