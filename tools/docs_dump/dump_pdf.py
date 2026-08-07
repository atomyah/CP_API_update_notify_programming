"""docs/ の PDF をテキスト抽出する一時スクリプト。"""
import sys
from pathlib import Path
from pypdf import PdfReader

src = Path(sys.argv[1])
dst = Path(sys.argv[2])

reader = PdfReader(str(src))
print("pages:", len(reader.pages))
print("encrypted:", reader.is_encrypted)

chunks = []
for i, page in enumerate(reader.pages, 1):
    chunks.append(f"=== page {i} ===")
    try:
        chunks.append(page.extract_text() or "(no text layer)")
    except Exception as e:  # noqa: BLE001
        chunks.append(f"(extract failed: {e})")

dst.write_text("\n".join(chunks), encoding="utf-8")
print("wrote", dst)
