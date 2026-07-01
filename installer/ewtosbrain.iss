; @author Dario | ewtos.com
; Inno-Setup-Skript fuer den EwtosBrain-Server (Tray-App).
; Erwartet den PyInstaller-Output unter ..\dist\EwtosBrain\ (build.bat vorher laufen lassen).
; Kompilieren: ISCC.exe installer\ewtosbrain.iss  (Inno Setup 6)

#define AppName "EwtosBrain"
; Version-Single-Source ist die Datei VERSION im Repo-Root. Bei Release:
; VERSION, extension/manifest.json, server/bridge.py und diese Datei
; synchron aktualisieren.
#define AppVersion "1.0.0"
#define AppExe "EwtosBrain.exe"

[Setup]
AppId={{B7E3B6A2-2C4E-4E2A-9D1F-EW70S0BRA1N0}}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Dario | ewtos.com
AppPublisherURL=https://ewtos.com
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=EwtosBrain-Setup-{#AppVersion}
SetupIconFile=..\server\ewtos.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "de"; MessagesFile: "compiler:Languages\German.isl"

[Tasks]
Name: "autostart"; Description: "EwtosBrain beim Login automatisch starten"; GroupDescription: "Start:"
Name: "desktopicon"; Description: "Desktop-Verknuepfung anlegen"; GroupDescription: "Verknuepfungen:"; Flags: unchecked

[Files]
Source: "..\dist\{#AppName}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\{#AppName} deinstallieren"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; \
  ValueName: "{#AppName}"; ValueData: """{app}\{#AppExe}"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\{#AppExe}"; Description: "EwtosBrain jetzt starten"; Flags: nowait postinstall skipifsilent
