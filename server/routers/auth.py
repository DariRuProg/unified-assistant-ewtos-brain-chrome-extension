# @author Dario | ewtos.com
"""Auth-Endpoints: Bootstrap (Erst-Admin), Login, Me, Status, User-Verwaltung."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import settings
import users

router = APIRouter()


class LoginRequest(BaseModel):
    username: str
    password: str
    instance_token: str | None = None
    device_name: str | None = None


class BootstrapRequest(BaseModel):
    username: str
    password: str


class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = "member"


def _current(request: Request) -> dict[str, Any] | None:
    return getattr(request.state, "user", None)


def _require_admin(request: Request) -> None:
    # Open-Mode (0 User): lokaler Owner darf alles.
    if settings.user_count() == 0:
        return
    cur = _current(request)
    if not cur:
        raise HTTPException(401, "Unauthorized")
    if cur.get("role") != "admin":
        raise HTTPException(403, "Admin erforderlich")


@router.get("/auth/status")
def auth_status() -> dict[str, Any]:
    """Sagt der Extension, ob Login nötig ist (≥1 User) oder Open-Mode läuft."""
    n = settings.user_count()
    return {"auth_required": n > 0, "user_count": n}


@router.post("/auth/bootstrap")
def auth_bootstrap(req: BootstrapRequest) -> dict[str, Any]:
    if settings.user_count() > 0:
        raise HTTPException(409, "Bereits initialisiert — Bootstrap nicht mehr erlaubt.")
    if not req.username.strip() or not req.password:
        raise HTTPException(400, "Username und Passwort erforderlich.")
    user = users.create_user(req.username, req.password, role="admin")
    return {"token": users.issue_token(user), "user": users.public_user(user)}


@router.post("/auth/login")
def auth_login(req: LoginRequest) -> dict[str, Any]:
    user = users.authenticate(req.username, req.password)
    if not user:
        raise HTTPException(401, "Ungültige Anmeldedaten.")
    inst = (req.instance_token or "").strip()
    if inst and not settings.seat_available(inst):
        raise HTTPException(402, "Seat-Limit erreicht — für ein weiteres Gerät ist eine Lizenz nötig.")
    if inst:
        settings.register_session(user["id"], inst, req.device_name or "")
    return {"token": users.issue_token(user), "user": users.public_user(user)}


@router.get("/auth/me")
def auth_me(request: Request) -> dict[str, Any]:
    if settings.user_count() == 0:
        return {"user": None, "open_mode": True}
    cur = _current(request)
    if not cur:
        raise HTTPException(401, "Unauthorized")
    return {
        "user": {"id": cur.get("sub"), "username": cur.get("username"), "role": cur.get("role")},
        "open_mode": False,
    }


@router.get("/auth/users")
def auth_list_users(request: Request) -> dict[str, Any]:
    _require_admin(request)
    return {"users": [users.public_user(u) for u in settings.get_users()]}


@router.post("/auth/users")
def auth_create_user(req: CreateUserRequest, request: Request) -> dict[str, Any]:
    _require_admin(request)
    try:
        user = users.create_user(req.username, req.password, role=req.role)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"user": users.public_user(user)}


@router.delete("/auth/users/{user_id}")
def auth_delete_user(user_id: str, request: Request) -> dict[str, Any]:
    _require_admin(request)
    if not settings.remove_user(user_id):
        raise HTTPException(404, "User nicht gefunden.")
    return {"ok": True}
