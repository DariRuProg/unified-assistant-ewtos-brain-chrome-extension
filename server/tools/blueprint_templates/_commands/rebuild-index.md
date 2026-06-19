---
description: Index-Hubs und ## Pages-MOCs nach der flachen Karpathy-Regel neu aufbauen.
---

Baue die Index-Struktur dieses Vaults nach der flachen Regel neu auf (siehe `agents.md`):

1. **Hubs sicherstellen** — `index.md` gibt es nur für:
   - `wiki/` (Root-MOC),
   - jeden Bucket `wiki/<bucket>/`,
   - Themen-Ordner *direkt unter einem Bucket* (`wiki/<bucket>/<thema>/`), wenn sie ≥2 Seiten/Unterordner enthalten.
   Tiefer (≥3 Ebenen unter `wiki/`): kein Hub. Fehlende Hubs anlegen (`typ: index` + `## Pages`), überzählige/zu tiefe leere Hubs zur Löschung vorschlagen (nicht eigenständig löschen).

2. **`## Pages` neu schreiben** — in jedem Hub die Sektion `## Pages` komplett ersetzen durch:
   - zuerst Kind-Hubs: `- [[<rel>/index|<Ordnername>]]`
   - dann eigene Direkt-Seiten: `- [[<rel-ohne-.md>|<Titel>]]` (Titel aus `# Überschrift` bzw. Frontmatter `titel`).
   Alles außerhalb von `## Pages` unverändert lassen. Der `wiki/`-Root-MOC bleibt handkuratiert, wenn er kein `## Pages` hat.

Melde am Ende, welche Hubs angelegt und welche MOCs aktualisiert wurden.
