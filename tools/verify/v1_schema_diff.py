"""V-1: オリつく項目が schema に現れるか。
項目一覧 xlsx（tools/docs_dump/out/xlsx/*.tsv）と実環境の schema を突き合わせる。
"""
import json
from pathlib import Path

import cpv

OUT = Path(__file__).resolve().parents[1] / "docs_dump" / "out" / "xlsx"
SCHEMA_DUMP = Path(__file__).resolve().parent / "out"
SCHEMA_DUMP.mkdir(exist_ok=True)

SHEETS = {
    "career": "求職者.tsv",
    "career_action": "求職者対応履歴.tsv",
    "progress": "進捗.tsv",
    "progress_history": "進捗詳細.tsv",
    "order": "求人.tsv",
    "client": "企業.tsv",
    "career_workexperience": "求職者職歴.tsv",
    "department": "部署.tsv",
    "wrkcareer": "求職者候補.tsv",
    "file": "ファイル.tsv",
}


def xlsx_item_ids(fname: str) -> set[str]:
    ids = set()
    for line in (OUT / fname).read_text(encoding="utf-8").splitlines():
        first = line.split("\t")[0].strip()
        if "#" in first:
            ids.add(first)
    return ids


token = cpv.get_token()
all_schema = {}

for resource, sheet in SHEETS.items():
    ok, res = cpv.safe(lambda r=resource: cpv.get(f"/v1/ext2/schema/{r}", token), f"schema/{resource}")
    if not ok:
        continue
    items = res["result"]["items"]
    all_schema[resource] = items
    live = {it["itemId"] for it in items}
    doc = xlsx_item_ids(sheet)

    only_live = sorted(live - doc)
    only_doc = sorted(doc - live)

    cpv.out(f"\n=== {resource} ===")
    cpv.out(f"  schema: {len(live)} 項目 / xlsx: {len(doc)} 項目")
    if only_live:
        cpv.out(f"  ▼ schema にのみ存在（オリつく項目の候補）: {len(only_live)}")
        by_id = {it["itemId"]: it for it in items}
        for iid in only_live:
            it = by_id[iid]
            vr = it.get("validationRule") or {}
            cpv.out(
                f"      {iid}"
                f"\n        label={it.get('label')!r} type={it.get('itemType')}"
                f" readOnly={it.get('isReadOnly')} notUpdatable={it.get('isNotUpdatable')}"
                f" sortable={it.get('isSortable')}"
                f"\n        validationRule={json.dumps(vr, ensure_ascii=False)}"
            )
    else:
        cpv.out("  ▼ schema にのみ存在する項目: なし")
    if only_doc:
        cpv.out(f"  ▲ xlsx にのみ存在（実環境で削除済み等）: {len(only_doc)}")
        for iid in only_doc:
            cpv.out(f"      {iid}")

cpv.out("\n\n=== ラベルに『国籍』を含む項目の全リソース横断検索 ===")
found = False
for resource, items in all_schema.items():
    for it in items:
        if "国籍" in (it.get("label") or ""):
            found = True
            vr = it.get("validationRule") or {}
            cpv.out(f"  {resource}: {it['itemId']}")
            cpv.out(f"    label={it.get('label')!r} type={it.get('itemType')}")
            cpv.out(f"    isReadOnly={it.get('isReadOnly')} isSortable={it.get('isSortable')}")
            cpv.out(f"    validationRule={json.dumps(vr, ensure_ascii=False)}")
if not found:
    cpv.out("  見つからず")

path = SCHEMA_DUMP / "schema_live.json"
path.write_text(json.dumps(all_schema, ensure_ascii=False, indent=2), encoding="utf-8")
cpv.out(f"\n  schema 全体を保存: {path}")

cpv.report("V-1 完了")
