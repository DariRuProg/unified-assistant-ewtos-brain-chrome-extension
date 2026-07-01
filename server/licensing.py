# @author Dario | ewtos.com
"""Pro-Lizenz + 28-Tage-Trial mit Feature-Gating (LemonSqueezy).

Der effektive Tier wird dynamisch bestimmt: gueltige Lizenz -> 'pro', sonst
innerhalb des Trial-Fensters -> 'trial', danach -> 'free'. Im Trial sind alle
Pro-Tools frei. Aktivierung/Validierung laufen ueber die LemonSqueezy-License-API;
bei fehlendem Netz greift eine Offline-Grace ueber 'validated_at'.

Der Lizenz-State liegt im 'licensing'-Block der settings.json (siehe settings.py).
Diese Schicht ist unabhaengig vom Multi-User-Seat-System (settings.seat_available).
"""
from __future__ import annotations

import logging
import os
import socket
import time

import httpx

import settings

log = logging.getLogger("ewtosbrain")

TRIAL_DAYS = 14
GRACE_DAYS = 14  # Pro bleibt aktiv, wenn die Re-Validierung so lange offline war
LS_API = "https://api.lemonsqueezy.com/v1"
_TIMEOUT = 10.0


def ensure_trial_started() -> float:
    """Setzt beim ersten Aufruf das Trial-Startdatum und liefert es zurueck."""
    ts = settings.licensing().get("trial_started_at")
    if ts:
        return float(ts)
    now = time.time()
    settings.set_licensing({"trial_started_at": now})
    return now


def trial_days_left() -> int:
    elapsed = (time.time() - ensure_trial_started()) / 86400.0
    return max(0, TRIAL_DAYS - int(elapsed))


def _license_active() -> bool:
    lic = settings.licensing()
    if not (lic.get("license_key") and lic.get("license_valid")):
        return False
    validated_at = lic.get("validated_at")
    if not validated_at:
        return True
    return (time.time() - float(validated_at)) < GRACE_DAYS * 86400.0


def tier() -> str:
    # Owner-/Dev-Bypass: EWTOS_PRO=1 haelt die lokale Instanz dauerhaft Pro (die
    # ausgelieferte .exe beim Endnutzer hat die Var nicht gesetzt).
    if os.environ.get("EWTOS_PRO") == "1":
        return "pro"
    if _license_active():
        return "pro"
    if trial_days_left() > 0:
        return "trial"
    return "free"


def is_pro() -> bool:
    """True im Trial und mit gueltiger Pro-Lizenz — dann sind alle Tools frei."""
    return tier() in ("pro", "trial")


def status() -> dict:
    lic = settings.licensing()
    t = tier()
    return {
        "tier": t,
        "is_pro": t in ("pro", "trial"),
        "trial_days_left": trial_days_left() if t == "trial" else 0,
        "license_key_set": bool(lic.get("license_key")),
    }


def activate(license_key: str) -> dict:
    """Aktiviert einen Lizenz-Key bei LemonSqueezy und speichert ihn bei Erfolg.
    Wirft ValueError mit Klartext, wenn der Key abgelehnt wird oder LS offline ist."""
    key = (license_key or "").strip()
    if not key:
        raise ValueError("Lizenz-Key fehlt")
    try:
        resp = httpx.post(
            f"{LS_API}/licenses/activate",
            data={"license_key": key, "instance_name": socket.gethostname() or "EwtosBrain"},
            headers={"Accept": "application/json"},
            timeout=_TIMEOUT,
        )
        payload = resp.json()
    except Exception as e:
        raise ValueError(f"LemonSqueezy nicht erreichbar: {e}")
    if not payload.get("activated"):
        raise ValueError(payload.get("error") or "Lizenz-Key ungueltig oder Aktivierungs-Limit erreicht")
    settings.set_licensing({
        "license_key": key,
        "instance_id": (payload.get("instance") or {}).get("id"),
        "license_valid": True,
        "validated_at": time.time(),
    })
    return status()


def validate() -> None:
    """Re-validiert die gespeicherte Lizenz beim Start. Netzfehler aendern nichts
    (Offline-Grace greift ueber validated_at)."""
    lic = settings.licensing()
    key, instance_id = lic.get("license_key"), lic.get("instance_id")
    if not (key and instance_id):
        return
    try:
        resp = httpx.post(
            f"{LS_API}/licenses/validate",
            data={"license_key": key, "instance_id": instance_id},
            headers={"Accept": "application/json"},
            timeout=_TIMEOUT,
        )
        valid = bool(resp.json().get("valid"))
    except Exception as e:
        log.info("Lizenz-Validierung offline, Grace greift: %s", e)
        return
    settings.set_licensing({"license_valid": valid, "validated_at": time.time()})


def require_pro() -> None:
    """FastAPI-Dependency: blockt Pro-Tools im Free-Modus mit HTTP 402.

    detail ist bewusst ein Klartext-String, damit die bestehende Fehleranzeige
    der Extension ihn direkt lesbar zeigt (kein Renderer-Umbau noetig)."""
    if not is_pro():
        from fastapi import HTTPException
        raise HTTPException(
            status_code=402,
            detail=("Dieses Tool gehoert zu Office-Brain Pro — im 28-Tage-Trial und mit "
                    "Lizenz frei. Lizenz eintragen unter Einstellungen → Office-Brain Pro."),
        )
