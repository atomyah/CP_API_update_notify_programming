"""V-2 の確定確認: 「求人紹介OK → 新規登録」で作られた進捗履歴 21_2 の中身。"""
import cpv

token = cpv.get_token()

HIST_ITEMS = [
    "PROGRESS_HISTORY#PROGRESS_ID", "PROGRESS_HISTORY#PROGRESS_ID_SUB",
    "PROGRESS_HISTORY#INSERT_DATE", "PROGRESS_HISTORY#UPDATE_DATE",
    "PROGRESS_HISTORY#UPDATEUSER_ID",
    "PROGRESS_HISTORY#PROGRESS_STATUS_ID", "PROGRESS_HISTORY#PROGRESS_DATE",
    "PROGRESS_HISTORY#RELATED_DATE",
    "PROGRESS_HISTORY#CAREER_CHARGE_ID", "PROGRESS_HISTORY#CAREER_CHARGETEAM_ID",
    "PROGRESS_HISTORY#ORDER_CHARGE_ID", "PROGRESS_HISTORY#ORDER_CHARGETEAM_ID",
    "PROGRESS_HISTORY#IS_LAST_COUNT", "PROGRESS_HISTORY#PROGRESS_COUNTER_ID",
    "PROGRESS_HISTORY#COUNT_NUMBER", "PROGRESS_HISTORY#MEMO",
    "PROGRESS_HISTORY#ESTIMATED_SALES_AMOUNT",
    "PROGRESS_HISTORY#ESTIMATED_SALES_ACCURACY",
    "PROGRESS_HISTORY#ESTIMATED_SALES_MONTH",
    "PROGRESS_HISTORY#INTERVIEWGUIDEMAIL_FLG",
]

cpv.out("=== 進捗履歴 21_1（進捗の新規作成時）と 21_2（求人紹介OK）の比較 ===")
rows = {}
for hid in ("21_1", "21_2"):
    rows[hid] = cpv.select("progress_history", hid, HIST_ITEMS, token)

cpv.out(f"\n  {'項目':<44} {'21_1 (作成)':<24} {'21_2 (求人紹介OK)'}")
cpv.out("  " + "-" * 100)
for k in HIST_ITEMS:
    a, b = rows["21_1"].get(k), rows["21_2"].get(k)
    mark = " ★" if a != b else ""
    cpv.out(f"  {k:<44} {str(a):<24} {str(b)}{mark}")

cpv.out("\n=== 進捗 21 の現在の状態 ===")
p = cpv.select("progress", "21", [
    "PROGRESS#PROGRESS_ID", "PROGRESS#CAREER_ID", "PROGRESS#ORDER_ID",
    "PROGRESS#STATUS_ID", "PROGRESS#INSERT_DATE", "PROGRESS#UPDATE_DATE",
    "PROGRESS#LASTPROGRESS_ID_SUB", "PROGRESS#INTRODUCTION_DATE",
    "PROGRESS#RECRUITMENT_DATE", "PROGRESS#LASTPROGRESS_DATE",
    "PROGRESS#PROGRESS_CHARGE_ID", "PROGRESS#IS_LAST_COUNT",
    "PROGRESS#ESTIMATED_SALES_AMOUNT", "PROGRESS#ESTIMATED_SALES_ACCURACY",
    "PROGRESS#ESTIMATED_SALES_MONTH",
], token)
for k in sorted(p):
    cpv.out(f"  {k:<40} = {p[k]!r}")

cpv.out("\n=== ステータスのラベル確認 ===")
m = cpv.get("/v1/ext2/master/MST_PROGRESS_STATUS", token)["result"]["values"]
labels = {str(v.get("value", v.get("values"))): v.get("label") for v in m}
for code in ("16", "11"):
    cpv.out(f"  {code} = {labels.get(code)}")
cpv.out(f"\n  遷移: {labels.get('16')}({16}) -> {labels.get('11')}({11})")

cpv.out("\n=== 要件2/3 のウォッチャーが実際に拾えるか（本番と同じクエリ）===")
c = cpv.cond(cpv.item("PROGRESS_HISTORY#INSERT_DATE", "GE", "2026/08/05 16:20:00"))
res = cpv.search("progress_history", token, condition=c,
                 sort=[{"itemId": "PROGRESS_HISTORY#INSERT_DATE", "order": "asc"}], limit=100)
cpv.out(f"  INSERT_DATE GE 16:20:00 -> count={res['count']} ids={res['ids']}")
cpv.out("  -> このIDから progressId=21 / 枝番=2 を文字列分解で取得できる（API呼び出し不要）")

cpv.out("\n=== 通知本文に必要な情報を集めるコスト ===")
cpv.out("  1) progress_history/select/21_2   … ステータス・進捗日・担当")
cpv.out("  2) progress/select/21             … CAREER_ID / ORDER_ID")
cpv.out("  3) career/select/18               … 求職者名（resolver キャッシュ可）")
cpv.out("  4) order/select/6                 … 求人名・企業名（resolver キャッシュ可）")
o = cpv.select("order", "6", ["ORDER#ORDER_ID", "ORDER#POSITIONNAME", "ORDER#CLIENT_ID"], token)
cpv.out(f"\n  求人 6: {o}")

cpv.report("V-2 確定")
