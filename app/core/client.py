"""CP API クライアント。**このアプリで唯一の HTTP 出口。**

ウォッチャーや通知モジュールから `requests` を直接呼ばない
（`rules/20-rate-limit.md`）。

責務:
- トークンバケットの消費（例外なく全リクエストが通る）
- 予算の消費（リトライも消費する）
- `Authorization` ヘッダの付与とトークン期限管理（`core/auth.py` に委譲）
- ステータスコードに応じたリトライ（`rules/10-cp-api.md` の表に従う）
- `requestId` のログ記録（ベンダー問い合わせに必須）
- 例外の `CpApiError` への正規化
"""
from __future__ import annotations

import json
import time
from typing import Any, Iterable

import requests

from app.core.auth import TokenManager
from app.core.budget import RequestBudget, UnlimitedBudget
from app.core.errors import (
    CpApiError,
    CpAuthError,
    CpBadRequestError,
    CpForbiddenError,
    CpNotFoundError,
    CpServerError,
    CpTransportError,
)
from app.core.logging import Logger
from app.core.ratelimit import RequestMetrics, TokenBucket

MAX_LIMIT = 100          # 仕様上の上限。101 は 400（実測）
SERVER_RETRY_MAX = 3     # 500 / 504 / 接続エラー
BACKOFF_BASE_SECONDS = 2.0


class CpClient:
    def __init__(
        self,
        base_url: str,
        bucket: TokenBucket,
        metrics: RequestMetrics,
        logger: Logger,
        token_manager: TokenManager | None = None,
        timeout: float = 60.0,
    ):
        self._base_url = base_url.rstrip("/")
        # TokenManager はトークン取得のために自分自身（post_token）を必要とするため、
        # 生成後に注入する。`set_token_manager` を呼ぶまで認可つきの呼び出しはできない
        self._auth = token_manager
        self._bucket = bucket
        self._metrics = metrics
        self._log = logger
        self._timeout = timeout
        self._session = requests.Session()
        # 現在どのウォッチャーが叩いているか。メトリクスの内訳に使う
        self.current_watcher = "-"

    def set_token_manager(self, token_manager: TokenManager) -> None:
        self._auth = token_manager

    # --- 公開 API --------------------------------------------------------

    def search(
        self,
        resource: str,
        condition: dict[str, Any] | None = None,
        sort: list[dict[str, str]] | None = None,
        limit: int = MAX_LIMIT,
        offset: int = 0,
        budget: RequestBudget | None = None,
    ) -> tuple[list[str], int]:
        """検索。**ID の配列と総件数しか返らない。**項目値は返らない。

        `limit` は常に 100 を指定する（`rules/20-rate-limit.md`）。
        `sort` を省くと順序が保証されないので、ページングするなら必ず指定すること。
        """
        if limit > MAX_LIMIT:
            raise ValueError(f"limit must be <= {MAX_LIMIT}")
        body: dict[str, Any] = {"limit": limit, "offset": offset}
        if sort:
            body["sort"] = sort
        if condition:
            body["condition"] = condition

        result = self._post(f"/v1/ext2/{resource}/search", body, budget)["result"]
        ids = [str(i) for i in result.get("ids", [])]
        return ids, int(result.get("count", 0))

    def select(
        self,
        resource: str,
        resource_id: str,
        item_ids: Iterable[str],
        budget: RequestBudget | None = None,
    ) -> dict[str, Any]:
        """取得。**1リクエスト = 1リソース。**

        `itemIds` には必要な項目だけを列挙する（レスポンスサイズとタイムアウトのリスク）。
        関連リソースの項目 ID も混ぜられる（実測で確認済み）。
        """
        body = {"itemIds": list(item_ids)}
        result = self._post(f"/v1/ext2/{resource}/select/{resource_id}", body, budget)["result"]
        return {it["itemId"]: it.get("value") for it in result.get("items", [])}

    def get_schema(self, resource_category: str,
                   budget: RequestBudget | None = None) -> list[dict[str, Any]]:
        """リソース定義。実環境の schema を正とする（`rules/10-cp-api.md`）。"""
        result = self._get(f"/v1/ext2/schema/{resource_category}", budget)["result"]
        return list(result.get("items", []))

    def get_master(self, code_name: str,
                   budget: RequestBudget | None = None) -> dict[str, str]:
        """コード値 → ラベル。`selectone` 等の値をそのまま通知に出すと読めないため。"""
        result = self._get(f"/v1/ext2/master/{code_name}", budget)["result"]
        labels: dict[str, str] = {}
        for entry in result.get("values", []):
            # 検証スクリプトで value / values の両方が観測されているため両対応にする
            code = entry.get("value", entry.get("values"))
            if code is None:
                continue
            labels[str(code)] = entry.get("label", "")
        return labels

    def post_token(self, payload: dict[str, Any]) -> dict[str, Any]:
        """トークンエンドポイント。**共通ラッパが無い**のでここだけ生の dict を返す。

        認可も CP へのリクエストなのでトークンバケットを通す。
        """
        return self._request("POST", "/v1/auth/token", payload, budget=None, with_auth=False)

    # --- 内部 ------------------------------------------------------------

    def _get(self, path: str, budget: RequestBudget | None) -> dict[str, Any]:
        return self._request("GET", path, None, budget)

    def _post(self, path: str, body: dict[str, Any],
              budget: RequestBudget | None) -> dict[str, Any]:
        return self._request("POST", path, body, budget)

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None,
        budget: RequestBudget | None,
        with_auth: bool = True,
    ) -> dict[str, Any]:
        budget = budget or UnlimitedBudget()
        auth_retried = False
        server_attempts = 0

        while True:
            # 予算 → トークンバケットの順。予算切れなら CP を叩く前に止める
            budget.consume()
            waited = self._bucket.acquire()
            self._metrics.record(self.current_watcher, _endpoint_of(path))

            try:
                response = self._send(method, path, body, with_auth)
            except (requests.ConnectionError, requests.Timeout) as exc:
                server_attempts += 1
                if server_attempts >= SERVER_RETRY_MAX:
                    raise CpTransportError(f"{type(exc).__name__} on {path}") from None
                self._backoff(server_attempts, path, "transport_error")
                continue

            request_id = _extract_request_id(response)
            status = response.status_code

            if status == 200:
                if waited > 1.0:
                    self._log.debug("rate_limited", path=path, waited_seconds=round(waited, 2))
                return response.json()

            error = _classify(status, response.text, request_id, path)

            # 401 はトークンを取り直して 1 回だけリトライ。2 回目は設定不備として扱う
            if isinstance(error, CpAuthError) and with_auth and not auth_retried:
                auth_retried = True
                self._log.warn("token_refresh_on_401", path=path, request_id=request_id)
                self._auth.invalidate()
                continue

            # 500 / 504 は指数バックオフで最大 3 回
            if error.retryable:
                server_attempts += 1
                if server_attempts < SERVER_RETRY_MAX:
                    self._backoff(server_attempts, path, "server_error",
                                  status=status, request_id=request_id)
                    continue

            self._log.error(
                "cp_api_error",
                path=path,
                status=status,
                request_id=request_id,
                retryable=error.retryable,
            )
            raise error

    def _send(self, method: str, path: str, body: dict[str, Any] | None,
              with_auth: bool) -> requests.Response:
        headers = {"Content-Type": "application/json"}
        if with_auth and self._auth is None:
            raise RuntimeError("token manager is not attached to the client")
        if with_auth:
            # `Bearer` は大文字が正。小文字は 401 になる（実測）
            headers["Authorization"] = f"Bearer {self._auth.get_token()}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        return self._session.request(
            method, self._base_url + path, data=data, headers=headers, timeout=self._timeout
        )

    def _backoff(self, attempt: int, path: str, reason: str, **fields: Any) -> None:
        delay = BACKOFF_BASE_SECONDS ** attempt
        self._log.warn("retrying", path=path, reason=reason, attempt=attempt,
                       delay_seconds=delay, **fields)
        time.sleep(delay)


