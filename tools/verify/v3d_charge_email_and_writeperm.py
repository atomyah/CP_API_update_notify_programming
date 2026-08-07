"""V-3 続き:
 (1) CAREER#CHARGE_EMAIL が空になりうるか（要件4の宛先の信頼性）
 (2) APIキーに書き込み権限が付いていないかの確認（意図的に不正なボディで 403/400 を判別）
     ※ 実際のデータは作らない。DELETE は一切試さない。
"""
import cpv

token = cpv.get_token()

cpv.out("=== (1) 全求職者の担当者と担当者メールアドレス ===")
res = cpv.search("career", token, limit=100, sort=[{"itemId": "CAREER#CAREER_ID", "order": "asc"}])
cpv.out(f"  求職者総数: {res['count']}")
blank = []
for cid in res["ids"]:
    v = cpv.select("career", cid, [
        "CAREER#LASTNAME", "CAREER#FIRSTNAME", "CAREER#CHARGE_ID", "CAREER#CHARGE_EMAIL",
    ], token)
    name = f"{v.get('CAREER#LASTNAME') or ''} {v.get('CAREER#FIRSTNAME') or ''}".strip()
    charge = v.get("CAREER#CHARGE_ID")
    email = v.get("CAREER#CHARGE_EMAIL")
    mark = "" if email else "   <-- 宛先なし"
    cpv.out(f"  id={cid:<3} {name:<12} CHARGE_ID={str(charge):<6} CHARGE_EMAIL={str(email):<28}{mark}")
    if not email:
        blank.append((cid, name, charge))

cpv.out(f"\n  担当者メールアドレスが空の求職者: {len(blank)} / {res['count']}")
if blank:
    cpv.out("  ★ xlsx では『必須』表記だが実際には空になりうる。要件4は宛先なしを必ず処理すること")

cpv.out("\n=== (2) APIキーの書き込み権限の確認 ===")
cpv.out("  不正な itemId を含むボディを送り、403(権限なし) と 400(権限あり・内容不正) を判別する")
BAD = {"items": [{"itemId": "CAREER_ACTION#__NO_SUCH_ITEM__", "value": "x"}]}

probes = [
    ("POST /v1/ext2/career_action/  (登録)", "POST", "/v1/ext2/career_action/", {"careerId": "6", **BAD}),
    ("PUT  /v1/ext2/career_action/6_0 (更新)", "PUT", "/v1/ext2/career_action/6_0", BAD),
    ("POST /v1/ext2/career/       (登録)", "POST", "/v1/ext2/career/", {"items": [{"itemId": "CAREER#__NO_SUCH__", "value": "x"}]}),
    ("PUT  /v1/ext2/career/18     (更新)", "PUT", "/v1/ext2/career/18", {"items": [{"itemId": "CAREER#__NO_SUCH__", "value": "x"}]}),
    ("POST /v1/ext2/progress/     (登録)", "POST", "/v1/ext2/progress/", {"careerId": "18", "orderId": "1", "progressDate": "9999/99/99"}),
]
for label, method, path, body in probes:
    try:
        cpv._request(method, path, body, token)
        cpv.out(f"  {label:<40} -> 200 !!  想定外。データが作られた可能性あり。要確認")
    except cpv.CpError as e:
        verdict = {
            403: "権限なし（期待どおり）",
            400: "★ 権限あり（内容が不正なだけ）。読み取り専用になっていない",
        }.get(e.status, "その他")
        cpv.out(f"  {label:<40} -> HTTP {e.status}  {verdict}")

cpv.out("\n=== (3) 対応履歴の所有者 career 6 の状況 ===")
v = cpv.select("career", "6", [
    "CAREER#LASTNAME", "CAREER#FIRSTNAME", "CAREER#INSERT_DATE", "CAREER#UPDATE_DATE",
], token)
cpv.out(f"  {v.get('CAREER#LASTNAME')} {v.get('CAREER#FIRSTNAME')}")
cpv.out(f"  INSERT_DATE = {v.get('CAREER#INSERT_DATE')}")
cpv.out(f"  UPDATE_DATE = {v.get('CAREER#UPDATE_DATE')}")
a = cpv.select("career_action", "6_0", ["CAREER_ACTION#ACTION_DATE", "CAREER_ACTION#NEXTACTION_DATE"], token)
cpv.out(f"  対応履歴 6_0 の ACTION_DATE = {a.get('CAREER_ACTION#ACTION_DATE')}")
cpv.out("  -> ACTION_DATE が UPDATE_DATE より新しければ、対応履歴の追加で親は更新されていない疑いが濃い")
cpv.out("     （確定には画面操作による V-3c が必要）")

cpv.report("V-3d 完了")
