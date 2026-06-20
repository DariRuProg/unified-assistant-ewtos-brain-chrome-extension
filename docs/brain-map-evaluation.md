# brain-map — Evaluation

**Datum:** 2026-06-19
**Quelle:** https://github.com/zubair-trabzada/brain-map (MIT)
**Entdeckt über:** Skool AI Workshop Lite

---

## Was ist brain-map?

Ein Python-CLI-Tool (zero dependencies, Python stdlib only), das einen Ordner mit Markdown-Dateien als interaktiven Wikilink-Graph auf `localhost:4710` rendert.

**Kern-Workflow:**
```
curl -fsSL https://raw.githubusercontent.com/zubair-trabzada/brain-map/main/run.sh | bash -s -- ~/vault
```

1. `run.sh` lädt `build.py` + `index.html` von GitHub herunter
2. `build.py` crawlt alle `.md`-Dateien, extrahiert `[[wikilinks]]` + `[md-links](file.md)`, baut `graph-data.js`
3. `serve.py` startet `http.server` auf Port 4710, öffnet Browser

**UI-Features:** Zoom, Pan, Search, Wachstums-Animation (Gource-Stil), Node-Sizing nach Verbindungszahl.

---

## AIOS-Erkennung (relevant für EwtosBrain)

brain-map erkennt Vaults mit `CLAUDE.md` + `wiki/`-Ordner als "AI Workshop OS" und wendet spezielle Gruppen-Styles an:

```python
aios = os.path.exists(os.path.join(vault, "CLAUDE.md")) and os.path.isdir(os.path.join(vault, "wiki"))
```

AIOS-Gruppen:

| Gruppe | Farbe | Pfad-Mapping |
|---|---|---|
| `router` | grün | `CLAUDE.md` |
| `core` | grau | `wiki/` |
| `concept` | gelb | `wiki/concepts/` |
| `hub` | lila | `wiki/skills/` (1 Ebene) |
| `skill` | blau | `wiki/skills/` (tiefer) |
| `tool` | pink | `wiki/tools/` |
| `world` | orange | `wiki/worlds/` |
| `note` | grün | `projects/`, `brainstorm/`, lose Root-Dateien |
| `external` | dunkel | alles andere |

→ Jeder EwtosBrain-Karpathy-Vault wird automatisch als AIOS erkannt und bekommt diese strukturierte Gruppen-Darstellung.

---

## Vergleich mit EwtosBrain

| Dimension | brain-map | EwtosBrain |
|---|---|---|
| Zweck | Graph-Visualisierung | AI-Assistent + Vault-Management |
| Zugang | CLI → lokaler Server | Chrome Extension + Python Server |
| AI-Integration | Keine | Zentral (Multi-LLM) |
| Graph-Visualisierung | Ja, vollständig | Nicht vorhanden |
| Vault lesen | Python, direkt | Server-Tools (wiki_reader.py) |
| Vault schreiben | Nein | Ja (mit Permissions) |
| Karpathy-Awareness | Implizit (AIOS-Gruppen) | Explizit (Blueprint + Chat-Agent) |
| Briefing, YouTube, SEO | Nein | Ja |
| Dependencies | Null | Python FastAPI + Chrome Extension |
| Lizenz | MIT | Proprietär (ewtos.com) |

**Fazit:** brain-map löst Visualisierung. EwtosBrain löst AI-Integration + Vault-Management. Sie sind komplementär, nicht konkurrierend.

---

## Integrations-Potenzial

### Option A — brain-map als Graph-View in EwtosBrain einbetten (empfohlen, low effort)

EwtosBrain könnte `build.py` lokal ausführen und den Graph im Browser öffnen:

```python
# server: neuer Endpoint /vaults/{vault_id}/graph
subprocess.Popen(["python3", "build.py", "--vault", vault_path, "--out", out_dir])
subprocess.Popen(["python3", out_dir + "/serve.py"])
# → öffnet localhost:4710 im Browser
```

Extension-UI: Button „Graph öffnen" im Vault-Explorer → `POST /vaults/{id}/graph`.

Vorteile: MIT-lizenziert, keine eigene Implementierung, sofort nutzbar.

### Option B — Wikilink-Parser übernehmen

Der Regex aus brain-map ist erprobt und deckt Edge-Cases ab:

```python
WIKILINK = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")
MDLINK   = re.compile(r"\]\(([^)#\s]+\.md)\)")
```

Könnte in `server/tools/wiki_reader.py` für Link-Extraktion verwendet werden (aktuell dort prüfen ob bereits vorhanden).

### Option C — AIOS-Gruppen-Logik als Vault-Metadaten-Schicht

Die Gruppen-Zuordnung (router/core/concept/skill/tool) spiegelt die Karpathy-Blueprint-Struktur wider. Könnte als Metadaten-Annotation in `vault_audit.py` oder zukünftigem Graph-Feature genutzt werden.

---

## Empfehlung

**Kurzfristig:** Kein Handlungsbedarf. brain-map ist ein nettes Tool, das Nutzer eigenständig auf ihren Vault loslassen können.

**Mittelfristig:** Option A (Graph-View-Button) als Low-Effort-Feature für EwtosBrain v0.2 evaluieren — gibt dem Vault-Explorer eine visuelle Dimension ohne eigene Implementierung.

**Nicht empfohlen:** brain-map als Ersatz für eigene Wikilink-Logik nutzen (zu viel Kopplung an externe Abhängigkeit für Kernfunktionalität).

---

## Entdeckungskontext

Das Tool wurde über den Skool AI Workshop Lite entdeckt (Kurs „AI Second Brain with Claude"). Der Kurs bewirbt brain-map als kostenlosen Einstieg, verkauft „Brain Studio" (3D-Modus, Note-Previews, Pfadfinder) als Paid-Tier. EwtosBrain bietet Note-Previews und Pfad-Navigation bereits — brain-map ist aus Produkt-Sicht kein Wettbewerber.
