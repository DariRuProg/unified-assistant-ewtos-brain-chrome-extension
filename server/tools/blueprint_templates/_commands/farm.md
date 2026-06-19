---
description: Neue Quelle/Seed anlegen — Roh-Eintrag in raw/ vorbereiten für späteres Ingest.
argument-hint: [url oder titel der quelle]
---

Lege eine neue Quelle für den Farming-Loop an. Eingabe: $ARGUMENTS

Vorgehen:

1. **Einordnen:** Bestimme den Typ (YouTube-Video, Playlist, Artikel, eigene Notiz). Bei einer URL die Eckdaten erfassen (Titel, Kanal/Autor, ggf. Video-ID).
2. **Roh-Datei anlegen:** unter dem passenden `raw/`-Unterordner (`raw/youtube/`, `raw/artikel/`, `raw/eigene-notizen/` …) als `<slug>.md` mit Frontmatter (`quelle_url`, `typ`, `zuletzt`) und Platz für Transkript/Inhalt. Noch **nicht** ins Wiki kuratieren — das macht `/ingest`.
3. **Notieren:** Falls ein Transkript/Inhalt nachgezogen werden muss, vermerke das in der Roh-Datei.
4. Weise darauf hin, dass die Quelle anschließend mit `/ingest <pfad>` ins Wiki überführt wird.

Halte dich an kebab-case-Dateinamen + ISO-Datum.
