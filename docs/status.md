# EwtosBrain — Projektstatus

Stand: 2026-05-14

---

## Erledigt (diese Session)

### Strategie & Dokumentation
- [x] Marktanalyse + Feature-Inventar der Extension
- [x] `docs/evaluation.html` — Interaktives Strategie-Dokument (Markt, SWOT, Roadmap, Zielgruppen, Marketing)
- [x] `docs/wizard-mockup.html` — Interaktiver Setup-Wizard-Prototyp (5 Steps, simulierte Verbindung)
- [x] Feature-Evaluation von 7 Ideen mit Priorisierung und Aufwand-Einschätzung

### Server — neue Tools & Endpoints
- [x] `server/tools/briefing.py` — Guten-Morgen-Briefing (Wetter via wttr.in, Todos, Vault-Fristen, Lernstreak)
- [x] `server/tools/auto_tagger.py` — LLM-basiertes Auto-Tagging für YouTube-Videos (Säule + Playlist + Tags)
- [x] `server/main.py` — 6 neue Routes:
  - `GET /tools/briefing` + Profile-CRUD (`/tools/briefing/profiles`)
  - `POST /tools/auto_tag`
  - `POST /tools/url_extractor` (WS-Bridge)
  - `POST /tools/auto_brain` (WS-Bridge)
- [x] `server/settings.py` — `briefing_profiles` im Settings-Schema
- [x] `server/requirements.txt` — `httpx` + `pyyaml` ergänzt

### Extension — neue Browser-Tools
- [x] `extension/tools/url_extractor.js` — DOM-basierte URL-Extraktion aus aktivem Tab
- [x] `extension/tools/auto_brain.js` — Transcript + Auto-Tag kombiniert
- [x] `extension/background.js` — neue Tool-Handler + Context-Menü "Ins Brain speichern" (nur auf YouTube)

### Extension — Sidepanel UI
- [x] URL-Extraktor-Panel mit Format-Toggle (Liste / Komma / JSON) + Copy-Button
- [x] Guten-Morgen-Briefing-Panel (Quick-Action-Button "Morgen")
- [x] YouTube Auto-Brain Modal (Transcript + Säule/Playlist-Vorschlag + Bestätigung)
- [x] Briefing zeigt Datum + Uhrzeit im Panel-Header
- [x] YouTube-Transcript-Tool füllt URL automatisch vor (aktiver Tab)
- [x] URL-Extraktor zeigt Quell-Domain als anklickbaren Link nach dem Scan
- [x] "Brain"-Button in Quick-Actions-Bar wenn YouTube-Video erkannt (persistent, verschwindet bei Tab-Wechsel)
- [x] `chrome.tabs.onActivated`-Listener für dynamische Brain-Button-Anzeige

### Extension — Options UI
- [x] Neue "Guten-Morgen-Briefing"-Section in `options.html`
- [x] Briefing-Profile als Karten (Quellen-Badges, Standorte)
- [x] Neues Profil anlegen: Name, Inhalte-Checkboxen, Standorte
- [x] Default-Profil kann nicht gelöscht werden

---

## Offen — Kurzfristig

### Sprint 3 abschliessen (Browser-Tools)
- [x] Page-Scrape UI im Sidepanel
- [x] SEO-Check UI im Sidepanel
- [x] Image-Analyse UI im Sidepanel
- [x] Color-Picker im Sidepanel
- [x] Screenshot + Annotation (Canvas + Stift/Rechteck/Pfeil/Text, Undo-Stack, Copy/Download)

### Setup-Wizard integrieren
- [ ] `extension/setup/wizard.html` — Wizard als echte Extension-Seite (Mockup existiert in `docs/wizard-mockup.html`)
- [ ] `extension/background.js` — Erststart erkennen (settings leer?) → Wizard automatisch öffnen
- [ ] Nach Wizard: Redirect zur Sidepanel

### Briefing verfeinern
- [ ] Profil-Wechsel direkt im Briefing-Panel (Dropdown statt immer "default")
- [ ] Briefing in `showBriefingPanel()` lädt immer "default" — sollte letztes gewähltes Profil merken

---

