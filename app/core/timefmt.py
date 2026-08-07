"""JST ⇔ CP形式 ⇔ SQLite保存形式 の変換。

**この変換はここ 1 箇所に集約する。各所で strftime を書かない**
（`rules/10-cp-api.md`）。

実測で判明している形式（`docs/design/07-verification-results.md` 2章）:

| | レスポンス（読む） | リクエスト（書く） |
|---|---|---|
| datetime | ISO 8601・秒あり `2026-08-05T15:20:48` | `YYYY/MM/DD HH:MM:SS` |
| date | ISO 8601 `2026-08-05` | `YYYY/MM/DD` |

**仕様書に書かれている `YYYY/MM/DD HH:MM`（分まで）は 400 で拒否される。**
読んだ値をそのまま検索条件に渡せないので、必ずここを通すこと。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

# CP が返す datetime はタイムゾーン情報を持たない。JST として扱う
# （`rules/30-state-and-idempotency.md`）。
JST = timezone(timedelta(hours=9))

_STORE_FMT = "%Y-%m-%d %H:%M:%S"
_STORE_DATE_FMT = "%Y-%m-%d"
_CP_DATETIME_FMT = "%Y/%m/%d %H:%M:%S"
_CP_DATE_FMT = "%Y/%m/%d"


def now_jst() -> datetime:
    """現在時刻（JST・秒精度）。マイクロ秒は落とす。"""
    return datetime.now(JST).replace(microsecond=0)


# --- CP へ渡す（検索条件の value） ---------------------------------------

def to_cp_datetime(dt: datetime) -> str:
    """datetime 型の検索条件に渡す形式。`YYYY/MM/DD HH:MM:SS`。"""
    return _as_jst(dt).strftime(_CP_DATETIME_FMT)


def to_cp_date(dt: datetime) -> str:
    """date 型の検索条件に渡す形式。`YYYY/MM/DD`。"""
    return _as_jst(dt).strftime(_CP_DATE_FMT)


# --- CP から読む（レスポンスの value） -----------------------------------

def parse_cp_datetime(value: str) -> datetime:
    """レスポンスの datetime（ISO 8601・秒あり）を JST の datetime にする。"""
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=JST)


def parse_cp_date(value: str) -> datetime:
    """レスポンスの date（ISO 8601）を JST の datetime（00:00:00）にする。"""
    return datetime.strptime(value, _STORE_DATE_FMT).replace(tzinfo=JST)


# --- SQLite に保存する ---------------------------------------------------

def to_store(dt: datetime) -> str:
    """SQLite 保存形式。JST の `yyyy-MM-dd HH:mm:ss`。

    UTC 混在は差分検知のバグの温床になるため、保存は必ず JST で統一する。
    """
    return _as_jst(dt).strftime(_STORE_FMT)


def from_store(value: str) -> datetime:
    """SQLite 保存形式を JST の datetime に戻す。日付のみの値も受け付ける。"""
    text = value.strip()
    if len(text) == len("2026-08-05"):
        return datetime.strptime(text, _STORE_DATE_FMT).replace(tzinfo=JST)
    return datetime.strptime(text, _STORE_FMT).replace(tzinfo=JST)


def _as_jst(dt: datetime) -> datetime:
    """tz 未指定の datetime は JST とみなす。他の tz は JST へ変換する。"""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=JST)
    return dt.astimezone(JST)
