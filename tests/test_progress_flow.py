"""`ProgressFlowWatcher` — 要件2 + 要件3（仕様書 3.2）。

検証したいこと:

- ブートストラップは通知せず、リクエストも使わずにカーソルだけ置く
- 進捗履歴が増えたら通知する（モードA = 全遷移）
- **後戻り（`16 → 11 → 16`）が 3 件別々に通知される**
  （冪等キーに枝番が入っていないとここで 1 件消える）
- オーバーラップで同じ履歴を再取得しても二重通知しない
- 要件3（求人紹介OK）が別チャンネル・別文面で出る
- 遷移前ステータスを持ち越す（追加リクエストなし）。初回は「(不明)」
- **失敗したらカーソルを進めない**
- 名前解決がキャッシュされ、2 件目以降のリクエストが増えない
"""
from __future__ import annotations

from datetime import timedelta

import pytest

from app.core.errors import ConfigError
from app.core.timefmt import now_jst
from app.watchers.progress_flow import ProgressFlowWatcher
from tests.conftest import CapturingNotifier, FakeCpClient

CONFIG = {
    "type": "progress_flow",
    "enabled": True,
    "interval_minutes": 5,
    "priority": 1,
    "budget_per_cycle": 60,
    "overlap_seconds": 60,
    "notify_all_transitions": True,
    "watched_statuses": [],
    "notify": {"channel_key": "progress_flow", "template": "progress_transition"},
    "special_transitions": [
        {
            "name": "求人紹介OK",
            "to_status": "11",
            "from_status": "16",
            "notify": {"channel_key": "job_intro", "template": "job_intro_ok"},
        }
    ],
}


def _history(progress_id: int, sub: int, status: str, inserted: str = "2026-08-05T16:06:32",
             **estimated):
    """見込3項目は既定で未入力。実測でも「求人紹介OK」で入力しなければ None のまま。"""
    return {
        "PROGRESS_HISTORY#PROGRESS_ID": progress_id,
        "PROGRESS_HISTORY#PROGRESS_ID_SUB": sub,
        "PROGRESS_HISTORY#PROGRESS_STATUS_ID": status,
        "PROGRESS_HISTORY#PROGRESS_DATE": "2026-08-05",
        "PROGRESS_HISTORY#CAREER_CHARGE_ID": "7",
        "PROGRESS_HISTORY#ORDER_CHARGE_ID": "1",
        "PROGRESS_HISTORY#INSERT_DATE": inserted,
        "PROGRESS_HISTORY#ESTIMATED_SALES_AMOUNT": estimated.get("amount"),
        "PROGRESS_HISTORY#ESTIMATED_SALES_ACCURACY": estimated.get("accuracy"),
        "PROGRESS_HISTORY#ESTIMATED_SALES_MONTH": estimated.get("month"),
    }


def _progress(status: str = "11"):
    return {
        "PROGRESS#PROGRESS_ID": 21,
        "PROGRESS#CAREER_ID": 18,
        "PROGRESS#ORDER_ID": 6,
        "PROGRESS#CLIENT_ID": 3,
        "PROGRESS#STATUS_ID": status,
        "PROGRESS#PROGRESS_CHARGE_ID": "7",
    }


def _client(histories: dict[str, dict]) -> FakeCpClient:
    """実測（07-verification-results.md 11・12章）と同じ形のテナントを作る。"""
    return FakeCpClient(
        resources={
            "progress_history": histories,
            "progress": {"21": _progress()},
            "career": {"18": {"CAREER#LASTNAME": "惣流", "CAREER#FIRSTNAME": "アスカ"}},
            "order": {"6": {"ORDER#POSITIONNAME": "バックエンドエンジニア"}},
            "client": {"3": {"CLIENT#CLIENTNAME": "株式会社ネルフ"}},
        },
        default_resource="progress_history",
    )


@pytest.fixture
def watcher():
    return ProgressFlowWatcher("progress_flow", CONFIG)


def _bootstrapped(ctx, watcher, minutes_ago: int = 5):
    """通常運転の状態にする。カーソルは少し前に置く。"""
    ctx.store.set_cursor(watcher.id, now_jst() - timedelta(minutes=minutes_ago),
                         page_offset=0, bootstrapped=True)


