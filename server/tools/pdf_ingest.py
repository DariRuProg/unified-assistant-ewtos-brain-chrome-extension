# ewtos.com
import io


def extract_text(data: bytes, filename: str = "") -> str:
    """Extrahiert Text aus PDF- oder Textdaten. Gibt Markdown-String zurück."""
    fname = (filename or "").lower()
    if fname.endswith(".pdf"):
        return _extract_pdf(data)
    return data.decode("utf-8", errors="replace")


def _extract_pdf(data: bytes) -> str:
    try:
        import pdfplumber
    except ImportError:
        raise ImportError("pdfplumber nicht installiert. `pip install pdfplumber` ausführen.")
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        pages = []
        for page in pdf.pages:
            text = page.extract_text()
            if text:
                pages.append(text.strip())
    return "\n\n".join(pages)
