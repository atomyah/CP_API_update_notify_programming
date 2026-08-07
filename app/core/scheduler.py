"""ウォッチャーの逐次実行スケジューラ。

- **1つずつ逐次実行する。同時に走るウォッチャーは常に 0 か 1**
  （`rules/20-rate-limit.md`）。並行化はトークンバケットの競合と
  可観測性の悪化に見合わない。加えてトークンのリフレッシュが並行実行と相性が悪い。
- 予算切れで中断したウォッチャーは即座に次サイクル候補へ戻す。
  優先度の高いウォッチャーが待っていれば、そちらが先に入る。
- **例外は 1 つのウォッチャーの中に閉じる。**他のウォッチャーの実行を続ける。
- 連続失敗が閾値を超えたら自動停止する。壊れたまま回り続けて予算を食う方が有害。
"""
from __future__ import annotations

import signal
import time
from dataclasses import dataclass, field

from app.core.events import CycleResult
from app.core.logging import Logger
from app.core.ratelimit import RequestMetrics
from app.core.timefmt import now_jst
from app.watchers.base import Context, Watcher

MAX_CONSECUTIVE_FAILURES = 5
TICK_SECONDS = 1.0


@dataclass
class WatcherState:
    watcher: Watcher
    next_run_at: float = 0.0        # 壁時計（time.time）。スリープ復帰後は即座に実行される
    consecutive_failures: int = 0
    stopped: bool = False
    last_result: CycleResult | None = None
    cycles: int = 0

    @property
    def id(self) -> str:
        return self.watcher.id


@dataclass
class Scheduler:
    ctx: Context
    logger: Logger
    metrics: RequestMetrics
    states: list[WatcherState] = field(default_factory=list)
    _shutdown: bool = False

    def register(self, watcher: Watcher) -> None:
        self.states.append(WatcherState(watcher=watcher))

    def install_signal_handlers(self) -> None:
        """SIGTERM / SIGINT で**現在のサイクルを完了させてから**終了する。"""
        def handler(signum, _frame):  # noqa: ANN001
            self.logger.info("shutdown_requested", signal=signum)
            self._shutdown = True

        signal.signal(signal.SIGINT, handler)
        try:
            signal.signal(signal.SIGTERM, handler)
        except (AttributeError, ValueError):
            # Windows では SIGTERM が使えない場合がある。SIGINT だけで運用する
            pass

    def run_once(self, only: str | None = None) -> list[CycleResult]:
        """全ウォッチャー（または指定した 1 つ）を 1 サイクルだけ実行する。

        テスト用。ポーリング間隔を待たずに動作確認できる（仕様書 9.2）。
        """
        results = []
        for state in self._ordered():
            if only and state.id != only:
                continue
            if not state.watcher.enabled and not only:
                continue
            results.append(self._run_one(state))
        return results

    def run_forever(self) -> None:
        self.logger.info(
            "scheduler_started",
            watchers=[s.id for s in self._ordered() if s.watcher.enabled],
            disabled=[s.id for s in self._ordered() if not s.watcher.enabled],
        )
        while not self._shutdown:
            state = self._pick_due()
            if state is None:
                time.sleep(TICK_SECONDS)
                self._check_rate_health()
                continue
            self._run_one(state)
        self.logger.info("scheduler_stopped")

    # --- 内部 ------------------------------------------------------------

    def _ordered(self) -> list[WatcherState]:
        return sorted(self.states, key=lambda s: (s.watcher.priority, s.id))

    def _pick_due(self) -> WatcherState | None:
        now = time.time()
        for state in self._ordered():
            if state.stopped or not state.watcher.enabled:
                continue
            if state.next_run_at <= now:
                return state
        return None

    def _run_one(self, state: WatcherState) -> CycleResult:
        started = time.monotonic()
        result = state.watcher.run(self.ctx)
        state.last_result = result
        state.cycles += 1

        # 「何件取得して何件通知したか」を各サイクルの終わりに 1 行で出す
        # （これが読めないと流量とカーソルの妥当性を追えない。`rules/50-code-style.md`）
        self.logger.info(
            "cycle_done",
            watcher_id=state.id,
            duration_seconds=round(time.monotonic() - started, 2),
            **result.as_log_fields(),
        )

        if result.ok:
            state.consecutive_failures = 0
        else:
            state.consecutive_failures += 1
            if state.consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                state.stopped = True
                self.logger.error(
                    "watcher_auto_stopped",
                    watcher_id=state.id,
                    consecutive_failures=state.consecutive_failures,
                    hint="fix the cause and restart; the cursor was not advanced",
                )

        # 予算切れなら間隔を待たずに再スケジュールする。
        # ただし優先度の高いウォッチャーが先に入れるよう、いったんループへ戻る
        if result.exhausted:
            state.next_run_at = time.time()
        else:
            state.next_run_at = time.time() + state.watcher.interval_minutes * 60

        self._check_rate_health()
        return result

    def _check_rate_health(self) -> None:
        sustained = self.metrics.check_sustained_overuse()
        if sustained is not None:
            self.logger.warn(
                "rate_budget_pressure",
                rate_per_minute=round(self.metrics.rate_per_minute(), 1),
                limit_per_minute=self.metrics.limit_per_minute,
                sustained_seconds=int(sustained),
                hint="check that scan volume scales with recent activity, not total records",
            )

    def status(self) -> list[dict]:
        return [
            {
                "watcher_id": s.id,
                "enabled": s.watcher.enabled,
                "stopped": s.stopped,
                "cycles": s.cycles,
                "consecutive_failures": s.consecutive_failures,
                "next_run_at": now_jst().isoformat() if s.next_run_at <= time.time() else None,
            }
            for s in self._ordered()
        ]