# --- ブートストラップ -------------------------------------------------------

def test_bootstrap_notifies_nothing_and_costs_no_request(make_context, watcher, budget):
    """既存の進捗履歴を一斉通知しない。スナップショットも要らないので 0 リクエスト。"""
    client = _client({"21_1": _history(21, 1, "16")})
    notifier = CapturingNotifier({"progress_flow", "job_intro"})
    ctx = make_context(client, notifier, bootstrap=True)

    result = watcher.run(ctx)

    assert result.ok
    assert notifier.sent == []
    assert client.search_calls == []
    assert client.select_calls == []
    assert watcher.is_bootstrapped(ctx)


def test_execute_without_bootstrap_fails(make_context, watcher):
    """基準が無いまま走らせない。全既存履歴が「新規」に見えて Slack が溢れる。"""
    ctx = make_context(_client({}), CapturingNotifier({"progress_flow"}))

    result = watcher.run(ctx)

    assert not result.ok
    assert "bootstrap" in (result.error or "")


# --- 検知と通知 -------------------------------------------------------------

def test_notifies_transition_with_resolved_names(make_context, watcher):
    client = _client({"21_2": _history(21, 2, "11", "2026-08-05T16:28:08")})
    notifier = CapturingNotifier({"progress_flow", "job_intro"})
    ctx = make_context(client, notifier)
    _bootstrapped(ctx, watcher)

    result = watcher.run(ctx)

    assert result.ok
    assert result.events_detected == 1
    assert result.events_notified == 1
    sent = notifier.sent[0]
    # 冪等キーは枝番を含む履歴 ID
    assert sent.resource_id == "21_2"
    assert sent.event_type == "status_changed"
    assert "惣流 アスカ" in sent.body
    assert "バックエンドエンジニア" in sent.body
    assert "株式会社ネルフ" in sent.body
    # コード値ではなくラベルで出す
    assert "応募意思確認中(求人)" in sent.body


def test_first_sighting_shows_unknown_previous_status(make_context, watcher):
    """初めて観測する進捗の遷移前は分からない。推測で埋めず「(不明)」と書く。"""
    client = _client({"21_1": _history(21, 1, "16")})
    notifier = CapturingNotifier({"progress_flow", "job_intro"})
    ctx = make_context(client, notifier)
    _bootstrapped(ctx, watcher)

    watcher.run(ctx)

    assert "(不明) → 社内確認中" in notifier.sent[0].body


def test_backtracking_produces_three_distinct_notifications(make_context, watcher):
    """`16 → 11 → 16`。`21_1` と `21_3` は**同じステータス値**。

    冪等キーを `progressId + ステータス値` で作ると 3 件目が消える（実測で確認済み）。
    履歴 ID（枝番つき）を使えば 3 件とも残る。
    """
    client = _client({
        "21_1": _history(21, 1, "16", "2026-08-05T16:06:32"),
        "21_2": _history(21, 2, "11", "2026-08-05T16:28:08"),
        "21_3": _history(21, 3, "16", "2026-08-05T16:55:53"),
    })
    notifier = CapturingNotifier({"progress_flow", "job_intro"})
    ctx = make_context(client, notifier)
    _bootstrapped(ctx, watcher)

    result = watcher.run(ctx)

    assert result.events_notified == 3
    assert [n.resource_id for n in notifier.sent] == ["21_1", "21_2", "21_3"]
    # 遷移前ステータスが持ち越されている
    assert "(不明) → 社内確認中" in notifier.sent[0].body
    assert "社内確認中 → 応募意思確認中(求人)" in notifier.sent[1].body
    assert "応募意思確認中(求人) → 社内確認中" in notifier.sent[2].body


def test_overlap_does_not_resend(make_context, watcher):
    """オーバーラップで同じ履歴を再取得しても二重通知しない。

    **遷移前ステータスは 2 回目には持ち越し済みの値と一致してしまう。**
    これをダイジェストに入れていると別イベント扱いになり、ここで 2 通目が飛ぶ。
    """
    client = _client({"21_2": _history(21, 2, "11", "2026-08-05T16:28:08")})
    notifier = CapturingNotifier({"progress_flow", "job_intro"})
    ctx = make_context(client, notifier)
    _bootstrapped(ctx, watcher)

    watcher.run(ctx)
    ctx.store.set_cursor(watcher.id, now_jst() - timedelta(minutes=5), bootstrapped=True)
    second = watcher.run(ctx)

    assert len(notifier.sent) == 1
    assert second.events_notified == 0


