"""PDF に埋め込まれた画像を書き出す一時スクリプト。"""
import sys
from pathlib import Path
from pypdf import PdfReader

src = Path(sys.argv[1])
outdir = Path(sys.argv[2])
outdir.mkdir(parents=True, exist_ok=True)

reader = PdfReader(str(src))
n = 0
for pi, page in enumerate(reader.pages, 1):
    for img in page.images:
        n += 1
        path = outdir / f"p{pi}_{n}_{img.name}"
        path.write_bytes(img.data)
        print(path, len(img.data))
print("total images:", n)
