"""日時形式の変換。

**リクエストとレスポンスで形式が違う**（実測。仕様書の記載は誤り）。
読んだ値をそのまま検索条件に渡せないので、ここが壊れると
検索が 400 になるか、静かに取りこぼす。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.core.timefmt import (
    JST,
    from_store,
    now_jst,
    parse_cp_date,
    parse_cp_datetime,
    to_cp_date,
    to_cp_datetime,
    to_store,
)


def test_datetime_request_format_is_slash_with_seconds():
    """`YYYY/MM/DD HH:MM:SS`。仕様書の `YYYY/MM/DD HH:MM` は 400 で拒否される。"""
    dt = datetime(2026, 8, 5, 15, 20, 48, tzinfo=JST)
    assert to_cp_datetime(dt) == "2026/08/05 15:20:48"


def test_date_request_format_is_slash():
    dt = datetime(2026, 8, 5, 15, 20, 48, tzinfo=JST)
    assert to_cp_date(dt) == "2026/08/05"


def test_datetime_response_is_iso8601_with_seconds():
    """レスポンスは ISO 8601・秒あり（実測）。"""
    parsed = parse_cp_datetime("2026-08-05T15:20:48")
    assert parsed == datetime(2026, 8, 5, 15, 20, 48, tzinfo=JST)


def test_date_response_is_iso8601():
    assert parse_cp_date("2026-08-05") == datetime(2026, 8, 5, 0, 0, 0, tzinfo=JST)


def test_round_trip_response_to_request():
    """読んだ値を検索条件へ渡すときに必ず変換が要る、という前提そのものを固定する。"""
    raw = "2026-08-05T15:20:48"
    assert to_cp_datetime(parse_cp_datetime(raw)) == "2026/08/05 15:20:48"
    assert raw != to_cp_datetime(parse_cp_datetime(raw))


def test_store_format_is_jst_with_space():
    dt = datetime(2026, 8, 5, 15, 20, 48, tzinfo=JST)
    assert to_store(dt) == "2026-08-05 15:20:48"
    assert from_store("2026-08-05 15:20:48") == dt


def test_store_accepts_date_only():
    """要件4のカーソルは日付粒度になるため、日付のみの値も読めること。"""
    assert from_store("2026-08-05") == datetime(2026, 8, 5, tzinfo=JST)


def test_naive_datetime_is_treated_as_jst():
    """CP が返す datetime はタイムゾーンを持たない。JST として扱う。"""
    naive = datetime(2026, 8, 5, 15, 20, 48)
    assert to_cp_datetime(naive) == "2026/08/05 15:20:48"


def test_utc_input_is_converted_to_jst():
    """UTC 混在は差分検知のバグの温床になる。保存前に必ず JST へ寄せる。"""
    utc = datetime(2026, 8, 5, 6, 20, 48, tzinfo=timezone.utc)
    assert to_cp_datetime(utc) == "2026/08/05 15:20:48"
    assert to_store(utc) == "2026-08-05 15:20:48"


def test_now_jst_has_no_microseconds():
    """カーソルは秒粒度で持つ。マイクロ秒が残ると保存形式と往復しない。"""
    assert now_jst().microsecond == 0
    assert now_jst().tzinfo is not None


def test_second_precision_boundary_is_preserved():
    """秒精度は実際に効く（`GE ...48` はヒット、`GE ...49` は外れる）。

    オーバーラップを引いた結果が秒単位でずれないことを確認する。
    """
    cursor = datetime(2026, 8, 5, 15, 20, 48, tzinfo=JST)
    assert to_cp_datetime(cursor - timedelta(seconds=60)) == "2026/08/05 15:19:48"


@pytest.mark.parametrize("bad", ["2026/08/05 15:20:48", "2026-08-05 15:20:48", ""])
def test_parse_rejects_non_iso_response(bad):
    with pytest.raises(ValueError):
        parse_cp_datetime(bad)
