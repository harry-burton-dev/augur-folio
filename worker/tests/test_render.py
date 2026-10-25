import io
import os
import re
from pathlib import Path

import pytest
from PIL import Image

from folio_worker.render import RenderError, render
from tests import files

WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def write(tmp_path: Path, body: bytes | str) -> Path:
    path = tmp_path / "original"
    path.write_bytes(body if isinstance(body, bytes) else body.encode())
    return path


def test_markdown_keeps_its_structure(tmp_path):
    made = render(write(tmp_path, "# Notes\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"), "text/markdown")
    assert made.markdown.startswith("# Notes\n\n- one\n- two\n")
    assert re.search(r"^\|\s+a \|\s+b \|$", made.markdown, re.M) and re.search(r"^\|\s+1 \|\s+2 \|$", made.markdown, re.M)
    assert made.engine[0] == "docling"
    assert made.images == [] and made.thumbnail is None and made.pages is None


def test_plain_text_shows_as_written(tmp_path):
    made = render(write(tmp_path, "Hello *world*\n# not a heading\n1. not a list\n- nor this\n\nNext"), "text/plain")
    assert made.markdown == "Hello \\*world\\*  \n\\# not a heading  \n1\\. not a list  \n\\- nor this\n\nNext\n"
    assert made.text.startswith("Hello *world*")
    assert made.engine == ("folio-text", "1")


def test_plain_text_must_be_utf8(tmp_path):
    with pytest.raises(RenderError, match="UTF-8"):
        render(write(tmp_path, b"caf\xe9"), "text/plain")


def test_html_becomes_markdown_without_its_scripts(tmp_path):
    page = "<html><body><h1>Security</h1><p>Use a <b>strong</b> password.</p><script>alert(1)</script></body></html>"
    made = render(write(tmp_path, page), "text/html")
    assert made.markdown == "# Security\n\nUse a **strong** password.\n"
    assert "alert" not in made.text


def test_word_keeps_its_pictures_by_name(tmp_path):
    made = render(write(tmp_path, files.docx()), WORD)
    assert made.markdown == "## Leave policy\n\nEveryone gets 25 days of leave a year.\n\n![](images/1.png)\n\nAsk your lead before you book.\n"
    assert len(made.images) == 1
    assert Image.open(io.BytesIO(made.images[0])).size == (200, 100)
    assert "25 days" in made.text


def test_a_damaged_file_says_so(tmp_path):
    with pytest.raises(RenderError, match="couldn’t read this file"):
        render(write(tmp_path, b"PK\x03\x04 not really a zip"), WORD)


def test_folio_takes_only_its_kinds(tmp_path):
    with pytest.raises(RenderError, match="doesn’t make reader copies"):
        render(write(tmp_path, b"x"), "application/vnd.ms-powerpoint")


# PDFs need Docling's layout models, which it fetches from Hugging Face the first time. CI has them.
@pytest.mark.skipif(not os.environ.get("RUN_PDF_TESTS"), reason="set RUN_PDF_TESTS=1 where Docling can fetch its models")
def test_pdf_has_pages_and_a_thumbnail(tmp_path):
    made = render(write(tmp_path, files.pdf(["Travel policy", "Claim within 30 days"])), "application/pdf")
    assert made.pages == 2
    assert "Travel policy" in made.markdown and "Claim within 30 days" in made.markdown
    thumbnail = Image.open(io.BytesIO(made.thumbnail))
    assert thumbnail.width <= 480 and thumbnail.height > thumbnail.width
