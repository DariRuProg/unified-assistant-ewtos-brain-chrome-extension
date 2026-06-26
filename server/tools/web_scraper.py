# @author Dario | ewtos.com
"""Server-seitiger Scraper via Playwright (System-Chrome).

Rendert JavaScript voll und klickt Accordeons nativ auf — liest pro Item sofort
aus, bevor ein exklusives Accordeon das vorherige wieder schliesst. Damit werden
lazy-rendered Accordeons (Radix/React) erfasst, die der Extension-Scraper
prinzipbedingt nicht lesen kann (Inhalt ist erst nach dem Klick im DOM).

DOM->Markdown nutzt denselben Konverter wie die Extension (extension/tools/
scrape_dom.js), per page.evaluate injiziert — ein Format, eine Quelle.

Browser-Singleton: die Playwright-Browser-Instanz wird beim ersten Aufruf
gestartet und danach wiederverwendet — eliminiert den 3-5s Launch-Overhead
pro Request. Bei Crash wird automatisch neu gestartet.

SSRF-Schutz: Private/Loopback-IPs werden vor page.goto() abgelehnt.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import re
import socket
from urllib.parse import urlparse

import config
import paths

log = logging.getLogger("ewtosbrain.web_scraper")

# Browser-Singleton — einmal starten, wiederbenutzen
_pw = None
_browser = None
_browser_lock = asyncio.Lock()


async def _get_browser():
    global _pw, _browser
    async with _browser_lock:
        if _browser is not None and _browser.is_connected():
            return _browser
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise RuntimeError("Playwright nicht installiert — pip install playwright")
        if _pw is not None:
            try:
                await _pw.stop()
            except Exception:
                pass
        _pw = await async_playwright().start()
        try:
            _browser = await _pw.chromium.launch(channel="chrome", headless=True)
        except Exception:
            # Fallback: System-Chromium falls Chrome nicht installiert
            _browser = await _pw.chromium.launch(headless=True)
        log.info("Playwright-Browser gestartet")
        return _browser


def _is_private_url(url: str) -> bool:
    """True wenn die URL auf eine private/Loopback-IP zeigt (SSRF-Schutz)."""
    try:
        host = urlparse(url).hostname or ""
        for info in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local:
                return True
    except Exception:
        pass
    return False

_NON_FAQ = re.compile(
    r"\b(menu|nav|dropdown|search|cart|login|close|share|social|hamburger|submit|"
    r"cookie|consent|cookiebot|privacy|banner|cmp)\b",
    re.I,
)

# True, wenn der Trigger in einem Consent-/Cookie-/Dialog-Container sitzt — solche
# Buttons tragen oft aria-expanded, sind aber kein FAQ (Cookiebot, Modals etc.).
_SKIP_CONTAINER_JS = """(btn) => !!btn.closest(
  '[id*=cookie i],[class*=cookie i],[id*=consent i],[class*=consent i],' +
  '[class*=cookiebot i],[aria-modal=true],[role=dialog],dialog,' +
  '[class*=banner i],[id*=banner i],[class*=privacy i],' +
  'footer,[class*=footer i],[id*=footer i],nav,header'
)"""

# Backstop: echte FAQ-Antworten sind selten länger als das — Cookie-Tabellen 10k+.
_MAX_ANSWER_LEN = 4000

# Liest den Panel-Text eines Triggers — spiegelt findPanel() aus scrape_dom.js.
_READ_PANEL_JS = """(btn) => {
  const id = btn.getAttribute('aria-controls');
  let panel = id ? document.getElementById(id) : null;
  if (!panel) { const ns = btn.nextElementSibling; if (ns && ns.textContent.trim()) panel = ns; }
  if (!panel) { const ps = btn.parentElement && btn.parentElement.nextElementSibling; if (ps && ps.textContent.trim()) panel = ps; }
  return panel ? panel.textContent.trim() : '';
}"""


def _load_converter() -> str:
    """scrape_dom.js als injizierbarer Funktions-Ausdruck (ohne `export`)."""
    src = paths.scrape_dom_js().read_text(encoding="utf-8")
    return src.replace("export async function", "async function", 1)


async def _auto_scroll(page) -> None:
    """Scrollt die Seite schrittweise bis ganz unten, um lazy-geladene Sektionen
    (z.B. FAQ unterhalb des Folds) ins DOM zu bringen, dann zurück nach oben."""
    await page.evaluate(
        """async () => {
          await new Promise((resolve) => {
            let total = 0; const step = 800;
            const timer = setInterval(() => {
              window.scrollBy(0, step); total += step;
              if (total >= document.body.scrollHeight - window.innerHeight) {
                clearInterval(timer); resolve();
              }
            }, 120);
          });
        }"""
    )
    await page.wait_for_timeout(600)
    await page.evaluate("window.scrollTo(0, 0)")


async def _expand_and_collect_faq(page) -> list[dict]:
    """Klickt Accordion-Trigger einzeln auf und liest die Antwort sofort aus.
    Per-Item-Capture, weil exklusive Accordeons am Ende nur das letzte offen lassen."""
    triggers = await page.query_selector_all(
        'button[aria-expanded], button[aria-controls], '
        'button[class*="faq"], button[class*="accordion"]'
    )
    items: list[dict] = []
    seen_q: set[str] = set()
    for t in triggers:
        try:
            cls = (await t.get_attribute("class") or "") + " " + (await t.get_attribute("id") or "")
            if _NON_FAQ.search(cls):
                continue
            # aria-haspopup / combobox / listbox / menu = Select/Dropdown, kein Accordeon
            if await t.get_attribute("aria-haspopup"):
                continue
            if (await t.get_attribute("role")) in ("combobox", "listbox", "menu"):
                continue
            if await t.evaluate(_SKIP_CONTAINER_JS):
                continue
            question = (await t.inner_text()).strip()
            if not question or question in seen_q:
                continue
            await t.scroll_into_view_if_needed(timeout=2000)
            await t.click(timeout=2000)
            await page.wait_for_timeout(250)
            answer = (await t.evaluate(_READ_PANEL_JS) or "").strip()
            if answer and len(answer) <= _MAX_ANSWER_LEN:
                items.append({"question": question, "answer": answer})
                seen_q.add(question)
        except Exception:
            continue
    return items


def _append_faq(markdown: str, items: list[dict]) -> str:
    """Haengt gesammelte FAQ-Items als `## FAQ`-Block an, ohne im Body
    bereits vorhandene Antworten zu doppeln (Dedup ueber erste 60 Zeichen)."""
    if not items:
        return markdown
    seen = set(re.findall(r"\S.{0,59}", markdown))
    fresh = [it for it in items if it["answer"][:60] not in seen]
    if not fresh:
        return markdown
    block = "\n\n".join(f'#### {it["question"]}\n\n{it["answer"]}' for it in fresh)
    return markdown + "\n\n## FAQ\n\n" + block


async def scrape_url(url: str, mode: str = "content") -> dict:
    if not url or not url.startswith(("http://", "https://")):
        return {"ok": False, "error": "Ungueltige URL (http/https erwartet)"}

    if _is_private_url(url):
        return {"ok": False, "error": "Interne/private Adressen sind nicht erlaubt"}

    converter = _load_converter()
    timeout_ms = config.TOOL_TIMEOUT_SECONDS * 1000

    try:
        browser = await _get_browser()
        page = await browser.new_page()
        try:
            try:
                await page.goto(url, wait_until="networkidle", timeout=timeout_ms)
            except Exception:
                # networkidle timeouted (Dauer-Polling-Seiten) — domcontentloaded reicht
                await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            await page.wait_for_timeout(1200)

            # Lazy-Sektionen (FAQ unter dem Fold) ins DOM holen, bevor wir Trigger sammeln
            await _auto_scroll(page)
            faq_items = await _expand_and_collect_faq(page)
            result = await page.evaluate(
                f"(args) => ({converter})(args.mode, args.skip)",
                {"mode": mode, "skip": True},
            )
        finally:
            await page.close()
    except RuntimeError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"Scrape fehlgeschlagen: {e}"}

    if not isinstance(result, dict) or result.get("error"):
        return {"ok": False, "error": (result or {}).get("error", "Kein Ergebnis vom Konverter")}

    markdown = _append_faq(result.get("markdown", ""), faq_items)
    return {
        "ok": True,
        "data": {
            "markdown": markdown,
            "url": result.get("url") or url,
            "title": result.get("title", ""),
            "wordCount": len(markdown.split()),
            "mode": mode,
        },
    }
