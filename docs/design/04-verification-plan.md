# 04. 実環境検証計画

APIキーが発行された直後に、**実装着手前に**実施する検証。
`docs/` の原典だけでは確定しない事項を潰す。

> **実施状況（2026-08-05）**
> V-1 / V-3a / V-3b / V-4 / V-5 / V-6 / V-7 は**実施済み**。
> 結果は **`07-verification-results.md`** を参照（原典と食い違う箇所はそちらが正）。
> 残るのは画面操作が必要な **V-2** と **V-3c** のみ（手順は `08-ui-operation-request.md`）。
> 実行スクリプトは `tools/verify/`。

検証は使い捨てスクリプト（`tools/verify/`）で行う。`app/` は作らない。
全リクエストはトークンバケット相当の間隔（1秒に1回）で流す。合計でも300リクエスト程度。

---

## 優先度

| ID | 内容 | 区分 | これが失敗すると |
|---|---|---|---|
| **V-1** | オリつく項目が schema に現れるか | **BLOCKER** | 要件1の後半が実装不能 |
| **V-2** | 「求人紹介OK → 新規登録」が何を作るか | **BLOCKER** | 要件3の実現可否が判断できない |
| **V-3** | `career_action` で親リソースの項目が使えるか | **設計分岐** | 要件4のリクエスト数が約10倍変わる |
| V-4 | 進捗ステータスマスタの実際の値 | 設計入力 | 要件2のフロー定義が書けない |
| V-5 | 疎通・認可・権限の確認 | 前提 | 何も始まらない |
| V-6 | 検索クエリの形式（日時フォーマット等） | 前提 | 全ウォッチャーの検知が動かない |
| V-7 | 規模の実測 | 設計入力 | 流量予算が机上のまま |

**V-1・V-2・V-3 の結果を報告してから実装方針を最終決定する。**

---

## V-5. 疎通・認可・権限（最初にやる）

```
1. POST /v1/auth/token  { "grantType": "api_key", "apiKey": "..." }
   → accessToken / refreshToken / expiresIn を確認
2. POST /v1/auth/token  { "grantType": "refresh_token", "refreshToken": "..." }
   → リフレッシュが通ることを確認
3. GET  /v1/ext2/master/list
4. GET  /v1/ext2/schema/career
5. 使う予定の全エンドポイントに limit:1 の検索を1回ずつ投げ、403 が出ないことを確認
   career / career_action / progress / progress_history / order / client
```

確認すること:
- `expiresIn` が本当に 3600 か
- 権限不足（403）のエンドポイントがないか。あれば APIキーの権限を追加してもらう
- **`POST /v1/ext2/progress/select/{id}` の必要権限**（仕様書に記載漏れ、`00-findings.md` 2.9）
- レスポンスの `requestId` が取れるか（ベンダー問い合わせに必要）

---

## V-1. オリつく項目は schema に現れるか【BLOCKER】

### 手順

```
1. GET /v1/ext2/schema/career を取得し、items[].itemId を全件列挙
2. 項目一覧 xlsx の「求職者」シートの項目ID（230件）と差分を取る
3. schema にのみ存在する itemId を洗い出す
```

差分抽出は `tools/docs_dump/out/xlsx/求職者.tsv` と突き合わせれば機械的にできる。

### 判定

| 結果 | 意味 | 次のアクション |
|---|---|---|
| schema にのみ存在する項目がある | **オリつく項目が見えている可能性が高い** | 4. へ進む |
| 差分がない（xlsx と完全一致） | オリつく項目は API に露出していない | 要件1後半は実装不能。代替案へ |
| 差分はあるが CP のバージョンアップで増えた標準項目だった | 判別が必要 | 業務側に「オリつくで作った項目のラベル名」を聞き、`label` で照合する |

**確実な判別方法**: 事前に業務側から**オリつく項目の画面上のラベル名**を教えてもらい、
schema の `label` に一致するものを探す。差分だけでは標準項目の増加と区別がつかない。

### 4. 見つかった場合の追加確認

itemId が schema に現れても、検索・取得で使えるとは限らない。

```
4a. career/select/{既知の求職者ID} の itemIds にオリつく項目IDを含めて取得できるか
4b. career/search の condition にオリつく項目IDを使えるか（EQ で1件検索）
4c. itemType と validationRule.codeName を確認
    selectone ならマスタ名が取れるか → master/{codeName} でラベル変換できるか
```

4a が通れば要件1は完全に実現できる（YAML に itemId を書くだけ）。
4a が通らなければ 4b と組み合わせた別方式（検索で該当集合を取り、差分を集合演算で見る）を検討する。

### 全リソースについても同じ確認をする

`career` だけでなく `career_action` `progress` にもオリつく項目がある可能性がある。
6リソース分の schema を取得して xlsx と突き合わせる。

---

## V-2. 「求人紹介OK → 新規登録」が何を作るか【BLOCKER】

### 手順（テスト求職者を1件用意してもらう）

**事前スナップショット**（各1リクエスト。`count` だけ見ればよい）

