# Chrome Web Store — Einreichungs-Checkliste

Praktische Schritte, um die Extension (`extension/`) im Chrome Web Store zu veröffentlichen.

## 1. ZIP bauen
```
package-extension.bat
```
Erzeugt `dist/extension.zip` — `manifest.json` liegt auf oberster Ebene (Store-Anforderung),
das Dev-Skript `images/make_icons.py` ist ausgeschlossen.

## 2. Developer-Account
- Einmalig registrieren: https://chrome.google.com/webstore/devconsole
- **Einmalige Gebühr: 5 USD.**

## 3. Neues Item hochladen
- „Neues Item" → `dist/extension.zip` hochladen.

## 4. Store-Listing
- **Name:** Ewtos Office-Brain
- **Beschreibung:** aus `docs/store-listing.md` übernehmen.
- **Screenshots:** `docs/store-assets/out/` (1280×800, bereits fertig).
- **Icon:** 128×128 ist im Manifest (`images/icon-128.png`).
- **Wichtig:** klar kennzeichnen, dass die Extension die **kostenlose Server-App (Windows)**
  benötigt — sonst Ablehnung oder schlechte Reviews, weil sie ohne Server nicht arbeitet.

## 5. Datenschutz / Permissions
- **Datenschutz-URL:** `https://ewtos.com/office-brain/datenschutz`
- **Permission-Begründungen** (im Dashboard verlangt):
  - `tabs`, `scripting` — Seiten-Tools (Scrape, SEO, Bild-Analyse) lesen den aktiven Tab.
  - `downloads` — Bild-/Datei-Download-Tools.
  - `sidePanel`, `storage`, `contextMenus`, `clipboardWrite`, `alarms` — UI + lokale Einstellungen.
  - `optional_host_permissions` (`<all_urls>`) — nur bei Bedarf abgefragt, für Seiten-Tools.

## 6. Absenden & Review
- Zur Prüfung senden. Google-Review dauert i. d. R. einige Tage.
- Nach Freigabe: **Store-URL** in den Landing-„Bald im Store"-Button eintragen.