## Offen — Mittelfristig (Prio 2–3)

### Chat mit aktuell geöffneter Seite
- [ ] Server: neuer Chat-Modus `page` — `page_scrape` extrahiert Inhalt, wird als System-Kontext injiziert
- [ ] Server: Endpoint `POST /tools/chat/page` (kein Vault-Binding)
- [ ] Sidepanel: kontextsensitive Tab-Erkennung (YouTube → Video-Modus, Seite → Seiten-Chat, kein Tab → Vault-Chat)

### PDF / Dokument-Ingest
- [ ] Server: `pypdf` oder `pdfminer.six` für PDF-Parsing
- [ ] Server: Upload-Endpoint `POST /tools/ingest/document`
- [ ] Sidepanel: Drag-Drop auf Scratchpad erweitern → PDF wird extrahiert, Chat-Agent entscheidet Vault-Stelle

### Projekte (Säule + analysis.md)
- [ ] Konzept: Projekt = Säule mit `wiki/<saeule>/analysis.md` (lebendes Dokument)
- [ ] Sidepanel: Projekt-Erstellen-UI (Name, Thema, Trigger-Tags)
- [ ] Server: Säule anlegen + analysis.md-Template schreiben
- [ ] Seiten-Bookmarks einem Projekt zuordnen können

---

## Offen — Langfristig (Prio 4 / Sprint 4)

### Analyse-Projekt mit Auto-Update
- [ ] Datenmodell: `typ: analyse` im Frontmatter mit `trigger_tags`, `trigger_playlists`
- [ ] Trigger-Logik: bei Video-Ingest → passende Analyse-Dokumente aktualisieren
- [ ] LLM-Synthese: Analyse-Dokument neu schreiben (Trends, Key-Insights, Empfehlungen, Stats)
- [ ] UI: "Analyse aktualisieren"-Button + Konfigurations-UI

### Launch-Vorbereitung
- [ ] README mit Demo-GIF oder Demo-Video
- [ ] Docker-Image oder vereinfachtes Installer-Script (kein manuelles Python-Setup)
- [ ] Landing Page auf ewtos.com
- [ ] ProductHunt-Launch vorbereiten

### Cloud & Monetarisierung (Sprint 4)
- [ ] REST-API-Auth (API-Key-Middleware)
- [ ] Cloud-Deployment (Railway oder Render)
- [ ] Stripe-Integration für Paid-Tiers

---

## Architektur-Entscheidungen (Referenz)

| Thema | Entscheidung |
|-------|-------------|
| Chat-Modus | Kontextsensitiv — YouTube/Seite/Vault auto-erkannt |
| Projekte | Projekt = Säule + analysis.md, kein neues Datenmodell |
| Briefing | Konfigurierbare Profile (mehrere Kombinationen) |
| Analyse-Update | Manuell via Button, pro Dokument konfigurierbar |
| Web-Search via LLM | Abgelehnt — Extension-Stärke liegt im lokalen Kontext |
| Vault-Ingest | Karpathy-Methode (kein RAG), Claude navigiert wiki/ direkt |

---

## Dateien-Übersicht (geändert / neu diese Session)

```
docs/
  evaluation.html          ← NEU — Strategie-Dokument
  wizard-mockup.html       ← NEU — Setup-Wizard-Prototyp
  status.md                ← NEU — diese Datei

server/
  tools/
    briefing.py            ← NEU
    auto_tagger.py         ← NEU
  main.py                  ← geändert (+6 Routes)
  settings.py              ← geändert (briefing_profiles)
  requirements.txt         ← geändert (httpx, pyyaml)

extension/
  tools/
    url_extractor.js       ← NEU
    auto_brain.js          ← NEU
  background.js            ← geändert (Tool-Handler, Context-Menü)
  sidepanel/
    sidepanel.js           ← geändert (Briefing, URL-Extraktor, Brain-Modal, Auto-Fill, Quick-Actions)
    sidepanel.css          ← geändert (Styles für alle neuen UI-Elemente)
  options/
    options.html           ← geändert (Briefing-Profile-Section)
    options.js             ← geändert (loadBriefingProfiles, renderBriefingProfiles)
```
