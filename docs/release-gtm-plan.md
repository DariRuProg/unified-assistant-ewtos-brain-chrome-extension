# EwtosBrain — Release- & Go-to-Market-Plan (Stand 2026-07-01)

> **Zweck dieses Dokuments:** Vollständiger, eigenständiger Fahrplan, um EwtosBrain
> verkaufsfertig zu machen. Gedacht als Referenz für einen **frischen Chat** — enthält
> Status, konkrete TODOs, Datei-Pfade und Schritt-für-Schritt-Anleitungen. Der Demo-Teil
> (unten im Archiv) ist ein separater Strang, an dem später weitergearbeitet wird.

## Strategische Entscheidung (vom Owner bestätigt)

- **Launch-Reihenfolge:** **Free-Extension zuerst** in den Chrome Web Store (Server bleibt
  self-hosted, BYOK), Nutzer + Feedback sammeln. **Monetarisierung (Lemon Squeezy) direkt
  danach** — d.h. das Lizenz-Gate ist NICHT im Launch-kritischen Pfad.
- **Server-Vertrieb kurzfristig:** **Nur Windows-Desktop-Installer** (per-User `.exe`). Kein
  Cloud/SaaS/Managed-Hosting im Launch-Pfad — das ist ein späterer Ausbau (Sprint 4).
- **Billing-Entscheidung (steht schon in `docs/anleitung-und-lizenzierung.md`):** **Lemon
  Squeezy** als Merchant of Record (kümmert sich um EU-USt/OSS + Rechnungen — ideal für Solo).
  Seat-Modell statt HWID. Kein eigener Lizenz-Server nötig.

## Produkt in einem Satz

Chrome-Extension (MV3) als täglicher KI-Assistent, die mit einem **selbst betriebenen** Python-
Server (Desktop-`.exe`) spricht. USPs: **self-hosted, BYOK, DSGVO-freundlich**, Multi-LLM (kein
Anthropic-Lock-in), Karpathy-Vault statt RAG, Browser-Tools + Claude-Code-Integration (MCP).

---

## Gesamtbild — Ampel

| Komponente | Reife | Kurzstatus |
|---|---|---|
| Chrome Extension (Code) | 🟢 ~90% | MV3-konform, kein Remote-Code, WS-Reconnect + Version-Handshake fertig |
| Extension → Store-Upload | 🟡 ~85% | Erledigt: Version 1.0.0, icon-512, Onboarding, Screenshots, Privacy-Policy finalisiert. Offen: Privacy-Policy + Landing online stellen |
| Server Desktop (Installer) | 🟢 ~85% | PyInstaller-Tray + Inno-Installer laufen; fehlt Code-Signing + Auto-Update |
| Auth / Multi-User / Seats (F0) | 🟢 fertig | JWT, bcrypt, Bootstrap, Seat-Fundament — bereits gebaut (`server/auth.py`, `users.py`) |
| Multi-LLM-Backend | 🟢 fertig | Anthropic, OpenAI, Ollama, Mistral, OpenRouter |
| Monetarisierung (Lemon Squeezy, F-LIC) | 🔴 offen | Plan steht, Code-Anbindung fehlt (Phase 2, direkt nach Launch) |
| Marketing (Demo läuft) | 🟡 teils | `/demo` live über Coolify (BYOK); Landing-Page + Screenshots + Pitch fehlen |
| SaaS / Cloud (Sprint 4) | 🔴 später | Dockerfile da; VaultFS/DB/Stripe/Rate-Limiting fehlen — bewusst aufgeschoben |

---

## TEIL 1 — Chrome Extension: Store-Reife + Upload

### 1a. Fertig
- MV3, `manifest_version: 3`, kein Remote-Code (CSP `script-src 'self'`) — Store-Policy-konform.
- Berechtigungen begründet; `<all_urls>`/`file:///*` als **optional_host_permissions** (erst bei
  Bedarf angefordert) → enger Scope, gut fürs Review.
