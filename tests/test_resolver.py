"""`NameResolver` — 通知本文に出す名前のキャッシュ（仕様書 5.3）。

**このキャッシュがリクエスト数に直結する。**効かなければ通知 1 件あたり
3 リクエストが上乗せされる。

検証したいこと:
- 同じ ID を引き直してもリクエストが増えない
- TTL を過ぎたら取り直す
- LRU の上限を超えたら古いものから捨てる
- 未設定の ID（`None` / `0` / 空）でリクエストを使わない
- 参照先が消えていても通知を落とさない
"""
from __future__ import annotations

import pytest

from app.core.config import NameSource
from app.core.resolver import NameResolver
from tests.conftest import NAME_SOURCES, FakeCpClient


@pytest.fixture
def client() -> FakeCpClient:
    return FakeCpClient(
        resources={
            "career": {
                "18": {"CAREER#LASTNAME": "惣流", "CAREER#FIRSTNAME": "アスカ"},
                "17": {"CAREER#LASTNAME": "葛城", "CAREER#FIRSTNAME": "ミサト"},
            },
            "order": {"6": {"ORDER#POSITIONNAME": "バックエンドエンジニア"}},
            "client": {"3": {"CLIENT#CLIENTNAME": "株式会社ネルフ"}},
        },
        default_resource="career",
    )


@pytest.fixture
def resolver(client, logger) -> NameResolver:
    return NameResolver(client=client, logger=logger, sources=dict(NAME_SOURCES))


def test_resolves_from_configured_items(resolver):
    assert resolver.resolve("career", 18) == "惣流 アスカ"
    assert resolver.resolve("order", 6) == "バックエンドエンジニア"
    assert resolver.resolve("client", 3) == "株式会社ネルフ"


def test_second_lookup_costs_no_request(resolver, client):
    resolver.resolve("career", 18)
    resolver.resolve("career", 18)
    resolver.resolve("career", 18)

    assert client.select_calls == ["18"]
    assert resolver.stats()["name_cache_hits"] == 2


def test_number_and_string_ids_share_one_entry(resolver, client):
    """CP は ID を JSON 数値で返す。`18` / `18.0` / `"18"` は同じレコード。"""
    resolver.resolve("career", 18)
    resolver.resolve("career", 18.0)
    resolver.resolve("career", "18")

    assert client.select_calls == ["18"]


@pytest.mark.parametrize("value", [None, 0, "0", "", "  "])
def test_unset_id_costs_no_request(resolver, client, value):
    """未設定の参照 ID は CP では `0` か `None`（実測）。引きに行かない。"""
    assert resolver.resolve("career", value) == "(未設定)"
    assert client.select_calls == []


def test_expired_entry_is_refetched(client, logger):
    sources = {"career": NameSource(
        resource="career",
        items=["CAREER#LASTNAME", "CAREER#FIRSTNAME"],
        template="{CAREER#LASTNAME} {CAREER#FIRSTNAME}",
        ttl_seconds=0,
    )}
    resolver = NameResolver(client=client, logger=logger, sources=sources)

    resolver.resolve("career", 18)
    resolver.resolve("career", 18)

    assert client.select_calls == ["18", "18"]


def test_lru_evicts_the_least_recently_used(client, logger):
    sources = {"career": NameSource(
        resource="career",
        items=["CAREER#LASTNAME", "CAREER#FIRSTNAME"],
        template="{CAREER#LASTNAME} {CAREER#FIRSTNAME}",
        max_entries=1,
    )}
    resolver = NameResolver(client=client, logger=logger, sources=sources)

    resolver.resolve("career", 18)
    resolver.resolve("career", 17)
    resolver.resolve("career", 18)

    assert client.select_calls == ["18", "17", "18"]
    assert resolver.stats()["name_cache_entries"] == 1


def test_missing_record_does_not_break_the_notification(resolver):
    """参照先が削除されていても、通知そのものは落とさない。

    名前が出ないより「引けなかった」と書いてでも届く方が業務上の価値が高い。
    """
    name = resolver.resolve("career", 999)

    assert "career" in name and "999" in name


def test_unconfigured_kind_is_not_fatal(resolver):
    assert resolver.resolve("department", 1) == "(未設定)"
