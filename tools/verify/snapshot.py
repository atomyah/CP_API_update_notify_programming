"""V-2 / V-3c 用のスナップショット取得＆差分表示。

  py -3 snapshot.py before     … 画面操作の前に実行
  （CP の画面で操作する）
  py -3 snapshot.py after      … 画面操作の後に実行
  py -3 snapshot.py diff       … before と after を比較して差分を出す
"""
import json
import sys
from pathlib import Path

import cpv

OUT = Path(__file__).resolve().parent / "out"
OUT.mkdir(exist_ok=True)

WATCH_CAREERS = ["17", "18", "6"]   # ミサト / アスカ / 牛嶋(唯一の対応履歴の所有者)
RESOURCES = ["career", "career_action", "progress", "progress_history", "wrkcareer", "file", "order", "client"]

PROGRESS_ITEMS = [
    "PROGRESS#PROGRESS_ID", "PROGRESS#CAREER_ID", "PROGRESS#ORDER_ID", "PROGRESS#STATUS_ID",
    "PROGRESS#INSERT_DATE", "PROGRESS#UPDATE_DATE", "PROGRESS#INTRODUCTION_DATE",
    "PROGRESS#LASTPROGRESS_ID_SUB", "PROGRESS#PROGRESS_CHARGE_ID",
]


def take() -> dict:
    token = cpv.get_token()
    schema = json.loads((OUT / "schema_live.json").read_text(encoding="utf-8"))
    career_items = [it["itemId"] for it in schema["career"]]

    snap: dict = {"counts": {}, "ids": {}, "careers": {}, "progress": {}}

    for r in RESOURCES:
        res = cpv.search(r, token, limit=100, sort=None)
        snap["counts"][r] = res["count"]
        snap["ids"][r] = sorted(res["ids"], key=str)

    for cid in WATCH_CAREERS:
        # 232項目を一度に要求すると重いので分割
        vals = {}
        for i in range(0, len(career_items), 60):
            vals.update(cpv.select("career", cid, career_items[i:i + 60], token))
        snap["careers"][cid] = vals

    for pid in snap["ids"].get("progress", []):
        snap["progress"][pid] = cpv.select("progress", pid, PROGRESS_ITEMS, token)

    return snap


def show(snap: dict, label: str) -> None:
    cpv.out(f"\n--- {label} ---")
    for r, c in snap["counts"].items():
        cpv.out(f"  {r:<20} count={c}")


def diff(a: dict, b: dict) -> None:
    cpv.out("\n================ 差分 ================")

    cpv.out("\n[1] 件数の変化")
    changed = False
    for r in a["counts"]:
        if a["counts"][r] != b["counts"][r]:
            changed = True
            cpv.out(f"  ★ {r:<20} {a['counts'][r]} -> {b['counts'][r]}")
    if not changed:
        cpv.out("  どのリソースも件数は変化していない")

    cpv.out("\n[2] 新しく現れた ID")
    any_new = False
    for r in a["ids"]:
        new = [i for i in b["ids"][r] if i not in set(a["ids"][r])]
        gone = [i for i in a["ids"][r] if i not in set(b["ids"][r])]
        if new:
            any_new = True
            cpv.out(f"  ★ {r}: 追加 {new}")
        if gone:
            cpv.out(f"  ★ {r}: 消失 {gone}")
    if not any_new:
        cpv.out("  新しい ID なし")

    cpv.out("\n[3] 求職者レコードの項目変化")
    for cid in a["careers"]:
        av, bv = a["careers"][cid], b["careers"][cid]
        keys = sorted(set(av) | set(bv))
        rows = [(k, av.get(k), bv.get(k)) for k in keys if av.get(k) != bv.get(k)]
        if rows:
            cpv.out(f"  ★ career id={cid}")
            for k, x, y in rows:
                cpv.out(f"      {k:<32} {x!r} -> {y!r}")
        else:
            cpv.out(f"    career id={cid}: 変化なし")

    cpv.out("\n[4] 進捗レコードの変化")
    for pid in sorted(set(a["progress"]) | set(b["progress"]), key=str):
        av, bv = a["progress"].get(pid), b["progress"].get(pid)
        if av is None:
            cpv.out(f"  ★ 新規進捗 id={pid}")
            for k, v in (bv or {}).items():
                cpv.out(f"      {k:<34} = {v!r}")
        elif bv is None:
            cpv.out(f"  ★ 消えた進捗 id={pid}")
        else:
            rows = [(k, av.get(k), bv.get(k)) for k in sorted(set(av) | set(bv)) if av.get(k) != bv.get(k)]
            if rows:
                cpv.out(f"  ★ 進捗 id={pid} の変化")
                for k, x, y in rows:
                    cpv.out(f"      {k:<34} {x!r} -> {y!r}")


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "before"

    if mode in ("before", "after"):
        snap = take()
        path = OUT / f"snapshot_{mode}.json"
        path.write_text(json.dumps(snap, ensure_ascii=False, indent=2), encoding="utf-8")
        show(snap, mode)
        cpv.out(f"\n  保存: {path}")
        cpv.report(f"snapshot {mode}")
    elif mode == "diff":
        a = json.loads((OUT / "snapshot_before.json").read_text(encoding="utf-8"))
        b = json.loads((OUT / "snapshot_after.json").read_text(encoding="utf-8"))
        show(a, "before")
        show(b, "after")
        diff(a, b)
    else:
        raise SystemExit("使い方: py -3 snapshot.py [before|after|diff]")


if __name__ == "__main__":
    main()
