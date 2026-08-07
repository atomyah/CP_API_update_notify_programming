"""V-5 追加: アクセストークンのライフサイクル。
同一APIキーで複数のトークンを同時に有効化できるか（＝再取得で旧トークンが死ぬか）。
"""
import time

import cpv

PROBE = "/v1/ext2/master/list"


def alive(token: str) -> str:
    time.sleep(1.0)
    try:
        cpv.get(PROBE, token)
        return "有効"
    except cpv.CpError as e:
        return f"無効(HTTP {e.status})"


cpv.out("--- 1) トークンA を取得して使う ---")
a = cpv.token_response()
tok_a, ref_a = a["accessToken"], a["refreshToken"]
cpv.out(f"  A: {alive(tok_a)}")

cpv.out("\n--- 2) APIキーでトークンB を新規取得 ---")
b = cpv.token_response()
tok_b, ref_b = b["accessToken"], b["refreshToken"]
cpv.out(f"  A: {alive(tok_a)}   <- ここが無効なら「1APIキーにつき有効なトークンは1つ」")
cpv.out(f"  B: {alive(tok_b)}")
cpv.out(f"  A と B は同一文字列か: {tok_a == tok_b}")

cpv.out("\n--- 3) B の refreshToken でトークンC を取得 ---")
c = cpv.refresh(ref_b)
tok_c = c["accessToken"]
cpv.out(f"  B: {alive(tok_b)}   <- ここが無効ならリフレッシュでも旧トークンが死ぬ")
cpv.out(f"  C: {alive(tok_c)}")
cpv.out(f"  B と C は同一文字列か: {tok_b == tok_c}")

cpv.out("\n--- 4) 古い refreshToken (A のもの) は使えるか ---")
try:
    time.sleep(1.0)
    d = cpv.refresh(ref_a)
    cpv.out(f"  A の refreshToken: 使える (新 accessToken=<{len(d['accessToken'])} chars>)")
    cpv.out(f"  C: {alive(tok_c)}")
except cpv.CpError as e:
    cpv.out(f"  A の refreshToken: 使えない (HTTP {e.status})")

cpv.report("V-5b 完了")
