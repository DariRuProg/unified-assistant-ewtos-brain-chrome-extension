# Übergabe — ewtos-Website & Store-Screenshots (Stand 2026-07-01)

Kontext-Handoff für einen frischen Chat. Vollständiger Fahrplan: `docs/release-gtm-plan.md`.

## Struktur (neu)

Die Website liegt jetzt gebündelt unter **`site/`** — eine ewtos-Markenwebsite mit **einem** geteilten
Designsystem (geklont + rebrandet aus `dariru-website-v2`, Space-/Nova-Hero). ewtos und dariru sind
bewusst **getrennte Marken**; hier lebt nur die **ewtos**-Marke.

```
site/
  index.html            Homepage (ewtos-Marke, schlank): Hero mit animiertem Vault-Chat,
                        "Was ich baue", Office-Brain-Showcase, Über-mich, Kontakt
  datenschutz.html      Homepage-Datenschutz (statisch, kein Tracking)
  office-brain/
    index.html          Produkt-Landing (Features, "Ersetzt 10+ Extensions", Steps, USP, Galerie, Download)
    datenschutz.html    Produkt-Datenschutz (self-hosted/BYOK-Datenpraxis)
  css/styles.css        geteiltes Designsystem
  js/                   theme-init, mode-toggle (Hell/Dunkel), nova (Hero), sky (Section-Sternenhimmel), chat (Hero-Vault-Chat)
  images/               dario-Foto, favicon, Office-Brain-Screenshots
  llms.txt
```

Deploy-Ziele: `site/index.html` → `ewtos.com/`, `site/office-brain/` → `ewtos.com/office-brain/`.
Theme: `data-theme="studio-nova"` (fix) + `data-mode` (Hell/Dunkel-Toggle, localStorage `ewtos-appearance`).
Band-System: `band-space` = immer dunkel (Hero), `band-light` = immer hell, `band-dark` = dunkel im
Dunkel-Modus / hell im Hell-Modus.

## Erledigt (diese Session)

- dariru-Seite als Design-Basis geklont, **vollständig auf ewtos rebrandet** (kein dariru-Rest im `site/`).
- Homepage schlank neu aufgebaut; Agentur-Ballast (Preispakete, Lead-Wizard, FAQ, Ablauf) entfernt.
- Produkt-Landing aufs geteilte System migriert (inkl. „Ersetzt viele Extensions"-Section + „10+"-Stat).
- Hero mit vollem Space-Effekt (Grid + tanzende Sonnen + Warp + Maus-Parallax); Section-Sternenhimmel
  in dunklen Bändern; Hell/Dunkel-Toggle. **Beide Seiten in Dark & Light per Full-Page-Screenshots geprüft.**
- Alter `landing/`-Ordner entfernt.

## Owner-To-dos vor dem Deploy (stehen als TODO-Kommentare im HTML)

1. `demo.ewtos.com` DNS/Deploy auf die Coolify-Instanz richten (Landing/Store verlinken darauf).
2. `.exe` unter `ewtos.com/office-brain/EwtosBrain-Setup.exe` ablegen (oder `href` in
   `site/office-brain/index.html` anpassen).
3. Nach Store-Freigabe die Chrome-Web-Store-URL im „Bald verfügbar"-Button eintragen.
4. `site/`-Ordner nach `ewtos.com/` hochladen (Homepage im Root, `office-brain/` als Unterordner).
5. Optional/später: englische Version als separate HTML-Dateien (`site/en/`, `site/office-brain/en/`) +
   Sprachumschalter + `hreflang` (Stubs liegen im `<head>` der Landing).

## Store-Screenshots

6× **1280×800** in `docs/store-assets/out/` (`00-intro`, `01-main`, `02-explorer`, `03-chat`,
`04-scrape`, `05-video`) — aus der Live-Demo gezogen. Dieselben Bilder liegen als
`site/images/screenshot-*.png` für die Website.

## Nützlich

- Lokal ansehen: `site/` als Root serven (`py -m http.server`), dann `index.html` bzw.
  `office-brain/index.html`. (Direktes Datei-Öffnen scheitert an den Modul-/Pfad-Referenzen — Server nutzen.)
- Chrome: `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`.
- Nichts committet — alles im Working Tree.
