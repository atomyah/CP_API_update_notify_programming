"""PDF ページを PNG にレンダリングする一時スクリプト（縦に分割して読みやすくする）。"""
import sys
from pathlib import Path
import fitz

src = Path(sys.argv[1])
outdir = Path(sys.argv[2])
zoom = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
slices = int(sys.argv[4]) if len(sys.argv) > 4 else 1
outdir.mkdir(parents=True, exist_ok=True)

doc = fitz.open(str(src))
for pi, page in enumerate(doc, 1):
    rect = page.rect
    print("page", pi, "rect", rect)
    h = rect.height / slices
    for s in range(slices):
        clip = fitz.Rect(rect.x0, rect.y0 + s * h, rect.x1, rect.y0 + (s + 1) * h)
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip)
        path = outdir / f"page{pi}_{s + 1}.png"
        pix.save(str(path))
        print(path, pix.width, "x", pix.height)
