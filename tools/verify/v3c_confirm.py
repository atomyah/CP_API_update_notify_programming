"""V-3c の確定確認 + 書き込み権限の再検証（前回の判定が誤りだった疑いの検証）。"""
import cpv

token = cpv.get_token()

cpv.out("=== V-3c: 対応履歴の操作で親の CAREER#UPDATE_DATE が動いたか ===")
cpv.out("  操作: 16:12 新規登録 / 16:13 内容更新 / 16:14 完了日入力  (対象: 式波アスカ id=18)")
v = cpv.select("career", "18", ["CAREER#LASTNAME", "CAREER#INSERT_DATE", "CAREER#UPDATE_DATE"], token)
cpv.out(f"\n  career 18 の INSERT_DATE = {v['CAREER#INSERT_DATE']}")
cpv.out(f"  career 18 の UPDATE_DATE = {v['CAREER#UPDATE_DATE']}")
cpv.out("  （検証開始時点の値は 2026-08-05T15:20:48）")
moved = v["CAREER#UPDATE_DATE"] != "2026-08-05T15:20:48"
cpv.out(f"\n  -> 親の更新日は動いたか: {'動いた' if moved else '★ 動いていない'}")

cpv.out("\n=== 新しく作られた対応履歴 18_0 の中身 ===")
a = cpv.select("career_action", "18_0", [
    "CAREER_ACTION#CAREER_ID", "CAREER_ACTION#HISTSEQ",
    "CAREER_ACTION#ACTION_DATE", "CAREER_ACTION#ACTION_ID",
    "CAREER_ACTION#ACTIONCHARGE_ID", "CAREER_ACTION#ACTIONTEAM_ID",
    "CAREER_ACTION#ACTIONMEMO", "CAREER_ACTION#COMPLETE_DATE",
    "CAREER_ACTION#NEXTACTION_DATE",
    "CAREER#LASTNAME", "CAREER#FIRSTNAME", "CAREER#CHARGE_EMAIL",
], token)
for k in sorted(a):
    cpv.out(f"  {k:<34} = {a[k]!r}")
cpv.out("\n  ※ 完了日が入っていれば『対応完了』は COMPLETE_DATE で検知できる")

cpv.out("\n=== 新しく作られた進捗履歴 21_1 の中身 ===")
h = cpv.select("progress_history", "21_1", [
    "PROGRESS_HISTORY#PROGRESS_ID", "PROGRESS_HISTORY#PROGRESS_ID_SUB",
    "PROGRESS_HISTORY#INSERT_DATE", "PROGRESS_HISTORY#UPDATE_DATE",
    "PROGRESS_HISTORY#PROGRESS_STATUS_ID", "PROGRESS_HISTORY#PROGRESS_DATE",
    "PROGRESS_HISTORY#CAREER_CHARGE_ID", "PROGRESS_HISTORY#ORDER_CHARGE_ID",
    "PROGRESS_HISTORY#ESTIMATED_SALES_AMOUNT", "PROGRESS_HISTORY#ESTIMATED_SALES_ACCURACY",
    "PROGRESS_HISTORY#ESTIMATED_SALES_MONTH", "PROGRESS_HISTORY#IS_LAST_COUNT",
], token)
for k in sorted(h):
    cpv.out(f"  {k:<44} = {h[k]!r}")
cpv.out("\n  ※ 進捗履歴の枝番は 1 始まり（career_action の HISTSEQ は 0 始まり）")

cpv.out("\n=== 書き込み権限の再検証 ===")
cpv.out("  前回 POST /v1/ext2/progress/ が 400 だったが、画面では『進捗＞作成』は未チェック。")
cpv.out("  400 がボディ検証(認可より前)によるものかを、作成権限のない他エンドポイントで確かめる。\n")

probes = [
    # (ラベル, method, path, body, 画面上の作成権限)
    ("career_action  items不正のみ", "POST", "/v1/ext2/career_action/",
     {"careerId": "18", "items": [{"itemId": "CAREER_ACTION#__NO_SUCH__", "value": "x"}]}),
    ("career_workexp 必須パラメータ不正", "POST", "/v1/ext2/career_workexperience/",
     {"careerId": "!!invalid!!", "items": [{"itemId": "CAREER_WORKEXP#__NO_SUCH__", "value": "x"}]}),
    ("wrkcareer      items不正のみ", "POST", "/v1/ext2/wrkcareer/",
     {"items": [{"itemId": "WRKCAREER#__NO_SUCH__", "value": "x"}]}),
    ("progress       日付形式が不正 (前回と同じ)", "POST", "/v1/ext2/progress/",
     {"careerId": "18", "orderId": "1", "progressDate": "9999/99/99"}),
    ("progress       PUT items不正のみ", "PUT", "/v1/ext2/progress/21",
     {"items": [{"itemId": "PROGRESS#__NO_SUCH__", "value": "x"}]}),
    ("progress_history PUT items不正のみ", "PUT", "/v1/ext2/progress_history/21_1",
     {"items": [{"itemId": "PROGRESS_HISTORY#__NO_SUCH__", "value": "x"}]}),
]
for label, method, path, body in probes:
    try:
        cpv._request(method, path, body, token)
        cpv.out(f"  {label:<44} -> 200 !! 想定外")
    except cpv.CpError as e:
        note = {403: "権限なし", 400: "ボディ検証で弾かれた（認可の前後は不明）"}.get(e.status, "")
        cpv.out(f"  {label:<44} -> HTTP {e.status}  {note}")

cpv.out("\n  判定: 作成権限が無いはずの career_workexperience で必須パラメータを不正にしたとき")
cpv.out("        400 が返るなら、CP は『ボディ検証 → 認可』の順で処理している。")
cpv.out("        その場合、progress の 400 は権限の有無を示していない。")

cpv.out("\n=== データが増えていないことの確認 ===")
for r, expected in [("progress", 15), ("progress_history", 26), ("career_action", 2), ("wrkcareer", 0), ("career_workexperience", 3)]:
    res = cpv.search(r, token, limit=1)
    mark = "OK" if res["count"] == expected else "!! 増えている"
    cpv.out(f"  {r:<24} count={res['count']:<4} (期待 {expected})  {mark}")

cpv.report("V-3c 確定")
