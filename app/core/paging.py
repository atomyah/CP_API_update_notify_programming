"""検索のページングを 1 箇所にまとめる。

ウォッチャーは互いに import しない。共有したいものは `core/` に上げる
（`rules/50-code-style.md`）。

守るべき点は 3 つ:

1. `limit` は常に 100。小さくするとページ数＝リクエスト数が増える
   （`rules/20-rate-limit.md`）。
2. `sort` を必ず指定する。未指定だと並び順が保証されずページングが壊れる。
3. **ページ数に上限を設ける。**深い offset はタイムアウトの可能性があると
   仕様書に明記されている。打ち切ったら呼び出し側は
   **カーソルを前進させてはいけない。**
"""
from __future__ import annotations

from typing import Any, Protocol

from app.core.budget import RequestBudget
from app.core.client import MAX_LIMIT
from app.core.logging import Logger


class _Searchable(Protocol):
    def search(self, resource: str, condition: dict[str, Any] | None = None,
               sort: list[dict[str, str]] | None = None, limit: int = MAX_LIMIT,
               offset: int = 0, budget: RequestBudget | None = None
               ) -> tuple[list[str], int]:
        ...


def search_ids(
    client: _Searchable,
    resource: str,
    condition: dict[str, Any] | None,
    sort: list[dict[str, str]],
    budget: RequestBudget,
    logger: Logger,
    watcher_id: str,
    max_pages: int,
) -> tuple[list[str], bool]:
    """条件に一致する ID を集める。

    Returns:
        `(ids, capped)`。`capped` が True なら**全件を見きれていない。**
        呼び出し側はカーソルを進めず、次サイクルで続きを拾う。
    """
    ids: list[str] = []
    offset = 0
    for _ in range(max_pages):
        page, count = client.search(
            resource, condition=condition, sort=sort,
            limit=MAX_LIMIT, offset=offset, budget=budget)
        ids.extend(page)
        offset += len(page)
        if not page or len(page) < MAX_LIMIT or offset >= count:
            return ids, False

    logger.warn("paging_capped", watcher_id=watcher_id, resource=resource,
                max_pages=max_pages, collected=len(ids))
    return ids, True
