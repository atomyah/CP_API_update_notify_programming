"""SQLite による状態管理。

テーブルは 4 つ（`rules/30-state-and-idempotency.md`）。ORM は入れない。

| テーブル | 役割 |
|---|---|
| `cursors` | ウォッチャーごとの前回実行位置 |
| `snapshots` | 差分検知用の前回値 |
| `notified` | 通知済みイベントの冪等キー（UNIQUE で二重送信を防ぐ） |
| `dead_letter` | 送信に失敗し諦めたイベント |

**`snapshots` には既定でハッシュのみを保存する。**生値を持つのは
「遷移前後を通知したい」項目だけで、対象は YAML で明示させる
（`rules/40-secrets-and-security.md`）。
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterator

from app.core.timefmt import from_store, now_jst, to_store

SCHEMA = """
CREATE TABLE IF NOT EXISTS cursors (
  watcher_id   TEXT PRIMARY KEY,
  cursor_value TEXT NOT NULL,
  page_offset  INTEGER NOT NULL DEFAULT 0,
  bootstrapped INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  watcher_id   TEXT NOT NULL,
  resource_id  TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  value_hash   TEXT NOT NULL,
  value_raw    TEXT,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (watcher_id, resource_id, item_id)
);

CREATE TABLE IF NOT EXISTS notified (
  watcher_id   TEXT NOT NULL,
  resource_id  TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  notified_at  TEXT NOT NULL,
  PRIMARY KEY (watcher_id, resource_id, event_type, payload_hash)
);

