"""「再面談（社内確認中へ）」で進捗履歴が追加されるか削除されるかを確認する（B-14）。"""
import cpv

token = cpv.get_token()

cpv.out("=== 進捗 21 に紐づく進捗履歴の一覧 ===")
res = cpv.search("progress_history", token,
                 condition=cpv.eq("PROGRESS_HISTORY#PROGRESS_ID", "21"),
                 sort=[{"itemId": "PROGRESS_HISTORY#PROGRESS_ID_SUB", "order": "asc"}],
                 limit=100)
cpv.out(f"  count={res['count']}  ids={res['ids']}")
cpv.out("  （操作A 直後は 21_1, 21_2 の 2件だった）")

labels = {}
m = cpv.get("/v1/ext2/master/MST_PROGRESS_STATUS", token)["result"]["values"]
for v in m:
    labels[str(v.get("value", v.get("values")))] = v.get("label")

cpv.out("\n=== 各履歴の中身 ===")
for hid in res["ids"]:
    h = cpv.select("progress_history", hid, [
        "PROGRESS_HISTORY#PROGRESS_ID_SUB", "PROGRESS_HISTORY#PROGRESS_STATUS_ID",
        "PROGRESS_HISTORY#INSERT_DATE", "PROGRESS_HISTORY#UPDATE_DATE",
        "PROGRESS_HISTORY#RELATED_DATE", "PROGRESS_HISTORY#IS_LAST_COUNT",
    ], token)
    st = str(h.get("PROGRESS_HISTORY#PROGRESS_STATUS_ID"))
    cpv.out(f"\n  {hid}")
    cpv.out(f"    枝番        = {h.get('PROGRESS_HISTORY#PROGRESS_ID_SUB')}")
    cpv.out(f"    ステータス   = {st} ({labels.get(st)})")
    cpv.out(f"    INSERT_DATE = {h.get('PROGRESS_HISTORY#INSERT_DATE')}")
    cpv.out(f"    UPDATE_DATE = {h.get('PROGRESS_HISTORY#UPDATE_DATE')}")
    cpv.out(f"    RELATED_DATE= {h.get('PROGRESS_HISTORY#RELATED_DATE')}")
    cpv.out(f"    最終フラグ   = {h.get('PROGRESS_HISTORY#IS_LAST_COUNT')}")

cpv.out("\n=== 進捗 21 の現在の状態 ===")
p = cpv.select("progress", "21", [
    "PROGRESS#STATUS_ID", "PROGRESS#UPDATE_DATE",
    "PROGRESS#LASTPROGRESS_ID_SUB", "PROGRESS#LASTPROGRESS_DATE",
], token)
st = str(p.get("PROGRESS#STATUS_ID"))
cpv.out(f"  STATUS_ID           = {st} ({labels.get(st)})")
cpv.out(f"  UPDATE_DATE         = {p.get('PROGRESS#UPDATE_DATE')}")
cpv.out(f"  LASTPROGRESS_ID_SUB = {p.get('PROGRESS#LASTPROGRESS_ID_SUB')}")

cpv.out("\n=== 全体の件数 ===")
for r, before in [("progress_history", 27), ("progress", 15), ("career_action", 2)]:
    c = cpv.search(r, token, limit=1)["count"]
    cpv.out(f"  {r:<20} {c}  (操作A 直後は {before})")

cpv.out("\n=== 判定 ===")
if res["count"] >= 3:
    cpv.out("  ★ 履歴が【追加】された → 後戻りも INSERT_DATE GE で検知できる")
elif res["count"] == 2:
    cpv.out("  ★ 履歴の件数が変わっていない → 21_2 が【更新】された可能性")
else:
    cpv.out("  ★ 履歴が【削除】された → 後戻りは検知できない")

cpv.report("B-14 確認")
