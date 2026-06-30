# @author Dario | ewtos.com
"""User-Auth: Passwort-Hashing (bcrypt) + JWT-Issue/Verify.

Seat-ready Multi-User-Fundament (F0). Users, Sessions und der JWT-Secret liegen
in settings.json (siehe settings.py). Open-Mode: 0 User → Server bleibt offen.
"""
from __future__ import annotations

import time
from typing import Any

import bcrypt
import jwt

import settings

_ALG = "HS256"
TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7  # 7 Tage


def hash_password(password: str) -> str:
    # bcrypt akzeptiert max. 72 Bytes — längere Passwörter sicher abschneiden.
    pw = (password or "").encode("utf-8")[:72]
    return bcrypt.hashpw(pw, bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        pw = (password or "").encode("utf-8")[:72]
        return bcrypt.checkpw(pw, (password_hash or "").encode("utf-8"))
    except Exception:
        return False


def issue_token(user: dict[str, Any]) -> str:
    now = int(time.time())
    payload = {
        "sub": user["id"],
        "username": user.get("username"),
        "role": user.get("role", "member"),
        "iat": now,
        "exp": now + TOKEN_TTL_SECONDS,
    }
    return jwt.encode(payload, settings.get_or_create_jwt_secret(), algorithm=_ALG)


def decode_token(token: str) -> dict[str, Any] | None:
    if not token:
        return None
    try:
        return jwt.decode(token, settings.get_or_create_jwt_secret(), algorithms=[_ALG])
    except Exception:
        return None


def authenticate(username: str, password: str) -> dict[str, Any] | None:
    user = settings.get_user_by_username(username)
    if not user:
        return None
    if not verify_password(password, user.get("password_hash", "")):
        return None
    return user


def create_user(username: str, password: str, role: str = "member") -> dict[str, Any]:
    if not (username or "").strip():
        raise ValueError("Username fehlt")
    if not password:
        raise ValueError("Passwort fehlt")
    return settings.add_user(username, hash_password(password), role)


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    """User ohne Secret-Felder (password_hash) für API-Antworten."""
    return {
        "id": user.get("id"),
        "username": user.get("username"),
        "role": user.get("role", "member"),
    }
