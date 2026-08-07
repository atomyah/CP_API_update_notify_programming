# 00. 原典検証結果

`docs/` の3ファイルを一次資料として読み込んだ結果。事前調査に対する追認・訂正・補足を含む。

読み取り方法は `tools/docs_dump/README.md` を参照（HTML はタグ除去、xlsx は全シート TSV 化、
PDF はテキストレイヤがないため 3倍解像度でレンダリングして目視）。

---

## 1. 事前調査の追認

以下は原典で裏が取れた。**事前調査は正しい。**

| # | 内容 | 根拠 |
|---|---|---|
| 1 | Webhook / イベント通知は存在しない | 仕様書の目次・本文に現れるエンドポイントは認可・マスタ・リソース定義と、各リソースの検索/取得/登録/更新/削除のみ。xlsx「API一覧」も同様 |
| 2 | 1分間240リクエストを超えるとAPIサービス停止の可能性 | 仕様書「概要 > 利用方法」に明記 |
| 3 | `select/{id}` は1リクエスト1リソース | 仕様書「共通 > 取得」。URI に単一 id を取り、レスポンスの `result` も単一リソース |
| 4 | アクセストークンは60分有効 | 仕様書「認可 > トークンエンドポイント」。`expiresIn: 3600` |
| 5 | ブラウザから直接叩かない | 仕様書「概要 > 利用方法」に明記。APIキー漏洩を理由として挙げている |
| 6 | `CAREER#UPDATE_DATE` は datetime・読み取り専用・`GE` 使用可 | xlsx「求職者」85行目。仕様書「比較方法」の対応表で datetime × GE は〇 |
| 7 | `PROGRESS#UPDATE_DATE` / `PROGRESS_HISTORY#INSERT_DATE` が存在 | xlsx「進捗」11行目 / 「進捗詳細」7行目。どちらも datetime・読み取り専用・ソート可 |
| 8 | `career_action` に `INSERT_DATE` も `UPDATE_DATE` も存在しない | xlsx「求職者対応履歴」は全14項目。日時系は `ACTION_DATE`(date) / `COMPLETE_DATE`(date) / `NEXTACTION_DATE`(datetime) のみ |
| 9 | `CAREER#CHARGE_EMAIL` が存在する | xlsx「求職者」30行目 |
| 10 | オリつく項目は項目一覧xlsxに1件も掲載されていない | 全13シートを走査。項目IDのプレフィックスは `CAREER` `CAREER_WORKEXP` `CAREER_ACTION` `CLIENT` `CLIENT_ACTION` `DEPARTMENT` `ORDER` `WRKCAREER` `PROGRESS` `PROGRESS_HISTORY` `FILE` の11種のみ。仕様書本文にも「オリジナル項目」の記述なし |

---

## 2. 訂正・見落としの指摘

### 2.1 【要注意】仕様書HTMLに項目IDの誤記がある

仕様書の `POST /v1/ext2/progress/select/{id}` のリクエスト例で **`PROGRESS#STATSU_ID`** と書かれているが、
xlsx「進捗」13行目では **`PROGRESS#STATUS_ID`** が正。`STATSU` は `STATUS` のタイプミス。

→ 実装は項目一覧を正とし、さらに起動時に `GET /v1/ext2/schema/progress` で実在を検証する。
仕様書のサンプルをコピペしない。

### 2.2 【重要】`career_action` は関連リソース＝求職者

事前調査で触れられていない。仕様書に次の記述がある。

- `POST /v1/ext2/career_action/search` — 権限：求職者(読み取り)、求職者対応履歴(読み取り) / **関連リソース：求職者**
- `POST /v1/ext2/career_action/select/{id}` — 同上 / **関連リソース：求職者**

そして仕様書「リソース定義 > 関連リソース」に次のようにある。

> 「検索」のエンドポイントでは、関連するリソースを使用した検索が可能です。
> また、「取得」のエンドポイントでは、関連するリソースの項目も合わせて取得が可能です。

