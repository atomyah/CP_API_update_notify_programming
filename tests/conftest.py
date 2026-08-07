"""テスト用のフェイク。

**CP API はモックする。実 API を叩くテストを CI に置かない**
（流量制約に反する。`rules/50-code-style.md`）。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from app.core.budget import RequestBudget
from app.core.config import AppConfig
from app.core.events import Notification
from app.core.logging import Logger
from app.core.master import MasterRegistry
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

MASTERS = {
    "MSTREGSTATUS": {"1": "仮登録", "2": "本登録", "5": "登録抹消"},
    "MSTCNSLSTATUS": {"1": "未対応", "2": "呼び込み中", "3": "面談待ち"},
}


class FakeCpClient:
    """`CpClient` と同じ形をした差し替え。予算も本物と同じように消費する。"""

    def __init__(self, records: dict[str, dict[str, Any]] | None = None):
        # {career_id: {itemId: value}}
        self.records: dict[str, dict[str, Any]] = records or {}
        self.search_calls: list[dict[str, Any]] = []
        self.select_calls: list[str] = []
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
               else sorted(self.records))
        page = ids[offset:offset + limit]
        return page, len(ids)

    def select(self, resource, resource_id, item_ids, budget=None):
        if budget is not None:
            budget.consume()
        self.select_calls.append(resource_id)
        self.select_item_ids.append(list(item_ids))
        if resource_id in self.fail_select_for:
            from app.core.errors import CpServerError
            raise CpServerError(500, "boom", "req-1", f"/v1/ext2/{resource}/select/{resource_id}")
        record = self.records[resource_id]
        return {i: record.get(i) for i in item_ids}

    def get_schema(self, resource_category, budget=None):
        if budget is not None:
            budget.consume()
        return CAREER_SCHEMA

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
    }
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
        notifier = notifier or CapturingNotifier({"career_status", "ops"})
        return Context(
            client=client,                       # type: ignore[arg-type]
            store=store,
            schema=SchemaRegistry(client, logger),   # type: ignore[arg-type]
            master=MasterRegistry(client, logger),   # type: ignore[arg-type]
            dispatcher=Dispatcher([notifier], store, logger, max_per_cycle=max_per_cycle),
            logger=logger,
            app_config=AppConfig(),
            templates=TEMPLATES,
            bootstrap=bootstrap,
        )
    return _make


@pytest.fixture
def budget() -> RequestBudget:
    return RequestBudget(100, "test")
