# ewtos.com
from fastapi import Request, HTTPException

import settings as _settings


async def api_key_middleware(request: Request, call_next):
    """Stub: prüft X-API-Key wenn `api_key` in settings gesetzt ist.
    Solange kein Key konfiguriert ist, bleibt der Server lokal offen.
    WebSocket-Upgrades werden immer durchgereicht — BaseHTTPMiddleware bricht WS-Lifecycle."""
    if request.headers.get("upgrade", "").lower() == "websocket":
        return await call_next(request)
    required = _settings.get("api_key") or ""
    if not required:
        return await call_next(request)
    token = request.headers.get("X-API-Key") or request.query_params.get("api_key", "")
    if token != required:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return await call_next(request)
