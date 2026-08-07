"""docs/ の HTML 仕様書からタグを除去してプレーンテキスト化する一時スクリプト。"""
import re
import sys
import html as htmllib
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])

raw = src.read_text(encoding="utf-8", errors="replace")

# script / style を丸ごと削除
raw = re.sub(r"(?is)<script.*?</script>", "", raw)
raw = re.sub(r"(?is)<style.*?</style>", "", raw)

# ブロック要素は改行に
raw = re.sub(r"(?i)<br\s*/?>", "\n", raw)
raw = re.sub(r"(?i)</(p|div|li|tr|h[1-6]|pre|section|article|table|ul|ol|dl|dt|dd)>", "\n", raw)
raw = re.sub(r"(?i)<(li|tr)[^>]*>", "\n", raw)
raw = re.sub(r"(?i)</(td|th)>", "\t", raw)

# 残りのタグ除去
raw = re.sub(r"(?s)<[^>]+>", "", raw)
raw = htmllib.unescape(raw)

# 空白整理
lines = [ln.rstrip() for ln in raw.splitlines()]
out = []
blank = 0
for ln in lines:
    if ln.strip() == "":
        blank += 1
        if blank > 1:
            continue
    else:
        blank = 0
    out.append(ln)

dst.write_text("\n".join(out), encoding="utf-8")
print(f"wrote {dst} ({len(out)} lines)")
