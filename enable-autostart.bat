@echo off
title EwtosBrain — Autostart aktivieren
echo.
echo Lege Autostart-Verknuepfung an...
echo.
powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup') + '\EwtosBrain Server.lnk'); $s.TargetPath = '%~dp0start-server.bat'; $s.WorkingDirectory = '%~dp0'; $s.WindowStyle = 7; $s.Description = 'EwtosBrain Server (laeuft minimiert)'; $s.Save()"
if errorlevel 1 (
  echo FEHLER beim Erstellen der Verknuepfung.
  pause
  exit /b 1
)
echo Autostart aktiviert.
echo.
echo Der Server startet jetzt bei jedem Windows-Start automatisch und laeuft minimiert.
echo Zum Deaktivieren: disable-autostart.bat ausfuehren.
echo.
pause