- WS-Reconnect mit Exponential-Backoff (1s→30s) + Ping-Keepalive + Version-Handshake
  (`extension/background.js`). Server-URL frei konfigurierbar (`extension/options/`), kein
  problematischer localhost-Hardcode (nur Default).
- Store-Texte + Permission-Begründungen + Single-Purpose bereits geschrieben:
  `docs/store-listing.md`. Privacy-Policy-Entwurf (DE+EN): `docs/legal/privacy-policy.md`.

### 1b. Code-/Config-Blocker (klein, im Repo zu fixen)
- [x] `extension/manifest.json`: **`version` → `1.0.0`** (erledigt 2026-07-01).
- [x] `extension/manifest.json`: **icon-512 registriert** (`"512": "images/icon-512.png"` in `icons`).
- [x] **Toter Command** `add-highlighted-youtube-to-playlist`: gegengeprüft — nicht mehr im
  Manifest (nur `capture-highlighted-tabs`), kein stale Verweis in `background.js`.
- [x] `web_accessible_resources` geprüft: **nicht nötig** — alle `chrome.runtime.getURL(...)`
  laufen aus privilegierten Kontexten (background/options/sidepanel/setup), keine
  Content-Scripts referenzieren Extension-Assets.
- [x] **Version-Single-Source** hergestellt: `VERSION`-Datei im Repo-Root = Quelle;
  `manifest.json`, `server/bridge.py:SERVER_VERSION`, `installer/ewtosbrain.iss` synchron auf
  `1.0.0` (Kommentare verweisen aufeinander).

### 1c. Launch-kritisches UX (WICHTIG, sonst schlechtes Store-Erlebnis)
Ein Store-Nutzer installiert die Extension **ohne** laufenden Server → sie muss ihn sauber
zum Desktop-Server-Download führen, statt „tot" zu wirken.
- [ ] **Onboarding-/Offline-Panel fertigstellen** (G1.2): Wenn kein Server erreichbar,
  klare Anleitung + Link zum `.exe`-Download + „so verbindest du dich". Aktuell existiert nur
  ein Mockup (`docs/wizard-mockup.html` / `extension/setup/`, laut `docs/status.md` nicht
  voll integriert). **Das ist der wichtigste UX-Blocker für einen guten Store-Eindruck.**

### 1d. Assets & Legal (Blocker für Einreichung)
- [x] **5 Screenshots (1280×800)** in `docs/store-assets/out/` (`01-main`, `02-explorer`,
  `03-chat`, `04-scrape`, `05-video` + `00-intro`) — aus der Live-Demo via agent-browser.
- [x] **Privacy-Policy finalisiert** (`docs/legal/privacy-policy.md`): Datum gesetzt, Draft-
  Disclaimer entfernt, Impressum-Links → `ewtos.com/impressum`, Marke → „Ewtos Office-Brain".
- [ ] **Privacy-Policy öffentlich online stellen** unter `ewtos.com/office-brain/datenschutz`
  (Markdown-Inhalt 1:1 übernehmen). Impressum wird NICHT dupliziert — es reicht der Verweis
  auf das bestehende `ewtos.com/impressum` (gleiche juristische Person). **Manueller Schritt
  (Hosting/DNS).**
- [ ] Optional: kleines Promo-Tile (440×280) für bessere Store-Darstellung.

### 1e. Schritt-für-Schritt: Upload in den Chrome Web Store
1. **Developer-Konto** anlegen: `chrome.google.com/webstore/devconsole`, einmalig **5 USD**
   Registrierungsgebühr.
2. **ZIP bauen:** Inhalt von `extension/` zippen, sodass `manifest.json` auf der **obersten
   ZIP-Ebene** liegt (nicht in einem Unterordner). `.venv`, Doku, Quell-Skripte wie
   `make_icons.py` nicht mit einpacken.
3. **New Item** → ZIP hochladen.
4. **Store-Listing** ausfüllen (Texte aus `docs/store-listing.md`): Titel, Kurz- + Detail-
   Beschreibung, **Kategorie: Productivity**, Sprachen DE + EN.
