"""V-4: マスタの実データ / V-7: 規模の実測。
あわせて直前の書き込み権限プローブでデータが作られていないことを確認する。
"""
import json
from pathlib import Path

import cpv

token = cpv.get_token()
OUT = Path(__file__).resolve().parent / "out"
OUT.mkdir(exist_ok=True)

cpv.out("=== 書き込みプローブでデータが増えていないことの確認 ===")
for r, expected in [("progress", 14), ("progress_history", 25), ("career", 18), ("career_action", 1)]:
    res = cpv.search(r, token, limit=1)
    mark = "OK" if res["count"] == expected else "!! 件数が変化している"
    cpv.out(f"  {r:<20} count={res['count']:<4} (検証開始時 {expected})  {mark}")

cpv.out("\n=== V-4: マスタ一覧 ===")
masters = cpv.get("/v1/ext2/master/list", token)["result"]["codeMaster"]
cpv.out(f"  マスタ数: {len(masters)}")

WANT = [
    "MST_PROGRESS_STATUS", "MSTUSER", "MSTTEAM", "MSTACTION",
    "MSTREGSTATUS", "MSTCNSLSTATUS", "MSTWKSTATUS", "MSTCONRANK",
    "MSTMYPAGECHK", "MSTPARTNERCOUNTRY",
    "MSTACTION_CHOICE1", "MSTACTION_CHOICE2", "MSTACTION_CHOICE3",
]
available = {m["name"] for m in masters}
cpv.out("\n  項目一覧の『参照マスタ』列に出てくる名前が実在するか:")
for w in WANT:
    cpv.out(f"    {w:<24} {'存在する' if w in available else '★ 存在しない'}")

cpv.out("\n=== V-4: 進捗ステータスマスタ（要件2のフロー定義）===")
dumped = {}
for name in ["MST_PROGRESS_STATUS", "MSTACTION", "MSTUSER", "MSTREGSTATUS", "MSTCNSLSTATUS", "MSTWKSTATUS", "MSTCONRANK"]:
    if name not in available:
        continue
    ok, res = cpv.safe(lambda n=name: cpv.get(f"/v1/ext2/master/{n}", token), f"master/{name}")
    if not ok:
        continue
    r = res["result"]
    values = r.get("values", [])
    dumped[name] = r
    cpv.out(f"\n  --- {name} ({r.get('codeLabel')}) : {len(values)} 件 ---")
    if name in ("MST_PROGRESS_STATUS", "MSTACTION", "MSTREGSTATUS", "MSTCNSLSTATUS", "MSTWKSTATUS", "MSTCONRANK"):
        for v in values:
            code = v.get("value", v.get("values"))
            cpv.out(f"      {str(code):>5} : {v.get('label')}")
    else:
        cpv.out(f"      （{len(values)} 件のため一覧は省略。JSON に保存）")

(OUT / "masters.json").write_text(json.dumps(dumped, ensure_ascii=False, indent=2), encoding="utf-8")
cpv.out(f"\n  マスタを保存: {OUT / 'masters.json'}")

cpv.out("\n=== V-7: 規模の実測 ===")
scale = [
    ("求職者 総数", "career", None),
    ("求職者 直近7日の更新", "career", cpv.cond(cpv.item("CAREER#UPDATE_DATE", "GE", "2026/07/29 00:00:00"))),
    ("求職者 直近30日の更新", "career", cpv.cond(cpv.item("CAREER#UPDATE_DATE", "GE", "2026/07/06 00:00:00"))),
    ("進捗 総数", "progress", None),
    ("進捗履歴 総数", "progress_history", None),
    ("進捗履歴 直近7日の追加", "progress_history", cpv.cond(cpv.item("PROGRESS_HISTORY#INSERT_DATE", "GE", "2026/07/29 00:00:00"))),
    ("進捗履歴 直近30日の追加", "progress_history", cpv.cond(cpv.item("PROGRESS_HISTORY#INSERT_DATE", "GE", "2026/07/06 00:00:00"))),
    ("対応履歴 総数", "career_action", None),
    ("対応履歴 対応日が未入力", "career_action", cpv.cond(cpv.item("CAREER_ACTION#ACTION_DATE", "NOT_ENTERED", ""))),
    ("対応履歴 完了日が入力済み", "career_action", cpv.cond(cpv.item("CAREER_ACTION#COMPLETE_DATE", "ENTERED", ""))),
    ("求人 総数", "order", None),
    ("企業 総数", "client", None),
]
for label, resource, c in scale:
    ok, res = cpv.safe(lambda r=resource, c=c: cpv.search(r, token, condition=c, limit=1), label)
    if ok:
        cpv.out(f"  {label:<28} = {res['count']}")

cpv.out("\n=== 要件1の対象（惣流アスカ）を絞る条件の確認 ===")
c = cpv.cond(cpv.item("CAREER#CAREER_ID", "EQ", "18"))
ok, res = cpv.safe(lambda: cpv.search("career", token, condition=c, limit=10), "target asuka")
if ok:
    cpv.out(f"  CAREER#CAREER_ID EQ 18  -> count={res['count']} ids={res['ids']}")
c2 = {
    "compoundType": "and",
    "items": [
        {"itemId": "CAREER#CAREER_ID", "searchType": "EQ", "value": "18"},
        {"itemId": "CAREER#UPDATE_DATE", "searchType": "GE", "value": "2026/01/01 00:00:00"},
    ],
}
ok, res = cpv.safe(lambda: cpv.search("career", token, condition=c2, limit=10), "target asuka + updated")
if ok:
    cpv.out(f"  上記 + UPDATE_DATE GE   -> count={res['count']} ids={res['ids']}  (要件1の実クエリ形)")

cpv.report("V-4 / V-7 完了")
