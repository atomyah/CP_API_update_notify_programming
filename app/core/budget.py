"""1サイクルあたりのリクエスト予算。

各ウォッチャーは 1 サイクルで消費してよいリクエスト数を持ち、
使い切ったら処理を打ち切って進捗を保存し、次サイクルに持ち越す。
**打ち切ったサイクルではカーソルを前進させない**（`rules/20-rate-limit.md`）。

これが無いと、重いウォッチャーが高頻度ウォッチャーを長時間ブロックする。
"""
from __future__ import annotations

from app.core.errors import BudgetExhausted


class RequestBudget:
    """消費のたびに減り、尽きたら `BudgetExhausted` を投げる。

    **リトライも消費する。**「リトライだから」と迂回させない。
    """

    def __init__(self, limit: int, watcher_id: str = "-"):
        self.limit = int(limit)
        self.watcher_id = watcher_id
        self.used = 0

    @property
    def remaining(self) -> int:
        return max(0, self.limit - self.used)

    @property
    def exhausted(self) -> bool:
        return self.used >= self.limit

    def consume(self, n: int = 1) -> None:
        if self.used + n > self.limit:
            raise BudgetExhausted(
                f"watcher={self.watcher_id} budget={self.limit} used={self.used}"
            )
        self.used += n

    def can_afford(self, n: int = 1) -> bool:
        """予算を消費せずに余力だけ確認する。ループの継続判定に使う。"""
        return self.used + n <= self.limit


class UnlimitedBudget(RequestBudget):
    """起動時チェックやブートストラップ用。予算で止めない。"""

    def __init__(self, watcher_id: str = "-"):
        super().__init__(limit=10 ** 9, watcher_id=watcher_id)