5. **Grafik:** Icon 128 (steckt im ZIP), Screenshots (1280×800), optional Promo-Tile.
6. **Privacy-Tab:** Single-Purpose-Statement, Permission-Justifications (jede angeforderte
   Berechtigung begründen — Vorlagen in `docs/store-listing.md`), Data-Usage-Disclosure
   (Auth-Token lokal, Website-Content nur nutzerausgelöst, **kein Tracking/Verkauf**),
   **Privacy-Policy-URL** eintragen.
7. **Submit** → Google-Review (i.d.R. wenige Tage, kann bis ~2 Wochen dauern). Bei Ablehnung:
   Grund lesen, fixen, neu einreichen.
8. Nach Freigabe: Versions-Bumps über neues ZIP + höhere `version`.

---

## TEIL 2 — Server (Desktop-Installer): Reife + TODOs

### 2a. Fertig (Phase 7)
- **Build:** `server/tray.py` (pystray-Tray-App, uvicorn im Thread) → `server/ewtosbrain.spec`
  (PyInstaller) → `build.bat` → `dist\EwtosBrain\EwtosBrain.exe`.
- **Installer:** `installer/ewtosbrain.iss` (Inno Setup 6) → **per-User** nach
  `%LOCALAPPDATA%\Programs\EwtosBrain`, kein Admin, optional Autostart (HKCU\Run).
- **Pfade sauber getrennt:** `server/paths.py` (`data_dir()` schreibt nach
  `%LOCALAPPDATA%\EwtosBrain`, `bundle_dir()` read-only Assets, `migrate_legacy_data()`).
- **`/health`** + WS-Version-Handshake (`server/routers/system.py`, `server/bridge.py`).
- **Auth-Fundament F0 fertig:** `server/auth.py` (Bearer/JWT-Middleware, Public-Paths),
  `server/users.py` (bcrypt + JWT), Bootstrap-/Login-/User-CRUD-Endpoints, Seat-Fundament
  in `server/settings.py` (`licensing.seat_limit`, `instance_token`, `seat_available()`).
- **Multi-LLM:** `server/llm_providers/` + `server/llm_client.py`.

### 2b. Vor Verkauf zu erledigen (Desktop)
- [ ] **Version-Single-Source:** Version steht doppelt (`server/bridge.py:SERVER_VERSION` +
  `extension/manifest.json` + `installer/ewtosbrain.iss`). Eine Quelle definieren (z.B. eine
  `VERSION`-Datei), Rest daraus ableiten. Erst dann synchron auf `1.0.0` heben.
- [ ] **Code-Signing** (wichtig): Ohne Signatur zeigt Windows SmartScreen eine Warnung →
  Vertrauens-/Konversions-Verlust. Code-Signing-Zertifikat kaufen (~200 €/Jahr, OV; EV teurer
  aber sofort SmartScreen-clean), `SignTool` in `build.bat`/`.iss` einbinden.
- [ ] **Auto-Update** (mittel, kann Phase 2): aktuell nur manueller Installer-Download.
  Einfachste Variante: `/health`-Version gegen eine „latest"-Info prüfen + Nutzer auf Download
  hinweisen. Voll-Auto-Update später.
- [ ] Kleine Code-TODOs: `server/tools/video_brain_sync.py:35-36` (Supabase-Demo-Creds noch
  hardcoded), `server/tools/blueprint.py:9` (`verify_signature` Stub — bewusst, kein Blocker).

