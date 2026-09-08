"""V-1 続き: オリつく項目が検索条件・取得項目として実際に使えるか。
あわせて検証用求職者（式波アスカ / 葛城ミサト）の ID を特定する。
"""
import json
import re
from pathlib import Path

import cpv

SCHEMA = json.loads((Path(__file__).resolve().parent / "out" / "schema_live.json").read_text(encoding="utf-8"))
NUMERIC = re.compile(r"^[A-Z_]+#\d+$")

cpv.out("=== 数値IDの項目（オリつく項目の候補）を全リソースから列挙 ===")
custom = {}
for resource, items in SCHEMA.items():
    hits = [it for it in items if NUMERIC.match(it["itemId"])]
    if hits:
        custom[resource] = hits
        for it in hits:
            cpv.out(f"  {resource:<22} {it['itemId']:<20} label={it['label']!r} type={it['itemType']}")
if not custom:
    cpv.out("  なし")

token = cpv.get_token()

cpv.out("\n=== 検証用求職者の ID を特定 ===")
targets = {}
for lastname in ("式波", "葛城"):
    ok, res = cpv.safe(
        lambda ln=lastname: cpv.search("career", token, condition=cpv.eq("CAREER#LASTNAME", ln), limit=100),
        f"search {lastname}",
    )
    if ok:
        cpv.out(f"  姓「{lastname}」: count={res['count']} ids={res['ids']}")
        for i in res["ids"]:
            targets[i] = lastname

if not targets:
    cpv.out("  見つからないため、全件から名前を引く")
    ok, res = cpv.safe(lambda: cpv.search("career", token, limit=100), "career/search all")
    if ok:
        for cid in res["ids"][:20]:
            v = cpv.select("career", cid, ["CAREER#LASTNAME", "CAREER#FIRSTNAME"], token)
            cpv.out(f"    id={cid}  {v.get('CAREER#LASTNAME')} {v.get('CAREER#FIRSTNAME')}")

ITEMS = [
    "CAREER#CAREER_ID", "CAREER#LASTNAME", "CAREER#FIRSTNAME",
    "CAREER#48002",                      # オリつく項目「国籍」
    "CAREER#CHARGE_ID", "CAREER#CHARGE_EMAIL",
    "CAREER#UPDATE_DATE", "CAREER#INSERT_DATE",
    "CAREER#REGSTATUS_ID", "CAREER#CNSLSTATUS_ID", "CAREER#WKSTATUS_ID",
    "CAREER#RANK_ID", "CAREER#MYPAGE_STATUS", "CAREER#CHARGETEAM_ID",
]

cpv.out("\n=== V-1-4a: オリつく項目を含む select ===")
for cid in targets:
    ok, vals = cpv.safe(lambda c=cid: cpv.select("career", c, ITEMS, token), f"select {cid}")
    if ok:
        cpv.out(f"\n  --- career id={cid} ---")
        for k in ITEMS:
            cpv.out(f"    {k:<26} = {vals.get(k)!r}")
        missing = [k for k in ITEMS if k not in vals]
        if missing:
            cpv.out(f"    ※ レスポンスに含まれなかった項目: {missing}")

cpv.out("\n=== V-1-4b: オリつく項目を検索条件に使えるか ===")
probes = [
    ("ENTERED", cpv.cond(cpv.item("CAREER#48002", "ENTERED", ""))),
    ("NOT_ENTERED", cpv.cond(cpv.item("CAREER#48002", "NOT_ENTERED", ""))),
    ("LIKE 日本", cpv.cond(cpv.item("CAREER#48002", "LIKE", "日本"))),
]
for label, c in probes:
    ok, res = cpv.safe(lambda c=c: cpv.search("career", token, condition=c, limit=100), f"48002 {label}")
    if ok:
        cpv.out(f"  {label:<14} -> OK  count={res['count']}  ids={res['ids'][:10]}")

cpv.out("\n=== V-1-4c: オリつく項目をソートキーにできるか ===")
ok, res = cpv.safe(
    lambda: cpv.search("career", token, sort=[{"itemId": "CAREER#48002", "order": "desc"}], limit=5),
    "sort by 48002",
)
if ok:
    cpv.out(f"  OK  ids={res['ids']}")

cpv.report("V-1b 完了")
