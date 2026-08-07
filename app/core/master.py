"""コードマスタの取得・キャッシュ・ラベル変換。

`selectone` / `select` / `search` 型の値はコード値であり、
そのまま通知に出すと意味が読めない（`rules/10-cp-api.md`）。
起動時に必要なマスタだけを取得して 24 時間キャッシュする。

どの項目がどのマスタを参照するかは **schema からは取得できない**ため、
`config/watchers.yaml` の各項目に `master:` として明示する。
"""
from __future__ import annotations

import time

from app.core.budget import RequestBudget
from app.core.client import CpClient
from app.core.logging import Logger

CACHE_TTL_SECONDS = 24 * 60 * 60

# CP は selectone の「未設定」をコード `0` で表す。マスタには載っていない
# （実測: `CAREER#CHARGE_ID = 0` は担当者なし / `MSTPREF` に `0` は無い）
UNSET_CODES = {"0"}


class MasterRegistry:
    def __init__(self, client: CpClient, logger: Logger):
        self._client = client
        self._log = logger
        self._cache: dict[str, tuple[float, dict[str, str]]] = {}

    def get(self, code_name: str, budget: RequestBudget | None = None) -> dict[str, str]:
        cached = self._cache.get(code_name)
        if cached and time.time() - cached[0] < CACHE_TTL_SECONDS:
            return cached[1]

        labels = self._client.get_master(code_name, budget)
        self._cache[code_name] = (time.time(), labels)
        self._log.info("master_loaded", code_name=code_name, value_count=len(labels))
        return labels

    def preload(self, code_names: list[str], budget: RequestBudget | None = None) -> None:
        for name in sorted(set(code_names)):
            self.get(name, budget)

    def label(self, code_name: str | None, value: object,
              budget: RequestBudget | None = None) -> str:
        """コード値を通知用のラベルにする。

        解決の順序:

        1. 空・`None` → `(未設定)`
        2. 参照マスタが無い項目（text 等）→ 値をそのまま
        3. マスタに載っているコード → ラベル
        4. **マスタに無い `0`** → `(未設定)`。
           CP は selectone の未設定を `0` で表す（実測: `CHARGE_ID = 0` は担当者なし）
        5. それ以外 → **値をそのまま出す。**
           `CAREER#ZIP_ID`（郵便番号）のように、`codeName` を持ちながら
           マスタが列挙を返さない項目がある。この値は「コード」ではなくデータなので、
           注釈を付けずにそのまま見せる。解決できなかった事実はログに残す
        """
        if value is None or value == "":
            return "(未設定)"
        if isinstance(value, (list, tuple)):
            if not value:
                return "(未設定)"
            return " / ".join(self.label(code_name, v, budget) for v in value)
        if not code_name:
            return str(value)

        labels = self.get(code_name, budget)
        key = str(value)
        if key in labels:
            return labels[key]
        if key in UNSET_CODES:
            return "(未設定)"

        # 値そのものは個人情報になりうるのでログに出さない
        self._log.debug("master_code_unresolved", code_name=code_name,
                        master_size=len(labels))
        return key
