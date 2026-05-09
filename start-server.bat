@echo off
title EwtosBrain Server
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo === Erste Einrichtung ===
  echo Erstelle Python-venv und installiere Dependencies...
  echo.
  python -m venv .venv
  if errorlevel 1 (
    echo.
    echo FEHLER: Python ist nicht installiert oder nicht im PATH.
    echo Installiere Python von https://python.org/downloads und starte dieses Skript erneut.
    echo.
    pause
    exit /b 1
  )
  ".venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
  ".venv\Scripts\python.exe" -m pip install --quiet -r server\requirements.txt
  if errorlevel 1 (
    echo.
    echo FEHLER beim Installieren der Dependencies.
    pause
    exit /b 1
  )
  echo Setup fertig.
  echo.
)

if not exist "server\.env" (
  echo.
  echo HINWEIS: server\.env fehlt — Anthropic-API-Key wird nicht geladen.
  echo Lege server\.env an mit: ANTHROPIC_API_KEY=sk-ant-...
  echo Vorlage: server\.env.example
  echo.
)

echo.
echo === EwtosBrain Server ===
echo Laeuft auf http://127.0.0.1:9988
echo Schliesse dieses Fenster um den Server zu stoppen.
echo.
".venv\Scripts\python.exe" server\main.py
echo.
echo Server beendet.
pause