これが文字通り成立するなら、要件4の設計が根本的に変わる。

1. **変更検知**: `career_action/search` の条件に `CAREER#UPDATE_DATE GE <カーソル>` を書ける。
   `career_action` 自身にタイムスタンプがない問題を、親の求職者のタイムスタンプで回避できる。
   （ただし「対応履歴を編集したときに `CAREER#UPDATE_DATE` が更新されるか」は別途の検証が要る）
2. **宛先取得**: `career_action/select` の `itemIds` に `CAREER#CHARGE_EMAIL` `CAREER#LASTNAME`
   `CAREER#FIRSTNAME` を混ぜられる。1リクエストで通知本文が完成し、`career/select` が不要になる。

仕様書のリクエスト例では関連リソースの項目IDを使った例が示されていないため、**実測未検証**。
`docs/design/04-verification-plan.md` の最優先検証項目とする。

### 2.3 【重要】`progress` / `progress_history` は関連リソース＝なし

- `POST /v1/ext2/progress/search` — 関連リソース：なし
- `POST /v1/ext2/progress_history/search` — 関連リソース：なし

つまり進捗の検索を求職者の属性（担当者・ランク等）で絞り込めない。
要件2は「全社の進捗遷移を拾ってからアプリ側でフィルタする」以外に方法がない。
監視対象を絞ってリクエストを減らす作戦が使えないことを意味する。

### 2.4 【重要】`progress_history` に `CAREER_ID` がない

xlsx「進捗詳細」の全20項目に求職者IDがない。進捗履歴だけでは誰の話か分からない。

ただし**進捗履歴IDは `{progressId}_{枝番}` 形式**（仕様書の例 `123_1`、`PROGRESS_HISTORY#PROGRESS_ID_SUB` の存在）。
IDの文字列から `progressId` を取り出せるので、`progress_history/search` の結果 ID だけで
`progress/select` に進める。**API呼び出しを1回節約できる**（`progress_history/select` を挟まなくてよい）。

### 2.5 `CAREER_ACTION#ACTION_DATE` と `COMPLETE_DATE` は date 型（日粒度）

事前調査は `COMPLETE_DATE` を手がかりに挙げているが、型は **date**（`yyyy/MM/dd`）で時刻を持たない。
`NEXTACTION_DATE` のみ datetime。

要件4のカーソルは**日単位**でしか切れない。1日分をまとめて再走査する前提の設計になる。

### 2.6 datetime に秒がない

仕様書「共通 > 取得」より、datetime 型の値は `yyyy/MM/dd HH:mm` 形式。秒がない。

カーソルの粒度の下限は**分**。`GE` で厳密に切ると同一分内の取りこぼしが起きる。
オーバーラップ + 冪等除去が必須（`rules/30-state-and-idempotency.md`）。

### 2.7 検索レスポンスは ID しか返さない

仕様書「共通 > 検索 > レスポンス」より `result` は `limit` / `offset` / `count` / `ids` のみ。
項目値は一切返らない。

これが流量設計の核心。「N件が変化した」を知るのに 1 リクエスト、
「何がどう変わったか」を知るのに N リクエストかかる。

なお `count` は総ヒット件数なので、**値が要らず件数だけ欲しい場面は 1 リクエストで済む**。
要件3の検証（何が作られたかの特定）でこれを使う。

### 2.8 `limit` の最大は100、未指定時20

仕様書「共通 > 検索 > リクエスト」。必ず明示的に 100 を指定する。
また「検索に時間が掛かりすぎる場合、タイムアウトすることがあります」との注記があり、
深いオフセットのページングはリスクがある。

### 2.9 文書間の不整合

