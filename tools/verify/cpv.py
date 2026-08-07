"""実環境検証用の共通モジュール（使い捨て。app/ の実装ではない）。

- .env から APIキーを読む。値はログにも例外にも出さない。
- 全リクエストを 1 秒に 1 回へ抑える（240req/分の制約に対して十分に安全側）。
- 消費リクエスト数を数え、終了時に出す。
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE_URL = "https://api.careerplus.jp"
ROOT = Path(__file__).resolve().parents[2]
MIN_INTERVAL_SEC = 1.0

_last_request_at = 0.0
_request_count = 0


def load_api_key() -> str:
    env_path = ROOT / ".env"
    for line in env_path.read_text(encoding="utf-8").splitlines():
        if "=" not in line or line.strip().startswith("#"):
            continue
        name, _, value = line.partition("=")
        if name.strip() == "CP_NOTIFY_API_KEY":
            return value.strip().strip('"').strip("'")
    raise SystemExit("CP_NOTIFY_API_KEY not found in .env")


class CpError(Exception):
    def __init__(self, status: int, body: str, request_id: str | None = None):
        self.status = status
        self.body = body
        self.request_id = request_id
        super().__init__(f"HTTP {status}: {body[:400]}")


def _request(method: str, path: str, body: dict | None, token: str | None) -> dict:
    """レート制御つきの生リクエスト。secret はここから外に出さない。"""
    global _last_request_at, _request_count

    wait = MIN_INTERVAL_SEC - (time.monotonic() - _last_request_at)
    if wait > 0:
        time.sleep(wait)

    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE_URL + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")

    _last_request_at = time.monotonic()
    _request_count += 1
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        rid = None
        try:
            rid = json.loads(raw).get("requestId")
        except Exception:  # noqa: BLE001
            pass
        raise CpError(e.code, raw, rid) from None


def get_token() -> str:
    res = _request("POST", "/v1/auth/token", {"grantType": "api_key", "apiKey": load_api_key()}, None)
    return res["result"]["accessToken"] if "result" in res else res["accessToken"]


def token_response() -> dict:
    """V-5 用。accessToken / refreshToken は呼び出し側でマスクすること。"""
    return _request("POST", "/v1/auth/token", {"grantType": "api_key", "apiKey": load_api_key()}, None)


def refresh(refresh_token: str) -> dict:
    return _request("POST", "/v1/auth/token", {"grantType": "refresh_token", "refreshToken": refresh_token}, None)


def get(path: str, token: str) -> dict:
    return _request("GET", path, None, token)


def post(path: str, body: dict, token: str) -> dict:
    return _request("POST", path, body, token)


def search(resource: str, token: str, condition=None, sort=None, limit=1, offset=0) -> dict:
    body: dict = {"limit": limit, "offset": offset}
    if sort:
        body["sort"] = sort
    if condition:
        body["condition"] = condition
    return post(f"/v1/ext2/{resource}/search", body, token)["result"]


def select(resource: str, rid: str, item_ids: list[str], token: str) -> dict:
    res = post(f"/v1/ext2/{resource}/select/{rid}", {"itemIds": item_ids}, token)["result"]
    return {it["itemId"]: it.get("value") for it in res.get("items", [])}


def eq(item_id: str, value) -> dict:
    return {"compoundType": "and", "items": [{"itemId": item_id, "searchType": "EQ", "value": value}]}


def cond(*items, compound="and") -> dict:
    return {"compoundType": compound, "items": list(items)}


def item(item_id: str, search_type: str, value) -> dict:
    return {"itemId": item_id, "searchType": search_type, "value": value}


def request_count() -> int:
    return _request_count


def report(title: str) -> None:
    print(f"\n=== {title} / requests used: {_request_count} ===", flush=True)


def out(*args) -> None:
    print(*args, flush=True)


def safe(fn, label: str):
    """検証は途中で止めない。失敗も結果として記録する。"""
    try:
        return True, fn()
    except CpError as e:
        out(f"  [{label}] FAILED  HTTP {e.status}  requestId={e.request_id}")
        out(f"           body: {e.body[:300]}")
        return False, None
    except Exception as e:  # noqa: BLE001
        out(f"  [{label}] ERROR   {type(e).__name__}: {e}")
        return False, None


if __name__ == "__main__":
    sys.exit("import して使うモジュールです")
