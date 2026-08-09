"""設定の読み込み。

**ルールの読み込みはここ 1 箇所に閉じる。**
将来スプレッドシート等から読む実装に差し替えられるようにするため、
ウォッチャー本体はルールの出所を知らない（`docs/design/01-architecture.md` 6.2）。

秘密情報は設定ファイルに書かず、`.env`（＝環境変数）から読む
（`rules/40-secrets-and-security.md`）。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from app.core.errors import ConfigError

ROOT = Path(__file__).resolve().parents[2]


def load_dotenv(path: Path | None = None) -> None:
    """`.env` を環境変数に読み込む。既に設定されている変数は上書きしない。

    外部依存を増やさないための最小実装。`KEY=VALUE` 形式のみを解釈する。
    """
    env_path = path or (ROOT / ".env")
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        name = name.strip()
        value = value.strip().strip('"').strip("'")
        if name and name not in os.environ:
            os.environ[name] = value


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(f"environment variable {name} is not set (see .env.example)")
    return value


@dataclass
class RateLimitConfig:
    tokens_per_second: float = 1.0      # = 60 req/分。CP 上限 240 の 25%
    bucket_capacity: int = 20
    warn_threshold_ratio: float = 0.8

    @property
    def limit_per_minute(self) -> float:
        return self.tokens_per_second * 60.0


@dataclass
class NameSource:
    """通知本文に出す名前を、どのリソースのどの項目から作るか（`core/resolver.py`）。

    項目 ID をコードに直書きしないため、ここで受け取る（`rules/10-cp-api.md`）。

    Attributes:
        resource:     解決先の CP リソース（`career` / `order` / `client`）
        items:        取得する項目 ID。**表示に使うものだけを列挙する**
        template:     `{項目ID}` を差し込んで名前を組み立てる
        ttl_seconds:  キャッシュの寿命
        max_entries:  LRU の上限件数
    """

    resource: str
    items: list[str]
    template: str
    ttl_seconds: int = 3600
    max_entries: int = 1000

    def render(self, values: dict[str, Any]) -> str:
        text = self.template
        for item_id in self.items:
            value = values.get(item_id)
            text = text.replace("{" + item_id + "}", "" if value is None else str(value))
        # 姓だけ入っていて名が空のときに余分な空白が残らないように潰す
        return " ".join(text.split())


@dataclass
class CatchupConfig:
    """断続起動（PoC）からの再開時の挙動（仕様書 9.5）。"""

    catchup_max_window_days: int = 30
    notify_gap_to_ops: bool = True
    gap_notify_threshold_minutes: int = 60


@dataclass
class AppConfig:
    base_url: str = "https://api.careerplus.jp"
    api_key_env: str = "CP_NOTIFY_API_KEY"
    rate_limit: RateLimitConfig = field(default_factory=RateLimitConfig)
    catchup: CatchupConfig = field(default_factory=CatchupConfig)
    store_path: Path = ROOT / "var" / "state.sqlite3"
    log_dir: Path = ROOT / "var" / "logs"
    slack_webhook_envs: dict[str, str] = field(default_factory=dict)
    name_resolution: dict[str, NameSource] = field(default_factory=dict)
    max_notifications_per_cycle: int = 50
    max_pages_per_cycle: int = 10
    http_timeout_seconds: float = 60.0
    dry_run_channel_key: str = "ops"
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def api_key(self) -> str:
        return require_env(self.api_key_env)


def load_app_config(path: Path) -> AppConfig:
    data = _read_yaml(path)
    cp = data.get("cp_api", {}) or {}
    rl = data.get("rate_limit", {}) or {}
    store = data.get("store", {}) or {}
    limits = data.get("limits", {}) or {}
    catchup = data.get("catchup", {}) or {}
    slack = ((data.get("notifiers", {}) or {}).get("slack", {}) or {})

    webhooks = {}
    for key, entry in (slack.get("webhooks", {}) or {}).items():
        env_name = (entry or {}).get("url_env")
        if not env_name:
            raise ConfigError(f"notifiers.slack.webhooks.{key}.url_env is required")
        webhooks[key] = env_name

    names = _load_name_sources(data.get("name_resolution", {}) or {})

    cfg = AppConfig(
        base_url=cp.get("base_url", "https://api.careerplus.jp"),
        api_key_env=cp.get("api_key_env", "CP_NOTIFY_API_KEY"),
        rate_limit=RateLimitConfig(
            tokens_per_second=float(rl.get("tokens_per_second", 1.0)),
            bucket_capacity=int(rl.get("bucket_capacity", 20)),
            warn_threshold_ratio=float(rl.get("warn_threshold_ratio", 0.8)),
        ),
        catchup=CatchupConfig(
            catchup_max_window_days=int(catchup.get("catchup_max_window_days", 30)),
            notify_gap_to_ops=bool(catchup.get("notify_gap_to_ops", True)),
            gap_notify_threshold_minutes=int(
                catchup.get("gap_notify_threshold_minutes", 60)),
        ),
        store_path=_resolve(store.get("path", "var/state.sqlite3")),
        log_dir=_resolve(store.get("log_dir", "var/logs")),
        slack_webhook_envs=webhooks,
        name_resolution=names,
        max_notifications_per_cycle=int(limits.get("max_notifications_per_cycle", 50)),
        max_pages_per_cycle=int(limits.get("max_pages_per_cycle", 10)),
        http_timeout_seconds=float(limits.get("http_timeout_seconds", 60.0)),
        raw=data,
    )

    # 上限の 50%（120 req/分）を超える設定は事故なので拒む（`rules/20-rate-limit.md`）
    if cfg.rate_limit.limit_per_minute > 120:
        raise ConfigError(
            f"rate_limit.tokens_per_second={cfg.rate_limit.tokens_per_second} "
            f"exceeds the emergency ceiling of 120 req/min (CP limit is 240)"
        )
    return cfg


def _load_name_sources(data: dict[str, Any]) -> dict[str, NameSource]:
    """`name_resolution` セクションを読む（`core/resolver.py`）。

    未設定でも起動できるようにする。名前が引けない場合は通知本文に
    `(未設定)` が出るだけで、通知そのものは落とさない。
    """
    sources: dict[str, NameSource] = {}
    for kind, entry in data.items():
        entry = entry or {}
        for key in ("resource", "items", "template"):
            if not entry.get(key):
                raise ConfigError(f"name_resolution.{kind}.{key} is required")
        items = entry["items"]
        if not isinstance(items, list):
            raise ConfigError(f"name_resolution.{kind}.items must be a list")
        sources[kind] = NameSource(
            resource=entry["resource"],
            items=[str(i) for i in items],
            template=str(entry["template"]),
            ttl_seconds=int(entry.get("ttl_seconds", 3600)),
            max_entries=int(entry.get("max_entries", 1000)),
        )
    return sources


def load_watchers_config(path: Path) -> dict[str, dict[str, Any]]:
    data = _read_yaml(path)
    watchers = data.get("watchers")
    if not isinstance(watchers, dict) or not watchers:
        raise ConfigError(f"{path}: 'watchers' section is missing or empty")
    return watchers


def load_templates(path: Path) -> dict[str, Any]:
    """通知本文のテンプレート。文言をコードに直書きしないため（`rules/50-code-style.md`）。"""
    data = _read_yaml(path)
    templates = data.get("templates")
    if not isinstance(templates, dict) or not templates:
        raise ConfigError(f"{path}: 'templates' section is missing or empty")
    return templates


def _read_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise ConfigError(f"config file not found: {path}")
    with path.open("r", encoding="utf-8") as fp:
        data = yaml.safe_load(fp)
    if not isinstance(data, dict):
        raise ConfigError(f"{path}: top level must be a mapping")
    return data


def _resolve(value: str) -> Path:
    p = Path(value)
    return p if p.is_absolute() else (ROOT / p)
