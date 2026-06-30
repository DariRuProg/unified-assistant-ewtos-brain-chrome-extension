# EwtosBrain — F0: Auth / Multi-User-Fundament (Implementierungsplan)

> Repo-Spiegel des freigegebenen Plans. Quelle: `~/.claude/plans/`. Strategie-/Monetarisierungs-Kontext am Ende.

## Context

Ziel: EwtosBrain vom lokalen Single-User-Tool zu einem **Firmen-Server mit Mitarbeiter-Logins** ausbauen. Anforderungen:
1. Vault wählbar wie bisher (lokal über Explorer auffindbar) **oder** auf einem Firmen-/Cloud-Server (Hetzner/Hostinger).
2. Ein User muss sich **anmelden** und **Rechte** bekommen, um auf einen Vault zuzugreifen.
3. Vorbereitung für **Telegram**: später mit Vault *oder* einzelner Datei chatten; in den Settings **sichtbar wählbar**, welche Tools Telegram beim Vault-/Datei-Chat hat.
4. Falls möglich, **OpenAI-Subscription-Login** für nicht-sensible Daten (günstiger als API-Key).

**Wichtige Erkenntnis:** „Vault lokal vs. auf Hetzner" ist keine neue Vault-Logik — der Vault ist immer ein Pfad auf der Maschine, auf der der Server läuft. Neu ist nur: **Auth + sichere Erreichbarkeit von außen.**

## Entscheidung: OpenAI-Subscription
- BYOK-API-Key bleibt Hauptweg (Anthropic: einzig erlaubt; OpenAI: einzig sicher).
- ChatGPT-Abo in Dritt-Apps real nur über Codex-OAuth (Graubereich + Wochen-Quota). → Optionale spätere Stufe **F-LLM**, nicht in F0. **Sensible Daten nie über Subscription.**

## F0 — Architektur

### 1. User-Modell & Speicherung (seat-ready)
- Store `users` in `settings.json`: `{id, username, password_hash, role, created_at}`. Hashing via bcrypt, **nie** Klartext.
- Token: **JWT** (PyJWT), signiert mit `EWTOS_SECRET_KEY` (.env) oder generiertem, persistiertem Secret.
- **Local-Open-Mode:** 0 User → Server offen (Backward-Compat). Ab ≥1 User Auth-Pflicht.
- **Seat-Readiness (vorgebaut, ohne zentrale Lizenz-API):** `licensing: {seat_limit, tier, license_key}` (`seat_limit=null` = aus). `sessions`-Liste + `active_seat_count()`/`seat_available()`. Login lehnt bei vollem Seat-Limit mit 402 ab — standardmäßig deaktiviert. Zentrale Lizenz-API = spätere Stufe **F-LIC**.

### 2. Per-Vault-Rechte
- Vault-Dict `members: [user_id]` (+ Admin sieht alles). `GET /vaults` user-gefiltert, Router-Guards via `user_can_access_vault`.

### 3. Auth-Endpoints & Middleware
- `server/routers/auth.py`: `/auth/login`, `/auth/me`, `/auth/status`, `/auth/bootstrap`, `/auth/users` (CRUD, admin-only).
- `server/auth.py`: `auth_middleware` — Open-Mode pass-through, sonst Bearer-Token prüfen → `request.state.user`. Public: `/health`, `/auth/login`, `/auth/bootstrap`, `/auth/status`, später `/telegram/*`, `/api/widget/*`.
- **WebSocket**: Token als Query-Param `/ws?token=…`, vor `bridge.attach()` validieren, sonst `close(1008)`.

### 4. Vault-Standort (lokal vs. Server)
- Bleibt pfadbasiert. Deployment-Doku (`docs/deployment.md`): VPS + Caddy (Auto-TLS) bzw. Büro-Server + Cloudflare Tunnel.

### 5. Extension-Anpassungen
- `sidepanel/modules/api.js`: zentraler `apiFetch` mit `Authorization: Bearer`; Login-Gate + Token-Storage; `background.js` WS mit `?token=`.

## Telegram-Vorbereitung (Build F1)
- Settings `telegram: {enabled, bot_token, links, tool_policy: {vault_chat, file_chat}}`, nutzt bestehendes `tool_level`. Settings-UI: sichtbare Tool-Auswahl je für Vault-Chat und Datei-Chat. Build: `server/routers/telegram.py` → bestehende Chat-Pipeline.

## OpenAI-Subscription (Build F-LLM, optional)
- `openai_auth_mode: "api_key"|"subscription"`. Backend `openai_codex_backend.py`. Sensible Daten via `active_allowed_for_sensitive()` ausgeschlossen.

## Phasen (Wert & Adoption zuerst)
1. **F0a** Server-Auth + Seat-Readiness (users.py, auth-Router, Middleware, WS-Token, .env-Secret).
2. **F0b** Per-Vault-Rechte.
3. **F0c** Extension-Auth (apiFetch, Login-Gate, WS-Token).
4. **F0d** Deployment-Doku.
5. Danach **F1 Telegram** → **F2 Widget**. Lizenz-Scharfschaltung = **F-LIC** (erst bei zahlendem Szenario). Optional **F-LLM**.

## Verifikation
- Login → Token → `/auth/me`; falsches Passwort → 401; Open-Mode offen; nach Bootstrap → 401 ohne Token.
- WS ohne/falscher Token → close 1008; gültig → Bridge läuft.
- Per-Vault: fremder Vault → 403.
- Regression: bestehende lokale Installation ohne User unverändert.

---

## Monetarisierung (Kurzfassung)
- **Mehrwert ja**; Geld **nicht über LLM-Marge** (BYOK). Hebel: Software-Abo, Managed Hosting, **White-Label-Widget** (höchster LTV), Support/DSGVO/SLA.
- **Lizenz-Durchsetzung** hart nur, wenn DU hostest. Self-hosted = weich → zentraler Aktivierungs-Server bei ewtos.com + ToS. An **Seats/Logins** koppeln, nicht HWID.
- **Tool:** Lemon Squeezy (Merchant of Record → EU-USt). Chrome Web Store: Paywall hinter Login erlaubt.
- **Preise (Richtwert):** Free 0 / Pro 9 € / Team 79 € (10 Seats) / Agency 299–699 € + Widget 49–149 €/Widget + Managed Hosting +20–50 €.
- **Reihenfolge:** Wert & Adoption (Free+Pro) → Agentur-Widget → Managed Hosting → zentrale Lizenz-API.
