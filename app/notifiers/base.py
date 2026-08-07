"""通知の共通インタフェース。

`notifiers/` は CP のリソースや項目 ID を知らない。
渡された `Notification` を送るだけ（`rules/50-code-style.md`）。
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from app.core.events import Notification


class Notifier(ABC):
    @abstractmethod
    def send(self, notification: Notification) -> None:
        """送信する。失敗したら `NotifyError` を投げる。"""

    @abstractmethod
    def supports(self, channel_key: str) -> bool:
        """このチャンネルを扱えるか。"""
