# @author Dario | ewtos.com
import io


def extract_text(data: bytes, filename: str = "") -> str:
    """Extrahiert Text aus PDF- oder Textdaten. Gibt Markdown-String zurück."""
    fname = (filename or "").lower()
    if fname.endswith(".pdf"):
        info = _extract_pdf(data)
        return info["text"]
    return data.decode("utf-8", errors="replace")


def extract_info(data: bytes, filename: str = "") -> dict:
    """Wie extract_text, liefert zusätzlich PDF-Metadaten (title, author, pages).

    Returns:
        {"text": str, "title": str, "author": str, "pages": int}
    """
    fname = (filename or "").lower()
    if fname.endswith(".pdf"):
        return _extract_pdf(data)
    return {"text": data.decode("utf-8", errors="replace"), "title": "", "author": "", "pages": 0}


def _extract_pdf(data: bytes) -> dict:
    try:
        import pdfplumber
    except ImportError:
        raise ImportError("pdfplumber nicht installiert. `pip install pdfplumber` ausführen.")
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            meta = pdf.metadata or {}
            pages_text = []
            for page in pdf.pages:
                try:
                    text = page.extract_text()
                except Exception:
                    text = None
                if text and text.strip():
                    pages_text.append(text.strip())
            text = "\n\n---\n\n".join(pages_text)
    except Exception as e:
        raise ValueError(f"PDF konnte nicht gelesen werden: {e}")
    return {
        "text": text,
        "title": (meta.get("Title") or "").strip(),
        "author": (meta.get("Author") or "").strip(),
        "pages": len(pages_text),
    }
