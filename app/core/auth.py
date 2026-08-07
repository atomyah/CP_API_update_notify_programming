"""アクセストークンの取得・キャッシュ・更新。

実測で判明している挙動（`docs/design/07-verification-results.md` 4章）:

- トークンエンドポイントのレスポンスには **`code`/`result` の共通ラッパが無い。**
  `{accessToken, refreshToken, expiresIn}` のフラットな JSON が返る。
  他のエンドポイントと同じパーサを使い回さないこと。
- **`refresh_token` で取り直すと、同系列の直前のアクセストークンが即座に無効化される。**
  猶予期間はない。よってトークンの差し替えは原子的に行い、
  「新トークンを取得してから差し替える」の間に旧トークンを使うコードパスを作らない。
- ヘッダは `Bearer <token>`。`bearer`（小文字）は 401。

トークンは **メモリ上のみ。**SQLite にもログにも書かない
（`rules/40-secrets-and-security.md`）。
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable

# 有効期限の何秒前に取り直すか。仕様は 60 分（expiresIn: 3600）
REFRESH_MARGIN_SECONDS = 300


class TokenManager:
    """アクセストークンの寿命を管理する。

    `post_token` には「トークンエンドポイントへ POST してフラットな dict を返す」
    関数を渡す。HTTP の実体は `core/client.py` が持ち、ここは寿命だけを見る。
    """

    def __init__(self, api_key: str, post_token: Callable[[dict[str, Any]], dict[str, Any]]):
        self._api_key = api_key
        self._post_token = post_token
        self._lock = threading.Lock()
        self._access_token: str | None = None
        self._refresh_token: str | None = None
        # 絶対時刻で持つ。スリープ中の経過も期限切れとして正しく扱うため（仕様書 9.5.5）
        self._expires_at: float = 0.0

    def get_token(self) -> str:
        """有効なアクセストークンを返す。期限が近ければ取り直す。"""
        with self._lock:
            if self._access_token and time.time() < self._expires_at - REFRESH_MARGIN_SECONDS:
                return self._access_token
            self._acquire_locked()
            assert self._access_token is not None
            return self._access_token

    def invalidate(self) -> str:
        """401 を受けたときに呼ぶ。強制的に取り直して新しいトークンを返す。

        リトライは 1 回だけ（`rules/10-cp-api.md`）。2 回目の 401 は設定不備として扱う。
        """
        with self._lock:
            self._access_token = None
            self._acquire_locked()
            assert self._access_token is not None
            return self._access_token

    def _acquire_locked(self) -> None:
        """トークンを取得して原子的に差し替える。呼び出し元はロック済みであること。

        refreshToken があればそれを使い、失効していれば APIキーからやり直す。
        """
        payload: dict[str, Any]
        if self._refresh_token:
            payload = {"grantType": "refresh_token", "refreshToken": self._refresh_token}
            try:
                self._store(self._post_token(payload))
                return
            except Exception:  # noqa: BLE001 - refreshToken 失効は想定内。APIキーへ落とす
                self._refresh_token = None

        payload = {"grantType": "api_key", "apiKey": self._api_key}
        self._store(self._post_token(payload))

    def _store(self, response: dict[str, Any]) -> None:
        # 共通ラッパが無いのが正だが、将来 API 側が揃えてきても壊れないようにしておく
        body = response.get("result") if isinstance(response.get("result"), dict) else response
        access = body.get("accessToken")
        if not access:
            raise ValueError("token response has no accessToken")
        self._access_token = access
        self._refresh_token = body.get("refreshToken") or self._refresh_token
        expires_in = float(body.get("expiresIn") or 3600)
        self._expires_at = time.time() + expires_in
