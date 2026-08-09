"""要件2 + 要件3 — 進捗フローの進行（仕様書 3.2）。

**進捗履歴が1行増えたら「フローが進行した」とみなす。**
CP はステータス変更を進捗履歴の追加として記録する設計であり、
進捗の新規作成も枝番の最初の進捗履歴として記録される（実測 2026-08-05）。

要件3（求人紹介OK）は**要件2と同一のデータソース**であり、
「進捗ステータスが `社内確認中(16)` → `応募意思確認中(求人)(11)` へ遷移するイベント」だった。
別々に API を叩かず、全遷移の上に「特定の遷移だけ文面とチャンネルを変える」形で乗せる。

検知方式:

1. `progress_history/search`（`INSERT_DATE GE カーソル − オーバーラップ`）で追加された ID を得る
2. `progress_history/select` で遷移先ステータスと進捗 ID を得る
3. `progress/select` で「誰の・どの求人か」を得る
4. `core/resolver.py` で求職者名・求人名・企業名を解決（キャッシュヒット時は 0 リクエスト）
5. マスタでコード値をラベルに変換して通知

**モードA（全遷移を通知）で開始する**（仕様書 3.2.2）。
マスタの返却順が業務フロー順ではないことが実測で判明しており、
フロー定義を推測で埋めると通知漏れになる。まず全遷移を流し、実データを見てから絞る。

## 冪等キーに枝番を含める理由

フローは後戻りする（「再面談」で `11` → `16` に戻り、これも履歴の追加として記録される）。
`progressId + ステータス値` で冪等キーを作ると、`16 → 11 → 16` と往復したときに
2回目の `16` が重複扱いされて通知が消える（`21_1` と `21_3` は同じステータス値 `16`）。
**`resource_id` に進捗履歴 ID（枝番を含む `21_3`）を使う**ことでこれを避ける。

## 遷移前ステータス（`from_status`）の持ち方

CP は「遷移前のステータス」を返さない。`progress/select` で読める `PROGRESS#STATUS_ID` は
**遷移後の値**であり（実測）、遷移前の値はどこにも残っていない。
そこで **1つ前に観測したステータスを `snapshots` に持ち越す。**追加リクエストは 0。

- 枝番の起点（`progress_history` は 1 始まり、`career_action` は 0 始まり）に依存しない。
  枝番を判定に一切使っていないため（仕様書 3.2.3 の「起点に依存しない実装にすること」）。
- **初めて観測する進捗の `from_status` は不明になる。**「(不明)」と表示する。
  推測で埋めない（`rules/00-scope-and-phase.md`）。
- `from_status` を冪等キーに入れてはいけない。オーバーラップで再取得したときに
  持ち越し済みの値と突き合わせて別のダイジェストになり、二重通知になる。

## 拾えないもの（仕様書 3.2.5）

進捗履歴の**削除**と進捗そのものの削除は検知できない（削除は検索に現れない）。
必要になったら日次で全進捗を棚卸しする低頻度ウォッチャーを足す設計になる。**今回は作らない。**
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from app.core.budget import RequestBudget
from app.core.errors import ConfigError
from app.core.events import CycleResult, Notification
from app.core.paging import search_ids
from app.core.store import canonical_value, payload_hash
from app.core.timefmt import now_jst, to_cp_datetime
from app.watchers.base import Context, Watcher

# 項目 ID をコードに直書きせず 1 箇所に集約する（`rules/10-cp-api.md`）。
# 起動時に実環境の schema と突き合わせ、存在しなければ**起動を失敗させる。**
HISTORY_RESOURCE = "progress_history"
PROGRESS_RESOURCE = "progress"

HISTORY_INSERT_DATE = "PROGRESS_HISTORY#INSERT_DATE"
HISTORY_PROGRESS_ID = "PROGRESS_HISTORY#PROGRESS_ID"
HISTORY_PROGRESS_ID_SUB = "PROGRESS_HISTORY#PROGRESS_ID_SUB"
HISTORY_STATUS = "PROGRESS_HISTORY#PROGRESS_STATUS_ID"
HISTORY_PROGRESS_DATE = "PROGRESS_HISTORY#PROGRESS_DATE"
HISTORY_CAREER_CHARGE = "PROGRESS_HISTORY#CAREER_CHARGE_ID"
HISTORY_ORDER_CHARGE = "PROGRESS_HISTORY#ORDER_CHARGE_ID"
# 「求人紹介OK」の小画面で入力する 3 項目（実測。仕様書 3.2.9）。
# 入力されなければ None のままなので、通知本文では「(未設定)」になる
HISTORY_ESTIMATED_AMOUNT = "PROGRESS_HISTORY#ESTIMATED_SALES_AMOUNT"
HISTORY_ESTIMATED_ACCURACY = "PROGRESS_HISTORY#ESTIMATED_SALES_ACCURACY"
HISTORY_ESTIMATED_MONTH = "PROGRESS_HISTORY#ESTIMATED_SALES_MONTH"

PROGRESS_CAREER_ID = "PROGRESS#CAREER_ID"
PROGRESS_ORDER_ID = "PROGRESS#ORDER_ID"
PROGRESS_CLIENT_ID = "PROGRESS#CLIENT_ID"
PROGRESS_STATUS = "PROGRESS#STATUS_ID"
PROGRESS_CHARGE = "PROGRESS#PROGRESS_CHARGE_ID"

# 進捗履歴から取る項目（仕様書 3.2.3 手順2）。
# **項目を足しても 1 リクエストのまま。**`select` は 1 リクエスト = 1 リソースで、
# `itemIds` の数はリクエスト数に影響しない。
# `PROGRESS_ID` / `PROGRESS_ID_SUB` は ID 文字列の分解でも得られるが、
# 同じリクエストに含められるので追加コストなしで確実な値を使う
HISTORY_ITEMS = [
    HISTORY_PROGRESS_ID,
    HISTORY_PROGRESS_ID_SUB,
    HISTORY_STATUS,
    HISTORY_PROGRESS_DATE,
    HISTORY_CAREER_CHARGE,
    HISTORY_ORDER_CHARGE,
    HISTORY_ESTIMATED_AMOUNT,
    HISTORY_ESTIMATED_ACCURACY,
    HISTORY_ESTIMATED_MONTH,
]

# 進捗から取る項目（仕様書 3.2.3 手順4）。
# `PROGRESS#PROGRESS_CHARGE_ID` は項目一覧 xlsx に無いが実環境には存在する（実測）
PROGRESS_ITEMS = [
    PROGRESS_CAREER_ID,
    PROGRESS_ORDER_ID,
    PROGRESS_CLIENT_ID,
    PROGRESS_STATUS,
    PROGRESS_CHARGE,
]

# `from_status` の持ち越しを `snapshots` に置くときの項目 ID。
# 実際の項目値のスナップショットではなく、このウォッチャー専用の持ち越し領域
LAST_STATUS_KEY = HISTORY_STATUS

UNKNOWN_LABEL = "(不明)"


@dataclass(frozen=True)
class TransitionRule:
    """どの遷移をどのチャンネルへ、どの文面で送るか。"""

    name: str
    channel_key: str
    template: str
    to_status: str | None = None
    from_status: str | None = None
    # `from_status` が不明（その進捗を初めて観測した）ときに一致とみなすか。
    # 既定は「一致とみなす」。取りこぼしは通知漏れであり、重複通知より重い
    # （`rules/30-state-and-idempotency.md`）
    from_status_required: bool = False
    is_special: bool = False

    def matches(self, to_status: str | None, from_status: str | None) -> bool:
        if self.to_status is not None and to_status != self.to_status:
            return False
        if self.from_status is None:
            return True
        if from_status is None:
            return not self.from_status_required
        return from_status == self.from_status


@dataclass
class Transition:
    """通知 1 件ぶんの材料。"""

    history_id: str
    progress_id: str
    progress_sub: str
    from_status: str | None
    to_status: str | None
    progress_date: str
    history: dict[str, Any]
    progress: dict[str, Any]


class ProgressFlowWatcher(Watcher):
    EVENT_TYPE = "status_changed"

    def __init__(self, watcher_id: str, config: dict[str, Any]):
        super().__init__(watcher_id, config)

        self.notify_all_transitions: bool = bool(config.get("notify_all_transitions", True))
        self.watched_statuses: list[str] = [
            str(s) for s in (config.get("watched_statuses") or [])
        ]
        if not self.notify_all_transitions and not self.watched_statuses:
            raise ConfigError(
                f"{watcher_id}: notify_all_transitions is false but watched_statuses is empty. "
                f"Nothing would ever be notified"
            )

        notify = config.get("notify") or {}
        for key in ("channel_key", "template"):
            if not notify.get(key):
                raise ConfigError(f"{watcher_id}: notify.{key} is required")
        self.general_rule = TransitionRule(
            name=notify.get("name", "進捗フローの進行"),
            channel_key=notify["channel_key"],
            template=notify["template"],
        )

        self.special_rules: list[TransitionRule] = [
            self._build_special(watcher_id, entry)
            for entry in (config.get("special_transitions") or [])
        ]

    def _build_special(self, watcher_id: str, entry: dict[str, Any]) -> TransitionRule:
        notify = (entry or {}).get("notify") or {}
        for key in ("channel_key", "template"):
            if not notify.get(key):
                raise ConfigError(
                    f"{watcher_id}: special_transitions[].notify.{key} is required")
        if not entry.get("to_status") and not entry.get("from_status"):
            raise ConfigError(
                f"{watcher_id}: special_transitions[] needs to_status or from_status; "
                f"a rule that matches everything would shadow the general channel"
            )
        return TransitionRule(
            name=str(entry.get("name") or "特定の遷移"),
            channel_key=notify["channel_key"],
            template=notify["template"],
            to_status=_as_code(entry.get("to_status")),
            from_status=_as_code(entry.get("from_status")),
            from_status_required=bool(entry.get("from_status_required", False)),
            is_special=True,
        )

    # --- 起動時チェック --------------------------------------------------

    def validate(self, ctx: Context) -> None:
        ctx.schema.validate(HISTORY_RESOURCE, [HISTORY_INSERT_DATE] + HISTORY_ITEMS)
        ctx.schema.validate(PROGRESS_RESOURCE, PROGRESS_ITEMS)

        # 名前解決に使う項目も実在検証の対象にする。
        # 存在しない項目 ID を書くと、通知が届いてから初めて気づくことになる
        for kind in ("career", "order", "client"):
            resource = ctx.resolver.resource_of(kind)
            if resource is None:
                ctx.logger.warn("name_resolution_missing", watcher_id=self.id, kind=kind,
                                hint="add it to name_resolution in config/app.yaml")
                continue
            ctx.schema.validate(resource, ctx.resolver.item_ids(kind))

        for rule in [self.general_rule] + self.special_rules:
            template = ctx.templates.get(rule.template)
            if template is None:
                raise ConfigError(
                    f"{self.id}: template '{rule.template}' not found")
            _check_template(self.id, rule, template)

        ctx.logger.info(
            "watcher_validated",
            watcher_id=self.id,
            resource=HISTORY_RESOURCE,
            notify_all_transitions=self.notify_all_transitions,
            watched_statuses=self.watched_statuses,
            special_transitions=[
                {"name": r.name, "to_status": r.to_status, "from_status": r.from_status,
                 "channel_key": r.channel_key}
                for r in self.special_rules
            ],
        )

    def required_masters(self) -> list[str]:
        """参照するマスタは schema の `codeName` から解決するため先読みしない。

        取得結果は 24 時間キャッシュされ、トークンバケットは通る
        （`ResourceWatcher` と同じ方針）。
        """
        return []

    def channel_keys(self) -> list[str]:
        return [r.channel_key for r in [self.general_rule] + self.special_rules]

    # --- 本体 ------------------------------------------------------------

    def execute(self, ctx: Context, budget: RequestBudget) -> CycleResult:
        cursor = ctx.store.get_cursor(self.id)
        if cursor is None or not cursor.bootstrapped:
            raise ConfigError(
                f"{self.id}: no baseline yet. Run with --bootstrap first "
                f"(without it, every existing progress history would be notified)"
            )

        cycle_start = now_jst()
        since = cursor.value - timedelta(seconds=self.overlap_seconds)

        ids, capped = search_ids(
            ctx.client,
            HISTORY_RESOURCE,
            condition={
                "compoundType": "and",
                "items": [{
                    "itemId": HISTORY_INSERT_DATE,
                    "searchType": "GE",
                    # datetime は `YYYY/MM/DD HH:MM:SS`。秒精度は実際に効く（実測）
                    "value": to_cp_datetime(since),
                }],
            },
            # 古い順に処理する。**同一進捗で複数の遷移が同時に来たとき、
            # 順序が狂うと `from_status` の持ち越しが壊れる**
            sort=[{"itemId": HISTORY_INSERT_DATE, "order": "asc"}],
            budget=budget,
            logger=ctx.logger,
            watcher_id=self.id,
            max_pages=ctx.app_config.max_pages_per_cycle,
        )
        ctx.logger.info("search_done", watcher_id=self.id, resource=HISTORY_RESOURCE,
                        candidate_count=len(ids), since=since.isoformat())

        detected = 0
        ctx.dispatcher.begin_cycle()
        try:
            for history_id in ids:
                if self._process(ctx, budget, history_id):
                    detected += 1
        finally:
            sent = ctx.dispatcher.end_cycle()

        ctx.logger.info("name_cache", watcher_id=self.id, **ctx.resolver.stats())

        if capped:
            # 全件を見きれていないのでカーソルを進めない。次サイクルで続きを拾う
            return CycleResult(ok=True, events_detected=detected,
                               events_notified=sent, exhausted=True)

        ctx.store.set_cursor(self.id, cycle_start, page_offset=0, bootstrapped=True)
        return CycleResult(ok=True, events_detected=detected, events_notified=sent)

    def bootstrap(self, ctx: Context, budget: RequestBudget) -> CycleResult:
        """基準を作るだけ。**通知しない。リクエストも使わない。**

        このウォッチャーは「履歴が増えたこと」自体がイベントなので、
        項目値のスナップショットは要らない（仕様書 3.2.3 手順7）。
        必要なのは「ここから先を見る」というカーソルだけ。

        既存の進捗履歴（検証テナントで 27 件、本番では相応の件数）を
        全部通知してしまわないよう、**現在時刻をカーソルに置く。**
        """
        cursor = ctx.store.get_cursor(self.id)
        if cursor is not None and cursor.bootstrapped:
            ctx.logger.info("bootstrap_skipped", watcher_id=self.id, reason="already done")
            return CycleResult(ok=True)

        started_at = now_jst()
        ctx.store.set_cursor(self.id, started_at, page_offset=0, bootstrapped=True)
        ctx.logger.info("bootstrap_done", watcher_id=self.id, resource=HISTORY_RESOURCE,
                        cursor_value=started_at.isoformat(),
                        note="no snapshot needed; history rows are the events")
        return CycleResult(ok=True)

    def is_bootstrapped(self, ctx: Context) -> bool:
        cursor = ctx.store.get_cursor(self.id)
        return cursor is not None and cursor.bootstrapped

    # --- 内部 ------------------------------------------------------------

    def _process(self, ctx: Context, budget: RequestBudget, history_id: str) -> bool:
        """進捗履歴 1 件を通知に変える。通知したら True。

        順序: `select` → 判定 → **通知** → `from_status` の持ち越し更新。
        持ち越しを先に更新すると、通知に失敗したときに遷移前の値が失われる。
        """
        history = ctx.client.select(HISTORY_RESOURCE, history_id, HISTORY_ITEMS, budget)

        progress_id, progress_sub = _identify(history_id, history)
        if progress_id is None:
            # ID の形式が想定と違う。ここで例外にすると同じ行で毎サイクル止まるので、
            # 人が見る dead letter に落として先へ進む（`rules/10-cp-api.md` の 400 相当）
            ctx.store.add_dead_letter(
                self.id, f'{{"history_id": "{history_id}"}}',
                "cannot determine progress id from history id")
            ctx.logger.error("history_id_unparsed", watcher_id=self.id,
                             resource_id=history_id)
            return False

        to_status = _as_code(history.get(HISTORY_STATUS))
        from_status = self._load_last_status(ctx, progress_id)

        rule = self._match(to_status, from_status)
        if rule is None:
            ctx.logger.debug("transition_filtered", watcher_id=self.id,
                             resource_id=history_id, to_status=to_status)
            self._store_last_status(ctx, progress_id, to_status)
            return False

        progress = ctx.client.select(PROGRESS_RESOURCE, progress_id, PROGRESS_ITEMS, budget)
        transition = Transition(
            history_id=history_id,
            progress_id=progress_id,
            progress_sub=progress_sub,
            from_status=from_status,
            to_status=to_status,
            progress_date=_as_text(history.get(HISTORY_PROGRESS_DATE)),
            history=history,
            progress=progress,
        )

        ctx.logger.info("transition_detected", watcher_id=self.id, resource_id=history_id,
                        progress_id=progress_id, from_status=from_status,
                        to_status=to_status, rule=rule.name, special=rule.is_special)
        ctx.dispatcher.dispatch_one(self._build_notification(ctx, rule, transition))

        self._store_last_status(ctx, progress_id, to_status)
        return True

    def _match(self, to_status: str | None, from_status: str | None) -> TransitionRule | None:
        """先に書かれた特別ルールが勝つ。どれにも当たらなければ一般ルール。"""
        for rule in self.special_rules:
            if rule.matches(to_status, from_status):
                return rule
        if self.notify_all_transitions:
            return self.general_rule
        if to_status is not None and to_status in self.watched_statuses:
            return self.general_rule
        return None

    # `from_status` の持ち越し。`snapshots` を「前回観測したステータス」の置き場として使う。
    # 差分検知のためではないので、値は必ず生で持つ（表示に使うため）
    def _load_last_status(self, ctx: Context, progress_id: str) -> str | None:
        snapshot = ctx.store.get_snapshots(self.id, progress_id).get(LAST_STATUS_KEY)
        if snapshot is None or not snapshot.has_raw:
            return None
        return _as_code(snapshot.decoded())

    def _store_last_status(self, ctx: Context, progress_id: str,
                           status: str | None) -> None:
        with ctx.store.transaction():
            ctx.store.put_snapshot(self.id, progress_id, LAST_STATUS_KEY, status,
                                   keep_raw=True, item_type="selectone")

    def _build_notification(self, ctx: Context, rule: TransitionRule,
                            transition: Transition) -> Notification:
        template = ctx.templates[rule.template]
        progress = transition.progress

        fields = {
            "transition_name": rule.name,
            "resource_id": transition.history_id,
            "progress_id": transition.progress_id,
            "progress_sub": transition.progress_sub,
            "from_status": transition.from_status or "",
            "to_status": transition.to_status or "",
            "from_label": self._status_label(ctx, transition.from_status),
            "to_label": self._status_label(ctx, transition.to_status),
            "progress_date": transition.progress_date or "(未設定)",
            "career_name": ctx.resolver.resolve("career", progress.get(PROGRESS_CAREER_ID)),
            "order_name": ctx.resolver.resolve("order", progress.get(PROGRESS_ORDER_ID)),
            "client_name": ctx.resolver.resolve("client", progress.get(PROGRESS_CLIENT_ID)),
            "progress_charge": self._code_label(ctx, PROGRESS_RESOURCE, PROGRESS_CHARGE,
                                                progress.get(PROGRESS_CHARGE)),
            "career_charge": self._code_label(ctx, HISTORY_RESOURCE, HISTORY_CAREER_CHARGE,
                                              transition.history.get(HISTORY_CAREER_CHARGE)),
            "order_charge": self._code_label(ctx, HISTORY_RESOURCE, HISTORY_ORDER_CHARGE,
                                             transition.history.get(HISTORY_ORDER_CHARGE)),
            # 「求人紹介OK」の小画面で入力する 3 項目。単位（万円）は文言なので
            # テンプレート側のラベルに書く（`rules/50-code-style.md`）
            "estimated_amount": _as_number(
                transition.history.get(HISTORY_ESTIMATED_AMOUNT)),
            "estimated_accuracy": self._code_label(
                ctx, HISTORY_RESOURCE, HISTORY_ESTIMATED_ACCURACY,
                transition.history.get(HISTORY_ESTIMATED_ACCURACY)),
            "estimated_month": _as_text(
                transition.history.get(HISTORY_ESTIMATED_MONTH)) or "(未設定)",
        }

        # **`from_status` をダイジェストに入れない。**
        # オーバーラップで同じ履歴を再取得したとき、持ち越し済みの値と突き合わせると
        # 別のダイジェストになり、重複除去をすり抜けて二重通知になる。
        # 進捗履歴は追記専用なので、履歴 ID と自身の内容だけで一意に決まる
        digest = payload_hash([
            transition.to_status,
            transition.progress_date,
            transition.history.get(HISTORY_ESTIMATED_AMOUNT),
            transition.history.get(HISTORY_ESTIMATED_ACCURACY),
            transition.history.get(HISTORY_ESTIMATED_MONTH),
        ])

        return Notification(
            watcher_id=self.id,
            # 枝番を含む履歴 ID。後戻り（`16 → 11 → 16`）を別イベントとして区別できる
            resource_id=transition.history_id,
            event_type=self.EVENT_TYPE,
            digest=digest,
            channel_key=rule.channel_key,
            subject=template.get("subject", "[CP] 進捗が動きました").format(**fields),
            body=template["body"].format(**fields),
            meta={"resource": HISTORY_RESOURCE, "progress_id": transition.progress_id,
                  "rule": rule.name},
        )

    def _status_label(self, ctx: Context, status: str | None) -> str:
        """進捗ステータスのコードをラベルにする。

        参照マスタ名（`MST_PROGRESS_STATUS`）は schema の `validationRule.codeName`
        から取れるので、YAML にもコードにも書かない。
        """
        if status is None:
            # 初めて観測する進捗には遷移前の値が存在しない。推測で埋めない
            return UNKNOWN_LABEL
        definition = ctx.schema.describe(HISTORY_RESOURCE, HISTORY_STATUS)
        return ctx.master.label(definition.code_name if definition else None, status)

    def _code_label(self, ctx: Context, resource: str, item_id: str, value: object) -> str:
        """コード値をラベルにする。参照マスタ名は schema から解決するので書かない。"""
        definition = ctx.schema.describe(resource, item_id)
        return ctx.master.label(definition.code_name if definition else None, value)


def _identify(history_id: str, history: dict[str, Any]) -> tuple[str | None, str]:
    """進捗 ID と枝番を決める。

    レスポンスに含まれる値を優先し、無ければ ID 文字列を分解する
    （`{progressId}_{枝番}`）。分解は `rpartition` で行う。
    **枝番の起点はリソースによって違う**（`progress_history` は 1 始まり、
    `career_action` は 0 始まり）ので、起点を前提にした判定を書かないこと。
    """
    progress_id = _as_code(history.get(HISTORY_PROGRESS_ID))
    # 枝番は number。**`0` を未設定に潰してはいけない**
    # （`career_action` は 0 始まり。同じ分解処理を将来使い回すため）
    sub_value = canonical_value(history.get(HISTORY_PROGRESS_ID_SUB), "number")
    progress_sub = None if sub_value is None else str(sub_value)

    parent, separator, sub = history_id.rpartition("_")
    if progress_id is None and separator and parent:
        progress_id = parent
    if progress_sub is None and separator:
        progress_sub = sub

    return progress_id, progress_sub or ""


def _as_code(value: object) -> str | None:
    """CP の値をコード文字列に揃える。

    `number` は JSON 数値で返るので `21` / `21.0` / `"21"` を同じ ID として扱う。
    未設定（`None` / 空 / 選択項目の `0`）は `None`。
    """
    normalized = canonical_value(value, "selectone")
    return None if normalized is None else str(normalized)


def _as_text(value: object) -> str:
    return "" if value is None else str(value)


def _as_number(value: object) -> str:
    """`number` を通知用の文字列にする。

    CP は number を JSON 数値で返すので `300.0` を `300` に直す。
    **`0` は正当な値なので潰さない**（未設定は `None`）。
    """
    normalized = canonical_value(value, "number")
    return "(未設定)" if normalized is None else str(normalized)


def _check_template(watcher_id: str, rule: TransitionRule,
                    template: dict[str, Any]) -> None:
    """テンプレートに未定義の変数が書かれていないかを**起動時に**確かめる。

    通知の組み立て時に `KeyError` で落ちると、そのイベントは dead letter にすら
    載らずに 1 サイクル丸ごと失敗する。設定不備は起動時に出す。
    """
    probe = {key: "" for key in (
        "transition_name", "resource_id", "progress_id", "progress_sub",
        "from_status", "to_status", "from_label", "to_label", "progress_date",
        "career_name", "order_name", "client_name",
        "progress_charge", "career_charge", "order_charge",
        "estimated_amount", "estimated_accuracy", "estimated_month",
    )}
    if "body" not in template:
        raise ConfigError(f"{watcher_id}: template '{rule.template}' has no body")
    for key in ("subject", "body"):
        text = template.get(key)
        if text is None:
            continue
        try:
            text.format(**probe)
        except (KeyError, IndexError, ValueError) as exc:
            raise ConfigError(
                f"{watcher_id}: template '{rule.template}'.{key} uses an unknown "
                f"variable {exc}. Available: {sorted(probe)}"
            ) from None
