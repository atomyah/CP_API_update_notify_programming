"""状態管理と冪等除去。

- 冪等キーによる重複除去（`rules/50-code-style.md` の優先テスト対象）
- 通知送信より先に予約すること
- 失敗時にカーソルが進まないこと
"""
from __future__ import annotations

from datetime import datetime

from app.core.store import payload_hash, value_hash
from app.core.timefmt import JST


def test_claim_is_idempotent(store):
    key = ("career_status", "18", "item_changed", "abc")
    assert store.claim_notification(*key) is True
    assert store.claim_notification(*key) is False


def test_claim_distinguishes_by_payload(store):
    """同じリソースの別の変化は別イベントとして通知される。"""
    assert store.claim_notification("w", "18", "item_changed", "hash-a") is True
    assert store.claim_notification("w", "18", "item_changed", "hash-b") is True


def test_claim_distinguishes_by_resource_id_including_branch(store):
    """進捗履歴のように枝番を含む ID は別イベントになること。

    `21_1` と `21_3` は同じステータス値でも別の遷移（後戻り）。
    `progressId + ステータス値` で冪等キーを作ると 2 回目が消える。
    """
    assert store.claim_notification("w", "21_1", "status_changed", "same") is True
    assert store.claim_notification("w", "21_3", "status_changed", "same") is True


def test_value_hash_normalizes_number_types():
    """CP は number を JSON 数値で返す。18 と "18" を同じ値として扱う。"""
    assert value_hash(18) == value_hash("18")
    assert value_hash(18.0) == value_hash("18")


def test_none_and_empty_string_are_the_same_unset():
    """どちらも「値が無い」。区別すると保存操作のたびに誤検知が出る。"""
    assert value_hash(None) == value_hash("")


def test_value_hash_distinguishes_list_order():
    assert value_hash(["8", "9"]) != value_hash(["9", "8"])


def test_payload_hash_is_stable_across_runs():
    parts = [("CAREER#RANK_ID", "1", "2")]
    assert payload_hash(parts) == payload_hash(parts)


def test_snapshot_round_trip_keeps_type(store):
    store.put_snapshot("w", "18", "CAREER#48002", "米国", keep_raw=True)
    snap = store.get_snapshots("w", "18")["CAREER#48002"]
    assert snap.decoded() == "米国"

    store.put_snapshot("w", "18", "CAREER#CHARGE_ID", 7, keep_raw=True)
    assert store.get_snapshots("w", "18")["CAREER#CHARGE_ID"].decoded() == 7


def test_snapshot_defaults_to_hash_only(store):
    """既定は生値を保存しない（`rules/40-secrets-and-security.md`）。"""
    store.put_snapshot("w", "18", "CAREER#LASTNAME", "惣流", keep_raw=False)
    snap = store.get_snapshots("w", "18")["CAREER#LASTNAME"]
    assert snap.value_raw is None
    assert snap.has_raw is False
    assert snap.value_hash == value_hash("惣流")


def test_cursor_is_per_watcher(store):
    a = datetime(2026, 8, 5, 10, 0, 0, tzinfo=JST)
    b = datetime(2026, 8, 5, 11, 0, 0, tzinfo=JST)
    store.set_cursor("career_status", a, bootstrapped=True)
    store.set_cursor("progress_flow", b, bootstrapped=True)

    assert store.get_cursor("career_status").value == a
    assert store.get_cursor("progress_flow").value == b


def test_transaction_rolls_back_on_failure(store):
    """1 件でも処理しきれなかったら、そのサイクルの変更は残さない。"""
    original = datetime(2026, 8, 5, 10, 0, 0, tzinfo=JST)
    store.set_cursor("w", original, bootstrapped=True)

    try:
        with store.transaction():
            store.set_cursor("w", datetime(2026, 8, 5, 12, 0, 0, tzinfo=JST))
            raise RuntimeError("boom")
    except RuntimeError:
        pass

    assert store.get_cursor("w").value == original


def test_page_offset_does_not_move_cursor(store):
    """予算切れの中断では再開位置だけを保存し、カーソル本体は動かさない。"""
    original = datetime(2026, 8, 5, 10, 0, 0, tzinfo=JST)
    store.set_cursor("w", original, bootstrapped=True)
    store.set_page_offset("w", 200)

    cursor = store.get_cursor("w")
    assert cursor.value == original
    assert cursor.page_offset == 200


def test_dead_letter_is_recorded(store):
    store.add_dead_letter("w", '{"body":"x"}', "NotifyError: boom")
    assert store.count_dead_letters() == 1


# --- 「未設定」の正規化 ---------------------------------------------------
# CP は画面で保存すると、未入力の選択項目を None から "0" に書き換える。
# 正規化しないと、1項目を直しただけで未入力の選択項目が軒並み誤検知される
# （2026-08-07 の実送信で判明）。

def test_unset_forms_hash_identically_for_code_items():
    """selectone / select / search では None・空文字・0 を同じ「未設定」とみなす。"""
    for item_type in ("selectone", "select", "search"):
        base = value_hash(None, item_type)
        assert value_hash("", item_type) == base
        assert value_hash("0", item_type) == base
        assert value_hash(0, item_type) == base


def test_zero_is_a_real_value_for_number_items():
    """number の 0 は正当な値。潰すと本当の変化を見逃す。"""
    assert value_hash(0, "number") != value_hash(None, "number")
    assert value_hash(0, "number") == value_hash("0", "number")


def test_saving_a_record_does_not_look_like_a_change():
    """保存で None → "0" になっても変化として扱わない（今回のバグの再現）。"""
    before = value_hash(None, "selectone")
    after = value_hash("0", "selectone")
    assert before == after


def test_real_code_change_is_still_detected():
    assert value_hash("1", "selectone") != value_hash("2", "selectone")
    assert value_hash(None, "selectone") != value_hash("1", "selectone")


def test_empty_list_is_unset():
    assert value_hash([], "select") == value_hash(None, "select")
    assert value_hash(["0"], "select") == value_hash(None, "select")
    assert value_hash(["1"], "select") != value_hash(None, "select")


def test_whitespace_only_text_is_unset():
    assert value_hash("   ", "text") == value_hash(None, "text")
