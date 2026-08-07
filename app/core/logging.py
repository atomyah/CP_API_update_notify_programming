"""構造化ログ（1行1 JSON）。

- ログメッセージは英語、コメントとドキュメントは日本語（`rules/50-code-style.md`）。
- **個人情報を出さない。**値はマスクし、項目 ID とリソース ID のみを出す
  （`rules/40-secrets-and-security.md`）。
- 最低限 `watcher_id`, `event`, `resource_id`, `request_id` を含める。
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from app.core.timefmt import now_jst

# ログに絶対に出さないキー。値が渡されても伏せる
_SECRET_KEYS = {
    "api_key", "apikey", "access_token", "accesstoken", "refresh_token",
    "refreshtoken", "authorization", "password", "webhook", "url", "token",
}


class Logger:
    """JSON Lines を stdout と（任意で）ファイルへ書く。

    ローテーションは日付ごとのファイル分割で済ませる。PoC に外部依存は要らない。
    """

    def __init__(self, log_dir: Path | None = None, echo: bool = True):
        self._log_dir = log_dir
        self._echo = echo
        if log_dir is not None:
            log_dir.mkdir(parents=True, exist_ok=True)
        if echo:
            _force_utf8_console()

    def log(self, level: str, event: str, **fields: Any) -> None:
        record = {
            "ts": now_jst().isoformat(),
            "level": level,
            "event": event,
        }
        record.update(_scrub(fields))
        line = json.dumps(record, ensure_ascii=False, default=str)

        if self._echo:
            stream = sys.stderr if level in ("error", "warn") else sys.stdout
            print(line, file=stream, flush=True)

        if self._log_dir is not None:
            path = self._log_dir / f"app-{datetime.now().strftime('%Y%m%d')}.jsonl"
            with path.open("a", encoding="utf-8") as fp:
                fp.write(line + "\n")

    def info(self, event: str, **fields: Any) -> None:
        self.log("info", event, **fields)

    def warn(self, event: str, **fields: Any) -> None:
        self.log("warn", event, **fields)

    def error(self, event: str, **fields: Any) -> None:
        self.log("error", event, **fields)

    def debug(self, event: str, **fields: Any) -> None:
        self.log("debug", event, **fields)


def _force_utf8_console() -> None:
    """Windows のコンソールでも日本語ラベルが読めるようにする。

    既定のコードページ（cp932）のままだと項目ラベルが化ける。
    ファイルへの出力は最初から UTF-8 なので影響を受けない。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


def _scrub(fields: dict[str, Any]) -> dict[str, Any]:
    """秘密情報らしいキーの値を伏せる。うっかり渡しても漏れないようにする。"""
    out: dict[str, Any] = {}
    for key, value in fields.items():
        if key.lower() in _SECRET_KEYS:
            out[key] = "***"
        elif isinstance(value, dict):
            out[key] = _scrub(value)
        else:
            out[key] = value
    return out


def mask_value(value: Any) -> str:
    """個人情報になりうる値をログ用に潰す。長さと型だけを残す。"""
    if value is None:
        return "<none>"
    if isinstance(value, (list, tuple)):
        return f"<list len={len(value)}>"
    return f"<{type(value).__name__} len={len(str(value))}>"