```
progress/search          { limit: 1 }                         → count
progress_history/search  { limit: 1 }                         → count
career_action/search     { limit: 1 }                         → count
wrkcareer/search         { limit: 1 }                         → count
file/search              { limit: 1 }                         → count
career/select/{テスト求職者ID}  { itemIds: schema の全項目 }   → 全項目値
```

**UI 操作**（業務側に依頼）

> テスト求職者の画面で「求人紹介OK」ボタン → 開いた小画面で「新規登録」ボタンを1回だけクリック。
> 操作した日時を記録する。

**事後スナップショット**（同じ6リクエスト）

**差分**

```
1. count が増えたリソースを特定する
2. 増えたリソースについて、新規 ID を検索で特定
   progress なら:          progress/search { condition: PROGRESS#INSERT_DATE GE <操作時刻-5分> }
   progress_history なら:  progress_history/search { condition: PROGRESS_HISTORY#INSERT_DATE GE <操作時刻-5分> }
   career_action なら:     career_action/search { condition: CAREER_ACTION#CAREER_ID EQ <テスト求職者ID>, sort: HISTSEQ desc, limit: 5 }
3. 新規 ID を select して全項目を取得し、何が入っているかを確認
4. career/select の前後を diff し、変化した項目（特にオリつく項目）を特定
```

合計 15〜20 リクエスト程度。

### 判定と分岐

| 差分 | 結論 | 設計への反映 |
|---|---|---|
| `progress` +1、`progress_history` +1（枝番1） | 想定どおり | `progress_flow` に統合（`02-watchers.md` 設計どおり） |
| `progress` +1 のみ（履歴なし） | 進捗だけ作られる | 検知を `PROGRESS#INSERT_DATE GE` に切り替える |
| `career_action` +1 | 対応履歴として記録される | 要件4のウォッチャーに相乗り |
| `wrkcareer` +1 | 求職者候補が作られる | 別ウォッチャーを新設。`wrkcareer` にタイムスタンプ項目がないため ID 高水位マーク方式になる |
| `career` の項目のみ変化 | フラグ更新 | 要件1のウォッチャーに監視項目を追加（V-1 に依存） |
| **どれも変化しない** | **API から見えない** | `02-watchers.md`「API から一切見えなかった場合の代替案」へ |

### 補足で確認すること

- 「求人紹介OK」を押した時点と「新規登録」を押した時点で、それぞれ何が起きるか
  （2段階で別々にレコードが作られる可能性がある）。可能なら2回に分けて計測する
- `PROGRESS#INTRODUCTION_DATE`（紹介日）に値が入るか。入るならこれが要件3の直接的な判定条件になる
- 同じ操作を2回すると2件作られるか（冪等性の確認）

---

## V-3. `career_action` で関連リソースの項目が使えるか【設計分岐】

仕様書「リソース定義 > 関連リソース」に
「検索のエンドポイントでは、関連するリソースを使用した検索が可能です」
「取得のエンドポイントでは、関連するリソースの項目も合わせて取得が可能です」とある。
`career_action` の関連リソースは求職者。実測で確認する。

### V-3a. 取得での混在

```
POST /v1/ext2/career_action/select/{既知の対応履歴ID}
{
  "itemIds": [
    "CAREER_ACTION#CAREER_ID",
    "CAREER_ACTION#HISTSEQ",
    "CAREER_ACTION#ACTIONMEMO",
    "CAREER#LASTNAME",
    "CAREER#FIRSTNAME",
    "CAREER#CHARGE_EMAIL"
  ]
}
```

- 200 が返り `CAREER#*` の値も含まれる → **1リクエストで通知本文が完成する。`career/select` が不要**
- 400 が返る → 別途 `career/select` が必要（resolver キャッシュで吸収）

### V-3b. 検索条件での混在

```
POST /v1/ext2/career_action/search
{
  "limit": 100,
  "sort": [{ "itemId": "CAREER_ACTION#HISTSEQ", "order": "asc" }],
  "condition": {
    "compoundType": "and",
    "items": [
      { "itemId": "CAREER#UPDATE_DATE", "searchType": "GE", "value": "2026/08/01 00:00" }
    ]
  }
}
```

- 200 が返る → 構文としては使える。次に V-3c へ
- 400 が返る → **戦略A は不成立。戦略B（日付窓走査）で確定**

### V-3c. 対応履歴の変更で `CAREER#UPDATE_DATE` が動くか【最重要】

V-3b が通っても、これが動かなければ戦略Aは意味がない。

```
1. テスト求職者の CAREER#UPDATE_DATE を取得（値A）
2. 業務側に依頼: その求職者の対応履歴タブで「新規対応」を1件登録
3. CAREER#UPDATE_DATE を再取得（値B）
4. 値B > 値A なら、対応履歴の登録で親の更新日が動く
5. 同じ求職者の対応履歴の「内容」だけを編集してもらい、もう一度確認
6. 完了日を入れてもらい、もう一度確認
```

