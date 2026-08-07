"""401 の切り分け。トークン本体は出力しない（クレーム名と非機密の値のみ）。"""
import base64
import json
import time
import urllib.error
import urllib.request

import cpv


def b64url(seg: str) -> dict:
    seg += "=" * (-len(seg) % 4)
    return json.loads(base64.urlsafe_b64decode(seg).decode("utf-8"))


res = cpv.token_response()
token = res["accessToken"]

cpv.out("--- アクセストークンの構造 ---")
parts = token.split(".")
cpv.out(f"  ドット区切りのセグメント数: {len(parts)}  (3 なら JWT)")
if len(parts) == 3:
    header = b64url(parts[0])
    claims = b64url(parts[1])
    cpv.out(f"  header: {header}")
    cpv.out(f"  claim keys: {sorted(claims.keys())}")
    for k in ("iss", "aud", "scope", "scp", "token_use", "client_id", "sub"):
        if k in claims:
            v = claims[k]
            shown = v if k in ("iss", "aud", "scope", "scp", "token_use") else f"<{len(str(v))} chars>"
            cpv.out(f"    {k}: {shown}")
    now = int(time.time())
    for k in ("iat", "exp", "nbf", "auth_time"):
        if k in claims:
            cpv.out(f"    {k}: {claims[k]}  ({claims[k] - now:+d} 秒 / 現在時刻比)")

cpv.out(f"\n  ローカル現在時刻(UTC epoch): {int(time.time())}")

TARGET = "/v1/ext2/master/list"
variants = [
    ("Authorization: Bearer <token>", {"Authorization": f"Bearer {token}"}),
    ("Authorization: bearer <token>", {"Authorization": f"bearer {token}"}),
    ("Authorization: <token>", {"Authorization": token}),
    ("X-Api-Key ヘッダ", {"X-Api-Key": token}),
    ("Bearer + Accept:application/json", {"Authorization": f"Bearer {token}", "Accept": "application/json"}),
]

cpv.out(f"\n--- ヘッダ形式ごとの結果 ({TARGET}) ---")
for label, headers in variants:
    time.sleep(1.0)
    req = urllib.request.Request(cpv.BASE_URL + TARGET, method="GET")
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode("utf-8")
            cpv.out(f"  {label:<38} -> HTTP {r.status}  {body[:120]}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        cpv.out(f"  {label:<38} -> HTTP {e.code}  {raw[:160]}")

cpv.out("\n--- 実際に送信されるヘッダの確認 ---")
req = urllib.request.Request(cpv.BASE_URL + TARGET, method="GET")
req.add_header("Authorization", f"Bearer {token}")
cpv.out(f"  header_items のキー: {[k for k, _ in req.header_items()]}")
cpv.out(f"  Authorization の先頭: {req.get_header('Authorization')[:10]}...")

cpv.out("\n--- POST 系のエンドポイントでも同じか (career/search) ---")
time.sleep(1.0)
req = urllib.request.Request(
    cpv.BASE_URL + "/v1/ext2/career/search",
    data=json.dumps({"limit": 1}).encode("utf-8"),
    method="POST",
)
req.add_header("Content-Type", "application/json")
req.add_header("Authorization", f"Bearer {token}")
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        cpv.out(f"  HTTP {r.status}  {r.read().decode('utf-8')[:200]}")
except urllib.error.HTTPError as e:
    cpv.out(f"  HTTP {e.code}  {e.read().decode('utf-8', errors='replace')[:250]}")

cpv.report("debug_auth 完了")
