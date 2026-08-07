"""エントリポイント。

    py -3 -m app.main --check                                  疎通・権限・項目IDの検証のみ
    py -3 -m app.main --bootstrap                              スナップショット構築（通知しない）
    py -3 -m app.main --once --watcher career_status           1サイクルだけ実行
    py -3 -m app.main --once --dry-run                         通知を ops チャンネルへ寄せる
    py -3 -m app.main --since "2026-08-05 15:00:00" --once     カーソルを指定時刻に戻して実行
    py -3 -m app.main                                          常駐

PoC は手元 Windows PC での断続起動を前提にしている（仕様書 9.5）。
起動時に前回実行からの経過を出し、「止まっていた」のか「壊れた」のかを区別できるようにする。
"""
from __future__ import annotations

import argparse
import sys
from datetime import timedelta
from pathlib import Path
from typing import Any

from app.core.auth import TokenManager
from app.core.budget import UnlimitedBudget
from app.core.client import CpClient
from app.core.config import (
    ROOT,
    AppConfig,
    load_app_config,
    load_dotenv,
    load_templates,
    load_watchers_config,
)
from app.core.errors import ConfigError, CpNotifyError
from app.core.events import Notification
from app.core.logging import Logger
from app.core.master import MasterRegistry
from app.core.ratelimit import RequestMetrics, TokenBucket
from app.core.scheduler import Scheduler
from app.core.schema import SchemaRegistry, summarize_customs
from app.core.store import Store
from app.core.timefmt import from_store, now_jst
from app.notifiers.dispatcher import Dispatcher
from app.notifiers.slack import SlackNotifier
from app.watchers.base import Context, Watcher
from app.watchers.resource_watch import ResourceWatcher

# 実装済みのウォッチャー種別。設定の `type` で選ぶ（既定は resource_watch）
WATCHER_TYPES: dict[str, type[Watcher]] = {
    "resource_watch": ResourceWatcher,
}


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="app.main", description="CP進捗通知")
    p.add_argument("--config-dir", type=Path, default=ROOT / "config")
    p.add_argument("--check", action="store_true",
                   help="起動時チェックだけ実行して終了する（通知しない）")
    p.add_argument("--bootstrap", action="store_true",
                   help="スナップショットを構築するのみ。通知しない")
    p.add_argument("--once", action="store_true",
                   help="1サイクルだけ実行して終了する")
    p.add_argument("--watcher", type=str, default=None,
                   help="指定したウォッチャーだけ実行する")
    p.add_argument("--since", type=str, default=None,
                   help='カーソルを強制設定する（"yyyy-MM-dd HH:mm:ss"）')
    p.add_argument("--dry-run", action="store_true",
                   help="すべての通知を ops チャンネルへリダイレクトする")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    load_dotenv()

    try:
        app_config = load_app_config(args.config_dir / "app.yaml")
        watchers_config = load_watchers_config(args.config_dir / "watchers.yaml")
        templates = load_templates(args.config_dir / "templates.yaml")
    except ConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 2

    logger = Logger(log_dir=app_config.log_dir)

    try:
        runtime = _build_runtime(app_config, watchers_config, templates, logger,
                                 dry_run=args.dry_run, bootstrap=args.bootstrap)
    except (ConfigError, CpNotifyError) as exc:
        logger.error("startup_failed", error=f"{type(exc).__name__}: {exc}")
        return 2

    ctx, scheduler, watchers = runtime

    try:
        if args.check:
            logger.info("check_ok", watchers=[w.id for w in watchers])
            return 0

        if args.since:
            _force_cursor(ctx, watchers, args.since, args.watcher, logger)

        _report_gap(ctx, watchers, logger)

        if args.bootstrap:
            return _run_bootstrap(ctx, scheduler, watchers, args.watcher, logger)

        if args.once:
            results = scheduler.run_once(only=args.watcher)
            return 0 if all(r.ok for r in results) else 1

        scheduler.install_signal_handlers()
        scheduler.run_forever()
        return 0
    finally:
        ctx.store.close()


# --- 組み立て -------------------------------------------------------------

