# Datenschutzerklärung — Ewtos Office-Brain

> Stand: 2026-07-01. Englische Fassung unten.

## 1. Verantwortlicher
Dario / ewtos.com — info@ewtos.com. (Vollständige Anschrift siehe [Impressum](https://ewtos.com/impressum).)

## 2. Architektur-Grundsatz (für Datenschutz entscheidend)
Ewtos Office-Brain besteht aus (a) einer Chrome-Extension und (b) einem **Backend, das du selbst betreibst** (lokal auf deinem Rechner oder auf einem Server deiner Wahl). **Inhaltsdaten (Vault, Chats, erfasste Web-Inhalte) verlassen deine Infrastruktur nicht in Richtung ewtos.com.** Der Anbieter (ewtos.com) erhält diese Inhalte nicht.

## 3. Welche Daten verarbeitet die Extension?
- **Lokale Einstellungen** (im Browser-Storage): Server-URL, UI-Präferenzen, ein **Login-Token** (bei Multi-User-Servern) und eine zufällige Geräte-Kennung (`instance_token`). Bleiben auf deinem Gerät.
- **Web-Inhalte (nur nutzer-ausgelöst):** Wenn du ein Page-Tool startest (z.B. Seite clippen, SEO-Check), liest die Extension Inhalte der aktiven Seite und sendet sie an **dein** Backend. Keine Übertragung an ewtos.com.
- **Kein Tracking, keine Werbung, kein Verkauf von Daten.**

## 4. Welche Daten verarbeitet dein Backend?
Dein selbst betriebenes Backend verarbeitet deinen Vault-Inhalt, Chats, Notizen und leitet Chat-Anfragen an den von dir konfigurierten **LLM-Anbieter (BYOK)** weiter (z.B. Anthropic, OpenAI, Mistral; oder Ollama vollständig lokal). Für diese Übermittlung gelten die Datenschutzbestimmungen des jeweiligen Anbieters. Bei Ollama (lokal) verlassen keine Daten dein System.

## 5. Login & Logs (nur bei Multi-User-/Server-Betrieb)
- **Login:** Passwörter werden ausschließlich als bcrypt-Hash gespeichert; Sitzungen laufen über signierte Tokens (JWT). 
- **Server-Logs:** Das Backend kann technische Logs (Zeitstempel, Fehler) schreiben. Inhalte von Chats werden nicht für Trainingszwecke verwendet. Umfang/Aufbewahrung bestimmt der jeweilige Betreiber des Backends.

## 6. Chrome-Web-Store-Datenkategorien
Im Sinne der Store-Offenlegung werden verarbeitet: **Authentifizierungsinformationen** (Login-Token, lokal) und **Website-Inhalte** (nur nutzer-ausgelöst, an das eigene Backend). Es findet **keine** Weitergabe an Dritte zu Werbe-/Tracking-Zwecken statt; **kein** Verkauf von Daten.

## 7. Demo-Instanz
Falls du die öffentliche Demo nutzt: Sie läuft read-only mit einem Beispiel-Vault. Eingaben können zur Missbrauchsvermeidung temporär protokolliert werden; gib dort keine sensiblen Daten ein.

## 8. Deine Rechte (DSGVO)
Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit, Widerspruch. Da Inhaltsdaten auf deiner eigenen Infrastruktur liegen, kontrollierst du diese unmittelbar. Anfragen an: info@ewtos.com.

## 9. Änderungen
Diese Erklärung kann angepasst werden; die jeweils aktuelle Fassung ist unter der genannten URL abrufbar.

---

# Privacy Policy — Ewtos Office-Brain (EN)

> Last updated: 2026-07-01.

**Controller:** Dario / ewtos.com — info@ewtos.com (see [Impressum](https://ewtos.com/impressum)).

**Architecture principle:** Ewtos Office-Brain is a Chrome extension plus a **backend you run yourself** (local or your own server). Content data (vault, chats, clipped web content) does **not** leave your infrastructure toward ewtos.com; the provider does not receive it.

**Extension data:** local settings (server URL, UI prefs, a login token for multi-user servers, a random device id) stored in browser storage; web page content only on user-triggered actions, sent to **your** backend. No tracking, ads, or data sales.

**Backend data:** processes your vault/chat/notes and forwards chat requests to your configured **BYOK** LLM provider (Anthropic/OpenAI/Mistral, or fully local Ollama). The provider's privacy terms apply to that transfer.

**Auth & logs (multi-user only):** passwords stored as bcrypt hashes; sessions via signed JWT; technical logs only; chat content not used for training.

**Chrome Web Store categories:** Authentication information (local token) and Website content (user-triggered, to your own backend). No third-party sharing for ads/tracking; no data sale.

**Your GDPR rights:** access, rectification, erasure, restriction, portability, objection — exercised directly since content lives on your own infrastructure. Contact: info@ewtos.com.
