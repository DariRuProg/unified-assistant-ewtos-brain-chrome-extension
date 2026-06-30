# EwtosBrain auf Hetzner mit Coolify deployen

Schritt-für-Schritt, um eine EwtosBrain-Server-Instanz (z.B. die öffentliche **Demo**)
auf deinem Hetzner-Server über **Coolify** live zu bringen. Coolify übernimmt Build,
Reverse-Proxy und automatisches HTTPS — das ist deine „Ein-Klick"-Lösung.

> **Vercel geht nicht.** Vercel ist serverless (kurze Functions, kein dauerhafter
> Prozess, kein WebSocket, flüchtiges Dateisystem). EwtosBrain ist ein dauerlaufender,
> zustandsbehafteter Server. Vercel taugt höchstens für die spätere Landingpage.

## Voraussetzungen
- Coolify läuft bereits auf deinem Hetzner-Server (hast du).
- Das Repo ist in Coolify erreichbar (GitHub/GitLab verbunden, oder öffentliche Repo-URL).
- Eine (Sub-)Domain, z.B. `demo.ewtos.com`, mit **A-Record auf die Server-IP**.

## 1. Anwendung anlegen
1. Coolify → **+ New** → **Application** → dein Repo wählen, Branch `master`.
2. **Build Pack: Dockerfile** (Coolify findet den `Dockerfile` im Repo-Root automatisch).
3. **Port** (Ports Exposes): `9988`.

## 2. Environment-Variablen setzen
Unter **Environment Variables** eintragen:

| Variable | Wert | Zweck |
|----------|------|-------|
| `EWTOS_DEMO_MODE` | `1` | Demo: Beispiel-Vault + read-only (für eine echte Instanz weglassen) |
| `EWTOS_SECRET_KEY` | `<openssl rand -hex 48>` | stabiler Login-Token-Schlüssel |
| `ANTHROPIC_API_KEY` | `sk-ant-…` | damit der Demo-Chat antworten kann (oder `OPENAI_API_KEY` etc.) |
| `EWTOS_LLM_PROVIDER` | `anthropic` | **wichtig für Demo:** Provider festnageln (im Demo-Modus ist `/settings` gesperrt) |
| `EWTOS_LLM_MODEL` | `claude-haiku-4-5-20251001` | **günstiges** Modell für die Demo (sonst greift der teure Default `claude-opus-4-7`) |

`EWTOS_HOST=0.0.0.0` und `EWTOS_PORT=9988` stecken schon im Dockerfile.

> Kostenkontrolle: Da im Demo-Modus `/settings` schreibgeschützt ist, lässt sich das
> Modell nur über `EWTOS_LLM_PROVIDER` / `EWTOS_LLM_MODEL` setzen — unbedingt ein
> günstiges Modell wählen.

## 3. Persistentes Datenverzeichnis (empfohlen)
**Storages** → Persistent Storage hinzufügen, Mount-Pfad **`/data`**. Dorthin schreibt
der Server `settings.json`, Chats und Logs (`XDG_DATA_HOME=/data` ist gesetzt → Daten
unter `/data/EwtosBrain`). Für die reine Demo optional (sie registriert den Beispiel-
Vault bei jedem Start neu), für eine echte Instanz Pflicht.

## 4. Domain + HTTPS
**Domains** → `https://demo.ewtos.com` eintragen. Coolify holt automatisch ein
Let's-Encrypt-Zertifikat. WebSockets laufen durch den Coolify-Proxy (Traefik) ohne
Zusatzkonfiguration.

## 5. Health-Check (optional)
**Health Checks** → Pfad `/health`, Port `9988`. Liefert `{"ok": true, ...}`.

## 6. Deploy + Test
1. **Deploy** klicken. Coolify baut das Image und startet den Container.
2. `https://demo.ewtos.com/health` öffnen → muss `{"ok": true}` zeigen.
3. Demo-Vault prüfen: `https://demo.ewtos.com/vaults` → enthält „Demo-Vault".
4. In der Extension (Optionen) Server-URL auf `wss://demo.ewtos.com/ws` setzen und einen
   Vault-Chat starten — der Demo-Chat liest den Beispiel-Vault und antwortet.

## Wichtig: Kosten-/Missbrauchsschutz für eine öffentliche Demo
Der Demo-Chat nutzt **deinen** LLM-Key (BYOK) — eine öffentliche Demo kann Token kosten,
wenn sie jemand spammt. Empfehlungen:
- **Günstiges Modell** wählen (z.B. ein Haiku-/Mini-Modell) und niedrige `max_user_turns`.
- **Cloudflare davor** (Proxy + Rate-Limiting/Bot-Schutz) oder ein einfaches Per-IP-Limit
  (kann ich als kleinen Folgeschritt im Server ergänzen).
- Notfalls den LLM-Key rotieren/entfernen. Schreibzugriffe sind im Demo-Modus ohnehin hart
  gesperrt (read-only), es geht nur um Token-Kosten.

## Eine ECHTE (nicht-Demo) Instanz betreiben
- `EWTOS_DEMO_MODE` weglassen.
- Den echten Vault als zweites **Persistent Storage** mounten (z.B. `/vaults`) und in den
  Server-Settings einen Vault mit diesem Pfad anlegen.
- Multi-User: einmalig Admin anlegen (`POST /auth/bootstrap`, siehe
  [anleitung-und-lizenzierung.md](anleitung-und-lizenzierung.md)), dann Mitarbeiter +
  Vault-Mitglieder.

## Hinweis (Browser-Tools im Container)
Page-Scraping per Playwright ist im schlanken Image **nicht** aktiv (Browser nicht
installiert) — für die Demo und den Vault-Chat irrelevant. Falls eine Server-Instanz
serverseitiges Scraping braucht, muss das Image um Playwright-Browser + den Pfad
`extension/tools/scrape_dom.js` erweitert werden (eigener Schritt).
