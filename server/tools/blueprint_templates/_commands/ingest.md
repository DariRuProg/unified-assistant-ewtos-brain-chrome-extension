---
description: Karpathy-Ingest — eine Quelle aus raw/ in eine kuratierte Wiki-Master-Page überführen.
argument-hint: [pfad-zur-raw-datei oder thema]
---

Überführe die angegebene Quelle in eine kuratierte Wiki-Page (Karpathy-Loop: `raw/` → `wiki/`). Quelle: $ARGUMENTS

**Ohne Argument = alle uningesteten:** Wenn kein Pfad/Thema angegeben ist, ingeste **alle noch nicht ingesteten** Roh-Quellen. Ermittle sie so: für jede Datei unter `raw/**/*.md` prüfen, ob ihr Dateiname-Slug (ohne Datum-Präfix, ohne `.md`) in irgendeiner `wiki/**`-Page als Wikilink/`quelle`/`quellen` referenziert ist — wenn nicht, ist sie uningested. Arbeite die Liste der Reihe nach mit dem Vorgehen unten ab (eine Page pro Quelle), und schreibe **am Ende einen gesammelten `log.md`-Eintrag**. Bei vielen Dateien vorher kurz die Liste zeigen und bestätigen lassen.

Vorgehen (pro Quelle):

1. **Lesen:** Lies die Roh-Quelle unter `raw/` (Transkript, Artikel, Notiz). Falls ein einzelner Pfad gegeben ist, nimm den.
2. **Vorlage wählen:** Für ein Video die Vorlage `templates/video.md`, für einen Creator `templates/creator.md`, für eine Playlist `templates/playlist.md`, sonst `templates/wissensseite.md` bzw. `templates/quelle.md`. **Frontmatter-Keys und Sektionen exakt übernehmen.**
3. **Master-Page anlegen:** unter dem passenden Asset-Ordner, z. B. `wiki/resources/videos/<slug>.md`. Frontmatter füllen (bei Video: titel, quelle_url, video_id, thumbnail_url, kanal, upload_datum, dauer, aufrufe, likes, analyse_datum), Thumbnail im Body rendern, `## Beschreibung` / `## Zusammenfassung` / `## Transkript` befüllen.
4. **Querverlinken:** Creator-Page aktualisieren/anlegen, Seite in den passenden `## Pages`-Hub eintragen.
5. **Log:** Einen Eintrag in `log.md` ergänzen (Datum — was ingested).

Behalte die kebab-case-Dateinamen + ISO-Datum-Konvention bei. Frage nach, bevor du bestehende Pages überschreibst.
