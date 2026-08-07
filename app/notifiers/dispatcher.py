"""通知の送出口。冪等除去と dead letter をここで一括して扱う。

**通知送信より先に `notified` へ INSERT する**（`rules/30-state-and-idempotency.md`）。
送信後に INSERT すると、送信成功・INSERT 失敗のときに二重送信する。
逆順なら最悪 1 件落ちるだけで、落ちたことは `dead_letter` で検出できる。

**1件ずつ即座に送る（ストリーミング）。**
まとめてから送る作りにすると、途中で予算切れになったときに
組み立て済みの通知が送信前に捨てられる。スナップショットは更新済みなので
次サイクルでも再検知されず、**通知漏れになる。**
取りこぼしは重複通知より重い（`rules/30-state-and-idempotency.md`）。
"""
from __future__ import annotations

import json

from app.core.errors import NotifyError
from app.core.events import Notification
from app.core.logging import Logger
from app.core.store import Store
from app.core.timefmt import now_jst, to_store
from app.notifiers.base import Notifier


class Dispatcher:
    def __init__(self, notifiers: list[Notifier], store: Store, logger: Logger,
                 max_per_cycle: int = 50):
        self._notifiers = notifiers
        self._store = store
        self._log = logger
        self._max_per_cycle = max_per_cycle
        self._cycle_sent = 0
        self._suppressed: list[Notification] = []

    # --- サイクル単位の送出（ウォッチャーが使う） -------------------------

    def begin_cycle(self) -> None:
        self._cycle_sent = 0
        self._suppressed = []

    def dispatch_one(self, notification: Notification) -> bool:
        """1 件送る。送れたら True。

        1 サイクルの上限を超えたぶんは送らずに溜め、`end_cycle` でサマリに畳む
        （一括更新でチャンネルが溢れるのを防ぐ。`docs/design/03-rate-budget.md` 5.2）。
        """
        if self._cycle_sent >= self._max_per_cycle:
            self._suppressed.append(notification)
            return False
        if self._send_one(notification):
            self._cycle_sent += 1
            return True
        return False

    def end_cycle(self) -> int:
        """サイクルを閉じ、送信できた件数を返す。"""
        if self._suppressed:
            self._log.warn(
                "notification_flood",
                watcher_id=self._suppressed[0].watcher_id,
                suppressed=len(self._suppressed),
                limit=self._max_per_cycle,
            )
            if self._send_one(self._summary(self._suppressed)):
                self._cycle_sent += 1
            self._suppressed = []
        return self._cycle_sent

    def dispatch(self, notifications: list[Notification]) -> int:
        """単発の通知用。サイクルの開始と終了を内包する。"""
        self.begin_cycle()
        for notification in notifications:
            self.dispatch_one(notification)
        return self.end_cycle()

    # --- 内部 ------------------------------------------------------------

    def _send_one(self, notification: Notification) -> bool:
        watcher_id, resource_id, event_type, digest = notification.idempotency_key()

        # 先に予約する。競合したら既送信なので黙って捨てる
        if not self._store.claim_notification(watcher_id, resource_id, event_type, digest):
            self._log.debug(
                "notification_deduped",
                watcher_id=watcher_id, resource_id=resource_id, event_type=event_type,
            )
            return False

        notifier = self._pick(notification)
        if notifier is None:
            self._fail(notification, f"no notifier handles channel '{notification.channel_key}'")
            return False

        try:
            notifier.send(notification)
            return True
        except NotifyError as exc:
            self._fail(notification, str(exc))
            return False

    def _pick(self, notification: Notification) -> Notifier | None:
        for notifier in self._notifiers:
            if notifier.supports(notification.channel_key):
                return notifier
        return None

    def _fail(self, notification: Notification, error: str) -> None:
        """諦めた通知は dead letter に落とす。**自動再送はしない。**

        本文は個人情報を含みうるため、保存先の取り扱いに注意する
        （`rules/40-secrets-and-security.md`）。
        """
        payload = json.dumps(
            {
                "channel_key": notification.channel_key,
                "subject": notification.subject,
                "body": notification.body,
                "resource_id": notification.resource_id,
                "event_type": notification.event_type,
            },
            ensure_ascii=False,
        )
        self._store.add_dead_letter(notification.watcher_id, payload, error)
        self._log.error(
            "notification_failed",
            watcher_id=notification.watcher_id,
            resource_id=notification.resource_id,
            event_type=notification.event_type,
            error=error,
        )

    def _summary(self, suppressed: list[Notification]) -> Notification:
        """上限を超えたぶんを 1 通のサマリに畳む。"""
        first = suppressed[0]
        total = self._cycle_sent + len(suppressed)
        body = (
            f"*{total} 件の変更が検出されました*\n"
            f"うち {len(suppressed)} 件は詳細を省略しました"
            f"（1サイクルの通知上限 {self._max_per_cycle} 件）。\n"
            f"対象リソース: {len(set(n.resource_id for n in suppressed))} 件"
        )
        return Notification(
            watcher_id=first.watcher_id,
            resource_id="__summary__",
            event_type="summary",
            # サイクルごとに一意にする。過去のサマリと冪等キーが衝突すると消える
            digest=f"{to_store(now_jst())}:{total}",
            channel_key=first.channel_key,
            subject=f"[CP] {total} 件の変更",
            body=body,
        )
