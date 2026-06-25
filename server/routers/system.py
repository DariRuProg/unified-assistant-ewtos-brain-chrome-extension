"""System: Root, Health, Folder-Picker, Status. ewtos.com"""
from __future__ import annotations

import subprocess
import sys

from typing import Any

from fastapi import APIRouter

from bridge import bridge, SERVER_VERSION


router = APIRouter()

@router.get("/")
def root() -> dict[str, Any]:
    return {
        "name": "EwtosBrain",
        "version": SERVER_VERSION,
        "extension_connected": bridge.connected,
    }


@router.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "version": SERVER_VERSION}


@router.get("/pick_folder")
def pick_folder() -> dict[str, Any]:
    """Oeffnet einen nativen Ordner-Dialog auf der Server-Maschine (lokal) und
    gibt den gewaehlten Pfad zurueck. Fuer den Vault-Pfad im Setup-Wizard."""
    if sys.platform != "win32":
        return {"ok": False, "error": "Ordner-Dialog nur unter Windows verfügbar."}
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$f=New-Object System.Windows.Forms.FolderBrowserDialog;"
        "$f.Description='EwtosBrain: Vault-Ordner wählen';"
        "$f.ShowNewFolderButton=$true;"
        "if($f.ShowDialog() -eq 'OK'){[Console]::Out.Write($f.SelectedPath)}"
    )
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", ps],
            capture_output=True, text=True, timeout=180,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        path = out.stdout.strip()
        return {"ok": bool(path), "path": path}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@router.get("/status")
def status() -> dict[str, Any]:
    return {"extension_connected": bridge.connected, "pending_calls": len(bridge.pending)}
