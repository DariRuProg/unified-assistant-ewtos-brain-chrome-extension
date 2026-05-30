# @author Dario | ewtos.com
# PyInstaller-Spec fuer den EwtosBrain-Server (Tray-App).
# Build aus dem Projekt-Root:  build.bat   (bzw. python -m PyInstaller server/ewtosbrain.spec)
import os

from PyInstaller.utils.hooks import collect_submodules

SERVER_DIR = SPECPATH  # Verzeichnis dieser .spec = server/

datas = [
    (os.path.join(SERVER_DIR, "tools", "blueprint_schemas"), "tools/blueprint_schemas"),
    (os.path.join(SERVER_DIR, "tools", "blueprint_templates"), "tools/blueprint_templates"),
]
_trusted = os.path.join(SERVER_DIR, "blueprint_trusted_keys.json")
if os.path.exists(_trusted):
    datas.append((_trusted, "."))

# uvicorn[standard] waehlt Loop/Protocol-Impls dynamisch -> alle Submodule mitnehmen.
hiddenimports = collect_submodules("uvicorn") + ["anthropic", "openai"]

a = Analysis(
    [os.path.join(SERVER_DIR, "tray.py")],
    pathex=[SERVER_DIR],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["mcp"],  # MCP-Server laeuft aus Source (Dev), nicht im Bundle
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="EwtosBrain",
    console=False,  # Tray-App ohne Konsolenfenster
    icon=os.path.join(SERVER_DIR, "ewtos.ico"),
)

coll = COLLECT(exe, a.binaries, a.datas, name="EwtosBrain")