# --- 要件3（special_transitions） -------------------------------------------

def test_special_transition_goes_to_its_own_channel(make_context, watcher):
    """求人紹介OK（16 → 11）は job_intro へ。一般チャンネルには出ない。"""
    client = _client({
        "21_1": _history(21, 1, "16", "2026-08-05T16:06:32"),
        "21_2": _history(21, 2, "11", "2026-08-05T16:28:08"),
    })
    notifier = CapturingNotifier({"progress_flow", "job_intro"})
    ctx = make_context(client, notifier)
    _bootstrapped(ctx, watcher)

    watcher.run(ctx)

    channels = [n.channel_key for n in notifier.sent]
    assert channels == ["progress_flow", "job_intro"]
    assert "求人紹介OK" in notifier.sent[1].body


def test_unknown_previous_status_still_matches_special_by_default(make_context, watcher):
    """遷移前が不明でも `to_status` が一致すれば要件3として扱う（既定）。

    取りこぼしは通知漏れであり、重複通知より重い
    （`rules/30-state-and-idempotency.md`）。
    """
    client = _client({"21_2": _history(21, 2, "11", "2026-08-05T16:28:08")})
    notifier = CapturingNotifier({"progress_flow", "job_intro"})
    ctx = make_context(client, notifier)
    _bootstrapped(ctx, watcher)

    watcher.run(ctx)

    assert notifier.sent[0].channel_key == "job_intro"


def test_job_intro_body_carries_the_estimated_sales_fields(make_context, watcher):
    """「求人紹介OK」の小画面で入力した3項目を本文に出す。

    **`progress_history/select` に相乗りするのでリクエストは増えない。**
    """
    client = _client({
        "21_2": _history(21, 2, "11", "2026-08-05T16:28:08",
                         amount=300, accuracy="1", month="2026-09-01"),
    })
    notifier = CapturingNotifier({"progress_flow", "job_intro"})
    ctx = make_context(client, notifier)
    _bootstrapped(ctx, watcher)

    watcher.run(ctx)

    body = notifier.sent[0].body
    assert "見込回収金額（万円）: 300" in body
    # 見込確度はコード値ではなくマスタのラベルで出す
    assert "見込確度: A" in body
    assert "見込計上月: 2026-09-01" in body
    # 履歴の select は 1 回のまま
    assert client.select_resources.count("progress_history") == 1


def test_estimated_fields_are_marked_unset_when_not_entered(make_context, watcher):
    """入力しなければ None のまま（実測）。空欄ではなく「(未設定)」と書く。"""
    client = _client({"21_2": _history(21, 2, "11", "2026-08-05T16:28:08")})
    notifier = CapturingNotifier({"progress_flow", "job_intro"})
    ctx = make_context(client, notifier)
    _bootstrapped(ctx, watcher)

    watcher.run(ctx)

    body = notifier.sent[0].body
    assert "見込回収金額（万円）: (未設定)" in body
    assert "見込確度: (未設定)" in body
    assert "見込計上月: (未設定)" in body


def test_from_status_required_falls_back_to_general_channel(make_context):
    """`from_status_required: true` にすると、遷移前が確認できたときだけ要件3にする。"""
    config = dict(CONFIG, special_transitions=[
        dict(CONFIG["special_transitions"][0], from_status_required=True)])
    strict = ProgressFlowWatcher("progress_flow", config)
    client = _client({"21_2": _history(21, 2, "11", "2026-08-05T16:28:08")})
    notifier = CapturingNotifier({"progress_flow", "job_intro"})
    ctx = make_context(client, notifier)
    _bootstrapped(ctx, strict)

    strict.run(ctx)

    assert notifier.sent[0].channel_key == "progress_flow"


# --- モードB（絞り込み） ----------------------------------------------------

