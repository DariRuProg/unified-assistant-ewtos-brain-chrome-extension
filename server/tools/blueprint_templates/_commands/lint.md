---
description: Vault-Hygiene — Orphans, kaputte Wikilinks, fehlende Hubs und veraltete MOCs finden und beheben.
---

Führe einen Hygiene-Durchlauf über diesen Obsidian-Vault aus. Halte dich strikt an die Vault-Konventionen aus `agents.md` / `CLAUDE.md` (flache Index-Regel, `## Pages`, `templates/`).

Arbeite diese Schritte ab und melde am Ende eine kurze Zusammenfassung (gefunden / behoben / offen):

1. **Fehlende Hubs:** Prüfe `wiki/`. Ein `index.md`-Hub gehört nur in: `wiki/` selbst, jeden Bucket (`wiki/<bucket>/`) und Themen-Ordner *eine Ebene unter einem Bucket*, die ≥2 Seiten/Unterordner sammeln. Fehlt ein nötiger Hub, lege ihn an (Frontmatter `typ: index` + `## Pages`). Tiefer als 2 Ebenen unter `wiki/` keine Hubs.
2. **MOC-Pflege (`## Pages`):** Aktualisiere in jedem Hub die `## Pages`-Sektion: liste die Kind-Hubs (`- [[…/index|Name]]`) und eigenen Seiten (`- [[rel|Titel]]`) statisch. Verändere nichts außerhalb von `## Pages`.
3. **Orphans:** Seiten, die in keinem Hub verlinkt sind → in den passenden `## Pages` ergänzen.
4. **Kaputte Wikilinks:** `[[...]]` ohne Zielnotiz → korrigieren oder melden.
5. **Frontmatter:** Seiten in `wiki/` brauchen mindestens `typ`, `titel`, `status`, `zuletzt`. Fehlt etwas, ergänzen (nutze die passende Vorlage aus `templates/`).

Frage vor dem Löschen/Verschieben von Dateien immer nach. Ergänzungen (Hubs, Links, Frontmatter) darfst du direkt vornehmen.
