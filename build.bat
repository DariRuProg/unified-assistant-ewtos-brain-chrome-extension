@echo off
REM EwtosBrain — baut die Server-.exe (Tray-App) via PyInstaller.
REM @author Dario ^| ewtos.com
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [Fehler] Keine venv gefunden. Bitte zuerst start-server.bat einmal ausfuehren.
  exit /b 1
)

echo [1/3] Build-Dependencies sicherstellen...
".venv\Scripts\python.exe" -m pip install --quiet --upgrade pyinstaller pystray Pillow

echo [2/3] Alte Build-Artefakte entfernen...
if exist "build" rmdir /s /q "build"
if exist "dist\EwtosBrain" rmdir /s /q "dist\EwtosBrain"

echo [3/3] PyInstaller-Build...
".venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean server\ewtosbrain.spec
if errorlevel 1 (
  echo [Fehler] Build fehlgeschlagen.
  exit /b 1
)

echo.
echo Fertig: dist\EwtosBrain\EwtosBrain.exe
