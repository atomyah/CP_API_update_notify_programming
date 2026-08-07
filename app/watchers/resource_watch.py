"""リソース横断の項目変化ウォッチャー。

任意のリソースについて「項目の値が前回と変わったら通知する」を行う。
要件1（求職者）はこのウォッチャーの 1 インスタンスとして実現する。

**適用できるのは `UPDATE_DATE` を持つリソースだけ**（実測 2026-08-07）:

| リソース | UPDATE_DATE | 適用 |
|---|---|---|
| `career` / `client` / `department` / `order` / `progress` / `progress_history` / `file` | ✅ | ○ |
| `career_workexperience` / `career_action` / `client_action` / `wrkcareer` | ❌ | **×** |

タイムスタンプの無い 4 リソースは「いつ変更されたか」を CP に問い合わせる手段が無く、
ID 集合の差分＋全件走査（要件4の戦略B）が要る。ここでは扱わない。

検知方式:

1. `{resource}/search` （対象条件 AND `*#UPDATE_DATE GE カーソル`）で変化した ID を得る
2. 各 ID を `{resource}/select` して現在値を得る
3. `snapshots` の前回値と比較し、異なる項目だけを通知イベントにする
4. 通知してから `snapshots` を更新し、カーソルを前進させる

**通知より先にスナップショットを更新してはいけない。**
更新してから通知に失敗すると、その変化は永久に通知されない。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from app.core.budget import RequestBudget
from app.core.errors import ConfigError
from app.core.events import CycleResult, Notification
from app.core.schema import ItemDef
from app.core.store import payload_hash, value_hash
from app.core.timefmt import now_jst, to_cp_datetime
from app.watchers.base import Context, Watcher

# 保存のたびに必ず動く項目。これを監視対象に含めると「更新された」だけで毎回通知が出る
DEFAULT_EXCLUDE_SUFFIXES = ["#UPDATE_DATE", "#INSERT_DATE"]

WATCH_ALL = "*"


@dataclass(frozen=True)
class WatchedItem:
    item_id: str
    label: str
    master: str | None
    item_type: str

    @staticmethod
    def from_schema(definition: ItemDef, label_override: str | None = None,
                    master_override: str | None = None) -> "WatchedItem":
        return WatchedItem(
            item_id=definition.item_id,
            label=label_override or definition.label,
            # 参照マスタ名は schema の validationRule.codeName から取れる（実測）。
            # YAML への手書きは不要
            master=master_override or definition.code_name,
            item_type=definition.item_type,
        )


@dataclass
class Change:
    item: WatchedItem
    old_display: str
    new_display: str
    old_raw: object
    new_raw: object


class ResourceWatcher(Watcher):
    EVENT_TYPE = "item_changed"

    def __init__(self, watcher_id: str, config: dict[str, Any]):
        super().__init__(watcher_id, config)
        self.resource: str = config.get("resource") or ""
        if not self.resource:
            raise ConfigError(f"{watcher_id}: 'resource' is required")

        self.update_date_item: str = (
            config.get("update_date_item") or f"{self.resource.upper()}#UPDATE_DATE")
        self.target_condition = (config.get("target") or {}).get("condition")

        watched = config.get("watched_items", WATCH_ALL)
        self.watch_all: bool = watched == WATCH_ALL
        self._explicit_items: list[dict[str, Any]] = [] if self.watch_all else [
            {"item_id": e} if isinstance(e, str) else e for e in (watched or [])
        ]
        if not self.watch_all and not self._explicit_items:
            raise ConfigError(f"{watcher_id}: watched_items is empty")

        self.exclude_items: set[str] = set(config.get("exclude_items") or [])
        self.exclude_suffixes: list[str] = list(
            config.get("exclude_suffixes") or DEFAULT_EXCLUDE_SUFFIXES)
        self.exclude_types: set[str] = set(config.get("exclude_types") or [])

        self.identity_items: list[str] = list(config.get("identity_items") or [])
        self.name_template: str = config.get("name_template") or ""
        self.max_items_in_body: int = int(config.get("max_items_in_body", 20))
        # 遷移前後を通知するには生値の保存が要る。
        # 個人情報を SQLite に平文で持つことになるため設定で切れるようにしてある
        # （`rules/40-secrets-and-security.md`）
        self.keep_raw_values: bool = bool(config.get("keep_raw_values", True))
        self.bootstrap_budget_per_cycle: int = int(
            config.get("bootstrap_budget_per_cycle", 500))

        self.notify_config: dict[str, Any] = config.get("notify") or {}
        for key in ("channel_key", "template"):
            if not self.notify_config.get(key):
                raise ConfigError(f"{watcher_id}: notify.{key} is required")

        self._resolved: list[WatchedItem] | None = None

    # --- 起動時チェック --------------------------------------------------

    def validate(self, ctx: Context) -> None:
        schema = ctx.schema.get(self.resource)

        if self.update_date_item not in schema:
            raise ConfigError(
                f"{self.id}: '{self.update_date_item}' does not exist in resource "
                f"'{self.resource}'. This resource cannot be watched by update date"
            )

        explicit_ids = [e["item_id"] for e in self._explicit_items]
        ctx.schema.validate(
            self.resource,
            sorted(set(explicit_ids) | set(self.identity_items)
                   | {self.update_date_item} | _condition_item_ids(self.target_condition)),
        )

        items = self._resolve_items(ctx)
        if not items:
            raise ConfigError(f"{self.id}: no item remains after exclusions")

        if ctx.templates.get(self.notify_config["template"]) is None:
            raise ConfigError(
                f"{self.id}: template '{self.notify_config['template']}' not found")

        customs = [i.item_id for i in items if _is_custom(i.item_id)]
        ctx.logger.info(
            "watcher_validated",
            watcher_id=self.id,
            resource=self.resource,
            watched_item_count=len(items),
            watch_all=self.watch_all,
            custom_items=customs,
            keep_raw_values=self.keep_raw_values,
        )

    def required_masters(self) -> list[str]:
        """全項目監視ではマスタ数が多くなるため、先読みせず参照時に取得する。

        取得結果は 24 時間キャッシュされ、トークンバケットは通る。
        """
        return []

    def _resolve_items(self, ctx: Context) -> list[WatchedItem]:
        """監視対象の項目を schema から解決する。ラベルと参照マスタもここで決まる。"""
        if self._resolved is not None:
            return self._resolved

        schema = ctx.schema.get(self.resource)
        resolved: list[WatchedItem] = []

        if self.watch_all:
            for definition in schema.values():
                if self._is_excluded(definition):
                    continue
                resolved.append(WatchedItem.from_schema(definition))
        else:
            for entry in self._explicit_items:
                definition = schema[entry["item_id"]]
                resolved.append(WatchedItem.from_schema(
                    definition,
                    label_override=entry.get("label_override"),
                    master_override=entry.get("master"),
                ))

        resolved.sort(key=lambda i: i.item_id)
        self._resolved = resolved
        return resolved

    def _is_excluded(self, definition: ItemDef) -> bool:
        if definition.item_id in self.exclude_items:
            return True
        if definition.item_type in self.exclude_types:
            return True
        return any(definition.item_id.endswith(s) for s in self.exclude_suffixes)

    # --- 本体 ------------------------------------------------------------

    def execute(self, ctx: Context, budget: RequestBudget) -> CycleResult:
        cursor = ctx.store.get_cursor(self.id)
        if cursor is None or not cursor.bootstrapped:
            raise ConfigError(
                f"{self.id}: no snapshot yet. Run with --bootstrap first "
                f"(notifying without a baseline would flood the channel)"
            )

        cycle_start = now_jst()
        since = cursor.value - timedelta(seconds=self.overlap_seconds)

        ids, capped = self._search_page_range(
            ctx, budget, since, max_pages=ctx.app_config.max_pages_per_cycle)
        ctx.logger.info("search_done", watcher_id=self.id, resource=self.resource,
                        candidate_count=len(ids), since=since.isoformat())

        detected = 0
        ctx.dispatcher.begin_cycle()
        try:
            for resource_id in ids:
                if self._process(ctx, budget, resource_id, notify=True):
                    detected += 1
        finally:
            sent = ctx.dispatcher.end_cycle()

        if capped:
            # 全件を見きれていないのでカーソルを進めない。次サイクルで続きを拾う
            return CycleResult(ok=True, events_detected=detected,
                               events_notified=sent, exhausted=True)

        ctx.store.set_cursor(self.id, cycle_start, page_offset=0, bootstrapped=True)
        return CycleResult(ok=True, events_detected=detected, events_notified=sent)

    def bootstrap(self, ctx: Context, budget: RequestBudget) -> CycleResult:
        """スナップショットを作るだけ。**通知しない。**

        件数の多いリソース（企業 9,845 / 部署 14,565）では 1 サイクルで終わらない。
        **ページ単位で再開できるようにしてある**ので、複数サイクルに分けて完了させる。
        """
        cursor = ctx.store.get_cursor(self.id)
        if cursor is not None and cursor.bootstrapped:
            ctx.logger.info("bootstrap_skipped", watcher_id=self.id, reason="already done")
            return CycleResult(ok=True)

        offset = cursor.page_offset if cursor else 0
        # 完了後のカーソルには**最初のブートストラップ開始時刻**を使う。
        # 走査に数時間かかるため、終了時刻を入れると
        # 「走査中に変更されたレコード」が初回サイクルの検索から漏れる
        started_at = cursor.value if cursor else now_jst()
        condition = self._build_condition(since=None)
        sort = [{"itemId": self.update_date_item, "order": "asc"}]
        processed = 0

        while True:
            # **ページの開始位置を処理前に確定させる。**
            # ページの途中で予算切れになっても、このページからやり直せる
            ctx.store.set_cursor(self.id, started_at, page_offset=offset,
                                 bootstrapped=False)

            page, count = ctx.client.search(
                self.resource, condition=condition, sort=sort,
                limit=100, offset=offset, budget=budget)
            if not page:
                break

            for resource_id in page:
                # 既にスナップショットがある ID は飛ばす（再開時の再取得を避ける）
                if not ctx.store.has_snapshot(self.id, resource_id):
                    self._process(ctx, budget, resource_id, notify=False)
                    processed += 1

            offset += len(page)
            ctx.logger.info("bootstrap_progress", watcher_id=self.id,
                            resource=self.resource, offset=offset, total=count,
                            processed_this_cycle=processed)
            if offset >= count:
                break

        ctx.store.set_cursor(self.id, started_at, page_offset=0, bootstrapped=True)
        ctx.logger.info("bootstrap_done", watcher_id=self.id, resource=self.resource,
                        snapshot_rows=ctx.store.count_snapshots(self.id))
        return CycleResult(ok=True)

    def is_bootstrapped(self, ctx: Context) -> bool:
        cursor = ctx.store.get_cursor(self.id)
        return cursor is not None and cursor.bootstrapped

    # --- 内部 ------------------------------------------------------------

    def _search_page_range(self, ctx: Context, budget: RequestBudget, since,
                           max_pages: int) -> tuple[list[str], bool]:
        """変化した ID を集める。戻り値の 2 つ目は「ページ上限で打ち切ったか」。

        `sort` は必ず指定する。未指定だと順序が保証されずページングが壊れる。
        """
        condition = self._build_condition(since)
        sort = [{"itemId": self.update_date_item, "order": "asc"}]

        ids: list[str] = []
        offset = 0
        for _ in range(max_pages):
            page, count = ctx.client.search(
                self.resource, condition=condition, sort=sort,
                limit=100, offset=offset, budget=budget)
            ids.extend(page)
            offset += len(page)
            if not page or len(page) < 100 or offset >= count:
                return ids, False

        ctx.logger.warn("paging_capped", watcher_id=self.id, resource=self.resource,
                        max_pages=max_pages, collected=len(ids))
        return ids, True

    def _build_condition(self, since) -> dict[str, Any] | None:
        items: list[dict[str, Any]] = []
        if self.target_condition:
            items.append(self.target_condition)
        if since is not None:
            items.append({
                "itemId": self.update_date_item,
                "searchType": "GE",
                # datetime は `YYYY/MM/DD HH:MM:SS`。秒精度は実際に効く（実測）
                "value": to_cp_datetime(since),
            })
        if not items:
            return None
        if len(items) == 1:
            return items[0] if "compoundType" in items[0] else {
                "compoundType": "and", "items": items}
        return {"compoundType": "and", "items": items}

    def _process(self, ctx: Context, budget: RequestBudget, resource_id: str,
                 notify: bool) -> bool:
        """1 レコードぶんを取得し、差分を検出し、通知してからスナップショットを更新する。

        順序: `select` → 差分検出 → **通知** → スナップショット更新。
        1 レコードを完結させてから次へ進むので、予算切れで中断しても
        処理済みのレコードは次サイクルで重複通知にならない。
        """
        items = self._resolve_items(ctx)
        # **重複した itemId は 400 になる**（`itemIdが重複しています`。実測 2026-08-07）。
        # `watched_items: "*"` では identity_items が必ず重複するので、
        # 順序を保ったまま一意化してから渡す
        values = ctx.client.select(
            self.resource, resource_id,
            _unique([i.item_id for i in items] + self.identity_items),
            budget,
        )

        changes = self._detect_changes(ctx, resource_id, values, items) if notify else []

        if changes:
            ctx.logger.info("change_detected", watcher_id=self.id, resource=self.resource,
                            resource_id=resource_id, changed_count=len(changes),
                            item_ids=[c.item.item_id for c in changes])
            ctx.dispatcher.dispatch_one(
                self._build_notification(ctx, resource_id, values, changes))

        with ctx.store.transaction():
            for item in items:
                ctx.store.put_snapshot(
                    self.id, resource_id, item.item_id, values.get(item.item_id),
                    keep_raw=self.keep_raw_values, item_type=item.item_type,
                )
        return bool(changes)

    def _detect_changes(self, ctx: Context, resource_id: str, values: dict[str, Any],
                        items: list[WatchedItem]) -> list[Change]:
        previous = ctx.store.get_snapshots(self.id, resource_id)
        changes: list[Change] = []
        for item in items:
            current = values.get(item.item_id)
            snapshot = previous.get(item.item_id)
            if snapshot is None:
                # 初めて見たレコード・項目は通知しない。基準値を作るだけ
                continue
            if snapshot.value_hash == value_hash(current, item.item_type):
                continue
            old_raw = snapshot.decoded() if snapshot.has_raw else None
            change = Change(
                item=item,
                old_display=(ctx.master.label(item.master, old_raw)
                             if snapshot.has_raw else "(記録なし)"),
                new_display=ctx.master.label(item.master, current),
                old_raw=old_raw,
                new_raw=current,
            )
            if change.old_display == change.new_display:
                # 正規化しきれていない値が残っているサイン。
                # 読み手には「変わっていない」ようにしか見えないので、
                # 握りつぶさずログに残して原因を追えるようにする
                ctx.logger.warn("change_without_visible_difference",
                                watcher_id=self.id, resource_id=resource_id,
                                item_id=item.item_id, item_type=item.item_type)
            changes.append(change)
        return changes

    def _build_notification(self, ctx: Context, resource_id: str,
                            values: dict[str, Any], changes: list[Change]) -> Notification:
        template = ctx.templates[self.notify_config["template"]]
        change_line = template.get("change_line", "• {label}: {old} → {new}")

        shown = changes[: self.max_items_in_body]
        lines = "\n".join(
            change_line.format(label=c.item.label,
                               old=_clip(c.old_display), new=_clip(c.new_display))
            for c in shown
        )
        if len(changes) > len(shown):
            lines += f"\n… ほか {len(changes) - len(shown)} 項目"

        fields = {
            "resource": self.resource,
            "resource_label": self.notify_config.get("resource_label", self.resource),
            "resource_id": resource_id,
            "record_name": self._display_name(values) or f"{self.resource} {resource_id}",
            "changes": lines,
            "change_count": len(changes),
        }

        # 冪等キーは「何がどう変わったか」で決める。
        # 同じ変化を再取得しても再送されず、次の変化は別イベントとして通知される
        digest = payload_hash([
            (c.item.item_id, c.old_raw, c.new_raw)
            for c in sorted(changes, key=lambda x: x.item.item_id)
        ])

        return Notification(
            watcher_id=self.id,
            resource_id=resource_id,
            event_type=self.EVENT_TYPE,
            digest=digest,
            channel_key=self.notify_config["channel_key"],
            subject=template.get("subject", "[CP] 変更がありました").format(**fields),
            body=template["body"].format(**fields),
            meta={"resource": self.resource, "change_count": len(changes)},
        )

    def _display_name(self, values: dict[str, Any]) -> str:
        """通知の見出しに使う名前。`name_template` で項目 ID を差し込む。"""
        if not self.name_template:
            return ""
        text = self.name_template
        for item_id in self.identity_items:
            value = values.get(item_id)
            text = text.replace("{" + item_id + "}", "" if value is None else str(value))
        return text.strip()


def _unique(item_ids: list[str]) -> list[str]:
    """順序を保って重複を除く。CP は `itemIds` の重複を 400 で拒否する。"""
    seen: set[str] = set()
    out: list[str] = []
    for item_id in item_ids:
        if item_id not in seen:
            seen.add(item_id)
            out.append(item_id)
    return out


def _clip(text: str, limit: int = 120) -> str:
    """textarea など長い値で Slack が読めなくなるのを防ぐ。"""
    text = str(text).replace("\n", " ")
    return text if len(text) <= limit else text[:limit] + "…"


def _is_custom(item_id: str) -> bool:
    from app.core.schema import CUSTOM_ITEM_PATTERN
    return bool(CUSTOM_ITEM_PATTERN.match(item_id))


def _condition_item_ids(condition: Any) -> set[str]:
    """検索条件に登場する項目 ID を再帰的に集める。起動時の実在検証に使う。"""
    found: set[str] = set()
    if not isinstance(condition, dict):
        return found
    if "itemId" in condition:
        found.add(condition["itemId"])
    for entry in condition.get("items", []) or []:
        found |= _condition_item_ids(entry)
    return found