### 2c. Release-Ablauf (Desktop)
1. Version in Single-Source erhöhen.
2. `build.bat` ausführen → `dist\EwtosBrain\`.
3. Inno Setup über `installer\ewtosbrain.iss` → `dist\EwtosBrain-Setup-<version>.exe`.
4. (Nach 2b) Setup-`.exe` signieren.
5. `.exe` auf `ewtos.com` zum Download bereitstellen; Extension-Onboarding verlinkt darauf.

---

## TEIL 3 — Monetarisierung (Phase 2, direkt nach Free-Launch)

Plan liegt in `docs/F0-auth-plan.md` + `docs/anleitung-und-lizenzierung.md`.

- **Modell:** Free / Pro (~9 €) / Team (~79 €, 10 Seats) / Agency (~299–699 €).
  *(Finale Preise + Limits pro Tier = deine Entscheidung, siehe unten.)*
- **F-LIC-Anbindung (zu bauen):** Beim Login ruft der Server **Lemon Squeezy
  `POST /v1/licenses/activate`** mit `instance_token` als `instance_name`. Antwort OK → Seat
  frei; Limit erreicht → `402`. Kein eigener Lizenz-Server. Webhook für Kündigung/Refund.
- **Vorbereitung Lemon Squeezy (No-Code-Teil):** Store + Produkte/Tiers anlegen,
  `activation_limit` je Tier = Seat-Limit, Test-Keys erzeugen.
- **Aufwand:** ~3–5 Tage Server-Anbindung + Webhook.

---

## TEIL 4 — Marketing & Go-to-Market

### Vorhanden
- **Live-Demo als Marketing-Asset:** `server/routers/demo.py`, Route `GET /demo`, deployed über
  **Coolify** (`demo.ewtos.com`). BYOK, read-only Beispiel-Vault, **keine Server-LLM-Kosten**.
  Perfekt für „Zero-Risk testen" auf der Landing-Page.

### Fehlt (zu erstellen)
- [x] **Website gebaut** in `site/` (ewtos-Markenhomepage `site/index.html` + Produkt-Landing
  `site/office-brain/index.html`, geteiltes Space-/Nova-Designsystem, Hell/Dunkel-Toggle): Hero,
  Features, „Ersetzt 10+ Extensions", So-funktioniert's, USP-Band, Screenshot-Galerie, CTA, Footer +
  Datenschutz-Seiten. Deploy: `site/` → `ewtos.com/` (Homepage Root, `office-brain/` als Unterordner).
  **Offen (Owner):** Demo-URL/`.exe`-Pfad/Store-URL eintragen (TODO-Kommentare im HTML), online
  stellen. *(Pricing-Tabelle bewusst weggelassen — Free-Launch; kommt mit Meilenstein B.)*
- [ ] **Kurzer Demo-Clip / GIF** (Vault-Chat + Page-Scrape) für Landing + Store.
- [ ] **Pitch-Copy** (1 Absatz + Bullet-USPs) — Baustein aus `docs/store-listing.md` ausbauen.

### Kanäle (Vorschlag, nach Store-Freigabe)
- Chrome Web Store selbst (organisch, Kategorie Productivity).
- Eigene Marke ewtos.com + Newsletter/Social.
- Obsidian-Community (Forum/Discord/Reddit r/ObsidianMD) — self-hosted + DSGVO ist dort ein
  starkes Argument.
- Agentur-Netzwerk (unica-marketing) für den späteren White-Label-Widget-Hebel (F2).

---

## TEIL 5 — Priorisierte TODO-Liste (Reihenfolge)

### 🎯 Meilenstein A — Free-Store-Launch (jetzt)
1. **Onboarding-/Offline-Panel** fertig (G1.2) — Extension führt server-los sauber zum Download.
2. Manifest-Fixes: `version 1.0.0`, icon-512, toten Command entfernen, `web_accessible_resources`.
3. Version-Single-Source (Manifest ↔ Server ↔ Installer).
4. ~~**Screenshots** (3–5, 1280×800) erstellen.~~ ✅ `docs/store-assets/out/` (aus Live-Demo).
5. **Privacy-Policy** finalisieren + öffentlich online stellen (+ Impressum).
6. Desktop-`.exe` bauen, signieren (falls Zertifikat da; sonst Warnung dokumentieren) + auf
   ewtos.com zum Download.
7. ~~**Landing-Page** minimal (Pitch + Demo-Link + Downloads).~~ ✅ `site/` (ewtos-Homepage + `site/office-brain/`).
8. Extension-ZIP in den Chrome Web Store einreichen (Teil 1e).

### 💶 Meilenstein B — Monetarisierung (direkt danach)
9. Lemon-Squeezy-Store + Tiers anlegen.
10. F-LIC: `licenses/activate` beim Login + Webhook (Server).
11. Finale Preise/Limits pro Tier festlegen + auf Landing-Page/Store kommunizieren.
12. Code-Signing (falls in A noch nicht erledigt) + Auto-Update-Hinweis.

### 🚀 Meilenstein C — Ausbau (später, nicht jetzt)
- Sprint 3 Rest: SEO-Check, Image-Analyse, Color-Picker, Screenshot+Annotation.
- F2 White-Label-Widget (höchster LTV — für Agentur-Kunden) — Spec fehlt noch.
- Sprint 4 SaaS: VaultFS-Abstraktion, PostgreSQL statt JSON, Redis-WS-Broker, Rate-Limiting,
  Managed Hosting, API-Keys für externe Devs.
- Backlog „Guten Morgen"-Briefing-Ausbau, video-brain-Sync-Features (siehe Memory).

---

## Kritische Dateipfade (Referenz für frischen Chat)

| Zweck | Pfad |
|---|---|
| Roadmap/Architektur/Entscheidungen | `CLAUDE.md` |
| Store-Texte + Permission-Begründungen + Checkliste | `docs/store-listing.md` |
| Privacy-Policy (DE+EN, zu finalisieren) | `docs/legal/privacy-policy.md` |
| Auth/Pricing-Plan | `docs/F0-auth-plan.md` |
| Lemon-Squeezy-Lizenzierung | `docs/anleitung-und-lizenzierung.md` |
| Deployment (VPS/Cloudflare) + Coolify | `docs/deployment.md`, `docs/deploy-coolify.md` |
| Onboarding-Mockup / Status | `docs/wizard-mockup.html`, `docs/status.md` |
| Manifest | `extension/manifest.json` |
| WS-Reconnect + Handshake | `extension/background.js` |
| Server-URL/Key-Settings | `extension/options/options.js` |
| Auth-Middleware / User-Mgmt | `server/auth.py`, `server/users.py`, `server/routers/auth.py` |
| Settings/Seats/Licensing | `server/settings.py` |
| Pfade (bundle-aware) | `server/paths.py` |
| LLM-Factory + Backends | `server/llm_client.py`, `server/llm_providers/` |
| Tray/Build/Installer | `server/tray.py`, `server/ewtosbrain.spec`, `build.bat`, `installer/ewtosbrain.iss` |
| Docker (Cloud/Demo) | `Dockerfile` |
| Öffentliche Demo | `server/routers/demo.py` (`GET /demo`) |

## Offene Business-Entscheidungen (du, nicht Code)
- Finale Preise + Limits je Tier (Vaults? Seats? Briefing-Profile?).
- Free-Tier-Umfang (was ist gratis vs. Pro-Gate?).
- Code-Signing jetzt (Meilenstein A) oder erst B? (beeinflusst SmartScreen-Eindruck bei Early-Usern).
- ~~Domain-Struktur~~ **entschieden (2026-07-01):** Produkt-Heimat `ewtos.com/office-brain`
  (Subpath, Landing + `/datenschutz` + `.exe`-Download), Demo bleibt `demo.ewtos.com`.
  Öffentliche Marke „Ewtos Office-Brain" (Code intern weiter `EwtosBrain`).

## Verifikation (wenn Umsetzung startet)
- Extension: lokal als „unpacked" laden, ohne Server öffnen → Onboarding-Panel muss sauber
  erscheinen. Mit Server → Verbindung grün, Version-Handshake ohne Banner.
- `manifest.json` mit `chrome://extensions` „Fehler"-Check + Store-Draft-Upload (Validierung).
- Installer auf sauberer Windows-VM testen (per-User, kein Admin, Autostart-Option).
- Privacy-URL öffentlich erreichbar (200) vor Einreichung.

---

