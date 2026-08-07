"""ウォッチャーの基底と実行コンテキスト。

- `watchers/` 同士は import しない。共有したいものは `core/` に上げる
  （`rules/50-code-style.md`）。
- `run()` は例外を外に投げない。捕捉してログに残し、失敗を戻り値で返す。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from app.core.budget import RequestBudget
from app.core.client import CpClient
from app.core.config import AppConfig
from app.core.errors import BudgetExhausted, CpNotifyError
from app.core.events import CycleResult
from app.core.logging import Logger
from app.core.master import MasterRegistry
from app.core.schema import SchemaRegistry
from app.core.store import Store
from app.notifiers.dispatcher import Dispatcher


@dataclass
class Context:
    """ウォッチャーが使う共通基盤一式。"""

    client: CpClient
    store: Store
    schema: SchemaRegistry
    master: MasterRegistry
    dispatcher: Dispatcher
    logger: Logger
    app_config: AppConfig
    templates: dict[str, Any]
    bootstrap: bool = False


class Watcher(ABC):
    """1 つの監視ルールを実行する単位。

    カーソル・予算・実行間隔をウォッチャーごとに持つ。
    ウォッチャー間でカーソルを共有しないので、1 つを停止・再開・巻き戻ししても
    他に影響しない（`rules/30-state-and-idempotency.md`）。
    """

    def __init__(self, watcher_id: str, config: dict[str, Any]):
        self.id = watcher_id
        self.config = config
        self.enabled: bool = bool(config.get("enabled", False))
        self.interval_minutes: int = int(config.get("interval_minutes", 15))
        self.priority: int = int(config.get("priority", 100))
        self.budget_per_cycle: int = int(config.get("budget_per_cycle", 60))
        self.overlap_seconds: int = int(config.get("overlap_seconds", 60))

    # --- サブクラスが実装する ------------------------------------------

    @abstractmethod
    def validate(self, ctx: Context) -> None:
        """起動時チェック。設定の項目 ID が実在するか等を検証する。

        問題があれば例外を投げて **起動を失敗させる**。
        """

    @abstractmethod
    def required_masters(self) -> list[str]:
        """通知本文で使うマスタ名。起動時に先読みする。"""

    @abstractmethod
    def execute(self, ctx: Context, budget: RequestBudget) -> CycleResult:
        """1 サイクルの本体。例外はここで投げてよい（`run` が捕捉する）。"""

    @abstractmethod
    def bootstrap(self, ctx: Context, budget: RequestBudget) -> CycleResult:
        """スナップショットの構築のみを行う。**通知を出さない。**"""

    # --- スケジューラから呼ばれる ---------------------------------------

    def run(self, ctx: Context) -> CycleResult:
        """例外を外に出さない。失敗は戻り値で返す（`rules/50-code-style.md`）。"""
        budget = RequestBudget(self.budget_per_cycle, self.id)
        ctx.client.current_watcher = self.id
        try:
            if ctx.bootstrap:
                result = self.bootstrap(ctx, budget)
            else:
                result = self.execute(ctx, budget)
            result.requests_used = budget.used
            return result
        except BudgetExhausted:
            # 予算切れは異常ではない。カーソルを進めずに次サイクルへ持ち越す
            ctx.logger.info("cycle_exhausted", watcher_id=self.id, requests_used=budget.used)
            return CycleResult(ok=True, requests_used=budget.used, exhausted=True)
        except CpNotifyError as exc:
            ctx.logger.error("cycle_failed", watcher_id=self.id,
                             error=f"{type(exc).__name__}: {exc}")
            return CycleResult(ok=False, requests_used=budget.used, error=str(exc))
        except Exception as exc:  # noqa: BLE001 - 1つの失敗が他を巻き込まないため
            ctx.logger.error("cycle_crashed", watcher_id=self.id,
                             error=f"{type(exc).__name__}: {exc}")
            return CycleResult(ok=False, requests_used=budget.used, error=str(exc))
        finally:
            ctx.client.current_watcher = "-"