def test_mode_b_filters_but_still_carries_previous_status(make_context):
    """通知しない遷移でも遷移前ステータスは持ち越す。

    持ち越しを飛ばすと、次に通知する遷移の「遷移前」が古い値になる。
    """
    config = dict(CONFIG, notify_all_transitions=False, watched_statuses=["11"],
                  special_transitions=[])
    mode_b = ProgressFlowWatcher("progress_flow", config)
    client = _client({
        "21_1": _history(21, 1, "16", "2026-08-05T16:06:32"),
        "21_2": _history(21, 2, "11", "2026-08-05T16:28:08"),
    })
    notifier = CapturingNotifier({"progress_flow", "job_intro"})
    ctx = make_context(client, notifier)
    _bootstrapped(ctx, mode_b)

    result = mode_b.run(ctx)

    assert result.events_notified == 1
    assert notifier.sent[0].resource_id == "21_2"
    assert "社内確認中 → 応募意思確認中(求人)" in notifier.sent[0].body


def test_mode_b_without_watched_statuses_is_rejected():
    """全部落とす設定は設定不備。黙って何も通知しない状態を作らせない。"""
    with pytest.raises(ConfigError):
        ProgressFlowWatcher("progress_flow", dict(
            CONFIG, notify_all_transitions=False, watched_statuses=[]))


# --- 流量 -------------------------------------------------------------------

def test_names_are_resolved_once_per_cycle(make_context, watcher):
    """名前解決キャッシュ。**これがリクエスト数に直結する**（仕様書 5.3）。"""
    client = _client({
        "21_1": _history(21, 1, "16", "2026-08-05T16:06:32"),
        "21_2": _history(21, 2, "11", "2026-08-05T16:28:08"),
        "21_3": _history(21, 3, "16", "2026-08-05T16:55:53"),
    })
    ctx = make_context(client, CapturingNotifier({"progress_flow", "job_intro"}))
    _bootstrapped(ctx, watcher)

    watcher.run(ctx)

    # 求職者・求人・企業はそれぞれ 1 回だけ。3 遷移とも同じ進捗なので 3 倍にならない
    assert client.select_resources.count("career") == 1
    assert client.select_resources.count("order") == 1
    assert client.select_resources.count("client") == 1
    # 履歴と進捗は遷移ごと（仕様書 3.2.8 の見積りどおり）
    assert client.select_resources.count("progress_history") == 3
    assert client.select_resources.count("progress") == 3


def test_search_uses_cp_datetime_format_with_overlap(make_context, watcher):
    """検索値は `YYYY/MM/DD HH:MM:SS`。ISO 8601 は 400 で拒否される（実測）。"""
    client = _client({})
    ctx = make_context(client, CapturingNotifier({"progress_flow"}))
    ctx.store.set_cursor(watcher.id, now_jst(), bootstrapped=True)

    watcher.run(ctx)

    condition = client.search_calls[0]["condition"]
    entry = condition["items"][0]
    assert entry["itemId"] == "PROGRESS_HISTORY#INSERT_DATE"
    assert entry["searchType"] == "GE"
    assert len(entry["value"]) == len("2026/08/05 16:28:08")
    assert entry["value"][4] == "/" and entry["value"][13] == ":"
    # 古い順。順序が狂うと遷移前ステータスの持ち越しが壊れる
    assert client.search_calls[0]["sort"] == [
        {"itemId": "PROGRESS_HISTORY#INSERT_DATE", "order": "asc"}]


# --- 失敗時の振る舞い -------------------------------------------------------

def test_cursor_does_not_advance_on_failure(make_context, watcher):
    client = _client({"21_2": _history(21, 2, "11", "2026-08-05T16:28:08")})
    client.fail_select_for = {"21_2"}
    ctx = make_context(client, CapturingNotifier({"progress_flow", "job_intro"}))
    before = now_jst() - timedelta(minutes=5)
    ctx.store.set_cursor(watcher.id, before, bootstrapped=True)

    result = watcher.run(ctx)

    assert not result.ok
    assert ctx.store.get_cursor(watcher.id).value == before