def _build_runtime(
    app_config: AppConfig,
    watchers_config: dict[str, dict[str, Any]],
    templates: dict[str, Any],
    logger: Logger,
    dry_run: bool,
    bootstrap: bool,
) -> tuple[Context, Scheduler, list[Watcher]]:
    """起動時チェックを兼ねた組み立て。失敗したら起動しない（仕様書 9.1）。"""

    # 1. 必須の環境変数
    api_key = app_config.api_key  # 無ければ ConfigError

    # 2. トークンバケットとクライアント
    bucket = TokenBucket(app_config.rate_limit.tokens_per_second,
                         app_config.rate_limit.bucket_capacity)
    metrics = RequestMetrics(app_config.rate_limit.limit_per_minute,
                             app_config.rate_limit.warn_threshold_ratio)
    client = CpClient(app_config.base_url, bucket=bucket, metrics=metrics,
                      logger=logger, timeout=app_config.http_timeout_seconds)
    # TokenManager はトークン取得に client を使い、client は認可に TokenManager を使う。
    # 相互参照はここ 1 箇所で閉じる
    token_manager = TokenManager(api_key, client.post_token)
    client.set_token_manager(token_manager)

    # 3. 疎通（トークン取得）。失敗したら起動しない
    token_manager.get_token()
    logger.info("auth_ok", base_url=app_config.base_url)

    store = Store(app_config.store_path)
    schema = SchemaRegistry(client, logger)
    master = MasterRegistry(client, logger)

    slack = SlackNotifier(
        app_config.slack_webhook_envs, logger,
        dry_run_channel_key=app_config.dry_run_channel_key if dry_run else None,
    )
    dispatcher = Dispatcher([slack], store, logger,
                            max_per_cycle=app_config.max_notifications_per_cycle)

    ctx = Context(
        client=client, store=store, schema=schema, master=master,
        dispatcher=dispatcher, logger=logger, app_config=app_config,
        templates=templates, bootstrap=bootstrap,
    )

    # 4. ウォッチャーの生成と検証
    watchers: list[Watcher] = []
    for watcher_id, config in watchers_config.items():
        type_name = config.get("type", "resource_watch")
        watcher_type = WATCHER_TYPES.get(type_name)
        if watcher_type is None:
            if config.get("enabled"):
                raise ConfigError(
                    f"watcher '{watcher_id}' uses type '{type_name}' which is not implemented"
                )
            logger.info("watcher_skipped", watcher_id=watcher_id, reason="not implemented")
            continue
        watchers.append(watcher_type(watcher_id, config))

    if not watchers:
        raise ConfigError("no implemented watcher is configured")

    startup_budget = UnlimitedBudget("startup")
    for watcher in watchers:
        # 5. 項目 ID の実在検証（実環境の schema を正とする）
        watcher.validate(ctx)
        # 6. 通知本文で使うマスタの先読み
        master.preload(watcher.required_masters(), startup_budget)

    # オリつく項目の一覧をログに出す。新しく追加されたときに気づける
    logger.info("custom_items_in_schema",
                resource="career", items=summarize_customs(schema.get("career")))

    # 7. 通知先の設定確認。URL が無いチャンネルは起動時に気づきたい
    configured = set(slack.configured_channels())
    required = {w.config.get("notify", {}).get("channel_key")
                for w in watchers if w.enabled}
    missing = sorted(c for c in required if c and c not in configured)
    if missing:
        raise ConfigError(f"slack webhook URL is not set for channels: {missing}")
    if dry_run and app_config.dry_run_channel_key not in configured:
        raise ConfigError(
            f"--dry-run needs the '{app_config.dry_run_channel_key}' webhook to be set")

    logger.info("startup_ok",
                watchers=[{"id": w.id, "enabled": w.enabled,
                           "interval_minutes": w.interval_minutes} for w in watchers],
                rate_limit_per_minute=app_config.rate_limit.limit_per_minute,
                store=str(app_config.store_path),
                dry_run=dry_run)

    scheduler = Scheduler(ctx=ctx, logger=logger, metrics=metrics)
    for watcher in watchers:
        scheduler.register(watcher)
    return ctx, scheduler, watchers


