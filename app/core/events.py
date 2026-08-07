"""通知イベントの中間表現。

**`notifiers/` は「誰に何を送るか」だけを知る。CP のリソースや項目 ID を知らない**
（`rules/50-code-style.md`）。ウォッチャーがこの中間表現を組み立てて渡す。

通知本文は**最初の取得時に組み立てて保存する。**
再送のためにイベントを再取得しない（`rules/20-rate-limit.md`）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Notification:
    """1 通の通知。

    Attributes:
        watcher_id:  発生元のウォッチャー
        resource_id: CP のリソース ID。冪等キーの一部
        event_type:  `item_changed` / `status_changed` / `created` など
        digest:      通知本文を決定づける値のハッシュ。冪等キーの一部
        channel_key: 送信先の論理名。Slack のチャンネル、またはメール宛先の解決キー
        subject:     件名（メール用。Slack では本文の先頭に使う）
        body:        本文（組み立て済み）
        to_address:  メールの宛先。Slack 通知では None
        meta:        ログ用の補助情報。**個人情報を入れない**
    """

    watcher_id: str
    resource_id: str
    event_type: str
    digest: str
    channel_key: str
    subject: str
    body: str
    to_address: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    def idempotency_key(self) -> tuple[str, str, str, str]:
        return (self.watcher_id, self.resource_id, self.event_type, self.digest)


@dataclass
class CycleResult:
    """1 サイクルの結果。スケジューラがこれを見てカーソルと失敗カウンタを更新する。"""

    ok: bool
    requests_used: int = 0
    events_detected: int = 0
    events_notified: int = 0
    exhausted: bool = False
    error: str | None = None

    def as_log_fields(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "requests_used": self.requests_used,
            "events_detected": self.events_detected,
            "events_notified": self.events_notified,
            "exhausted": self.exhausted,
            "error": self.error,
        }
