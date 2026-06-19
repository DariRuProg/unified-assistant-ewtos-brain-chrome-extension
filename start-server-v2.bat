@echo off
SETLOCAL EnableDelayedExpansion

title EwtosBrain Server Starter (Fixed)
echo ====================================================
echo   EwtosBrain - Unified Assistant Server
echo ====================================================
echo.

cd /d "%~dp0"

:: 1. Python-Erkennung (Robust)
echo [INFO] Suche Python...
set "PY_CMD="

:: Test 1: Windows Python Launcher 'py'
py --version >nul 2>&1
if !errorlevel! == 0 (
    set "PY_CMD=py"
    echo [OK] Nutze 'py' Launcher.
) else (
    :: Test 2: 'python' (ignoriere Store-Stubs um "App kann nicht ausgefuehrt werden" zu vermeiden)
    where python >nul 2>&1
    if !errorlevel! == 0 (
        for /f "delims=" %%i in ('where python') do (
            set "P_PATH=%%i"
            echo !P_PATH! | findstr /i "WindowsApps" >nul
            if !errorlevel! neq 0 (
                if "!PY_CMD!"=="" (
                    set "PY_CMD=python"
                    echo [OK] Nutze 'python' von !P_PATH!.
                )
            )
        )
    )
)

if "%PY_CMD%"=="" (
    echo [ERROR] Python wurde nicht gefunden. 
    echo Bitte stelle sicher, dass Python installiert ist.
    echo Tipp: Installiere Python von python.org und aktiviere 'Add Python to PATH'.
    pause
    exit /b 1
)

echo [INFO] Python erkannt als: %PY_CMD%

:: 2. Virtuelle Umgebung prüfen/erstellen
if not exist ".venv" (
    echo [INFO] Keine virtuelle Umgebung gefunden. Erstelle .venv...
    %PY_CMD% -m venv .venv
    if !errorlevel! neq 0 (
        echo [ERROR] Fehler beim Erstellen der venv.
        pause
        exit /b 1
    )
)

:: 3. Aktivieren und Abhängigkeiten installieren
echo [INFO] Aktiviere virtuelle Umgebung...
call .venv\Scripts\activate

echo [INFO] Prüfe Abhängigkeiten (requirements.txt)...
python -m pip install --upgrade pip
if exist "server\requirements.txt" (
    pip install -r server\requirements.txt
) else (
    echo [WARN] server\requirements.txt wurde nicht gefunden!
)

:: 4. Server starten
echo [INFO] Starte EwtosBrain Server...
echo.
if exist "server\main.py" (
    python server\main.py
) else (
    echo [ERROR] server\main.py wurde nicht gefunden!
    echo Aktueller Pfad: %CD%
)
pause