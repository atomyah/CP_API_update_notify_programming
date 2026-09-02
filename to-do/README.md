# GAS 移植 作業フェーズ

Python 版（`app/`）を Google Apps Script へ移植するための作業単位。
**「Phase1 を実装して」と指示すれば、そのファイルだけを読んで着手できる**ように書いてある。

| Phase | 内容 | 依存 | 状態 |
|---|---|---|---|
| [Phase1](Phase1.md) | 共通基盤（設定・時刻・流量制御・認可・HTTPクライアント） | なし | ⬜ 未着手 |
| [Phase2](Phase2.md) | 状態管理と実行基盤（シート・Properties・ロック・コミット点） | Phase1 | ⬜ 未着手 |
| [Phase3](Phase3.md) | 要件1 `career_status` ＋ Slack 通知 | Phase2 | ⬜ 未着手 |
| [Phase4](Phase4.md) | 要件2/3 `progress_flow` | Phase3 | ⬜ 未着手 |
| [Phase5](Phase5.md) | 運用（トリガー本設定・日次サマリ・通し確認） | Phase4 | ⬜ 未着手 |
| [Phase6](Phase6.md) | 要件4 `career_action_watch` ＋ メール送信 | Phase2 | ⬜ 条件付き |

## 進め方の原則

- **順番に進める。**Phase3 以降は前の Phase の完了条件が満たされていることが前提。
  Phase6 だけは Phase2 の後ならいつでも着手できるが、前提確認（6章）が先。
- **各 Phase の「完了条件」を満たさずに次へ進まない。**
  特に Phase1・Phase2 は全機能が乗る土台なので、ここが緩いと後で全部やり直しになる。
- **仕様書（`docs/CP進捗通知_システム仕様書.md`）が唯一の根拠。**
  GAS 固有の差分は 11章。1〜10章は特記なき限りそのまま適用される。
- 各 Phase の「やらないこと」を守る。先回りして実装しない。

## 全 Phase 共通の制約（毎回確認すること）

1. **CP API は 1分間に 240 リクエストを超えない。**全 HTTP 呼び出しが単一のトークンバケットを通る。
   （`rules/20-rate-limit.md`。これが最重要制約）
2. **CP に書き戻さない。**読み取り専用。
3. **秘密情報を `gas/src/` に置かない。**API キーと Slack Webhook URL は
   スクリプトプロパティに手で設定する（`rules/40-secrets-and-security.md`）。
4. **Apps Script のエディタで直接編集しない。**`clasp push` が唯一の反映経路。
5. 個人情報をログに出さない。項目 ID とリソース ID のみ。