def test_cursor_does_not_advance_when_paging_is_capped(make_context):
    """ページ上限で打ち切ったサイクルではカーソルを進めない。

    予算切れではなくページ上限で止まる状況を作るため、予算は多めに与える。
    """
    roomy = ProgressFlowWatcher("progress_flow", dict(CONFIG, budget_per_cycle=2000))
    histories = {f"21_{i}": _history(21, i, "16") for i in range(1, 260)}
    client = _client(histories)
    ctx = make_context(client, CapturingNotifier({"progress_flow", "job_intro"}))
    before = now_jst() - timedelta(minutes=5)
    ctx.store.set_cursor(roomy.id, before, bootstrapped=True)
    ctx.app_config.max_pages_per_cycle = 2

    result = roomy.run(ctx)

    assert result.exhausted
    assert not result.error
    # 2 ページぶん（200件）だけ見て打ち切っている
    assert len(client.search_calls) == 2
    assert ctx.store.get_cursor(roomy.id).value == before


def test_budget_exhaustion_keeps_cursor_and_does_not_resend(make_context):
    """予算切れで中断しても、次サイクルで処理済みのぶんを再送しない。

    カーソルは進まないので同じ履歴を再取得するが、冪等キーで落ちる。
    """
    tight = ProgressFlowWatcher("progress_flow", dict(CONFIG, budget_per_cycle=6))
    client = _client({
        f"21_{i}": _history(21, i, "16", f"2026-08-05T16:0{i}:00") for i in range(1, 6)
    })
    notifier = CapturingNotifier({"progress_flow", "job_intro"})
    ctx = make_context(client, notifier)
    before = now_jst() - timedelta(minutes=5)
    ctx.store.set_cursor(tight.id, before, bootstrapped=True)

    first = tight.run(ctx)
    assert first.exhausted
    assert ctx.store.get_cursor(tight.id).value == before
    partial = len(notifier.sent)
    assert 0 < partial < 5

    roomy = ProgressFlowWatcher("progress_flow", dict(CONFIG, budget_per_cycle=100))
    roomy.run(ctx)

    # 通知は合計 5 件。再取得したぶんが二重にならない
    assert len(notifier.sent) == 5
    assert len({n.resource_id for n in notifier.sent}) == 5


def test_unparsable_history_id_goes_to_dead_letter(make_context, watcher):
    """ID の形式が想定外でもサイクルを止めない。人が見る dead letter に落とす。"""
    client = _client({"broken": {"PROGRESS_HISTORY#PROGRESS_STATUS_ID": "16"}})
    ctx = make_context(client, CapturingNotifier({"progress_flow", "job_intro"}))
    _bootstrapped(ctx, watcher)

    result = watcher.run(ctx)

    assert result.ok
    assert result.events_notified == 0
    assert ctx.store.count_dead_letters() == 1


# --- 起動時チェック ---------------------------------------------------------

def test_validate_accepts_the_shipped_config(make_context, watcher):
    ctx = make_context(_client({}), CapturingNotifier({"progress_flow", "job_intro"}))
    watcher.validate(ctx)


def test_validate_rejects_unknown_template(make_context):
    bad = ProgressFlowWatcher("progress_flow", dict(
        CONFIG, notify={"channel_key": "progress_flow", "template": "nope"}))
    ctx = make_context(_client({}), CapturingNotifier({"progress_flow"}))

    with pytest.raises(ConfigError, match="nope"):
        bad.validate(ctx)


def test_validate_rejects_template_with_unknown_variable(make_context, watcher):
    ctx = make_context(_client({}), CapturingNotifier({"progress_flow", "job_intro"}))
    ctx.templates = dict(ctx.templates)
    ctx.templates["progress_transition"] = {"body": "{does_not_exist}"}

    with pytest.raises(ConfigError, match="unknown variable"):
        watcher.validate(ctx)


def test_channel_keys_include_special_transitions(watcher):
    """起動時に Webhook の設定漏れを検出するため、special の宛先も申告する。"""
    assert set(watcher.channel_keys()) == {"progress_flow", "job_intro"}


def test_special_transition_needs_a_condition():
    """条件のない special は一般チャンネルを丸ごと奪ってしまう。"""
    with pytest.raises(ConfigError):
        ProgressFlowWatcher("progress_flow", dict(CONFIG, special_transitions=[
            {"name": "全部", "notify": {"channel_key": "job_intro",
                                        "template": "job_intro_ok"}}]))