CREATE TABLE IF NOT EXISTS dead_letter (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  watcher_id TEXT NOT NULL,
  payload    TEXT NOT NULL,
  error      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""


@dataclass
class Cursor:
    watcher_id: str
    value: datetime
    page_offset: int
    bootstrapped: bool
    updated_at: datetime


@dataclass
class Snapshot:
    value_hash: str
    value_raw: str | None

    def decoded(self) -> object:
        """保存した生値を元の型で取り出す。保存していなければ None。"""
        if self.value_raw is None:
            return None
        try:
            return json.loads(self.value_raw)
        except json.JSONDecodeError:
            return self.value_raw

    @property
    def has_raw(self) -> bool:
        return self.value_raw is not None


# コード値を持つ項目タイプ。これらの `0` は「未設定」を意味する（実測）
CODE_ITEM_TYPES = {"selectone", "select", "search"}


def canonical_value(value: object, item_type: str | None = None) -> object:
    """差分検知のために値を正規化する。

    **CP は画面で保存すると、未入力の選択項目を `None` から `0` に書き換える。**
    正規化しないと、1 項目を直しただけで未入力の選択項目が軒並み
    「変化した」と誤判定され、`(未設定) → (未設定)` という通知が大量に出る
    （2026-08-07 の実送信で判明）。

    「未設定」とみなすもの:

    - `None` / 空文字 / 空配列 — 全項目タイプ共通
    - `0` / `"0"` — **`selectone` / `select` / `search` のみ。**
      `number` の `0` は正当な値なので潰さない
    """
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        values = [canonical_value(v, item_type) for v in value]
        values = [v for v in values if v is not None]
        return values or None

    # CP は number を JSON 数値で返す。18 / 18.0 / "18" を同じ値として扱う
    if isinstance(value, bool):
        text = str(value)
    elif isinstance(value, float) and value.is_integer():
        text = str(int(value))
    else:
        text = str(value).strip()

    if text == "":
        return None
    if item_type in CODE_ITEM_TYPES and text in ("0", "0.0"):
        return None
    return text


def value_hash(value: object, item_type: str | None = None) -> str:
    """差分検知用のハッシュ。正規化してから取る。"""
    return hashlib.sha256(
        _normalize(canonical_value(value, item_type)).encode("utf-8")
    ).hexdigest()


def payload_hash(parts: object) -> str:
    """通知本文を決定づける値から取る冪等キーの一部。"""
    return hashlib.sha256(_normalize(parts).encode("utf-8")).hexdigest()


def _normalize(value: object) -> str:
    if value is None:
        return "\x00none"
    if isinstance(value, bool):
        return f"\x00bool:{value}"
    if isinstance(value, (list, tuple)):
        return "\x00list:" + "\x1f".join(_normalize(v) for v in value)
    if isinstance(value, dict):
        return "\x00dict:" + "\x1f".join(
            f"{k}\x1e{_normalize(v)}" for k, v in sorted(value.items())
        )
    # CP は number を JSON 数値で返す。18 と "18" を同じ値として扱う
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)

    def close(self) -> None:
        self._conn.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """1サイクルの処理をトランザクションで囲む。

        1 件でも処理しきれなかったら例外を投げてロールバックし、
        **カーソルを前進させない**（`rules/30-state-and-idempotency.md`）。
        """
        self._conn.execute("BEGIN")
        try:
            yield self._conn
        except Exception:
            self._conn.execute("ROLLBACK")
            raise
        else:
            self._conn.execute("COMMIT")

    # --- cursors ---------------------------------------------------------

    def get_cursor(self, watcher_id: str) -> Cursor | None:
        row = self._conn.execute(
            "SELECT * FROM cursors WHERE watcher_id = ?", (watcher_id,)
        ).fetchone()
        if row is None:
            return None
        return Cursor(
            watcher_id=row["watcher_id"],
            value=from_store(row["cursor_value"]),
            page_offset=row["page_offset"],
            bootstrapped=bool(row["bootstrapped"]),
            updated_at=from_store(row["updated_at"]),
        )

    def set_cursor(self, watcher_id: str, value: datetime, page_offset: int = 0,
                   bootstrapped: bool | None = None) -> None:
        current = self.get_cursor(watcher_id)
        flag = current.bootstrapped if (bootstrapped is None and current) else bool(bootstrapped)
        self._conn.execute(
            """
            INSERT INTO cursors (watcher_id, cursor_value, page_offset, bootstrapped, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(watcher_id) DO UPDATE SET
              cursor_value = excluded.cursor_value,
              page_offset  = excluded.page_offset,
              bootstrapped = excluded.bootstrapped,
              updated_at   = excluded.updated_at
            """,
            (watcher_id, to_store(value), page_offset, int(flag), to_store(now_jst())),
        )

    def set_page_offset(self, watcher_id: str, page_offset: int) -> None:
        """予算切れで中断したときの再開位置。**カーソル本体は動かさない。**"""
        self._conn.execute(
            "UPDATE cursors SET page_offset = ?, updated_at = ? WHERE watcher_id = ?",
            (page_offset, to_store(now_jst()), watcher_id),
        )

    # --- snapshots -------------------------------------------------------

    def get_snapshots(self, watcher_id: str, resource_id: str) -> dict[str, Snapshot]:
        rows = self._conn.execute(
            "SELECT item_id, value_hash, value_raw FROM snapshots "
            "WHERE watcher_id = ? AND resource_id = ?",
            (watcher_id, resource_id),
        ).fetchall()
        return {r["item_id"]: Snapshot(r["value_hash"], r["value_raw"]) for r in rows}

    def put_snapshot(self, watcher_id: str, resource_id: str, item_id: str,
                     value: object, keep_raw: bool, item_type: str | None = None) -> None:
        """スナップショットを更新する。

        `keep_raw` が True の項目だけ生値を保存する。既定はハッシュのみ
        （`rules/40-secrets-and-security.md`）。

        `item_type` は正規化に使う。**渡し忘れると `0` と未設定が別物になり、
        保存操作のたびに大量の誤検知が出る**（`canonical_value`）。
        """
        # 生値は JSON で保存する。型を保ったまま復元できないと
        # 「遷移前 → 遷移後」の表示で見た目が壊れる
        raw = json.dumps(value, ensure_ascii=False) if keep_raw else None
        self._conn.execute(
            """
            INSERT INTO snapshots
              (watcher_id, resource_id, item_id, value_hash, value_raw, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(watcher_id, resource_id, item_id) DO UPDATE SET
              value_hash   = excluded.value_hash,
              value_raw    = excluded.value_raw,
              last_seen_at = excluded.last_seen_at
            """,
            (watcher_id, resource_id, item_id, value_hash(value, item_type), raw,
             to_store(now_jst())),
        )

    def delete_snapshots(self, watcher_id: str, resource_id: str) -> None:
        self._conn.execute(
            "DELETE FROM snapshots WHERE watcher_id = ? AND resource_id = ?",
            (watcher_id, resource_id),
        )

    def has_snapshot(self, watcher_id: str, resource_id: str) -> bool:
        """ブートストラップの再開時に、取得済みのレコードを飛ばすために使う。"""
        row = self._conn.execute(
            "SELECT 1 FROM snapshots WHERE watcher_id = ? AND resource_id = ? LIMIT 1",
            (watcher_id, resource_id),
        ).fetchone()
        return row is not None

    def count_snapshots(self, watcher_id: str) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) AS n FROM snapshots WHERE watcher_id = ?", (watcher_id,)
        ).fetchone()
        return int(row["n"])

    # --- notified --------------------------------------------------------

    def claim_notification(self, watcher_id: str, resource_id: str,
                           event_type: str, digest: str) -> bool:
        """冪等キーを予約する。**通知送信より先に呼ぶこと。**

        送信後に INSERT すると、送信成功・INSERT 失敗のときに二重送信する。
        逆順なら最悪 1 件落ちるだけで、落ちたことは `dead_letter` で検出できる
        （`rules/30-state-and-idempotency.md`）。

        Returns:
            True なら新規（送ってよい）。False なら既送信（黙って捨てる）。
        """
        try:
            self._conn.execute(
                "INSERT INTO notified "
                "(watcher_id, resource_id, event_type, payload_hash, notified_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (watcher_id, resource_id, event_type, digest, to_store(now_jst())),
            )
            return True
        except sqlite3.IntegrityError:
            return False

    def release_notification(self, watcher_id: str, resource_id: str,
                             event_type: str, digest: str) -> None:
        """テスト・再送用に予約を取り消す。運用では使わない。"""
        self._conn.execute(
            "DELETE FROM notified WHERE watcher_id = ? AND resource_id = ? "
            "AND event_type = ? AND payload_hash = ?",
            (watcher_id, resource_id, event_type, digest),
        )

    # --- dead_letter -----------------------------------------------------

    def add_dead_letter(self, watcher_id: str, payload: str, error: str) -> None:
        self._conn.execute(
            "INSERT INTO dead_letter (watcher_id, payload, error, created_at) "
            "VALUES (?, ?, ?, ?)",
            (watcher_id, payload, error, to_store(now_jst())),
        )

    def count_dead_letters(self) -> int:
        row = self._conn.execute("SELECT COUNT(*) AS n FROM dead_letter").fetchone()
        return int(row["n"])
