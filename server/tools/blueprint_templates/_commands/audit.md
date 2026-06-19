---
description: Read-only Health-Report des Vaults — Orphans, kaputte Links, fehlende Hubs, Frontmatter-Lücken. Ändert nichts.
---

Erstelle einen **read-only** Gesundheits-Bericht für diesen Vault. **Nimm keine Änderungen vor** — nur prüfen und auflisten.

Prüfe und gruppiere die Funde nach Schweregrad (🔴 Fehler / 🟡 Warnung / 🔵 Info):

1. **Fehlende Hubs** — Buckets oder Sammel-Themen (≥2 Einträge, 1 Ebene unter Bucket) ohne `index.md`.
2. **Veraltete MOCs** — `## Pages` eines Hubs, das nicht mehr zu den tatsächlichen Kind-Hubs/Seiten passt.
3. **Orphans** — `wiki/`-Seiten, die in keinem `## Pages` verlinkt sind.
4. **Kaputte Wikilinks** — `[[...]]` ohne Zielnotiz.
5. **Frontmatter-Lücken** — `wiki/`-Seiten ohne `typ`/`titel`/`status`/`zuletzt`.
6. **(Farming)** Falls `raw/` existiert: Quellen in `raw/`, die in keiner Wiki-Page referenziert sind (noch nicht ingested).

Gib eine kompakte Liste mit Pfaden + je einem Satz Empfehlung aus. Zum Beheben: `/lint` oder `/rebuild-index`.
