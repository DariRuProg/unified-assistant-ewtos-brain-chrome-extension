# EwtosBrain — Komplett-Anleitung: Nutzung, Multi-User & Lizenzierung

Stand nach F0 (Auth-Fundament). Diese Doku erklärt: (1) lokale Nutzung wie bisher, (2) Firmen-Server mit Mitarbeiter-Logins aktivieren, (3) wie Lizenzierung gedacht ist und (4) wie ein Lemon-Squeezy-Account hineinpasst.

---

## 1. Lokale Nutzung (Open-Mode) — unverändert

Solange **kein** Benutzer angelegt ist, läuft EwtosBrain wie immer: lokal, ohne Login.

1. `start-server.bat` starten (legt venv an, installiert Requirements, startet Server auf `127.0.0.1:9988`).
2. Extension in Chrome laden (`chrome://extensions` → Entwicklermodus → entpackt laden → `extension/`).
3. Server-URL in den Extension-Optionen steht auf `ws://localhost:9988/ws`.

Es ändert sich nichts — Auth ist **opt-in** und erst aktiv, sobald der erste Admin angelegt wird.

---

## 2. Firmen-Server mit Mitarbeiter-Logins aktivieren

### 2.1 Server online stellen
Siehe **[deployment.md](deployment.md)**: VPS (Hetzner/Hostinger) hinter Caddy mit Auto-TLS, oder Büro-Server via Cloudflare Tunnel. Wichtig: in `server/.env` einen festen `EWTOS_SECRET_KEY` setzen (`openssl rand -hex 48`), sonst werden Logins nach jedem Neustart ungültig.

### 2.2 Ersten Admin anlegen (Bootstrap)
Einmalig, solange noch kein User existiert:
```bash
curl -X POST https://brain.deine-firma.de/auth/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<starkes-passwort>"}'
```
Antwort enthält ein `token` (Admin). **Ab jetzt ist für alles ein Login Pflicht.**

### 2.3 Mitarbeiter anlegen
```bash
curl -X POST https://brain.deine-firma.de/auth/users \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"username":"max","password":"<pw>","role":"member"}'
```
Rollen: `admin` (sieht/verwaltet alles) oder `member`.

### 2.4 Vault-Zugriff je Mitarbeiter steuern
Jeder Vault hat eine optionale `members`-Liste. Ohne Liste = für alle angemeldeten User sichtbar. Mit Liste = nur für die genannten User (Admin immer).
```bash
# User-IDs holen:
curl https://brain.deine-firma.de/auth/users -H "Authorization: Bearer <ADMIN_TOKEN>"
# Mitglieder eines Vaults setzen:
curl -X POST https://brain.deine-firma.de/vaults/<VAULT_ID> \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{"members":["<user_id_1>","<user_id_2>"]}'
```
> Hinweis: Eine grafische Verwaltung (User & Mitglieder) in den Extension-Optionen ist als nächster kleiner Schritt geplant; aktuell läuft die Verwaltung über diese API-Aufrufe.

### 2.5 Wie sich ein Mitarbeiter anmeldet
1. Extension installieren, in den Optionen die **Server-URL** der Firma eintragen (`wss://brain.deine-firma.de/ws`).
2. Sidepanel öffnen → es erscheint automatisch ein **Login-Fenster** (weil der Server Auth verlangt).
3. Benutzername + Passwort → fertig. Das Login-Token wird lokal gespeichert; der WebSocket verbindet sich automatisch mit Token neu.

