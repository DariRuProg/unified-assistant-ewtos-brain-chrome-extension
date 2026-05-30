# @author Dario | ewtos.com
"""EwtosBrain Tray-App — startet den FastAPI-Server im Hintergrund-Thread und
zeigt ein System-Tray-Icon mit Status + Aktionen. Gebuendelter Entrypoint fuer
die ausgelieferte .exe (kein Konsolenfenster).
"""
from __future__ import annotations

import logging
import os
import sys
import threading
import webbrowser
from logging.handlers import RotatingFileHandler

import paths

# Logging in Datei — die gebuendelte .exe hat kein Konsolenfenster.
_handler = RotatingFileHandler(
    paths.logs_dir() / "server.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8"
)
_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logging.basicConfig(level=logging.INFO, handlers=[_handler])

import config  # noqa: E402
import main  # noqa: E402  -- loest paths.migrate_legacy_data + load_dotenv aus

import uvicorn  # noqa: E402
import pystray  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

log = logging.getLogger("ewtosbrain.tray")

_server: uvicorn.Server | None = None
_thread: threading.Thread | None = None


def _make_image() -> Image.Image:
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([2, 2, size - 3, size - 3], radius=14, fill=(108, 99, 255, 255))
    cx = cy = size // 2
    sat = [(-15, -13), (15, -11), (-13, 15), (14, 14)]
    for dx, dy in sat:
        d.line([(cx, cy), (cx + dx, cy + dy)], fill=(255, 255, 255, 160), width=3)
    for dx, dy in sat:
        d.ellipse([cx + dx - 5, cy + dy - 5, cx + dx + 5, cy + dy + 5], fill="white")
    d.ellipse([cx - 8, cy - 8, cx + 8, cy + 8], fill="white")
    return img


def _serve() -> None:
    global _server
    cfg = uvicorn.Config(main.app, host=config.HOST, port=config.PORT, log_config=None)
    _server = uvicorn.Server(cfg)
    _server.run()


def _start_server() -> None:
    global _thread
    if _thread and _thread.is_alive():
        return
    _thread = threading.Thread(target=_serve, daemon=True, name="ewtos-server")
    _thread.start()
    log.info("Server-Thread gestartet auf %s:%s", config.HOST, config.PORT)


def _stop_server() -> None:
    global _server, _thread
    if _server:
        _server.should_exit = True
    if _thread:
        _thread.join(timeout=5)
    _server = None
    _thread = None


def _open_folder(path) -> None:
    try:
        if sys.platform == "win32":
            os.startfile(str(path))  # type: ignore[attr-defined]
        else:
            webbrowser.open(f"file://{path}")
    except Exception as e:  # noqa: BLE001
        log.warning("Ordner oeffnen fehlgeschlagen: %s", e)


def _on_restart(icon, item) -> None:
    log.info("Neustart angefordert")
    _stop_server()
    _start_server()


def _on_quit(icon, item) -> None:
    log.info("Beenden angefordert")
    _stop_server()
    icon.stop()


def run() -> None:
    _start_server()
    menu = pystray.Menu(
        pystray.MenuItem(f"EwtosBrain läuft · {config.HOST}:{config.PORT}", None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Logs öffnen", lambda i, it: _open_folder(paths.logs_dir())),
        pystray.MenuItem("Datenordner öffnen", lambda i, it: _open_folder(paths.data_dir())),
        pystray.MenuItem("Neu starten", _on_restart),
        pystray.MenuItem("Beenden", _on_quit),
    )
    icon = pystray.Icon("ewtosbrain", _make_image(), "EwtosBrain", menu)
    icon.run()


if __name__ == "__main__":
    run()
