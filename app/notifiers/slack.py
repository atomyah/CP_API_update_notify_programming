"""Slack Incoming Webhook への送信。

Webhook URL は**チャンネルを特定する秘密情報**。環境変数から読み、
リポジトリにも設定ファイルにも書かない（`rules/40-secrets-and-security.md`）。

CP のトークンバケットは通さない。あれは CP API 専用の制約であり、
Slack への送信は CP の 240req/分 とは無関係。
"""
from __future__ import annotations

import os
import time

import requests

from app.core.errors import NotifyError
from app.core.events import Notification
from app.core.logging import Logger
from app.notifiers.base import Notifier

SEND_RETRY_MAX = 3
BACKOFF_BASE_SECONDS = 2.0
TIMEOUT_SECONDS = 15.0


class SlackNotifier(Notifier):
    """チャンネル論理名 → Webhook URL の対応を持つ。

    Args:
        webhook_envs: `{"career_status": "SLACK_WEBHOOK_CAREER_STATUS", ...}`
        dry_run_channel_key: 指定するとすべての通知をこのチャンネルへ寄せる。
            本番相当データで動かす前の確認用（`rules/40-secrets-and-security.md`）。
    """

    def __init__(self, webhook_envs: dict[str, str], logger: Logger,
                 dry_run_channel_key: str | None = None):
        self._webhook_envs = webhook_envs
        self._log = logger
        self._dry_run_channel_key = dry_run_channel_key
        self._session = requests.Session()

    def supports(self, channel_key: str) -> bool:
        return channel_key in self._webhook_envs

    def configured_channels(self) -> list[str]:
        """URL が実際に設定されているチャンネルの一覧。起動時チェックで使う。"""
        return [k for k, env in self._webhook_envs.items() if os.environ.get(env, "").strip()]

    def send(self, notification: Notification) -> None:
        channel_key = notification.channel_key
        text = notification.body

        if self._dry_run_channel_key:
            # 本来の宛先を明示したうえで、すべてドライラン用チャンネルへ寄せる
            text = (f"*[DRY-RUN]* 本来の通知先: `{channel_key}`\n"
                    f"{'-' * 40}\n{text}")
            channel_key = self._dry_run_channel_key

        url = self._resolve_url(channel_key)
        self._post(url, text, notification)

    def _resolve_url(self, channel_key: str) -> str:
        env_name = self._webhook_envs.get(channel_key)
        if not env_name:
            raise NotifyError(f"no webhook configured for channel '{channel_key}'")
        url = os.environ.get(env_name, "").strip()
        if not url:
            raise NotifyError(f"environment variable {env_name} is not set")
        return url

    def _post(self, url: str, text: str, notification: Notification) -> None:
        last_error: str = ""
        for attempt in range(1, SEND_RETRY_MAX + 1):
            try:
                res = self._session.post(
                    url, json={"text": text}, timeout=TIMEOUT_SECONDS
                )
                if res.status_code == 200:
                    self._log.info(
                        "slack_sent",
                        watcher_id=notification.watcher_id,
                        resource_id=notification.resource_id,
                        event_type=notification.event_type,
                        channel_key=notification.channel_key,
                    )
                    return
                # 4xx は再送しても直らない。URL 失効・チャンネル削除など
                if 400 <= res.status_code < 500:
                    raise NotifyError(
                        f"slack rejected the message: HTTP {res.status_code} {res.text[:200]}"
                    )
                last_error = f"HTTP {res.status_code}"
            except requests.RequestException as exc:
                last_error = f"{type(exc).__name__}"

            if attempt < SEND_RETRY_MAX:
                time.sleep(BACKOFF_BASE_SECONDS ** attempt)

        raise NotifyError(f"slack send failed after {SEND_RETRY_MAX} attempts: {last_error}")
