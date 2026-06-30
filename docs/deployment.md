# EwtosBrain — Deployment & Multi-User (F0)

Anleitung, um EwtosBrain als **Firmen-Server** mit Mitarbeiter-Logins zu betreiben — lokal, auf einem Büro-Server oder auf einem VPS (Hetzner/Hostinger).

## Architektur in einem Satz

Ein EwtosBrain-Server hält den Vault + alle Chats; die Mitarbeiter verbinden sich über die Chrome-Extension (zeigt auf die Server-URL) als **Clients**. Es gibt nur **eine** Vault-Kopie auf dem Server — kein Geräte-Sync nötig.

## Auth-Modell (Kurzfassung)

- **Open-Mode (Default):** Solange **kein** User angelegt ist, läuft der Server offen — wie die bisherige lokale Einzelnutzung. Nichts ändert sich.
- **Multi-User:** Sobald ein erster Admin angelegt wird (Bootstrap), ist für **alle** HTTP-Routen und den WebSocket ein gültiges Login-Token Pflicht.
- **Seats:** Optionales `licensing.seat_limit` (Default aus). Pro Gerät zählt ein Seat; bei vollem Limit liefert der Login `402`.

### Ersten Admin anlegen (Bootstrap)

```bash
curl -X POST https://DEIN-SERVER/auth/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<starkes-passwort>"}'
```

Danach Mitarbeiter anlegen (mit Admin-Token aus dem Login):

```bash
curl -X POST https://DEIN-SERVER/auth/users \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"username":"mitarbeiter","password":"<pw>","role":"member"}'
```

> Wichtig: Auf einem öffentlichen Server in `.env` einen festen `EWTOS_SECRET_KEY` setzen (`openssl rand -hex 48`), sonst werden Login-Tokens nach jedem Neustart ungültig.

## Variante A — VPS (Hetzner / Hostinger)

1. Python + venv aufsetzen, `pip install -r server/requirements.txt`.
2. `.env` mit `EWTOS_SECRET_KEY`, `ANTHROPIC_API_KEY` (oder anderem Provider) anlegen.
3. Server an alle Interfaces binden: `EWTOS_HOST=0.0.0.0` (Env).
4. TLS + Domain über **Caddy** (Auto-HTTPS) davorschalten:

```caddy
brain.deine-firma.de {
    reverse_proxy 127.0.0.1:9988
}
```

5. Server als Dienst laufen lassen (systemd / nssm). Extension-Server-URL: `wss://brain.deine-firma.de/ws`.

## Variante B — Büro-Server ohne Port-Freigabe (Cloudflare Tunnel)

Für einen Server im Firmennetz ohne öffentliche IP:

```bash
cloudflared tunnel login
cloudflared tunnel create ewtosbrain
cloudflared tunnel route dns ewtosbrain brain.deine-firma.de
cloudflared tunnel run --url http://127.0.0.1:9988 ewtosbrain
```

Cloudflare stellt HTTPS automatisch bereit; optional „Cloudflare Access" als zusätzliches Identity-Gate davor.

## Extension verbinden

In den Extension-Optionen die Server-URL eintragen (`wss://brain.deine-firma.de/ws`). Ab F0c (Extension-Auth) zeigt die Extension einen Login; bis dahin nur Open-Mode lokal nutzen.

## Sicherheits-Hinweise

- Niemals den Server ohne TLS öffentlich erreichbar machen (Tokens + Vault-Inhalte im Klartext).
- `EWTOS_SECRET_KEY` geheim halten; Rotation invalidiert alle Tokens (Re-Login nötig).
- Vault-Zugriff ist per `members`-Liste pro Vault steuerbar; Vaults ohne Liste sind für alle angemeldeten User sichtbar. Admin sieht/verwaltet alles.