| 結果 | 結論 |
|---|---|
| 登録・編集・完了のすべてで更新日が動く | **戦略A 成立。**要件4の流量が約1/10になる |
| 登録のみ動く | 新規は戦略A、更新・完了は戦略B のハイブリッド |
| 動かない | 戦略B で確定 |

---

## V-4. 進捗ステータスマスタ

```
GET /v1/ext2/master/list                      → マスタ名の一覧
GET /v1/ext2/master/MST_PROGRESS_STATUS       → 進捗ステータスのコード値とラベル
GET /v1/ext2/master/MSTUSER                   → 担当者
GET /v1/ext2/master/MSTACTION                 → アクション区分
GET /v1/ext2/master/MSTREGSTATUS              → 登録ステータス
GET /v1/ext2/master/MSTCNSLSTATUS             → 面談ステータス
GET /v1/ext2/master/MSTWKSTATUS               → 現在の状況
GET /v1/ext2/master/MSTCONRANK                → ランク
GET /v1/ext2/master/MSTTEAM                   → チーム
```

確認すること:
- `MST_PROGRESS_STATUS` の値の並びが「はじめから内定まで」のフローとしてどう対応するか
- **`master/list` に出るマスタ名が、項目一覧の「参照マスタ」列と一致するか**
  （`MST_PROGRESS_STATUS` `MSTACTION_CHOICE1` などが実在するか）
- コード値→ラベルの変換が全項目で可能か

**業務側に確認すべきこと**: このマスタのどの値が「はじめ」で、どれが「内定」か。
遷移グラフ（進捗ステータス設定）の内容。仕様書に「進捗ステータス設定で決められた
遷移先ステータス以外は登録時にエラー」とあるため、CP 上に定義が存在する。

なお、`master/list` のレスポンス例は `name` / `label` だが、
`master/{codeName}` のレスポンス例は `values[].value` と `values[].values`（複数形）が
混在している（仕様書の記載ゆれ）。実際のキー名を実測で確認する。

---

## V-6. 検索クエリの形式

全ウォッチャーの前提になる。

```
1. datetime の検索値の形式
   career/search { condition: CAREER#UPDATE_DATE GE "2026/08/01 00:00" }
   → 通るか。"2026/08/01 00:00:00" は通るか。"2026-08-01 00:00" は通るか
2. date の検索値の形式
   career_action/search { condition: CAREER_ACTION#ACTION_DATE GE "2026/08/01" }
3. datetime のレスポンス形式に秒があるか
   career/select で CAREER#UPDATE_DATE を取り、"yyyy/MM/dd HH:mm" か確認
4. number 型の値が文字列で返るか数値で返るか
5. ネストした condition が実際に動くか
6. limit: 100 で 100件返るか。offset を深くしたときの応答時間
7. count が limit を超える総件数を返すか
8. ENTERED / NOT_ENTERED に value: "" を渡して動くか
9. sort 未指定時に同じ検索を2回投げて ids の順序が変わるか（並び順が保証されない旨の確認）
```

3 の結果でカーソルのオーバーラップ幅が決まる。秒がなければ最低5分のオーバーラップが要る。

---

## V-7. 規模の実測

流量予算（`03-rate-budget.md`）の想定値を実測で置き換える。

```
1. career/search { limit: 1 } の count                          → 求職者総数
2. career/search { CAREER#UPDATE_DATE GE 昨日00:00, limit: 1 }  → 1日の求職者更新件数
   （直近7日ぶんを1日ずつ取れば平日/休日の差も分かる）
3. progress_history/search { INSERT_DATE GE 昨日00:00, limit: 1 } → 1日の進捗遷移件数
4. career_action/search { ACTION_DATE GE 3日前, limit: 1 }       → 走査窓内の対応履歴件数
5. career_action/search { ACTION_DATE NOT_ENTERED, limit: 1 }    → 対応日が未入力の対応履歴の件数
6. 要件1の絞り込み条件での count                                  → 監視対象求職者数
```

**5 が重要。**対応日が未入力の対応履歴が多いと、戦略Bの日付窓走査が
大量の取りこぼしを生む（`02-watchers.md`「戦略Bの既知の取りこぼし」）。
件数が無視できないなら、`NEXTACTION_DATE` の併用や `ACTIONCHARGE_ID` を使った
別の窓の設計が要る。

各1リクエスト、合計10リクエスト程度で済む（`count` しか見ないので `select` 不要）。

---

## 検証後に更新するもの

| 検証 | 反映先 |
|---|---|
| V-1 | `02-watchers.md` 要件1 / `config/watchers.yaml` のオリつく項目ID |
| V-2 | `02-watchers.md` 要件3 の判定条件 / `progress_flow` への統合可否 |
| V-3 | `02-watchers.md` 要件4 の戦略A/B 確定 / `03-rate-budget.md` の予算 |
| V-4 | `config/watchers.yaml` の `watched_statuses` |
| V-6 | `core/timefmt.py` の変換仕様 / `overlap_minutes` |
| V-7 | `03-rate-budget.md` 3章の想定規模と4章の見積り |