Jedes Gerät bekommt eine eindeutige `instance_token`-UUID (zählt als ein „Seat", siehe Lizenzierung).

---

## 3. Lizenzierung — wie es funktioniert

### 3.1 Das Modell: Seats statt Hardware
Lizenzierung hängt an **Logins/Geräten (Seats)**, nicht an Hardware-Fingerprints (die sind fälschbar und nerven). Jede Extension-Installation hat eine `instance_token`-UUID; der Server zählt aktive Seats.

- `licensing.seat_limit = null` → unbegrenzt (Default, **aktuell aktiv** — nichts ist limitiert).
- `licensing.seat_limit = 1` → 1 Gerät frei; ein zweites Gerät bekommt beim Login `402 Payment Required` (= „Lizenz erforderlich").

Die Felder + die Seat-Zählung sind **schon eingebaut** (F0), aber standardmäßig **aus**. Scharf geschaltet wird erst, wenn du verkaufst.

### 3.2 Die ehrliche Durchsetzungs-Realität
- **Du hostest den Server (EwtosBrain Cloud / Managed):** Lizenz ist **hart** durchsetzbar — der Server ist der Gatekeeper, kein Kunde kann ihn patchen.
- **Kunde hostet selbst (Python-Quellcode sichtbar):** Durchsetzung ist **weich** — technisch versierte Kunden könnten den Check entfernen. Wirksam gegen normale Firmen (die zahlen für Legitimität, Updates, Support), nicht gegen die <5 % Hacker. Realistisch erzwingbar nur über einen **zentralen Lizenz-Check** gegen ewtos.com bzw. Lemon Squeezy + AGB.

→ Empfehlung: **Managed-Hosting** anbieten (löst Durchsetzung automatisch) und für Self-Hoster den Online-Lizenz-Check (unten).

### 3.3 Was noch fehlt (Stufe F-LIC, bewusst noch nicht gebaut)
Eine kleine **zentrale Lizenz-Logik**, die beim Login prüft, ob ein gültiger Kauf vorliegt, und das `seat_limit` daraus setzt. Genau hier kommt Lemon Squeezy ins Spiel.

---

## 4. Lemon Squeezy — ja, das hilft (und passt sehr gut)

Dein Lemon-Squeezy-Account deckt **drei** Dinge ab, die wir sonst selbst bauen müssten:

1. **Zahlung + Abos:** gehosteter Checkout, monatlich/jährlich, Karten/PayPal.
2. **Merchant of Record:** Lemon Squeezy ist Verkäufer von Rechts wegen und **kümmert sich um die EU-Umsatzsteuer/OSS + Rechnungen** — für dich als Solo-Dev aus DE ein großer Vorteil (keine USt-Bürokratie pro Land).
3. **License-Keys-API:** Lemon Squeezy kann pro Kauf **Lizenzschlüssel** ausstellen und verwalten — inklusive **Activation Limit** und **Instances**.

### Der entscheidende Glücksfall: das Aktivierungs-Modell passt 1:1 auf unsere Seats
Lemon Squeezys Lizenz-API kennt:
- **`activation_limit`** = wie viele Geräte einen Key nutzen dürfen → **das ist genau unser `seat_limit`**.
- **`activate` / `validate` / `deactivate`** mit einem **Instance-Namen** → **das ist genau unser `instance_token`**.

Das heißt, die geplante F-LIC-Stufe wird **dünn**: Beim Login ruft der EwtosBrain-Server Lemon Squeezys `licenses/activate` mit dem `instance_token` auf. Akzeptiert Lemon Squeezy → Seat frei. Limit erreicht → `402`. Kein eigener Lizenz-Server, keine eigene Seat-Buchhaltung nötig.

```
Kunde kauft (Lemon Squeezy Checkout)
        │  Webhook order_created / license_key created
        ▼
Kunde trägt seinen License-Key in EwtosBrain ein (Settings)
        │
Login eines Geräts ──► EwtosBrain-Server ──► Lemon Squeezy  POST /v1/licenses/activate
                                              { license_key, instance_name = instance_token }
        ◄── ok (Seat frei)  |  limit erreicht → 402 (Lizenz/Upgrade nötig)
```

### Was du JETZT schon in Lemon Squeezy vorbereiten kannst
1. **Produkte/Varianten als Tiers** anlegen: Free (kein Kauf), Pro, Team (mit unterschiedlichem **Activation Limit** = Seats), Agency.
2. Bei den kostenpflichtigen Varianten **„License keys"** aktivieren und das **Activation Limit** je Tier setzen (z. B. Pro = 3, Team = 10).
3. Einen **API-Key** + **Webhook-Secret** generieren (für die spätere F-LIC-Anbindung).
4. Optional: Checkout-Links je Tier erstellen — die kann die Extension später beim `402` direkt verlinken („Upgrade").

Mehr braucht es jetzt nicht — die serverseitige Anbindung (F-LIC) bauen wir, sobald du das erste zahlende Szenario konkret machen willst.

---

## 5. Empfohlene Reihenfolge (Geschäft)
1. **Wert & Adoption:** Free + Pro, Funnel über Chrome Web Store. (Auth steht, F0c-Login funktioniert.)
2. **Agentur-Widget** (F2) — stärkster Umsatzhebel (White-Label-Chatbot für Kundenseiten).
3. **Managed Hosting** — löst die Lizenz-Durchsetzung automatisch.
4. **F-LIC** (Lemon-Squeezy-Lizenz-Check) scharf schalten, sobald zahlende Kunden real sind.

---

## 6. Schnell-Referenz: Auth-Endpoints
| Endpoint | Zweck |
|----------|-------|
| `GET /auth/status` | Sagt, ob Login nötig ist (öffentlich) |
| `POST /auth/bootstrap` | Ersten Admin anlegen (nur solange 0 User) |
| `POST /auth/login` | Login → Token (optional `instance_token` für Seat) |
| `GET /auth/me` | Aktueller User |
| `GET/POST/DELETE /auth/users` | User-Verwaltung (admin-only) |
| `POST /vaults/{id}` mit `members` | Vault-Zugriff je User (admin-only) |

Seat-Limit setzen (manuell, bis F-LIC): in `settings.json` den Block `"licensing": {"seat_limit": <n>, "tier": "...", "license_key": "..."}` setzen.
