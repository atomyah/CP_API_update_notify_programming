"""求職者名・求人名・企業名の解決キャッシュ（仕様書 5.3「`core/resolver.py`」）。

通知本文には人が読める名前が要るが、`progress_history` / `progress` が持っているのは
ID だけなので、別リソースを `select` して名前に直す必要がある。
これらは**変化が遅い**ので、TTL 付きの LRU でキャッシュする。

**このキャッシュがリクエスト数に直結する。**要件2では進捗が動くたびに
求職者・求人・企業の名前が要る。キャッシュが効かなければ通知1件あたり
3リクエストが上乗せされ、効けば 0 になる。

> ⚠️ **担当者メールアドレス（`CAREER#CHARGE_EMAIL`）をここでキャッシュしてはいけない。**
> 要件4の宛先であり、担当者変更の直後に旧担当へ送るのは実害がある。
> 要件4では毎回取り直す（仕様書 5.3）。このクラスは
> **設定に列挙された表示用の項目しか取得しない**ので、宛先を入れない限り事故は起きない。

項目 ID はコードに直書きせず `config/app.yaml` の `name_resolution` から受け取る
（`rules/10-cp-api.md`）。
"""
from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from app.core.budget import RequestBudget
from app.core.client import CpClient
from app.core.config import NameSource
from app.core.errors import CpNotFoundError
from app.core.logging import Logger


@dataclass
class _Entry:
    name: str
    fetched_at: float


@dataclass
class NameResolver:
    """ID → 表示名。TTL 付き LRU。

    解決に失敗しても**通知そのものは落とさない。**名前が出ないより
    「名前が引けなかった」と書いてでも通知が届く方が業務上の価値が高い。
    """

    client: CpClient
    logger: Logger
    sources: dict[str, NameSource] = field(default_factory=dict)
    _cache: dict[str, OrderedDict[str, _Entry]] = field(default_factory=dict)
    hits: int = 0
    misses: int = 0

    def resolve(self, kind: str, resource_id: object,
                budget: RequestBudget | None = None) -> str:
        """`kind`（`career` / `order` / `client`）の ID を表示名にする。

        ID が未設定（`None` / `0` / 空）なら 1 リクエストも使わずに `(未設定)` を返す。
        """
        source = self.sources.get(kind)
        key = _normalize_id(resource_id)
        if source is None or key is None:
            return "(未設定)"

        cache = self._cache.setdefault(kind, OrderedDict())
        entry = cache.get(key)
        if entry is not None and time.time() - entry.fetched_at < source.ttl_seconds:
            cache.move_to_end(key)
            self.hits += 1
            return entry.name

        self.misses += 1
        try:
            values = self.client.select(source.resource, key, source.items, budget)
        except CpNotFoundError:
            # 削除済みのレコードを参照している。通知は落とさず、その旨を本文に出す
            self.logger.warn("name_unresolved", resource=source.resource,
                             resource_id=key, reason="not_found")
            return f"(取得できません: {source.resource} {key})"

        name = source.render(values) or f"{source.resource} {key}"
        cache[key] = _Entry(name=name, fetched_at=time.time())
        cache.move_to_end(key)
        while len(cache) > source.max_entries:
            cache.popitem(last=False)
        return name

    def item_ids(self, kind: str) -> list[str]:
        """起動時に schema と突き合わせるための項目 ID。"""
        source = self.sources.get(kind)
        return list(source.items) if source else []

    def resource_of(self, kind: str) -> str | None:
        source = self.sources.get(kind)
        return source.resource if source else None

    def stats(self) -> dict[str, int]:
        """キャッシュの効きをログに出すため。ヒット率が低いと流量が跳ねる。"""
        return {
            "name_cache_hits": self.hits,
            "name_cache_misses": self.misses,
            "name_cache_entries": sum(len(c) for c in self._cache.values()),
        }


def _normalize_id(resource_id: object) -> str | None:
    """CP の ID は number で返る（`18` / `18.0` / `"18"` を同じ ID として扱う）。

    `None` / 空 / `0` は「未設定」。CP は未設定の参照 ID を `0` で表す（実測）。
    """
    if resource_id is None:
        return None
    if isinstance(resource_id, float) and resource_id.is_integer():
        resource_id = int(resource_id)
    text = str(resource_id).strip()
    if text in ("", "0"):
        return None
    return text
