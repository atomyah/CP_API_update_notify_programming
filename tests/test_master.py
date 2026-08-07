"""コード値 → ラベルの変換。

通知本文の読みやすさを決める。実運用で次の 2 つが問題になったため回帰テストを置く
（2026-08-07 の実送信で判明）:

- 都道府県 `0` が `0(コード不明)` と出た（`0` は「未設定」の意味）
- 郵便番号 `2250013` が `2250013(コード不明)` と出た
  （`MSTZIPCODE` は列挙を返さないマスタで、値はコードではなくデータ）
"""
from __future__ import annotations

import pytest

from app.core.master import MasterRegistry
from tests.conftest import FakeCpClient


@pytest.fixture
def master(logger) -> MasterRegistry:
    client = FakeCpClient()
    return MasterRegistry(client, logger)   # type: ignore[arg-type]


def test_known_code_becomes_label(master):
    assert master.label("MSTREGSTATUS", "2") == "本登録"


def test_number_value_is_matched_against_string_codes(master):
    """CP は number を JSON 数値で返す。コードとの突き合わせは文字列で行う。"""
    assert master.label("MSTREGSTATUS", 2) == "本登録"


def test_empty_value_is_unset(master):
    assert master.label("MSTREGSTATUS", None) == "(未設定)"
    assert master.label("MSTREGSTATUS", "") == "(未設定)"
    assert master.label(None, None) == "(未設定)"


def test_zero_is_unset_even_though_it_is_not_in_the_master(master):
    """CP は selectone の未設定をコード `0` で表す（マスタには載っていない）。

    `0(コード不明)` と出すと、担当者未設定や都道府県未入力が読めなくなる。
    """
    assert master.label("MSTREGSTATUS", "0") == "(未設定)"
    assert master.label("MSTREGSTATUS", 0) == "(未設定)"


def test_unresolvable_value_is_shown_as_is(master):
    """列挙を返さないマスタ（`MSTZIPCODE` 等）の値はデータなので注釈を付けない。"""
    assert master.label("MSTZIPCODE", "2250013") == "2250013"


def test_item_without_master_is_shown_as_is(master):
    """text 型など参照マスタを持たない項目。"""
    assert master.label(None, "米国") == "米国"


def test_multi_select_values_are_joined(master):
    """`select` 型は文字列の配列で返る。"""
    assert master.label("MSTREGSTATUS", ["1", "2"]) == "仮登録 / 本登録"
    assert master.label("MSTREGSTATUS", []) == "(未設定)"


def test_master_is_cached(master):
    master.label("MSTREGSTATUS", "1")
    master.label("MSTREGSTATUS", "2")
    # FakeCpClient は呼ばれた回数を数えないので、キャッシュの有無は
    # 同じ辞書オブジェクトが返ることで確認する
    assert master.get("MSTREGSTATUS") is master.get("MSTREGSTATUS")
