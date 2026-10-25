"""Small files of each kind Folio takes, made here so the tests carry no binaries."""

from __future__ import annotations

import io

from docx import Document
from PIL import Image


def png(width: int = 200, height: int = 100) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), (40, 90, 200)).save(out, "PNG")
    return out.getvalue()


def docx() -> bytes:
    doc = Document()
    doc.add_heading("Leave policy", 1)
    doc.add_paragraph("Everyone gets 25 days of leave a year.")
    doc.add_picture(io.BytesIO(png()))
    doc.add_paragraph("Ask your lead before you book.")
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


def pdf(pages: list[str]) -> bytes:
    """A PDF with a line of Helvetica on each page."""
    objects = ["<< /Type /Catalog /Pages 2 0 R >>", ""]
    kids = []
    for text in pages:
        stream = f"BT /F1 24 Tf 72 720 Td ({text}) Tj ET".encode()
        content = len(objects) + 2
        kids.append(len(objects) + 1)
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content} 0 R /Resources << /Font << /F1 {len(pages) * 2 + 3} 0 R >> >> >>")
        objects.append(f"<< /Length {len(stream)} >>\nstream\n{stream.decode()}\nendstream")
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>"
    objects.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for n, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(f"{n} 0 obj\n{body}\nendobj\n".encode())
    xref = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        out.write(f"{offset:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()
