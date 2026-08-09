"""テスト用のフェイク。

**CP API はモックする。実 API を叩くテストを CI に置かない**
（流量制約に反する。`rules/50-code-style.md`）。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from app.core.budget import RequestBudget
from app.core.config import AppConfig, NameSource
from app.core.events import Notification
from app.core.logging import Logger
from app.core.master import MasterRegistry
from app.core.resolver import NameResolver
from app.core.schema import SchemaRegistry
from app.core.store import Store
from app.notifiers.base import Notifier
from app.notifiers.dispatcher import Dispatcher
from app.watchers.base import Context

# 実環境の schema を模したもの。
# 参照マスタ名が validationRule.codeName に入る点は実測どおり（2026-08-07）
def _item(item_id, label, item_type, code_name=None, read_only=False):
    return {
        "itemId": item_id, "label": label, "itemType": item_type,
        "isReadOnly": read_only, "isNotUpdatable": False, "isSortable": True,
        "validationRule": {"required": False, "codeName": code_name},
    }


CAREER_SCHEMA = [
    _item("CAREER#CAREER_ID", "求職者ID", "number", read_only=True),
    _item("CAREER#LASTNAME", "姓", "text"),
    _item("CAREER#FIRSTNAME", "名", "text"),
    _item("CAREER#UPDATE_DATE", "更新日", "datetime", read_only=True),
    _item("CAREER#INSERT_DATE", "登録日", "datetime", read_only=True),
    _item("CAREER#LAST_LOGIN", "最終ログイン", "datetime"),
    _item("CAREER#48002", "国籍（氏名・生年月日）", "text"),
    _item("CAREER#REGSTATUS_ID", "登録ステータス", "selectone", "MSTREGSTATUS"),
    _item("CAREER#CNSLSTATUS_ID", "面談ステータス", "selectone", "MSTCNSLSTATUS"),
    _item("CAREER#MEMO", "備考", "textarea"),
]

# 要件2/3 が使うリソース。実環境の schema から必要な項目だけを写している
PROGRESS_HISTORY_SCHEMA = [
    _item("PROGRESS_HISTORY#PROGRESS_ID", "進捗履歴：進捗ID", "number"),
    _item("PROGRESS_HISTORY#PROGRESS_ID_SUB", "進捗履歴：進捗ID_枝番", "number"),
    _item("PROGRESS_HISTORY#PROGRESS_STATUS_ID", "進捗履歴：進捗ステータスID",
          "selectone", "MST_PROGRESS_STATUS"),
    _item("PROGRESS_HISTORY#PROGRESS_DATE", "進捗履歴：進捗日", "date"),
    _item("PROGRESS_HISTORY#CAREER_CHARGE_ID", "進捗履歴：求職者担当者", "selectone", "MSTUSER"),
    _item("PROGRESS_HISTORY#ORDER_CHARGE_ID", "進捗履歴：求人担当者", "selectone", "MSTUSER"),
    _item("PROGRESS_HISTORY#INSERT_DATE", "進捗履歴：入力日", "datetime", read_only=True),
    _item("PROGRESS_HISTORY#UPDATE_DATE", "進捗履歴：更新日", "datetime", read_only=True),
    # 「求人紹介OK」の小画面で入力する3項目
    _item("PROGRESS_HISTORY#ESTIMATED_SALES_AMOUNT", "進捗履歴：見込回収金額", "number"),
    _item("PROGRESS_HISTORY#ESTIMATED_SALES_ACCURACY", "進捗履歴：見込確度",
          "selectone", "MST_ESTIMATED_SALES_ACCURACY"),
    _item("PROGRESS_HISTORY#ESTIMATED_SALES_MONTH", "進捗履歴：見込計上月", "date"),
]

PROGRESS_SCHEMA = [
    _item("PROGRESS#PROGRESS_ID", "進捗：進捗ID", "number"),
    _item("PROGRESS#CAREER_ID", "進捗：求職者ID", "number"),
    _item("PROGRESS#ORDER_ID", "進捗：求人ID", "number"),
    _item("PROGRESS#CLIENT_ID", "進捗：企業ID", "number"),
    _item("PROGRESS#STATUS_ID", "進捗：進捗ステータス", "selectone", "MST_PROGRESS_STATUS"),
    # 項目一覧 xlsx には無いが実環境には存在する（実測）
    _item("PROGRESS#PROGRESS_CHARGE_ID", "進捗：担当者", "selectone", "MSTUSER"),
    _item("PROGRESS#UPDATE_DATE", "進捗：更新日", "datetime", read_only=True),
]

ORDER_SCHEMA = [
    _item("ORDER#ORDER_ID", "求人：求人ID", "number"),
    _item("ORDER#POSITIONNAME", "求人：ポジション名", "text"),
]

CLIENT_SCHEMA = [
    _item("CLIENT#CLIENT_ID", "企業：企業ID", "number"),
    _item("CLIENT#CLIENTNAME", "企業：企業名", "text"),
]

SCHEMAS = {
    "career": CAREER_SCHEMA,
    "progress_history": PROGRESS_HISTORY_SCHEMA,
    "progress": PROGRESS_SCHEMA,
    "order": ORDER_SCHEMA,
    "client": CLIENT_SCHEMA,
}

MASTERS = {
    "MSTREGSTATUS": {"1": "仮登録", "2": "本登録", "5": "登録抹消"},
    "MSTCNSLSTATUS": {"1": "未対応", "2": "呼び込み中", "3": "面談待ち"},
    # 実環境の MST_PROGRESS_STATUS（18件）から要件2/3 に関わるものを抜粋
    "MST_PROGRESS_STATUS": {
        "16": "社内確認中", "25": "説明会", "11": "応募意思確認中(求人)",
        "12": "書類提出待ち", "21": "内定", "10": "完了",
    },
    "MSTUSER": {"1": "求人担当ユーザ", "7": "【BL】矢原アトム"},
    "MST_ESTIMATED_SALES_ACCURACY": {"1": "A", "2": "B", "3": "C"},
}

# 名前解決の設定（config/app.yaml の name_resolution と同じ形）
NAME_SOURCES = {
    "career": NameSource(
        resource="career",
        items=["CAREER#LASTNAME", "CAREER#FIRSTNAME"],
        template="{CAREER#LASTNAME} {CAREER#FIRSTNAME}",
    ),
    "order": NameSource(
        resource="order", items=["ORDER#POSITIONNAME"], template="{ORDER#POSITIONNAME}"),
    "client": NameSource(
        resource="client", items=["CLIENT#CLIENTNAME"], template="{CLIENT#CLIENTNAME}"),
}


class FakeCpClient:
    """`CpClient` と同じ形をした差し替え。予算も本物と同じように消費する。"""

    def __init__(self, records: dict[str, dict[str, Any]] | None = None,
                 resources: dict[str, dict[str, dict[str, Any]]] | None = None,
                 default_resource: str = "career"):
        # {career_id: {itemId: value}}。要件1のテストとの互換のために残す
        self.records: dict[str, dict[str, Any]] = records or {}
        # {resource: {resource_id: {itemId: value}}}
        self.resources: dict[str, dict[str, dict[str, Any]]] = resources or {}
        self.resources.setdefault(default_resource, self.records)
        self.default_resource = default_resource
        self.search_calls: list[dict[str, Any]] = []
        self.select_calls: list[str] = []
        self.select_resources: list[str] = []
        self.select_item_ids: list[list[str]] = []
        self.current_watcher = "-"
        self.fail_select_for: set[str] = set()
        self.search_result_ids: list[str] | None = None

    def search(self, resource, condition=None, sort=None, limit=100, offset=0, budget=None):
        if budget is not None:
            budget.consume()
        self.search_calls.append(
            {"resource": resource, "condition": condition, "sort": sort,
             "limit": limit, "offset": offset})
        ids = (self.search_result_ids
               if self.search_result_ids is not None
               else sorted(self.resources.get(resource, {})))
        page = ids[offset:offset + limit]
        return page, len(ids)

    def select(self, resource, resource_id, item_ids, budget=None):
        if budget is not None:
            budget.consume()
        self.select_calls.append(resource_id)
        self.select_resources.append(resource)
        self.select_item_ids.append(list(item_ids))
        if resource_id in self.fail_select_for:
            from app.core.errors import CpServerError
            raise CpServerError(500, "boom", "req-1", f"/v1/ext2/{resource}/select/{resource_id}")
        table = self.resources.get(resource, {})
        if resource_id not in table:
            from app.core.errors import CpNotFoundError
            raise CpNotFoundError(404, "not found", "req-1",
                                  f"/v1/ext2/{resource}/select/{resource_id}")
        record = table[resource_id]
        return {i: record.get(i) for i in item_ids}

    def get_schema(self, resource_category, budget=None):
        if budget is not None:
            budget.consume()
        return SCHEMAS.get(resource_category, [])

    def get_master(self, code_name, budget=None):
        if budget is not None:
            budget.consume()
        return MASTERS.get(code_name, {})


class CapturingNotifier(Notifier):
    """送信内容を記録するだけの通知先。"""

    def __init__(self, channels: set[str], fail: bool = False):
        self.channels = channels
        self.sent: list[Notification] = []
        self.fail = fail

    def supports(self, channel_key: str) -> bool:
        return channel_key in self.channels

    def send(self, notification: Notification) -> None:
        if self.fail:
            from app.core.errors import NotifyError
            raise NotifyError("simulated failure")
        self.sent.append(notification)


TEMPLATES = {
    "record_changed": {
        "subject": "[CP] {resource_label}「{record_name}」の項目が変更されました",
        "change_line": "• {label}: {old} → {new}",
        "body": "*{resource_label}の項目が変更されました*（{change_count} 件）\n"
                "{record_name}（{resource} / ID {resource_id}）\n\n{changes}",
    },
    "progress_transition": {
        "subject": "[CP] 進捗が動きました: {career_name}",
        "body": "*進捗フローが進行しました*\n{career_name} × {order_name}（{client_name}）\n"
                "ステータス: {from_label} → {to_label}\n進捗日: {progress_date}\n"
                "進捗担当: {progress_charge}\n（進捗 {progress_id} / 履歴 {resource_id}）",
    },
    "job_intro_ok": {
        "subject": "[CP] {transition_name}: {career_name}",
        "body": "*{transition_name}*\n{career_name} を「{order_name}」"
                "（{client_name}）へ紹介しました。\n"
                "ステータス: {from_label} → {to_label}\n"
                "見込回収金額（万円）: {estimated_amount}\n"
                "見込確度: {estimated_accuracy}\n"
                "見込計上月: {estimated_month}\n（履歴 {resource_id}）",
    },
}


@pytest.fixture
def logger() -> Logger:
    # テスト中は標準出力を汚さない
    return Logger(log_dir=None, echo=False)


@pytest.fixture
def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "state.sqlite3")
    yield s
    s.close()


@pytest.fixture
def make_context(logger, store):
    def _make(client: FakeCpClient, notifier: CapturingNotifier | None = None,
              bootstrap: bool = False, max_per_cycle: int = 50) -> Context:
        notifier = notifier or CapturingNotifier(
            {"career_status", "progress_flow", "job_intro", "ops"})
        return Context(
            client=client,                       # type: ignore[arg-type]
            store=store,
            schema=SchemaRegistry(client, logger),   # type: ignore[arg-type]
            master=MasterRegistry(client, logger),   # type: ignore[arg-type]
            resolver=NameResolver(client=client, logger=logger,  # type: ignore[arg-type]
                                  sources=dict(NAME_SOURCES)),
            dispatcher=Dispatcher([notifier], store, logger, max_per_cycle=max_per_cycle),
            logger=logger,
            app_config=AppConfig(name_resolution=dict(NAME_SOURCES)),
            templates=TEMPLATES,
            bootstrap=bootstrap,
        )
    return _make


@pytest.fixture
def budget() -> RequestBudget:
    return RequestBudget(100, "test")
