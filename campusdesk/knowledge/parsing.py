"""Python extractors. Document parsing runs before a publication transaction."""

from contextlib import closing
from io import BytesIO
import os
from pathlib import Path
import subprocess
from zipfile import ZipFile

from docx import Document
from docx.table import Table
from PIL import Image
import pypdfium2 as pdfium

FORMATS = {".md", ".txt", ".docx", ".pdf", ".png", ".jpg", ".jpeg"}
PROJECT = Path(__file__).resolve().parents[2]


def ocr(image: Image.Image) -> str:
    if max(image.size) > 2000 or image.width * image.height > 4_000_000:
        raise ValueError("too_large")
    stream = BytesIO()
    image.save(stream, format="PNG")
    options = dict(input=stream.getvalue(), capture_output=True, timeout=30, check=True)
    configured = os.environ.get("CAMPUSDESK_TESSERACT")
    try:
        try:
            result = subprocess.run([configured or "tesseract", "stdin", "stdout", "-l", "chi_sim+eng"], **options)
        except FileNotFoundError:
            models = PROJECT / ".private" / "ocr"
            # Existing installations can reuse their offline OCR engine and language data.
            if configured or not all((models / f"{language}.traineddata.gz").is_file()
                                     for language in ("eng", "chi_sim")):
                raise
            result = subprocess.run(["node", str(PROJECT / "tools" / "knowledge-ocr.cjs")],
                                    cwd=PROJECT, **options)
    except FileNotFoundError as error:
        raise ValueError("ocr_not_configured") from error
    except (subprocess.SubprocessError, OSError) as error:
        raise ValueError("ocr_failed") from error
    return result.stdout.decode("utf-8")


def segments(name: str, data: bytes):
    suffix = Path(name).suffix.lower()
    if suffix in (".md", ".txt"):
        for number, text in enumerate(data.decode("utf-8-sig").splitlines(), 1):
            yield f"第 {number} 行", text
    elif suffix == ".docx":
        with ZipFile(BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 512 or sum(entry.file_size for entry in entries) > 64 * 1024 * 1024:
                raise ValueError("too_large")
        for number, item in enumerate(Document(BytesIO(data)).iter_inner_content(), 1):
            if isinstance(item, Table):
                text = "\n".join("\t".join(cell.text for cell in row.cells) for row in item.rows)
            else:
                text = item.text
            yield f"第 {number} 段", text
    elif suffix == ".pdf":
        with pdfium.PdfDocument(data) as document:
            if len(document) > 150:
                raise ValueError("too_large")
            scanned = 0
            for number in range(len(document)):
                with closing(document[number]) as page:
                    with closing(page.get_textpage()) as text_page:
                        text = text_page.get_text_bounded()
                    locator = f"第 {number + 1} 页"
                    if not text.strip():
                        scanned += 1
                        if scanned > 40:
                            raise ValueError("too_large")
                        scale = min(2, 1999 / max(page.get_size()))
                        with closing(page.render(scale=scale)) as bitmap:
                            text = ocr(bitmap.to_pil())
                        locator += " OCR"
                    yield locator, text
    elif suffix in FORMATS:
        with Image.open(BytesIO(data), formats=["PNG", "JPEG"]) as image:
            yield "图片 OCR", ocr(image)
    else:
        raise ValueError("unsupported_document")


def chunks(name: str, data: bytes) -> list[tuple[str, str]]:
    result = []
    group: list[tuple[str, str]] = []
    size = 0
    total = 0

    def flush():
        nonlocal size
        if group:
            first, last = group[0][0], group[-1][0]
            result.append((first if first == last else f"{first}–{last}", "\n".join(text for _, text in group)))
            group.clear()
            size = 0

    for locator, text in segments(name, data):
        if not text.strip():
            continue
        total += len(text.encode("utf-8"))
        if total > 8 * 1024 * 1024:
            raise ValueError("too_large")
        is_page = Path(name).suffix.lower() == ".pdf"
        if is_page or size + len(text) + 1 > 850:
            flush()
        if len(text) > 850:
            for start in range(0, len(text), 750):
                result.append((locator, text[start:start + 850]))
                if start + 850 >= len(text):
                    break
        else:
            group.append((locator, text))
            size += len(text) + 1
        if is_page:
            flush()
    flush()
    if not result:
        raise ValueError("parse_failed")
    return result