| 不整合 | 内容 |
|---|---|
| xlsx「API一覧」の欠落 | **進捗 / 進捗履歴 / ファイル のエンドポイントが1件も載っていない**（45行、求職者候補の削除で終わっている）。HTML仕様書には全て存在する。項目シートには「進捗」「進捗詳細」「ファイル」がある。API一覧シートの更新漏れと判断し、HTML を正とする |
| xlsx「進捗詳細」の `RESOURCE_CATEGORY` | `progress` と書かれているが、正しくは `progress_history`。HTML の `progress_history/select` レスポンス例に `"resourceCategory": "progress_history"` とある |
| 仕様書の権限記載漏れ | `POST /v1/ext2/progress/select/{id}` `POST /v1/ext2/progress/` `PUT /v1/ext2/progress/{id}` `DELETE /v1/ext2/progress/{id}` の4つに**権限の記載がない**。他の全エンドポイントには「権限：〜」がある。進捗(読み取り/作成/更新/削除)と推定されるが未確定 |
| xlsx の RESOURCE_CATEGORY 末尾空白 | `progress ` `wrkcareer ` `file ` に末尾スペース。パースするなら trim が要る |

### 2.10 xlsx の「読み取り専用」と「更新」列の関係

「読み取り専用」に ● が付く項目は、「更新」列が ○ でも更新できない。
読み取り専用が優先。「更新」列の × は「登録時は指定できるが更新時は指定できない」（`isNotUpdatable`）の意味。

例: `PROGRESS#CAREER_ID` は必須●・読み取り専用−・更新× → 登録時に指定、更新時は不可。
`PROGRESS#PROGRESS_ID` は読み取り専用● → どちらも不可。

読み取り専用の項目は当然ながら**アプリからは書けないが検索・取得はできる**。
通知アプリはすべて読み取りしかしないので実害はないが、schema の解釈を誤らないこと。

---

## 3. 確定した事実の要約

### 3.1 リソースとエンドポイント

11 リソース。全て `POST /v1/ext2/{resource}/search`, `POST .../select/{id}`,
`POST .../`, `PUT .../{id}`, `DELETE .../{id}`（ファイルのみ更新なし）。

| resourceCategory | 日本語 | 関連リソース | 検索・取得の権限 |
|---|---|---|---|
| `career` | 求職者 | なし | 求職者(読み取り) |
| `career_workexperience` | 求職者職歴 | 求職者 | 求職者・求職者職歴(読み取り) |
| `career_action` | 求職者対応履歴 | **求職者** | 求職者・求職者対応履歴(読み取り) |
| `client` | 企業 | なし | 企業(読み取り) |
| `client_action` | 企業対応履歴 | 企業 | 企業・企業対応履歴(読み取り) |
| `department` | 部署 | 企業 | 企業・部署(読み取り) |
| `order` | 求人 | 企業、部署 | 企業・部署・求人(読み取り) |
| `wrkcareer` | 求職者候補 | なし | 求職者候補(読み取り) |
| `progress` | 進捗 | なし | 進捗(読み取り) ※select は記載漏れ |
| `progress_history` | 進捗履歴 | なし | 進捗(読み取り) |
| `file` | ファイル | なし | ファイル(読み取り) |

補助エンドポイント:

- `GET /v1/ext2/schema/{resourceCategory}` — 権限：リソース定義(読み取り)
- `GET /v1/ext2/master/list` — 権限：マスター(読み取り)
- `GET /v1/ext2/master/{codeName}` — 権限：マスター(読み取り)
- `POST /v1/auth/token` — 権限不要

### 3.2 searchType と項目タイプの対応表

仕様書「共通 > 検索 > 比較方法」より。〇が使用可。

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

`value` に `null` は不可。未入力判定は `NOT_ENTERED` + 空文字。

### 3.3 差分検知に使える時刻項目（全リソース横断）

