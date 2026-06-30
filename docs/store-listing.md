# Chrome Web Store — Listing & Submission-Checkliste (EwtosBrain)

Alles, was für die Store-Einreichung der Extension nötig ist. Inhalte hier sind Vorlagen — vor Einreichung final prüfen.

## Stammdaten
- **Developer-Account:** einmalig 5 $ (Google). Ein Account, beliebig viele Extensions.
- **Kategorie:** „Productivity" (alternativ „Developer Tools").
- **Sprache:** Deutsch (primär) + Englisch.

## Single-Purpose-Beschreibung (Pflicht)
> EwtosBrain ist ein Produktivitäts-Assistent, der Web-Inhalte erfasst und mit einer selbst betriebenen Wissens-Datenbank (Obsidian-Vault) per KI nutzbar macht. Alle Funktionen dienen diesem einen Zweck: Wissen erfassen, organisieren und befragen.

## Titel & Kurzbeschreibung
- **Titel (≤ ~45 Zeichen, Keyword zuerst):** „EwtosBrain — Obsidian KI-Assistent (self-hosted)"
- **Kurzbeschreibung (≤ 132 Zeichen):** „Chatte mit deinem Obsidian-Vault, erfasse Web-Inhalte, nutze Browser-Tools — self-hosted, BYOK, DSGVO-freundlich."

## Detailbeschreibung (erster Satz keyword- & nutzenstark)
> Sprich direkt aus dem Browser mit deinem Obsidian-Vault: EwtosBrain verbindet eine Chrome-Extension mit deinem eigenen, lokal oder auf deinem Server laufenden EwtosBrain-Backend. Deine Notizen, dein LLM (BYOK: Claude, OpenAI, Mistral, Ollama lokal), deine Kontrolle — keine Daten in fremder Cloud.
>
> **Funktionen:** Vault-Chat (Karpathy-Methode, kein Vektor-RAG), Web-Seiten als Markdown clippen, SEO-Check, Bild-Analyse, Screenshot+Annotation, Farb-Pipette, Link-Extraktor, YouTube-Transkripte, Notiz-/Todo-/Bookmark-Erfassung.
>
> **Wichtig — Companion-Server:** EwtosBrain braucht das kostenlose EwtosBrain-Backend (Python). Installiere es lokal (Setup-Download auf ewtos.com) oder verbinde dich mit einem Server deiner Firma. Ohne Server zeigt die Extension eine Setup-Anleitung. Zum risikolosen Antesten gibt es eine öffentliche Demo-Instanz.
>
> **Privacy-first:** Self-hosted, BYOK, kein Tracking, EU/DSGVO-orientiert.

## Permission-Begründungen (Pflichtfeld je Permission)
| Permission | Begründung (für das Justification-Feld) |
|------------|------------------------------------------|
| `storage` | Speichert lokale Einstellungen (Server-URL, Login-Token, UI-Präferenzen) im Browser. |
| `scripting` | Führt nach Nutzer-Auslösung Lese-Skripte auf der aktiven Seite aus (Seite als Markdown clippen, SEO-/Bild-Analyse, Farb-Pipette, Link-Extraktor). Kein Remote-Code. |
| `tabs` | Liest URL/Titel des aktiven Tabs für Clipping- und Kontextmenü-Funktionen. |
| `sidePanel` | Stellt die Haupt-UI (Chat + Tools) im Browser-Seitenpanel bereit. |
| `contextMenus` | Rechtsklick-Aktionen: URL merken, Auswahl als Notiz, zu Playlist hinzufügen. |
| `downloads` | Speichert vom Nutzer ausgelöste Exporte/Bilder. |
| `alarms` | Hält die WebSocket-Verbindung zum eigenen Server am Leben (MV3-Keepalive). |
| `clipboardWrite` | Kopiert erfasste Inhalte (z.B. Multi-Tab-URLs) in die Zwischenablage. |
| **Host (Pflicht)** `http(s)://localhost`, `http(s)://127.0.0.1` | Verbindung (WebSocket + REST) zum lokal laufenden EwtosBrain-Backend. |
| **Host (optional)** `<all_urls>`, `file:///*` | Wird **nur bei Bedarf zur Laufzeit** angefragt: für Page-Tools auf beliebigen Webseiten und für die Verbindung zu einem entfernten Firmen-/Cloud-Server. Nicht bei Installation verlangt. |

> Hinweis: Die breite `<all_urls>`-Berechtigung ist bewusst **optional** (nicht bei Installation), um die Datennutzung transparent und minimal zu halten — der häufigste Ablehnungsgrund wird so vermieden.

## Datennutzungs-Offenlegung (Privacy-Practices-Tab)
Exakt mit der Privacy Policy abgleichen ([legal/privacy-policy.md](legal/privacy-policy.md)):
- **Erfasst:** Authentifizierungsinformationen (Login-Token, lokal), Website-Inhalte (nur nutzer-ausgelöst, an das EIGENE Backend), Nutzeraktivität in der Extension.
- **Nicht:** Verkauf von Daten, kein Tracking/Werbung, keine Nutzung für Bonität/Kreditzwecke.
- **Weitergabe:** Daten gehen nur an das vom Nutzer konfigurierte EwtosBrain-Backend (lokal/eigener Server) und an den vom Nutzer gewählten LLM-Anbieter (BYOK). EwtosBrain/ewtos.com erhält keine Inhalte.

## Assets
- [ ] Icon 128×128 (vorhanden: `extension/images/icon-128.png`).
- [ ] 3–5 Screenshots 1280×800: (1) Vault-Chat, (2) Web-Clipping/Page-Tools, (3) Vault-Explorer, (4) Setup/Onboarding, (5) Optionen.
- [ ] Optional: Promo-Kachel.
- [ ] Privacy-Policy-URL öffentlich (z.B. `ewtos.com/ewtosbrain/privacy`).

## Vor dem Submit
- [ ] `host_permissions` auf localhost reduziert, `<all_urls>` optional (erledigt im Manifest).
- [ ] Offline-Zustand zeigt saubere Setup-Anleitung (G1.2).
- [ ] Privacy Policy + Impressum online.
- [ ] Code unobfuskiert, kein Remote-Code-Load.
- [ ] Manuelle Funktionsprüfung aller Page-Tools nach Permission-Grant.

## Zweiter Kanal (später)
Microsoft Edge Add-ons: gleiches MV3-Paket, ~5–10 % zusätzliche Reichweite. Nach stabilem Chrome-Launch.
