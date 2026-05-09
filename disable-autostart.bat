@echo off
title EwtosBrain — Autostart deaktivieren
echo.
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\EwtosBrain Server.lnk"
if exist "%LINK%" (
  del "%LINK%"
  echo Autostart deaktiviert.
) else (
  echo Kein Autostart aktiv.
)
echo.
pause
