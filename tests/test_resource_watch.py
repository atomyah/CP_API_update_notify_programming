"""`ResourceWatcher` — リソース横断の項目変化ウォッチャー。

検証したいこと:
- ブートストラップは通知しない（既存レコードの一斉通知を防ぐ）
- 値が変わったときだけ通知する。値は限定しない
- 遷移前後をマスタのラベルで出す（マスタ名は schema から自動解決）
- `watched_items: "*"` で全項目を監視し、自動更新される項目は除外される
- 冪等キーで重複通知を除去する
- **失敗したらカーソルを進めない**
- 予算切れで中断してもカーソルを進めず、処理済みは再送しない
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.core.errors import ConfigError
from app.core.timefmt import JST, now_jst
from app.watchers.resource_watch import ResourceWatcher
from tests.conftest import CapturingNotifier, FakeCpClient

BASE = {
    "resource": "career",
    "enabled": True,
    "interval_minutes": 15,
    "priority": 2,
    "budget_per_cycle": 60,
    "overlap_seconds": 60,
    "identity_items": ["CAREER#CAREER_ID", "CAREER#LASTNAME", "CAREER#FIRSTNAME"],
    "name_template": "{CAREER#LASTNAME} {CAREER#FIRSTNAME}",
    "notify": {"channel_key": "career_status", "template": "record_changed",
               "resource_label": "求職者"},
}

CONFIG = dict(BASE, watched_items=[
    {"item_id": "CAREER#48002", "label_override": "国籍"},
    {"item_id": "CAREER#REGSTATUS_ID"},     # マスタは schema から自動解決される
    {"item_id": "CAREER#CNSLSTATUS_ID"},
])

CONFIG_ALL = dict(BASE, watched_items="*", exclude_items=["CAREER#LAST_LOGIN"])


def _record(**overrides):
    base = {
        "CAREER#CAREER_ID": 18,
        "CAREER#LASTNAME": "惣流",
        "CAREER#FIRSTNAME": "アスカ",
        "CAREER#48002": "米国",
        "CAREER#REGSTATUS_ID": "2",
        "CAREER#CNSLSTATUS_ID": "1",
        "CAREER#MEMO": "メモ",
        "CAREER#LAST_LOGIN": "2026-08-05T10:00:00",
        "CAREER#UPDATE_DATE": "2026-08-05T15:20:48",
        "CAREER#INSERT_DATE": "2026-01-01T00:00:00",
    }
    base.update(overrides)
    return base


@pytest.fixture
def watcher():
    return ResourceWatcher("career_status", CONFIG)


@pytest.fixture
def client():
    return FakeCpClient({"18": _record()})


def _bootstrap(watcher, make_context, client, notifier):
    ctx = make_context(client, notifier, bootstrap=True)
    assert watcher.run(ctx).ok
    return ctx


# --- ブートストラップ -----------------------------------------------------

def test_bootstrap_creates_snapshots_without_notifying(watcher, make_context, client, store):
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)

    assert notifier.sent == []
    assert store.count_snapshots("career_status") == 3
    assert store.get_cursor("career_status").bootstrapped is True


def test_bootstrap_is_resumable(make_context, client, store):
    """予算切れで中断しても、取得済みのレコードは再取得しない。"""
    client.records["19"] = _record(**{"CAREER#CAREER_ID": 19})
    limited = ResourceWatcher("career_status", dict(CONFIG, budget_per_cycle=2))

    assert limited.run(make_context(client, bootstrap=True)).exhausted is True
    assert store.get_cursor("career_status").bootstrapped is False
    first_round = list(client.select_calls)

    full = ResourceWatcher("career_status", CONFIG)
    full.run(make_context(client, bootstrap=True))

    assert store.get_cursor("career_status").bootstrapped is True
    # 1周目で取った ID を2周目で取り直していないこと
    assert client.select_calls[len(first_round):].count(first_round[0]) == 0


def test_execute_refuses_without_bootstrap(watcher, make_context, client):
    """前回値がない状態で通知するとチャンネルが溢れる。明示的に失敗させる。"""
    result = watcher.run(make_context(client))
    assert result.ok is False
    assert "bootstrap" in (result.error or "")


# --- 全項目監視 -----------------------------------------------------------

def test_watch_all_covers_every_schema_item_minus_exclusions(make_context, client):
    """`"*"` は schema の全項目。自動更新される項目だけを外す。"""
    watcher = ResourceWatcher("career_status", CONFIG_ALL)
    ctx = make_context(client)
    watcher.validate(ctx)

    watched = {i.item_id for i in watcher._resolve_items(ctx)}
    assert "CAREER#48002" in watched          # オリつく項目も自動で入る
    assert "CAREER#MEMO" in watched
    assert "CAREER#UPDATE_DATE" not in watched   # 保存のたびに動くので除外
    assert "CAREER#INSERT_DATE" not in watched
    assert "CAREER#LAST_LOGIN" not in watched   # exclude_items


def test_master_is_resolved_from_schema_code_name(make_context, client):
    """参照マスタ名は YAML ではなく schema（validationRule.codeName）から取る。"""
    watcher = ResourceWatcher("career_status", CONFIG_ALL)
    ctx = make_context(client)
    watcher.validate(ctx)

    by_id = {i.item_id: i for i in watcher._resolve_items(ctx)}
    assert by_id["CAREER#REGSTATUS_ID"].master == "MSTREGSTATUS"
    assert by_id["CAREER#48002"].master is None
    assert by_id["CAREER#REGSTATUS_ID"].label == "登録ステータス"


def test_watch_all_notifies_any_item_change(make_context, client):
    watcher = ResourceWatcher("career_status", CONFIG_ALL)
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)

    client.records["18"]["CAREER#MEMO"] = "書き換えた"
    watcher.run(make_context(client, notifier))

    assert "備考: メモ → 書き換えた" in notifier.sent[0].body


def test_update_date_change_alone_does_not_notify(make_context, client):
    """`UPDATE_DATE` は検索のカーソルであって監視対象ではない。

    含めてしまうと、どんな更新でも必ず 1 件の変化として通知が出る。
    """
    watcher = ResourceWatcher("career_status", CONFIG_ALL)
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)

    client.records["18"]["CAREER#UPDATE_DATE"] = "2026-08-07T09:00:00"
    result = watcher.run(make_context(client, notifier))

    assert result.events_detected == 0
    assert notifier.sent == []


# --- 差分検知 -------------------------------------------------------------

def test_no_change_produces_no_notification(watcher, make_context, client):
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)

    result = watcher.run(make_context(client, notifier))
    assert result.events_detected == 0
    assert notifier.sent == []


def test_change_is_notified_with_labels(watcher, make_context, client):
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)

    client.records["18"]["CAREER#CNSLSTATUS_ID"] = "3"
    result = watcher.run(make_context(client, notifier))

    assert result.events_detected == 1
    assert result.events_notified == 1
    body = notifier.sent[0].body
    assert "未対応 → 面談待ち" in body      # コード値ではなくラベル
    assert "惣流 アスカ" in body
    assert "求職者" in body


def test_custom_item_change_is_notified(watcher, make_context, client):
    """オリつく項目（`CAREER#48002`）もコード上の特別扱いなしで乗ること。"""
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)

    client.records["18"]["CAREER#48002"] = "日本"
    watcher.run(make_context(client, notifier))

    assert "国籍: 米国 → 日本" in notifier.sent[0].body


def test_all_transitions_are_notified_not_only_specific_values(watcher, make_context, client):
    """値は限定しない。どの値に変わっても通知する（業務側の決定 B-3）。"""
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)

    for value in ("1", "5", "2"):
        client.records["18"]["CAREER#REGSTATUS_ID"] = value
        watcher.run(make_context(client, notifier))

    assert len(notifier.sent) == 3


def test_multiple_changed_items_are_one_notification(watcher, make_context, client):
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)

    client.records["18"]["CAREER#48002"] = "日本"
    client.records["18"]["CAREER#REGSTATUS_ID"] = "5"
    result = watcher.run(make_context(client, notifier))

    assert result.events_detected == 1
    assert len(notifier.sent) == 1
    assert "国籍" in notifier.sent[0].body
    assert "登録ステータス" in notifier.sent[0].body


def test_body_is_capped_by_max_items(make_context, client):
    """全項目監視では一度に大量の項目が変わりうる。本文が壊れないようにする。"""
    watcher = ResourceWatcher("career_status", dict(CONFIG_ALL, max_items_in_body=1))
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)

    client.records["18"]["CAREER#48002"] = "日本"
    client.records["18"]["CAREER#MEMO"] = "変更"
    watcher.run(make_context(client, notifier))

    assert "ほか 1 項目" in notifier.sent[0].body


def test_newly_seen_record_is_not_notified(watcher, make_context, client):
    """初めて見たレコードは通知しない。基準値を作るだけ。"""
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)

    client.records["19"] = _record(**{"CAREER#CAREER_ID": 19, "CAREER#LASTNAME": "葛城"})
    result = watcher.run(make_context(client, notifier))

    assert result.events_detected == 0
    assert notifier.sent == []


# --- 冪等性 ---------------------------------------------------------------

def test_repeated_cycle_does_not_resend(watcher, make_context, client):
    """オーバーラップで同じ変化を再取得しても再送しない。"""
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)

    client.records["18"]["CAREER#CNSLSTATUS_ID"] = "3"
    watcher.run(make_context(client, notifier))
    watcher.run(make_context(client, notifier))

    assert len(notifier.sent) == 1


def test_failed_send_goes_to_dead_letter(watcher, make_context, client, store):
    """送信に失敗しても予約は残る（二重送信より 1 件落ちる方を選ぶ）。"""
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)

    client.records["18"]["CAREER#CNSLSTATUS_ID"] = "3"
    failing = CapturingNotifier({"career_status"}, fail=True)
    result = watcher.run(make_context(client, failing))

    assert result.events_detected == 1
    assert result.events_notified == 0
    assert store.count_dead_letters() == 1


# --- 失敗時の挙動 ---------------------------------------------------------

def test_cursor_does_not_advance_on_failure(watcher, make_context, client, store):
    """**失敗したらカーソルを進めない。**取りこぼしは通知漏れであり重複より重い。"""
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)
    before = store.get_cursor("career_status").value

    client.fail_select_for = {"18"}
    result = watcher.run(make_context(client, notifier))

    assert result.ok is False
    assert store.get_cursor("career_status").value == before


def test_cursor_does_not_advance_when_budget_exhausted(make_context, client, store):
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(ResourceWatcher("career_status", CONFIG), make_context, client, notifier)
    before = store.get_cursor("career_status").value

    client.records["18"]["CAREER#CNSLSTATUS_ID"] = "3"
    limited = ResourceWatcher("career_status", dict(CONFIG, budget_per_cycle=1))
    result = limited.run(make_context(client, notifier))

    assert result.exhausted is True
    assert result.ok is True
    assert store.get_cursor("career_status").value == before
    assert notifier.sent == []


def test_processed_records_are_not_resent_after_exhaustion(make_context, store):
    """予算切れで中断しても、処理済みのレコードは重複通知にならない。

    通知 → スナップショット更新 をレコードごとに完結させているため。
    """
    client = FakeCpClient({"18": _record(), "19": _record(**{"CAREER#CAREER_ID": 19})})
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(ResourceWatcher("career_status", CONFIG), make_context, client, notifier)

    client.records["18"]["CAREER#48002"] = "日本"
    client.records["19"]["CAREER#48002"] = "中国"

    limited = ResourceWatcher("career_status", dict(CONFIG, budget_per_cycle=2))
    assert limited.run(make_context(client, notifier)).exhausted is True

    ResourceWatcher("career_status", CONFIG).run(make_context(client, notifier))

    assert sorted(n.resource_id for n in notifier.sent) == ["18", "19"]


# --- クエリの組み立て -----------------------------------------------------

def test_search_condition_uses_update_date(watcher, make_context, client):
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)
    client.search_calls.clear()

    watcher.run(make_context(client, notifier))

    condition = str(client.search_calls[0]["condition"])
    assert "CAREER#UPDATE_DATE" in condition
    assert "GE" in condition


def test_target_condition_is_combined_when_present(make_context, client):
    """対象を絞りたいときは target.condition を足すだけでよい。"""
    watcher = ResourceWatcher("career_status", dict(CONFIG, target={
        "condition": {"compoundType": "and", "items": [
            {"itemId": "CAREER#CAREER_ID", "searchType": "EQ", "value": "18"}]}}))
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)
    client.search_calls.clear()

    watcher.run(make_context(client, notifier))

    condition = str(client.search_calls[0]["condition"])
    assert "CAREER#CAREER_ID" in condition
    assert "CAREER#UPDATE_DATE" in condition


def test_search_always_specifies_sort_and_limit(watcher, make_context, client):
    """`sort` 未指定だと順序が保証されずページングが壊れる。`limit` は常に 100。"""
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)

    call = client.search_calls[0]
    assert call["sort"] == [{"itemId": "CAREER#UPDATE_DATE", "order": "asc"}]
    assert call["limit"] == 100


def test_cursor_is_queried_with_overlap(watcher, make_context, client, store):
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)

    cursor_value = datetime(2026, 8, 5, 15, 0, 0, tzinfo=JST)
    store.set_cursor("career_status", cursor_value, bootstrapped=True)
    client.search_calls.clear()

    watcher.run(make_context(client, notifier))

    expected = (cursor_value - timedelta(seconds=60)).strftime("%Y/%m/%d %H:%M:%S")
    assert expected in str(client.search_calls[0]["condition"])


def test_cursor_advances_on_success(watcher, make_context, client, store):
    notifier = CapturingNotifier({"career_status"})
    _bootstrap(watcher, make_context, client, notifier)
    store.set_cursor("career_status", datetime(2026, 1, 1, tzinfo=JST), bootstrapped=True)

    watcher.run(make_context(client, notifier))

    assert store.get_cursor("career_status").value > datetime(2026, 1, 2, tzinfo=JST)
    assert store.get_cursor("career_status").value <= now_jst()


# --- 起動時チェック -------------------------------------------------------

def test_validate_rejects_unknown_item_id(make_context, client):
    watcher = ResourceWatcher("career_status", dict(
        CONFIG, watched_items=[{"item_id": "CAREER#NOPE"}]))
    with pytest.raises(ConfigError) as exc:
        watcher.validate(make_context(client))
    assert "CAREER#NOPE" in str(exc.value)


def test_validate_rejects_resource_without_update_date(make_context, client):
    """UPDATE_DATE を持たないリソースはこの方式で監視できない。起動時に弾く。"""
    watcher = ResourceWatcher("x", dict(
        CONFIG, resource="career", update_date_item="CAREER#NOT_EXIST"))
    with pytest.raises(ConfigError) as exc:
        watcher.validate(make_context(client))
    assert "cannot be watched by update date" in str(exc.value)


def test_validate_rejects_unknown_template(make_context, client):
    watcher = ResourceWatcher("career_status", dict(
        CONFIG, notify={"channel_key": "career_status", "template": "missing"}))
    with pytest.raises(ConfigError):
        watcher.validate(make_context(client))


def test_validate_accepts_the_shipped_configuration(make_context, client):
    ResourceWatcher("career_status", CONFIG).validate(make_context(client))
    ResourceWatcher("career_status", CONFIG_ALL).validate(make_context(client))


def test_resource_is_required():
    with pytest.raises(ConfigError):
        ResourceWatcher("x", {k: v for k, v in CONFIG.items() if k != "resource"})


def test_select_item_ids_are_deduplicated(make_context, client):
    """CP は `itemIds` の重複を 400 で拒否する（`itemIdが重複しています`。実測）。

    `watched_items: "*"` では identity_items が必ず重複するので、
    一意化しないと全項目監視が丸ごと動かない。
    """
    watcher = ResourceWatcher("career_status", CONFIG_ALL)
    ctx = make_context(client, bootstrap=True)
    watcher.run(ctx)

    sent = client.select_item_ids[0]
    assert len(sent) == len(set(sent))
    # identity_items も取得対象に含まれていること
    assert "CAREER#CAREER_ID" in sent
