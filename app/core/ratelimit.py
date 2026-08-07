"""グローバルなトークンバケットと流量メトリクス。

**このアプリで唯一絶対に守る不変条件: CP への HTTP リクエストは必ずここを通る**
（`rules/20-rate-limit.md`）。

CP の上限は 240 req/分。超えると API サービスを停止される可能性があり、
性能ではなく可用性の問題として扱う。既定は上限の 25%（60 req/分）。

トークンが無ければ **ブロックする。捨てない・スキップしない。**
"""
from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field


class TokenBucket:
    """トークンバケット。

    補充レート `tokens_per_second`、容量 `capacity`。
    `acquire()` はトークンが貯まるまでブロックする。
    """

    def __init__(self, tokens_per_second: float, capacity: int):
        if tokens_per_second <= 0:
            raise ValueError("tokens_per_second must be positive")
        if capacity < 1:
            raise ValueError("capacity must be >= 1")
        self._rate = float(tokens_per_second)
        self._capacity = float(capacity)
        self._tokens = float(capacity)
        self._last = time.monotonic()
        self._lock = threading.Lock()

    def acquire(self, tokens: int = 1) -> float:
        """トークンを取得する。取れるまでブロックし、待った秒数を返す。"""
        waited = 0.0
        while True:
            with self._lock:
                self._refill()
                if self._tokens >= tokens:
                    self._tokens -= tokens
                    return waited
                # 足りない分が貯まるまでの時間
                deficit = tokens - self._tokens
                sleep_for = deficit / self._rate
            time.sleep(sleep_for)
            waited += sleep_for

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last
        self._last = now
        self._tokens = min(self._capacity, self._tokens + elapsed * self._rate)

    @property
    def available(self) -> float:
        with self._lock:
            self._refill()
            return self._tokens


@dataclass
class RequestMetrics:
    """1分あたりの実リクエスト数を常時記録する（`rules/20-rate-limit.md`）。

    設計上限の 80% を 5 分継続で超えたら警告する。
    """

    limit_per_minute: float
    warn_ratio: float = 0.8
    _timestamps: deque[float] = field(default_factory=lambda: deque(maxlen=20000))
    by_watcher: dict[str, int] = field(default_factory=dict)
    by_endpoint: dict[str, int] = field(default_factory=dict)
    total: int = 0
    _over_since: float | None = None

    def record(self, watcher_id: str, endpoint: str) -> None:
        now = time.monotonic()
        self._timestamps.append(now)
        self.total += 1
        self.by_watcher[watcher_id] = self.by_watcher.get(watcher_id, 0) + 1
        self.by_endpoint[endpoint] = self.by_endpoint.get(endpoint, 0) + 1

    def count_within(self, seconds: float) -> int:
        cutoff = time.monotonic() - seconds
        return sum(1 for t in self._timestamps if t >= cutoff)

    def rate_per_minute(self, window_seconds: float = 60.0) -> float:
        return self.count_within(window_seconds) * 60.0 / window_seconds

    def check_sustained_overuse(self) -> float | None:
        """80% 超が 5 分続いていれば、その継続秒数を返す。そうでなければ None。"""
        rate = self.rate_per_minute(60.0)
        now = time.monotonic()
        if rate >= self.limit_per_minute * self.warn_ratio:
            if self._over_since is None:
                self._over_since = now
            elif now - self._over_since >= 300:
                return now - self._over_since
        else:
            self._over_since = None
        return None
