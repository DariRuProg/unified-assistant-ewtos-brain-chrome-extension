# @author Dario | ewtos.com
"""Lizenz-Endpoints: Status abfragen, Pro-Lizenz aktivieren."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import licensing
import settings

router = APIRouter()


class ActivateRequest(BaseModel):
    license_key: str


def _require_admin(request: Request) -> None:
    # Open-Mode (0 User): lokaler Owner darf alles.
    if settings.user_count() == 0:
        return
    cur = getattr(request.state, "user", None)
    if not cur:
        raise HTTPException(401, "Unauthorized")
    if cur.get("role") != "admin":
        raise HTTPException(403, "Admin erforderlich")


@router.get("/license/status")
def license_status() -> dict[str, Any]:
    return licensing.status()


@router.post("/license/activate")
def license_activate(req: ActivateRequest, request: Request) -> dict[str, Any]:
    _require_admin(request)
    try:
        return licensing.activate(req.license_key)
    except ValueError as e:
        raise HTTPException(400, str(e))
