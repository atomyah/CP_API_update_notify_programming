"""戦略B の検知方式を詰める。
全ID走査で新規・完了を取りこぼしなく検知できるか（日付窓に頼らない方式）を確認する。
"""
import cpv

token = cpv.get_token()

cpv.out("=== 1) 複数キーのソートが使えるか（安定ページングに必要）===")
sorts = [
    ("CAREER_ID asc のみ", [{"itemId": "CAREER_ACTION#CAREER_ID", "order": "asc"}]),
    ("CAREER_ID asc + HISTSEQ asc", [
        {"itemId": "CAREER_ACTION#CAREER_ID", "order": "asc"},
        {"itemId": "CAREER_ACTION#HISTSEQ", "order": "asc"},
    ]),
]
for label, s in sorts:
    ok, res = cpv.safe(lambda s=s: cpv.search("career_action", token, sort=s, limit=100), label)
    if ok:
        cpv.out(f"  {label:<30} -> OK  ids={res['ids']}")

cpv.out("\n=== 2) 全件走査（条件なし）で全 ID が取れるか ===")
ok, res = cpv.safe(lambda: cpv.search("career_action", token, limit=100), "all ids")
if ok:
    cpv.out(f"  count={res['count']}  ids={res['ids']}")
    cpv.out(f"  -> 必要なページ数 = ceil({res['count']}/100) = {-(-res['count'] // 100)}")

cpv.out("\n=== 3) 完了検知: COMPLETE_DATE ENTERED の ID 集合 ===")
for st in ["ENTERED", "NOT_ENTERED"]:
    ok, res = cpv.safe(
        lambda st=st: cpv.search("career_action", token,
                                 condition=cpv.cond(cpv.item("CAREER_ACTION#COMPLETE_DATE", st, "")),
                                 limit=100),
        f"COMPLETE_DATE {st}",
    )
    if ok:
        cpv.out(f"  COMPLETE_DATE {st:<12} -> count={res['count']}  ids={res['ids']}")

cpv.out("\n=== 4) 日付窓の挙動（未来日の対応日が含まれるか）===")
# 18_0 は ACTION_DATE=2026-08-06（未来）、6_0 は 2026-08-05
for f in ["2026/08/02", "2026/08/05", "2026/08/06", "2026/08/07"]:
    ok, res = cpv.safe(
        lambda f=f: cpv.search("career_action", token,
                               condition=cpv.cond(cpv.item("CAREER_ACTION#ACTION_DATE", "GE", f)),
                               limit=100),
        f"ACTION_DATE GE {f}",
    )
    if ok:
        cpv.out(f"  ACTION_DATE GE {f} -> count={res['count']}  ids={res['ids']}")

cpv.out("\n=== 5) 窓の和集合に使える他の日付項目 ===")
for iid, val in [
    ("CAREER_ACTION#COMPLETE_DATE", "2026/08/02"),
    ("CAREER_ACTION#NEXTACTION_DATE", "2026/08/02 00:00:00"),
]:
    ok, res = cpv.safe(
        lambda i=iid, v=val: cpv.search("career_action", token,
                                        condition=cpv.cond(cpv.item(i, "GE", v)), limit=100),
        f"{iid} GE",
    )
    if ok:
        cpv.out(f"  {iid:<32} GE {val:<22} -> count={res['count']} ids={res['ids']}")

cpv.out("\n=== 6) OR で窓の和集合を1リクエストにまとめられるか ===")
union = {
    "compoundType": "or",
    "items": [
        {"itemId": "CAREER_ACTION#ACTION_DATE", "searchType": "GE", "value": "2026/08/02"},
        {"itemId": "CAREER_ACTION#COMPLETE_DATE", "searchType": "GE", "value": "2026/08/02"},
        {"itemId": "CAREER_ACTION#NEXTACTION_DATE", "searchType": "GE", "value": "2026/08/02 00:00:00"},
    ],
}
ok, res = cpv.safe(lambda: cpv.search("career_action", token, condition=union, limit=100), "OR union")
if ok:
    cpv.out(f"  OK  count={res['count']} ids={res['ids']}")
    cpv.out("  -> 1リクエストで3つの日付窓の和集合が取れる")

cpv.out("\n=== 7) 対応日が未入力の対応履歴を拾えるか（窓走査の穴）===")
穴 = {
    "compoundType": "and",
    "items": [
        {"itemId": "CAREER_ACTION#ACTION_DATE", "searchType": "NOT_ENTERED", "value": ""},
    ],
}
ok, res = cpv.safe(lambda: cpv.search("career_action", token, condition=穴, limit=100), "ACTION_DATE NOT_ENTERED")
if ok:
    cpv.out(f"  対応日が未入力: count={res['count']} ids={res['ids']}")

cpv.out("\n=== 8) 進捗履歴も同様に確認（要件2の全件走査コスト）===")
ok, res = cpv.safe(
    lambda: cpv.search("progress_history", token,
                       condition=cpv.cond(cpv.item("PROGRESS_HISTORY#INSERT_DATE", "GE", "2026/08/05 16:00:00")),
                       sort=[{"itemId": "PROGRESS_HISTORY#INSERT_DATE", "order": "asc"}], limit=100),
    "progress_history INSERT_DATE GE",
)
if ok:
    cpv.out(f"  16:00 以降に追加された進捗履歴: count={res['count']} ids={res['ids']}")
    cpv.out("  -> 要件2 は INSERT_DATE GE で新規作成も遷移も同じ経路で拾える")

cpv.report("V-3e 完了")
