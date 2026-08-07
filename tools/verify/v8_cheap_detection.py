"""要件4を「全件走査なし」で成立させられるかの検証。

狙い: 走査量を 総件数(3万) ではなく 直近の活動量(W) に比例させる。
検索は ID 集合しか返さないが、逆に言えば
「条件を変えた検索の ID 集合を比べる」だけで、select なしに値の変化を検知できる。
"""
import cpv

token = cpv.get_token()


def n(label, resource, condition=None, sort=None):
    try:
        res = cpv.search(resource, token, condition=condition, sort=sort, limit=100)
    except cpv.CpError as e:
        msg = e.body[:80].replace("\n", " ")
        cpv.out(f"  {label:<58} HTTP {e.status}  {msg}")
        return None
    cpv.out(f"  {label:<58} count={res['count']:<5} ids={res['ids'][:6]}")
    return res


cpv.out("=== 1) 関連リソース条件と自リソース条件を AND できるか ===")
cpv.out("   （宛先のある求職者の対応履歴だけに絞れれば、走査対象が減る）")
mixed = {
    "compoundType": "and",
    "items": [
        {"itemId": "CAREER#CHARGE_ID", "searchType": "ENTERED", "value": ""},
        {"itemId": "CAREER_ACTION#ACTION_DATE", "searchType": "GE", "value": "2026/08/01"},
    ],
}
n("CAREER#CHARGE_ID ENTERED AND ACTION_DATE GE 2026/08/01", "career_action", mixed)

cpv.out("\n=== 2) 宛先の有無で対応履歴を絞れるか（通知対象の母集団）===")
n("CAREER#CHARGE_ID ENTERED（担当者あり）", "career_action",
  cpv.cond(cpv.item("CAREER#CHARGE_ID", "ENTERED", "")))
n("CAREER#CHARGE_ID NOT_ENTERED（担当者なし＝通知不要）", "career_action",
  cpv.cond(cpv.item("CAREER#CHARGE_ID", "NOT_ENTERED", "")))
n("CAREER#CHARGE_EMAIL ENTERED", "career_action",
  cpv.cond(cpv.item("CAREER#CHARGE_EMAIL", "ENTERED", "")))

cpv.out("\n=== 3) 求職者の登録ステータスで絞れるか（抹消済みを除外）===")
for code, label in [("1", "仮登録"), ("2", "本登録"), ("5", "登録抹消")]:
    n(f"CAREER#REGSTATUS_ID EQ {code} ({label})", "career_action",
      cpv.cond(cpv.item("CAREER#REGSTATUS_ID", "EQ", code)))

cpv.out("\n=== 4) 未完了の対応履歴だけに絞れるか（作業中の集合）===")
n("COMPLETE_DATE NOT_ENTERED（未完了＝編集されうる）", "career_action",
  cpv.cond(cpv.item("CAREER_ACTION#COMPLETE_DATE", "NOT_ENTERED", "")))
n("COMPLETE_DATE ENTERED（完了済み）", "career_action",
  cpv.cond(cpv.item("CAREER_ACTION#COMPLETE_DATE", "ENTERED", "")))

cpv.out("\n=== 5) 日付を EQ でバケット化して『各レコードの日付』を select なしに知れるか ===")
cpv.out("   （日付が変わったレコードは、所属するバケットが変わる＝集合の差分で分かる）")
for d in ["2026/08/04", "2026/08/05", "2026/08/06", "2026/08/07"]:
    n(f"ACTION_DATE EQ {d}", "career_action",
      cpv.cond(cpv.item("CAREER_ACTION#ACTION_DATE", "EQ", d)))

cpv.out("\n=== 6) 低カーディナリティ項目もバケット化できるか ===")
cpv.out("   （アクション種別・担当者の変更を select なしに検知できるか）")
for code, label in [("1", "面談"), ("6", "メール"), ("7", "電話")]:
    n(f"ACTION_ID EQ {code} ({label})", "career_action",
      cpv.cond(cpv.item("CAREER_ACTION#ACTION_ID", "EQ", code)))
for code in ["7", "8"]:
    n(f"ACTIONCHARGE_ID EQ {code}", "career_action",
      cpv.cond(cpv.item("CAREER_ACTION#ACTIONCHARGE_ID", "EQ", code)))

cpv.out("\n=== 7) 本文（textarea）は検索で覗けるか ===")
cpv.out("   textarea は EQ 不可・LIKE のみ。ハッシュ代わりに使えるかを見る")
for kw in ["電話", "メール", "ありました"]:
    n(f"ACTIONMEMO LIKE '{kw}'", "career_action",
      cpv.cond(cpv.item("CAREER_ACTION#ACTIONMEMO", "LIKE", kw)))
n("ACTIONMEMO ENTERED", "career_action",
  cpv.cond(cpv.item("CAREER_ACTION#ACTIONMEMO", "ENTERED", "")))

cpv.out("\n=== 8) 要件2の進捗履歴も同様に絞れるか ===")
n("progress_history 全件", "progress_history")
n("INSERT_DATE GE 2026/08/05 00:00:00", "progress_history",
  cpv.cond(cpv.item("PROGRESS_HISTORY#INSERT_DATE", "GE", "2026/08/05 00:00:00")))

cpv.report("V-8 完了")
