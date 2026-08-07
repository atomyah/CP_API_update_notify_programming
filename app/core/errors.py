"""例外の定義。

リトライ可否は呼び出し側でステータスコードを分岐させず、例外の型で判断する
（`rules/50-code-style.md`）。
"""
from __future__ import annotations


class CpNotifyError(Exception):
    """このアプリが投げる例外の基底。"""


class ConfigError(CpNotifyError):
    """設定不備。起動を失敗させる。"""


class CpApiError(CpNotifyError):
    """CP API 由来のエラー。

    `requestId` はベンダー問い合わせに必須なので必ず保持する
    （`rules/50-code-style.md`）。
    レスポンスボディは個人情報を含みうるため、`str()` では先頭のみを出す。
    """

    retryable = False

    def __init__(self, status_code: int, body: str, request_id: str | None = None,
                 path: str | None = None):
        self.status_code = status_code
        self.body = body
        self.request_id = request_id
        self.path = path
        super().__init__(f"HTTP {status_code} on {path} requestId={request_id}")


class CpBadRequestError(CpApiError):
    """400。リクエスト不正。リトライしない。設定不備として扱う。"""


class CpAuthError(CpApiError):
    """401。トークンを取り直して 1 回だけリトライする。"""


class CpForbiddenError(CpApiError):
    """403。APIキーの権限不足。リトライしない。"""


class CpNotFoundError(CpApiError):
    """404。エンドポイント誤り。リトライしない。"""


class CpServerError(CpApiError):
    """500 / 504。指数バックオフでリトライする。"""

    retryable = True


class CpTransportError(CpNotifyError):
    """接続エラー・タイムアウト。スリープ復帰直後などに起きる（仕様書 9.5.5）。"""

    retryable = True


class BudgetExhausted(CpNotifyError):
    """1サイクルのリクエスト予算を使い切った。

    ウォッチャーはこれを捕捉して `exhausted=True` を返し、
    **カーソルを進めずに**次サイクルへ持ち越す（`rules/20-rate-limit.md`）。
    """


class NotifyError(CpNotifyError):
    """通知の送信に失敗した。"""
