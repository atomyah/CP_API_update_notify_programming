"""V-6 続き: 正しい形式 (YYYY/MM/DD HH:MM:SS) で秒精度とネスト条件を確認。"""
import cpv

token = cpv.get_token()

cpv.out("=== 対象レコードの UPDATE_DATE ===")
for cid in ("17", "18"):
    v = cpv.select("career", cid, ["CAREER#LASTNAME", "CAREER#UPDATE_DATE"], token)
    cpv.out(f"  id={cid} {v['CAREER#LASTNAME']}  UPDATE_DATE={v['CAREER#UPDATE_DATE']}")

cpv.out("\n=== V-6-3(再): 秒精度の境界テスト ===")
# アスカ(18) = 2026-08-05T15:20:48 / ミサト(17) = 2026-08-05T15:16:43
cases = [
    ("2026/08/05 15:20:47", "18 を含むはず"),
    ("2026/08/05 15:20:48", "GE なので 18 を含むはず"),
    ("2026/08/05 15:20:49", "18 を含まないはず"),
    ("2026/08/05 15:16:43", "17 と 18 を含むはず"),
    ("2026/08/05 15:16:44", "17 を含まないはず"),
]
for f, note in cases:
    ok, res = cpv.safe(
        lambda f=f: cpv.search("career", token, condition=cpv.cond(cpv.item("CAREER#UPDATE_DATE", "GE", f)), limit=100),
        f"GE {f}",
    )
    if ok:
        cpv.out(f"  GE {f}  count={res['count']:>2}  17={'17' in res['ids']}  18={'18' in res['ids']}   ({note})")

cpv.out("\n=== V-6-2(補): datetime に日付のみ (YYYY/MM/DD) を渡した場合 ===")
for f in ["2026/08/05", "2026/08/06"]:
    ok, res = cpv.safe(
        lambda f=f: cpv.search("career", token, condition=cpv.cond(cpv.item("CAREER#UPDATE_DATE", "GE", f)), limit=100),
        f"GE {f}",
    )
    if ok:
        cpv.out(f"  GE {f}  count={res['count']}  -> 00:00:00 として扱われるか確認")

cpv.out("\n=== V-6-6(再): ネストした condition ===")
nested = {
    "compoundType": "and",
    "items": [
        {"itemId": "CAREER#UPDATE_DATE", "searchType": "GE", "value": "2026/01/01 00:00:00"},
        {"compoundType": "or", "items": [
            {"itemId": "CAREER#LASTNAME", "searchType": "EQ", "value": "惣流"},
            {"itemId": "CAREER#LASTNAME", "searchType": "EQ", "value": "葛城"},
        ]},
    ],
}
ok, res = cpv.safe(lambda: cpv.search("career", token, condition=nested, limit=100), "nested")
if ok:
    cpv.out(f"  OK  count={res['count']} ids={res['ids']}  (17,18 なら正しい)")

cpv.out("\n=== V-6-11: オリつく項目 + 日時の複合条件（要件1の実クエリ形）===")
c = {
    "compoundType": "and",
    "items": [
        {"itemId": "CAREER#UPDATE_DATE", "searchType": "GE", "value": "2026/01/01 00:00:00"},
        {"itemId": "CAREER#48002", "searchType": "ENTERED", "value": ""},
    ],
}
ok, res = cpv.safe(lambda: cpv.search("career", token, condition=c, limit=100), "custom+datetime")
if ok:
    cpv.out(f"  OK  count={res['count']} ids={res['ids']}")

cpv.out("\n=== V-6-12: 唯一の対応履歴 (id=6_0) の中身 ===")
ok, v = cpv.safe(
    lambda: cpv.select("career_action", "6_0", [
        "CAREER_ACTION#CAREER_ID", "CAREER_ACTION#HISTSEQ",
        "CAREER_ACTION#ACTION_DATE", "CAREER_ACTION#ACTION_ID",
        "CAREER_ACTION#ACTIONCHARGE_ID", "CAREER_ACTION#ACTIONMEMO",
        "CAREER_ACTION#COMPLETE_DATE", "CAREER_ACTION#NEXTACTION_DATE",
    ], token),
    "career_action/select 6_0",
)
if ok:
    for k, val in v.items():
        cpv.out(f"  {k:<34} = {val!r}")
    cpv.out("  ※ ID が '6_0' なので HISTSEQ は 0 始まり（1 始まりではない）")

cpv.report("V-6b 完了")
