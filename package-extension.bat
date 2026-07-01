@echo off
REM EwtosBrain — packt die Chrome-Extension als Store-fertiges ZIP (dist\extension.zip).
REM manifest.json liegt auf oberster ZIP-Ebene; Dev-Skripte werden ausgelassen.
REM @author Dario ^| ewtos.com
cd /d "%~dp0"

set "STAGE=dist\_extension_stage"

if not exist "dist" mkdir "dist"

echo [1/3] Staging vorbereiten...
if exist "%STAGE%" rmdir /s /q "%STAGE%"
xcopy "extension" "%STAGE%\" /e /i /q /y >nul

echo [2/3] Dev-Ballast entfernen...
if exist "%STAGE%\images\make_icons.py" del /q "%STAGE%\images\make_icons.py"

echo [3/3] ZIP erzeugen...
if exist "dist\extension.zip" del /q "dist\extension.zip"
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%\*' -DestinationPath 'dist\extension.zip' -Force"
rmdir /s /q "%STAGE%"

echo.
echo Fertig: dist\extension.zip  (manifest.json auf oberster Ebene)
