"""Turns an original file into Folio's renditions: a reader copy, its pictures, a thumbnail and text.

Every kind Folio takes goes through Docling, except plain text, which has no
structure to find and becomes Markdown as it is.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from functools import cache
from importlib.metadata import version
from pathlib import Path

from PIL import Image

#: What made a rendition, kept with it so a better engine can be told apart later.
ENGINE = "docling"
ENGINE_VERSION = version("docling")

#: The widest a thumbnail is, in pixels.
THUMBNAIL_WIDTH = 480

#: Marks where each picture goes in Docling's Markdown, before it gets its file name.
_PICTURE = "\x00folio-picture\x00"

#: What Folio keeps, by media type, and the Docling input format for each.
_FORMATS = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "text/html": "html",
    "text/markdown": "md",
}
TEXT = "text/plain"


class RenderError(Exception):
    """The file can't be rendered, for a reason a person can act on. Trying again won't help."""


@dataclass
class Rendered:
    markdown: str
    text: str
    #: The pictures the Markdown shows, as PNG, in the order of their names: 1.png, 2.png, …
    images: list[bytes] = field(default_factory=list)
    thumbnail: bytes | None = None
    pages: int | None = None
    #: What made it, and which version of that.
    engine: tuple[str, str] = (ENGINE, ENGINE_VERSION)


def _png(image: Image.Image) -> bytes:
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()


def _thumbnail(image: Image.Image) -> bytes:
    image = image.convert("RGB")
    if image.width > THUMBNAIL_WIDTH:
        image = image.resize((THUMBNAIL_WIDTH, round(image.height * THUMBNAIL_WIDTH / image.width)), Image.LANCZOS)
    return _png(image)


@cache
def _converter(timeout: int):
    """One converter for the life of the worker: it loads its models once."""
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    pdf = PdfPipelineOptions(generate_page_images=True, generate_picture_images=True, images_scale=1.5, document_timeout=timeout)
    return DocumentConverter(
        allowed_formats=[InputFormat.PDF, InputFormat.DOCX, InputFormat.HTML, InputFormat.MD],
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pdf)},
    )


_MARKDOWN_SPECIAL = re.compile(r"([\\`*_{}\[\]<>#|~])")


def _text_to_markdown(text: str) -> str:
    """Plain text as Markdown that shows it as written: specials escaped, line breaks kept."""
    paragraphs = re.split(r"\n\s*\n", text.replace("\r\n", "\n").strip())
    out = []
    for paragraph in paragraphs:
        lines = [_MARKDOWN_SPECIAL.sub(r"\\\1", line.rstrip()) for line in paragraph.split("\n")]
        # A line that starts like a list or a heading would turn into one.
        lines = [re.sub(r"^(\s*)([-+])(\s)", r"\1\\\2\3", line) for line in lines]
        lines = [re.sub(r"^(\s*\d+)([.)])(\s)", r"\1\\\2\3", line) for line in lines]
        out.append("  \n".join(lines))
    return "\n\n".join(out) + "\n"


def render(path: Path, media_type: str, timeout: int = 1200) -> Rendered:
    """Renders the file at `path`, which was uploaded as `media_type`, taking `timeout` seconds at most."""
    if media_type == TEXT:
        try:
            text = path.read_bytes().decode("utf-8")
        except UnicodeDecodeError as err:
            raise RenderError("This text file isn’t UTF-8, so Artifacts can’t read it.") from err
        return Rendered(markdown=_text_to_markdown(text), text=text, engine=("folio-text", "1"))
    if media_type not in _FORMATS:
        raise RenderError(f"Artifacts doesn’t make reader copies of {media_type} files.")

    from docling.datamodel.base_models import ConversionStatus
    from docling.exceptions import BaseError
    from docling_core.types.doc import ImageRefMode, PictureItem

    # Docling tells formats apart by file ending, so the file goes in under the right one.
    source = path.with_name(f"original.{_FORMATS[media_type]}")
    if source != path:
        source.write_bytes(path.read_bytes())
    try:
        result = _converter(timeout).convert(source, raises_on_error=False)
    except BaseError as err:
        raise RenderError("Artifacts couldn’t read this file. It may be damaged, or protected by a password.") from err
    if result.status == ConversionStatus.PARTIAL_SUCCESS:
        # Half a policy read as the whole of it is worse than none.
        raise RenderError("Artifacts could read only part of this file, so it made no reader copy. It may be too long, or partly damaged.")
    if result.status != ConversionStatus.SUCCESS:
        raise RenderError("Artifacts couldn’t read this file. It may be damaged, or protected by a password.")
    doc = result.document

    markdown = doc.export_to_markdown(image_mode=ImageRefMode.PLACEHOLDER, image_placeholder=_PICTURE)
    # The placeholders come in the order the pictures do; each gets its file, or goes if it has no picture.
    pictures = [item for item, _ in doc.iterate_items() if isinstance(item, PictureItem)]
    images: list[bytes] = []
    parts = markdown.split(_PICTURE)
    out = [parts[0]]
    for i, rest in enumerate(parts[1:]):
        picture = pictures[i] if i < len(pictures) else None
        image = picture.get_image(doc) if picture else None
        if image is not None:
            images.append(_png(image))
            alt = re.sub(r"[\[\]\n]", " ", picture.caption_text(doc) or "").strip()
            out.append(f"![{alt}](images/{len(images)}.png)")
        out.append(rest)
    markdown = "".join(out).strip() + "\n"

    thumbnail = None
    pages = len(doc.pages) or None
    first = doc.pages.get(1) if doc.pages else None
    if first is not None and first.image is not None and first.image.pil_image is not None:
        thumbnail = _thumbnail(first.image.pil_image)
    return Rendered(markdown=markdown, text=doc.export_to_text(), images=images, thumbnail=thumbnail, pages=pages if media_type == "application/pdf" else None)
