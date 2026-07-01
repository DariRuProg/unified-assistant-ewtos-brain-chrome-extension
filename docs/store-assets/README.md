# Store-Screenshots — Ewtos Office-Brain

Die 5 Chrome-Web-Store-Screenshots (1280×800, Querformat). Aufgenommen aus der **Live-Demo**
(getreue Web-Kopie der App) per Browser-Automation — kein Bastel-Frame nötig, die Demo ist
bereits vollflächiges Querformat.

## Dateien (`out/`)

| Datei | Ansicht |
|-------|---------|
| `00-intro.png` | Intro/Welcome-Overlay („Willkommen bei Ewtos Office-Brain") |
| `01-main.png` | Split-View: Browser-Tab links + volles Tool-Sidepanel rechts |
| `02-explorer.png` | Vault-Explorer mit gerendertem Markdown (Karpathy-Methode) |
| `03-chat.png` | Vault-Chat als Bottom-Dock (Dokument oben, Chat unten, BYOK) |
| `04-scrape.png` | Web-Scrape → Markdown + Chat über den Seiteninhalt |
| `05-video.png` | YouTube-Transcript-Tool |

Empfehlung fürs Store-Listing (max. 5): `01`, `02`, `03`, `04` + `00` oder `05`.

## Neu aufnehmen

```bash
npm i -g agent-browser
export PATH="$PATH:$APPDATA/npm"          # Windows/Git-Bash
agent-browser open "https://q40scswwkcwggwco8okcco04.coolify.utilflow.de/demo"
agent-browser set viewport 1280 800
agent-browser snapshot -i -c              # Refs finden ("Demo starten →", Tool-Buttons)
agent-browser click @eN                   # Ansicht wählen
agent-browser screenshot out/01-main.png  # 1280×800 exakt
agent-browser close
```

## Hinweis (Store-Review)

Die Demo weist sich selbst als „im Browser nachgestellt" aus. Für Landing 100% ok; fürs
Chrome-Store-Review vertretbar. Ein echtes Extension-Bild (laufende Extension im Browser)
wäre minimal sauberer — bei Bedarf zusätzlich aufnehmen und hier ablegen.
