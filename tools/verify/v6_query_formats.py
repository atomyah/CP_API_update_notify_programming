"""V-6: 検索クエリの形式。全ウォッチャーの前提になる。"""
import cpv

token = cpv.get_token()
ASUKA = "18"

cpv.out("=== V-6-1: datetime のレスポンス形式（仕様書は 'yyyy/MM/dd HH:mm'）===")
v = cpv.select("career", ASUKA, ["CAREER#UPDATE_DATE", "CAREER#INSERT_DATE", "CAREER#CNSL_DATE"], token)
for k, val in v.items():
    cpv.out(f"  {k:<22} = {val!r}")
cpv.out("  -> 実環境は ISO 8601 (秒あり)。仕様書の記載と異なる")

cpv.out("\n=== V-6-2: datetime の検索値としてどの形式が通るか ===")
formats = [
    "2026/08/05 00:00",
    "2026/08/05 00:00:00",
    "2026-08-05 00:00:00",
    "2026-08-05T00:00:00",
    "2026-08-05T00:00:00+09:00",
    "2026-08-05",
]
for f in formats:
    ok, res = cpv.safe(
        lambda f=f: cpv.search("career", token, condition=cpv.cond(cpv.item("CAREER#UPDATE_DATE", "GE", f)), limit=100),
        f"UPDATE_DATE GE {f}",
    )
    if ok:
        cpv.out(f"  {f:<30} -> OK   count={res['count']}")

cpv.out("\n=== V-6-3: 秒の精度が効いているか（境界テスト）===")
# アスカの UPDATE_DATE は 2026-08-05T15:20:48。秒が効くなら :48 と :49 で結果が変わる
for f, note in [
    ("2026-08-05T15:20:47", "48秒より前 → アスカを含むはず"),
    ("2026-08-05T15:20:48", "ちょうど → GE なので含むはず"),
    ("2026-08-05T15:20:49", "48秒より後 → アスカを含まないはず"),
]:
    ok, res = cpv.safe(
        lambda f=f: cpv.search("career", token, condition=cpv.cond(cpv.item("CAREER#UPDATE_DATE", "GE", f)), limit=100),
        f"boundary {f}",
    )
    if ok:
        cpv.out(f"  GE {f}  count={res['count']}  18を含む={'18' in res['ids']}   ({note})")

cpv.out("\n=== V-6-4: date の検索値形式 ===")
for f in ["2026/08/01", "2026-08-01"]:
    ok, res = cpv.safe(
        lambda f=f: cpv.search("career_action", token, condition=cpv.cond(cpv.item("CAREER_ACTION#ACTION_DATE", "GE", f)), limit=100),
        f"ACTION_DATE GE {f}",
    )
    if ok:
        cpv.out(f"  {f:<14} -> OK  count={res['count']}  ids={res['ids']}")

cpv.out("\n=== V-6-5: number 型の返り方 ===")
v = cpv.select("career", ASUKA, ["CAREER#CAREER_ID"], token)
val = v.get("CAREER#CAREER_ID")
cpv.out(f"  CAREER#CAREER_ID = {val!r}  (python type: {type(val).__name__})")

cpv.out("\n=== V-6-6: ネストした condition ===")
nested = {
    "compoundType": "and",
    "items": [
        {"itemId": "CAREER#UPDATE_DATE", "searchType": "GE", "value": "2026-01-01T00:00:00"},
        {"compoundType": "or", "items": [
            {"itemId": "CAREER#LASTNAME", "searchType": "EQ", "value": "惣流"},
            {"itemId": "CAREER#LASTNAME", "searchType": "EQ", "value": "葛城"},
        ]},
    ],
}
ok, res = cpv.safe(lambda: cpv.search("career", token, condition=nested, limit=100), "nested")
if ok:
    cpv.out(f"  OK  count={res['count']} ids={res['ids']}  (17 と 18 が出れば正しい)")

cpv.out("\n=== V-6-7: limit / offset / count の挙動 ===")
ok, res = cpv.safe(lambda: cpv.search("career", token, limit=100), "limit100")
if ok:
    cpv.out(f"  limit=100  -> count={res['count']} 返却ids数={len(res['ids'])} offset={res.get('offset')} limitキー={'limit' in res}")
ok, res = cpv.safe(lambda: cpv.search("career", token, limit=5, offset=0), "limit5 offset0")
if ok:
    cpv.out(f"  limit=5    -> count={res['count']} 返却ids数={len(res['ids'])}")
ok, res = cpv.safe(lambda: cpv.search("career", token, limit=101), "limit101")
if ok:
    cpv.out(f"  limit=101  -> OK  返却ids数={len(res['ids'])}  (最大100の記載に反して通るか)")

cpv.out("\n=== V-6-8: sort 未指定時に順序が安定するか ===")
runs = []
for i in range(2):
    ok, res = cpv.safe(lambda: cpv.search("career", token, limit=100), f"unsorted run{i}")
    if ok:
        runs.append(res["ids"])
if len(runs) == 2:
    cpv.out(f"  2回の ids が一致: {runs[0] == runs[1]}")
    cpv.out(f"  run1 先頭5: {runs[0][:5]}")
    cpv.out(f"  run2 先頭5: {runs[1][:5]}")

cpv.out("\n=== V-6-9: sort 指定時の順序 ===")
ok, res = cpv.safe(
    lambda: cpv.search("career", token, sort=[{"itemId": "CAREER#UPDATE_DATE", "order": "desc"}], limit=5),
    "sort desc",
)
if ok:
    cpv.out(f"  UPDATE_DATE desc 先頭5: {res['ids']}")

cpv.out("\n=== V-6-10: ENTERED / NOT_ENTERED に空文字 ===")
for st in ["ENTERED", "NOT_ENTERED"]:
    ok, res = cpv.safe(
        lambda st=st: cpv.search("career", token, condition=cpv.cond(cpv.item("CAREER#CNSL_DATE", st, "")), limit=1),
        st,
    )
    if ok:
        cpv.out(f"  CNSL_DATE {st:<12} -> OK count={res['count']}")

cpv.report("V-6 完了")
