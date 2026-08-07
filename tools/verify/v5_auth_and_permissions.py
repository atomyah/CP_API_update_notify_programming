"""V-5: 疎通・認可・権限の確認。"""
import cpv

cpv.out("--- V-5-1: APIキーでトークン取得 ---")
ok, res = cpv.safe(cpv.token_response, "token/api_key")
if not ok:
    raise SystemExit("トークン取得に失敗。以降の検証は実施できません。")

payload = res.get("result", res)
token = payload["accessToken"]
refresh_token = payload.get("refreshToken")
cpv.out(f"  code            : {res.get('code')}")
cpv.out(f"  accessToken     : <{len(token)} chars>")
cpv.out(f"  refreshToken    : <{len(refresh_token) if refresh_token else 0} chars>")
cpv.out(f"  expiresIn       : {payload.get('expiresIn')}  (仕様書の記載は 3600)")
cpv.out(f"  requestId       : {res.get('requestId')}")
cpv.out(f"  top-level keys  : {sorted(res.keys())}")

cpv.out("\n--- V-5-2: refreshToken でトークン再取得 ---")
# 注意: リフレッシュすると同系列の旧アクセストークンは即座に無効化される（V-5b で確認済み）。
# 以降は必ず新しいトークンを使うこと。
if refresh_token:
    ok, res2 = cpv.safe(lambda: cpv.refresh(refresh_token), "token/refresh_token")
    if ok:
        p2 = res2.get("result", res2)
        cpv.out(f"  OK  expiresIn={p2.get('expiresIn')}  accessToken=<{len(p2['accessToken'])} chars>")
        cpv.out(f"      新しい refreshToken が返るか: {'yes' if p2.get('refreshToken') else 'no'}")
        token = p2["accessToken"]  # 旧トークンは死んでいるので差し替える
        cpv.out("      -> 以降の検証は新しいアクセストークンで実施")
else:
    cpv.out("  refreshToken が返っていないためスキップ")

cpv.out("\n--- V-5-3: マスタ一覧 (権限: マスター読み取り) ---")
ok, res = cpv.safe(lambda: cpv.get("/v1/ext2/master/list", token), "master/list")
if ok:
    masters = res["result"]["codeMaster"]
    cpv.out(f"  OK  マスタ数: {len(masters)}")

cpv.out("\n--- V-5-4: リソース定義 (権限: リソース定義読み取り) ---")
ok, res = cpv.safe(lambda: cpv.get("/v1/ext2/schema/career", token), "schema/career")
if ok:
    cpv.out(f"  OK  career の項目数: {len(res['result']['items'])}")

cpv.out("\n--- V-5-5: 各リソースの検索権限 (limit:1) ---")
resources = [
    "career", "career_action", "progress", "progress_history",
    "order", "client", "department", "wrkcareer", "file", "career_workexperience",
]
counts = {}
for r in resources:
    ok, res = cpv.safe(lambda r=r: cpv.search(r, token, limit=1), f"{r}/search")
    if ok:
        counts[r] = res["count"]
        cpv.out(f"  {r:<24} OK   count={res['count']}")

cpv.out("\n--- V-5-6: progress/select の必要権限（仕様書に記載漏れ） ---")
if counts.get("progress"):
    ok, res = cpv.safe(lambda: cpv.search("progress", token, limit=1), "progress/search for id")
    if ok and res["ids"]:
        pid = res["ids"][0]
        ok2, vals = cpv.safe(
            lambda: cpv.select("progress", pid, ["PROGRESS#CAREER_ID", "PROGRESS#ORDER_ID", "PROGRESS#STATUS_ID"], token),
            "progress/select",
        )
        if ok2:
            cpv.out(f"  OK  進捗(読み取り)権限で select できた  id={pid}  keys={sorted(vals.keys())}")
else:
    cpv.out("  進捗レコードが0件のためスキップ")

cpv.out("\n--- V-5-7: 仕様書の項目ID誤記の確認 (PROGRESS#STATSU_ID vs STATUS_ID) ---")
if counts.get("progress"):
    ok, res = cpv.safe(lambda: cpv.search("progress", token, limit=1), "progress/search")
    if ok and res["ids"]:
        pid = res["ids"][0]
        for iid in ["PROGRESS#STATUS_ID", "PROGRESS#STATSU_ID"]:
            ok2, vals = cpv.safe(lambda iid=iid: cpv.select("progress", pid, [iid], token), iid)
            cpv.out(f"  {iid:<22} -> {'OK  value=' + str(vals.get(iid)) if ok2 else 'NG'}")

cpv.report("V-5 完了")
