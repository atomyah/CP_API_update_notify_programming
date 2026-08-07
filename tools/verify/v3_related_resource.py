"""V-3: career_action で関連リソース（求職者）の項目が使えるか。
要件4の戦略A（親のタイムスタンプで変更検知）が成立するかを決める。
"""
import cpv

token = cpv.get_token()
ACTION_ID = "6_0"   # 唯一の対応履歴
OWNER = "6"         # その求職者

cpv.out("=== V-3a: select の itemIds に CAREER#* を混ぜられるか ===")
ok, v = cpv.safe(
    lambda: cpv.select("career_action", ACTION_ID, [
        "CAREER_ACTION#CAREER_ID",
        "CAREER_ACTION#HISTSEQ",
        "CAREER_ACTION#ACTIONMEMO",
        "CAREER#LASTNAME",
        "CAREER#FIRSTNAME",
        "CAREER#CHARGE_EMAIL",
        "CAREER#UPDATE_DATE",
    ], token),
    "select with CAREER#*",
)
if ok:
    for k, val in v.items():
        cpv.out(f"  {k:<30} = {val!r}")
    got_career = [k for k in v if k.startswith("CAREER#")]
    cpv.out(f"\n  -> CAREER#* が返ったか: {bool(got_career)}  {got_career}")
    if got_career:
        cpv.out("  ★ 1リクエストで対応履歴の内容と宛先が同時に取れる")

cpv.out("\n=== V-3b: search の condition に CAREER#* を使えるか ===")
probes = [
    ("CAREER#UPDATE_DATE GE", cpv.cond(cpv.item("CAREER#UPDATE_DATE", "GE", "2026/01/01 00:00:00"))),
    ("CAREER#LASTNAME EQ", cpv.cond(cpv.item("CAREER#LASTNAME", "EQ", "惣流"))),
    ("CAREER#CHARGE_ID EQ", cpv.cond(cpv.item("CAREER#CHARGE_ID", "EQ", "7"))),
]
b_ok = False
for label, c in probes:
    ok, res = cpv.safe(
        lambda c=c: cpv.search("career_action", token, condition=c, limit=100),
        f"search {label}",
    )
    if ok:
        b_ok = True
        cpv.out(f"  {label:<26} -> OK  count={res['count']}  ids={res['ids']}")

cpv.out("\n=== V-3b2: 関連リソースの項目をソートキーにできるか ===")
ok, res = cpv.safe(
    lambda: cpv.search("career_action", token, sort=[{"itemId": "CAREER#UPDATE_DATE", "order": "desc"}], limit=5),
    "sort by CAREER#UPDATE_DATE",
)
if ok:
    cpv.out(f"  OK ids={res['ids']}")

cpv.out("\n=== V-3c 準備: 対応履歴の所有者 (career 6) の現在の UPDATE_DATE ===")
v = cpv.select("career", OWNER, ["CAREER#LASTNAME", "CAREER#FIRSTNAME", "CAREER#UPDATE_DATE"], token)
cpv.out(f"  career id={OWNER}  {v.get('CAREER#LASTNAME')} {v.get('CAREER#FIRSTNAME')}")
cpv.out(f"  CAREER#UPDATE_DATE = {v.get('CAREER#UPDATE_DATE')}")
cpv.out("\n  ※ V-3c（対応履歴を編集すると親の UPDATE_DATE が動くか）は")
cpv.out("     CP の画面操作が必要なため、別途手順を提示する")

cpv.out("\n=== 参考: 他リソースでも関連リソースが使えるか ===")
rel = [
    ("career_workexperience", "CAREER#LASTNAME", "EQ", "惣流"),
    ("order", "CLIENT#CLIENTNAME", "ENTERED", ""),
    ("department", "CLIENT#CLIENTNAME", "ENTERED", ""),
]
for resource, iid, st, val in rel:
    ok, res = cpv.safe(
        lambda r=resource, i=iid, s=st, v=val: cpv.search(r, token, condition=cpv.cond(cpv.item(i, s, v)), limit=5),
        f"{resource} / {iid}",
    )
    if ok:
        cpv.out(f"  {resource:<24} {iid:<22} -> OK count={res['count']}")

cpv.report("V-3 完了")
