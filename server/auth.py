# @author Dario | ewtos.com
"""Auth-Middleware: Bearer-Token (JWT) für HTTP-Routen.

Open-Mode: Sind 0 User angelegt, bleibt der Server offen (lokaler Single-User,
wie bisher). Ab dem ersten User ist ein gültiger Bearer-Token Pflicht — außer für
öffentliche Pfade (Health, Login, Bootstrap, Auth-Status). WebSocket-Auth läuft
über einen Query-Token in main.py.
"""
from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

import config
import settings
import users

PUBLIC_PATHS = {"/", "/health", "/auth/login", "/auth/bootstrap", "/auth/status", "/demo"}
# Eigene Secrets / Besucher-BYOK statt User-Token (kommen mit F1/F2):
PUBLIC_PREFIXES = ("/telegram/", "/api/widget/", "/demo/")

# Demo-Modus: read-only. Mutierende Requests werden geblockt — außer Lese-POSTs
# (Chat-Streams + Login/Status). Chat-Schreib-Tools sind zusätzlich in chat.py
# herausgefiltert (doppelte Absicherung).
_DEMO_POST_ALLOWLIST_EXACT = {"/auth/login", "/auth/status", "/vaults/preview-claude-md",
                              "/tools/crm/import_preview"}
_DEMO_POST_ALLOWLIST_PREFIX = ("/tools/chat/", "/demo/")


def _demo_blocked(request: Request) -> bool:
    method = request.method.upper()
    if method in ("GET", "HEAD", "OPTIONS"):
        return False
    if method != "POST":
        return True  # PUT/DELETE/PATCH → immer schreibend
    path = request.url.path
    if path in _DEMO_POST_ALLOWLIST_EXACT:
        return False
    return not any(path.startswith(p) for p in _DEMO_POST_ALLOWLIST_PREFIX)


def _is_public(path: str) -> bool:
    return path in PUBLIC_PATHS or any(path.startswith(p) for p in PUBLIC_PREFIXES)


def current_user_id(request: Request) -> str | None:
    u = getattr(request.state, "user", None)
    return u.get("sub") if u else None


def is_admin(request: Request) -> bool:
    """Open-Mode (0 User) → lokaler Owner gilt als Admin. Sonst Token-Rolle."""
    if settings.user_count() == 0:
        return True
    u = getattr(request.state, "user", None)
    return bool(u and u.get("role") == "admin")


def _vault_access_denied(request: Request, uid: str | None) -> bool:
    """True, wenn die Anfrage eine existierende Vault-ID adressiert (Pfad-Segment
    oder ?vault_id=), auf die der User keinen Zugriff hat. Nicht-Vault-Segmente
    (z.B. 'page', 'general', 'preview-claude-md') werden ignoriert."""
    candidates = [s for s in request.url.path.strip("/").split("/") if s]
    qv = request.query_params.get("vault_id")
    if qv:
        candidates.append(qv)
    for cand in candidates:
        if settings.get_vault(cand) and not settings.user_can_access_vault(uid, cand):
            return True
    return False


async def auth_middleware(request: Request, call_next):
    # WebSocket-Upgrades hier durchreichen — Auth via Query-Token in main.py.
    if request.headers.get("upgrade", "").lower() == "websocket":
        return await call_next(request)

    # Demo-Modus: read-only erzwingen (greift auch im Open-Mode).
    if config.DEMO_MODE and _demo_blocked(request):
        return JSONResponse({"detail": "Demo-Instanz ist schreibgeschützt."}, status_code=403)

    # Open-Mode: keine User → offen lassen (Backward-Compat lokal).
    if settings.user_count() == 0:
        return await call_next(request)

    if _is_public(request.url.path):
        return await call_next(request)

    auth = request.headers.get("Authorization") or ""
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if not token:
        token = request.query_params.get("token", "")
    payload = users.decode_token(token)
    if not payload:
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    request.state.user = payload
    if _vault_access_denied(request, payload.get("sub")):
        return JSONResponse({"detail": "Kein Zugriff auf diesen Vault."}, status_code=403)
    return await call_next(request)
