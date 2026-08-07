"""トークンバケットと予算。

**レートを超えないこと**が最優先の検証対象（`rules/50-code-style.md`）。
CP の 240 req/分 を超えると API サービスを停止される可能性がある。
"""
from __future__ import annotations

import time

import pytest

from app.core.budget import RequestBudget, UnlimitedBudget
from app.core.errors import BudgetExhausted
from app.core.ratelimit import RequestMetrics, TokenBucket


def test_burst_is_capped_by_capacity():
    """容量ぶんは即座に取れる。それを超えると待たされる。"""
    bucket = TokenBucket(tokens_per_second=100.0, capacity=5)
    started = time.monotonic()
    for _ in range(5):
        bucket.acquire()
    assert time.monotonic() - started < 0.05

    bucket.acquire()  # 6 個目は補充待ちになる
    assert time.monotonic() - started >= 0.005


def test_rate_is_not_exceeded_over_time():
    """補充レートを超えて取り続けられないこと。

    容量 1・レート 50/秒 で 5 回取ると、少なくとも 4 回ぶんの補充時間がかかる。
    """
    bucket = TokenBucket(tokens_per_second=50.0, capacity=1)
    started = time.monotonic()
    for _ in range(5):
        bucket.acquire()
    elapsed = time.monotonic() - started
    assert elapsed >= 4 / 50.0


def test_acquire_blocks_instead_of_dropping():
    """トークンが無ければブロックする。**捨てない・スキップしない。**"""
    bucket = TokenBucket(tokens_per_second=20.0, capacity=1)
    bucket.acquire()
    waited = bucket.acquire()
    assert waited > 0


def test_invalid_parameters_are_rejected():
    with pytest.raises(ValueError):
        TokenBucket(tokens_per_second=0, capacity=10)
    with pytest.raises(ValueError):
        TokenBucket(tokens_per_second=1, capacity=0)


def test_budget_raises_when_exhausted():
    budget = RequestBudget(3, "w")
    for _ in range(3):
        budget.consume()
    assert budget.exhausted
    with pytest.raises(BudgetExhausted):
        budget.consume()


def test_budget_counts_retries_too():
    """**リトライもトークンと予算を消費する。**「リトライだから」と迂回させない。"""
    budget = RequestBudget(2, "w")
    budget.consume()   # 本来の1回
    budget.consume()   # リトライ
    with pytest.raises(BudgetExhausted):
        budget.consume()


def test_can_afford_does_not_consume():
    budget = RequestBudget(1, "w")
    assert budget.can_afford()
    assert budget.can_afford()
    assert budget.used == 0


def test_unlimited_budget_is_for_startup_only():
    budget = UnlimitedBudget("startup")
    for _ in range(1000):
        budget.consume()
    assert not budget.exhausted


def test_metrics_track_rate_and_breakdown():
    metrics = RequestMetrics(limit_per_minute=60)
    for _ in range(10):
        metrics.record("career_status", "/v1/ext2/career/search")
    metrics.record("career_status", "/v1/ext2/career/select/*")

    assert metrics.total == 11
    assert metrics.by_watcher["career_status"] == 11
    assert metrics.by_endpoint["/v1/ext2/career/search"] == 10
    assert metrics.count_within(60) == 11


def test_metrics_do_not_warn_below_threshold():
    metrics = RequestMetrics(limit_per_minute=60, warn_ratio=0.8)
    metrics.record("w", "/e")
    assert metrics.check_sustained_overuse() is None
