"""C-11: 対応履歴の活動量を実測する（要件4の走査量 W を決める）。

`to-do/Phase6.md` の「未確定のパラメータ」。仕様書 8.1節の見積り
（1日40件・担当者設定率30%）と実測が乖離していたら、走査窓か予算を見直す。

測るもの:

1. 母集団（`CAREER#CHARGE_ID ENTERED`）で絞った件数と、絞らない件数
2. 30日窓（新規検知）と 3日窓（変更検知）の ID 集合の大きさ
   → **3日窓の件数がそのまま1サイクルの select 数**になる
3. `ACTION_DATE` の日別件数（直近7日）

**検索は `limit: 1` で `count` だけを見る。**ID は要らないのでページングしない。
全リクエストが `cpv` の 1秒に1回 の制限を通る。
"""
import datetime

import cpv

POPULATION = cpv.item("CAREER#CHARGE_ID", "ENTERED", "")

token = cpv.get_token()
today = datetime.date.today()


def cp_date(d: datetime.date) -> str:
    return d.strftime("%Y/%m/%d")


def window(since: datetime.date) -> dict:
    """3つの日付の OR 和集合（仕様書 3.3.4 の A / C）。"""
    return cpv.cond(
        cpv.item("CAREER_ACTION#ACTION_DATE", "GE", cp_date(since)),
        cpv.item("CAREER_ACTION#COMPLETE_DATE", "GE", cp_date(since)),
        cpv.item("CAREER_ACTION#NEXTACTION_DATE", "GE", cp_date(since) + " 00:00:00"),
        compound="or",
    )


def count(condition, label: str):
    ok, res = cpv.safe(
        lambda: cpv.search("career_action", token, condition=condition, limit=1), label
    )
    return res["count"] if ok else None


cpv.out("=== 0) 総件数 ===")
total = count(None, "total")
cpv.out(f"  career_action 総件数: {total}")

cpv.out("\n=== 1) 母集団の絞り込み（CAREER#CHARGE_ID ENTERED）===")
in_scope = count(cpv.cond(POPULATION), "population")
cpv.out(f"  担当者が設定されている求職者の対応履歴: {in_scope} / {total}")
if total and in_scope is not None:
    cpv.out(f"  -> 母集団は全体の {in_scope / total * 100:.1f}%")

cpv.out("\n=== 2) 走査窓の大きさ（仕様書 3.3.4）===")
for days, note in [(30, "新規検知（ID だけ・安い）"), (3, "変更検知（select する・高い）")]:
    since = today - datetime.timedelta(days=days)
    filtered = count(cpv.cond(POPULATION, window(since)), f"window {days}d filtered")
    raw = count(window(since), f"window {days}d raw")
    pages = None if filtered is None else -(-filtered // 100)
    cpv.out(f"  {days:>2}日窓  母集団あり={filtered}  絞らない={raw}  "
            f"検索ページ数={pages}  … {note}")

cpv.out("\n=== 3) ACTION_DATE の日別件数（直近7日）===")
cpv.out("  ※ ACTION_DATE は業務上の日付であり、レコードの作成時刻ではない")
prev = None
for k in range(0, 8):
    since = today - datetime.timedelta(days=k)
    cumulative = count(
        cpv.cond(POPULATION, cpv.item("CAREER_ACTION#ACTION_DATE", "GE", cp_date(since))),
        f"ACTION_DATE GE -{k}d",
    )
    if cumulative is None:
        continue
    delta = "" if prev is None else f"  （{since + datetime.timedelta(days=1)} 以降との差分 = {cumulative - prev} 件）"
    cpv.out(f"  ACTION_DATE >= {since}  累計 {cumulative} 件{delta}")
    prev = cumulative

cpv.report("C-11 対応履歴の活動量")