| リソース | 項目 | 型 | 読取専用 | ソート可 |
|---|---|---|---|---|
| career | `CAREER#INSERT_DATE` | datetime | ● | ○ |
| career | `CAREER#UPDATE_DATE` | datetime | ● | ○ |
| career | `CAREER#CNSL_DATE`（面談日） | datetime | − | ○ |
| career | `CAREER#LAST_LOGIN`（マイページ最終ログイン） | datetime | ○ | ○ |
| career_action | `CAREER_ACTION#ACTION_DATE`（対応日） | **date** | − | ○ |
| career_action | `CAREER_ACTION#COMPLETE_DATE`（完了日） | **date** | − | ○ |
| career_action | `CAREER_ACTION#NEXTACTION_DATE`（次回コンタクト日） | datetime | − | ○ |
| progress | `PROGRESS#INSERT_DATE`（入力日） | datetime | ● | ○ |
| progress | `PROGRESS#UPDATE_DATE`（更新日） | datetime | ● | ○ |
| progress | `PROGRESS#LASTPROGRESS_DATE`（最終進捗更新日） | date | − | ○ |
| progress | `PROGRESS#INTRODUCTION_DATE`（紹介日） | date | − | ○ |
| progress | `PROGRESS#RECRUITMENT_DATE`（採用日） | date | − | ○ |
| progress_history | `PROGRESS_HISTORY#INSERT_DATE`（入力日） | datetime | ● | ○ |
| progress_history | `PROGRESS_HISTORY#UPDATE_DATE`（更新日） | datetime | ● | ○ |
| progress_history | `PROGRESS_HISTORY#PROGRESS_DATE`（進捗日） | date | − | ○ |
| file | `FILE#INSERT_DATE` / `FILE#UPDATE_DATE` | datetime | ● | ○ |

**`career_action` に読み取り専用の自動タイムスタンプがない**のが要件4の難所。
`ACTION_DATE` `COMPLETE_DATE` `NEXTACTION_DATE` はいずれもユーザ入力値であり、
「レコードが変更された時刻」ではない。

### 3.4 要件に直結する項目

**要件1（求職者の項目ステータス）** — デフォルト項目で「ステータス」に相当するもの:

| 項目ID | ラベル | 型 | 参照マスタ |
|---|---|---|---|
| `CAREER#REGSTATUS_ID` | 登録ステータス | selectone | `MSTREGSTATUS` |
| `CAREER#CNSLSTATUS_ID` | 面談ステータス | selectone | `MSTCNSLSTATUS` |
| `CAREER#WKSTATUS_ID` | 現在の状況 | selectone | `MSTWKSTATUS` |
| `CAREER#RANK_ID` | ランク | selectone | `MSTCONRANK` |
| `CAREER#MYPAGE_STATUS` | マイページステータス | selectone | `MSTMYPAGECHK` |
| `CAREER#CHARGE_ID` | 担当者 | selectone | `MSTUSER` |
| `CAREER#CHARGETEAM_ID` | 担当チーム | selectone | `MSTTEAM` |

オリつく項目は不明（`docs/design/04-verification-plan.md` V-1）。

**要件2/3（進捗）**:

| 項目ID | ラベル | 型 | 備考 |
|---|---|---|---|
| `PROGRESS#STATUS_ID` | 進捗ステータス | selectone | `MST_PROGRESS_STATUS`。読み取り専用 |
| `PROGRESS#CAREER_ID` | 求職者ID | number | |
| `PROGRESS#ORDER_ID` | 求人ID | number | |
| `PROGRESS#INTRODUCTION_DATE` | 紹介日 | date | 要件3の手がかり |
| `PROGRESS_HISTORY#PROGRESS_STATUS_ID` | 進捗ステータスID | selectone | `MST_PROGRESS_STATUS` |
| `PROGRESS_HISTORY#PROGRESS_ID_SUB` | 進捗ID_枝番 | number | 1 なら初回＝進捗の新規作成 |
| `PROGRESS_HISTORY#CAREER_CHARGE_ID` | 求職者担当者 | selectone | `MSTUSER` |