def _classify(status: int, text: str, request_id: str | None, path: str) -> CpApiError:
    """`rules/10-cp-api.md` のエラーコード表に従って例外の型を決める。

    **400 は権限の有無を示さない**（CP は「ボディ検証 → 認可」の順に処理する）。
    """
    if status == 400:
        return CpBadRequestError(status, text, request_id, path)
    if status == 401:
        return CpAuthError(status, text, request_id, path)
    if status == 403:
        return CpForbiddenError(status, text, request_id, path)
    if status == 404:
        return CpNotFoundError(status, text, request_id, path)
    if status >= 500:
        return CpServerError(status, text, request_id, path)
    return CpApiError(status, text, request_id, path)


def _extract_request_id(response: requests.Response) -> str | None:
    try:
        return response.json().get("requestId")
    except Exception:  # noqa: BLE001 - JSON でない応答もありうる
        return None


def _endpoint_of(path: str) -> str:
    """メトリクス集計用にパスを正規化する（末尾の ID を `*` に潰す）。

    `/v1/ext2/career/select/18` -> `/v1/ext2/career/select/*`
    `/v1/ext2/schema/career`    -> `/v1/ext2/schema/*`
    """
    parts = [p for p in path.split("/") if p]
    if len(parts) >= 4 and parts[2] in ("schema", "master") and parts[3] != "list":
        return "/" + "/".join(parts[:3]) + "/*"
    if len(parts) >= 5 and parts[3] == "select":
        return "/" + "/".join(parts[:4]) + "/*"
    return "/" + "/".join(parts)