def _run_bootstrap(ctx: Context, scheduler: Scheduler, watchers: list[Watcher],
                   only: str | None, logger: Logger) -> int:
    """ブートストラップを完了まで回す。

    企業 9,845件・部署 14,565件のような大きいリソースは 1 サイクルでは終わらない。
    予算切れで中断してもページ単位で再開できるので、完了するまで繰り返す。
    **60 req/分 の制限があるため、全リソースで数時間かかる。**
    """
    # ID 指定があればそれだけ。無ければ有効なウォッチャーすべて
    targets = [w for w in watchers if (w.id == only if only else w.enabled)]
    if not targets:
        logger.error("bootstrap_no_target", requested=only)
        return 1
    logger.info("bootstrap_started", watchers=[w.id for w in targets])

    for watcher in targets:
        rounds = 0
        while True:
            rounds += 1
            result = scheduler.run_once(only=watcher.id)
            if not result or not result[0].ok:
                logger.error("bootstrap_failed", watcher_id=watcher.id,
                             error=result[0].error if result else "no result")
                return 1
            done = getattr(watcher, "is_bootstrapped", None)
            if done is None or done(ctx):
                logger.info("bootstrap_complete", watcher_id=watcher.id, rounds=rounds)
                break

    logger.info("bootstrap_all_complete", watchers=[w.id for w in targets])
    return 0


# --- 断続起動のための補助 --------------------------------------------------

def _report_gap(ctx: Context, watchers: list[Watcher], logger: Logger) -> None:
    """前回実行からの経過を出す（仕様書 9.5.4）。

    通知が来ない原因が「止まっていたから」なのか「壊れたから」なのかを
    区別できるようにするため。
    """
    threshold = timedelta(minutes=ctx.app_config.catchup.gap_notify_threshold_minutes)
    now = now_jst()
    for watcher in watchers:
        cursor = ctx.store.get_cursor(watcher.id)
        if cursor is None:
            logger.info("no_cursor", watcher_id=watcher.id,
                        hint="run with --bootstrap to create the baseline")
            continue
        gap = now - cursor.updated_at
        if gap < threshold:
            continue
        hours = gap.total_seconds() / 3600
        logger.warn("startup_gap", watcher_id=watcher.id,
                    gap_hours=round(hours, 1),
                    last_run_at=cursor.updated_at.isoformat())
        if ctx.app_config.catchup.notify_gap_to_ops:
            _notify_ops(ctx, watcher.id, hours, cursor.updated_at.isoformat())


def _notify_ops(ctx: Context, watcher_id: str, hours: float, last_run: str) -> None:
    body = (f"*CP進捗通知 を起動しました*\n"
            f"ウォッチャー: `{watcher_id}`\n"
            f"前回実行: {last_run}（約 {hours:.1f} 時間前）\n"
            f"この間の変化はカーソルから追いかけます。"
            f"求職者の項目は最後の状態のみが通知されます（仕様書 9.5.2）。")
    notification = Notification(
        watcher_id=watcher_id,
        resource_id="__startup__",
        event_type="startup_gap",
        # 起動ごとに 1 通。同じ時刻での重複起動は冪等キーで抑制される
        digest=f"{last_run}:{round(hours, 1)}",
        channel_key=ctx.app_config.dry_run_channel_key,
        subject="[CP] 起動しました",
        body=body,
    )
    ctx.dispatcher.dispatch([notification])


def _force_cursor(ctx: Context, watchers: list[Watcher], since: str,
                  only: str | None, logger: Logger) -> None:
    """`--since` でカーソルを巻き戻す。テスト用。

    冪等キーが効くので、同じ変化は再送されない。
    再送させたい場合は `notified` の該当行を消す必要がある。
    """
    value = from_store(since)
    for watcher in watchers:
        if only and watcher.id != only:
            continue
        ctx.store.set_cursor(watcher.id, value, page_offset=0, bootstrapped=True)
        logger.warn("cursor_forced", watcher_id=watcher.id, cursor_value=value.isoformat())


if __name__ == "__main__":
    sys.exit(main())