進捗ステータスの値は `MST_PROGRESS_STATUS` を実環境で取得しないと分からない。
「はじめから内定まで」がどのコード値の並びになるかはテナント設定依存。

仕様書に「進捗ステータス設定で決められた遷移先ステータス以外は登録時にエラー」とあり、
**テナントごとに遷移グラフが定義されている**ことが分かる。要件2の「フロー全体」はこの定義に従う。

**要件4（対応履歴）** — `career_action` の全14項目:

| 項目ID | ラベル | 型 | 備考 |
|---|---|---|---|
| `CAREER_ACTION#CAREER_ID` | 求職者ID | number | 読み取り専用 |
| `CAREER_ACTION#HISTSEQ` | 対応番号 | number | 読み取り専用・ソート可。ID は `{careerId}_{HISTSEQ}` |
| `CAREER_ACTION#ACTION_DATE` | 対応日 | date | 条件付き必須 |
| `CAREER_ACTION#ACTION_ID` | アクションID | selectone | `MSTACTION`。条件付き必須 |
| `CAREER_ACTION#ACTIONCHARGE_ID` | 担当 | selectone | `MSTUSER`。条件付き必須 |
| `CAREER_ACTION#ACTIONMEMO` | 内容 | textarea | 2000字 |
| `CAREER_ACTION#ACTIONTEAM_ID` | 担当チーム | selectone | `MSTTEAM`。読み取り専用 |
| `CAREER_ACTION#COMPLETE_DATE` | 完了日 | date | 「対応完了」の判定に使う |
| `CAREER_ACTION#NEXTACTION_DATE` | 次回コンタクト日 | datetime | |
| `CAREER_ACTION#ACTIONCHOICE_ID1〜3` | 対応履歴選択肢1〜3 | selectone | `MSTACTION_CHOICE1〜3` |
| `CAREER_ACTION#ACTIONTEXT1〜2` | 対応履歴テキスト1〜2 | text | 60字 |

「対応日」「アクションID」「担当」は**条件付き必須（いずれか1つ）**（xlsx 改訂履歴 2024-12-24、v3.9.0）。
つまり `ACTION_DATE` が空の対応履歴が存在しうる。日付窓による走査では取りこぼす。

宛先: `CAREER#CHARGE_EMAIL`（担当者メールアドレス、text、**必須かつ読み取り専用**）。
必須なので空にはならないはずだが、`CAREER#CHARGE_ID`（担当者）が未設定のときに何が入るかは未検証。

### 3.5 APIキーの操作許可リスト（PDF）

画像PDFのためレンダリングして目視確認。行（対象リソース）は以下の13。
列は **作成 / 読み取り / 更新 / 削除** の4つ。

求職者 / 求職者職歴 / 求職者対応履歴 / 企業 / 企業対応履歴 / 部署 / 求人 / 求職者候補 /
進捗 / ファイル / マスター / リソース定義 / ACES Meet（非公開）

**「進捗履歴」の独立した行はない。**進捗履歴のエンドポイントが「権限：進捗(読み取り)」を
要求することと整合する。

その他の設定項目:
- APIキー名（必須、最大20文字、重複不可）
- APIキーの利用方法（「CAREER PLUS の API で使用する」/「ACES Meet で使用する」の選択）
- IPアドレス制限（CIDR形式、複数指定可、単一または範囲。ACES Meet 利用時は指定不可）

### 3.6 CP からメールを送る唯一の口

`POST /v1/ext2/wrkcareer/`（求職者候補の登録）に **サンクスメール送信機能**がある
（`thanksMailFlg`、v2.0.1 で追加。CC/BCC/FROM/件名/本文は事前にベンダーへ連携が必要）。

ただしこれは「求職者候補を登録したときに候補者本人へ送る」ものであり、
要件4の「担当者へ送る」には使えない。**要件4のメール送信はアプリ側で行う。**
