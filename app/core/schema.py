"""リソース定義（schema）の取得・キャッシュ・項目 ID の検証。

**項目一覧 xlsx ではなく実環境の schema を正とする**（`rules/10-cp-api.md`）。
両者に乖離があることは実測で確認済み
（`docs/design/07-verification-results.md` 1章の「副産物」）。

用途は 3 つ:
1. 設定に書かれた項目 ID の実在検証 → 無ければ **起動を失敗させる**
2. 項目タイプの取得（値のパース・通知本文の整形に使う）
3. オリつく項目の発見
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any

from app.core.budget import RequestBudget
from app.core.client import CpClient
from app.core.errors import ConfigError
from app.core.logging import Logger

CACHE_TTL_SECONDS = 24 * 60 * 60

# オリつく項目の itemId は `{PREFIX}#{数値}`（実測）。標準項目は英字の記号名
CUSTOM_ITEM_PATTERN = re.compile(r"^[A-Z_]+#\d+$")


@dataclass(frozen=True)
class ItemDef:
    item_id: str
    label: str
    item_type: str
    is_read_only: bool
    is_sortable: bool
    # 参照マスタ名。`validationRule.codeName` に入っている（実測 2026-08-07）。
    # これが取れるので、監視項目ごとにマスタ名を YAML へ手書きする必要はない
    code_name: str | None = None

    @property
    def is_custom(self) -> bool:
        """オリつく項目か。"""
        return bool(CUSTOM_ITEM_PATTERN.match(self.item_id))


class SchemaRegistry:
    def __init__(self, client: CpClient, logger: Logger):
        self._client = client
        self._log = logger
        self._cache: dict[str, tuple[float, dict[str, ItemDef]]] = {}

    def get(self, resource: str, budget: RequestBudget | None = None) -> dict[str, ItemDef]:
        cached = self._cache.get(resource)
        if cached and time.time() - cached[0] < CACHE_TTL_SECONDS:
            return cached[1]

        raw = self._client.get_schema(resource, budget)
        items = {}
        for entry in raw:
            item_id = entry.get("itemId")
            if not item_id:
                continue
            rule = entry.get("validationRule") or {}
            items[item_id] = ItemDef(
                item_id=item_id,
                label=entry.get("label") or item_id,
                item_type=entry.get("itemType") or "",
                is_read_only=bool(entry.get("isReadOnly")),
                is_sortable=bool(entry.get("isSortable")),
                code_name=rule.get("codeName") or None,
            )
        self._cache[resource] = (time.time(), items)

        customs = sorted(i.item_id for i in items.values() if i.is_custom)
        self._log.info(
            "schema_loaded",
            resource=resource,
            item_count=len(items),
            custom_items=customs,
        )
        return items

    def validate(self, resource: str, item_ids: list[str],
                 budget: RequestBudget | None = None) -> None:
        """設定に書かれた項目 ID が実在するか検証する。

        存在しなければ `ConfigError` を投げて **起動を失敗させる**。
        黙って無視すると、通知が出ないことに気づけないまま運用が始まる。
        """
        items = self.get(resource, budget)
        missing = [i for i in item_ids if i not in items]
        if missing:
            raise ConfigError(
                f"unknown itemIds for resource '{resource}': {missing}. "
                f"The live schema is authoritative; check config/watchers.yaml"
            )

    def describe(self, resource: str, item_id: str,
                 budget: RequestBudget | None = None) -> ItemDef | None:
        return self.get(resource, budget).get(item_id)


def summarize_customs(items: dict[str, ItemDef]) -> list[dict[str, Any]]:
    """オリつく項目の一覧。起動時にログへ出して、追加に気づけるようにする。"""
    return [
        {"itemId": i.item_id, "label": i.label, "itemType": i.item_type}
        for i in sorted(items.values(), key=lambda x: x.item_id)
        if i.is_custom
    ]
