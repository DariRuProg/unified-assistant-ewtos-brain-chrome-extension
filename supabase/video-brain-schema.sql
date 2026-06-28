-- video-brain: Kunden-Supabase Schema
-- ewtos.com
--
-- Einmalig im SQL-Editor der KUNDEN-EIGENEN Supabase ausführen.
-- Enthält nur die drei Tabellen die video-brain liest; kein upsert_history-RPC
-- (ewtos-brain schreibt direkt mit dem service_key per REST-UPSERT).
--
-- Voraussetzung: Supabase-Projekt mit aktiviertem Auth (GoTrue).
-- Schritte:
--   1. Neues Supabase-Projekt anlegen
--   2. Dieses SQL im SQL-Editor ausführen
--   3. Einen Auth-User anlegen (Authentication → Users → Add user)
--   4. Die User-UUID + Projekt-URL + anon-key + service_key in
--      ewtos-brain Options → video-brain eintragen


-- ── History ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS history (
  video_id          TEXT NOT NULL,
  user_id           UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  url               TEXT NOT NULL,
  title             TEXT,
  thumbnail_url     TEXT,
  summary           TEXT,
  summary_short     TEXT,
  topics_json       TEXT,
  key_insights_json TEXT,
  transcript        TEXT,
  channel           TEXT,
  watched_at        TIMESTAMPTZ DEFAULT now(),
  last_seen_at      TIMESTAMPTZ DEFAULT now(),
  view_count        INTEGER DEFAULT 1,
  metadata_json     TEXT,
  yt_view_count     BIGINT,
  yt_like_count     BIGINT,
  creator_slug      TEXT,
  vault_synced      BOOLEAN DEFAULT false,
  vault_requested   BOOLEAN DEFAULT false,
  PRIMARY KEY (video_id, user_id)
);

CREATE INDEX IF NOT EXISTS history_user_last_seen  ON history (user_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS history_user_unsynced   ON history (user_id) WHERE vault_synced = false;
CREATE INDEX IF NOT EXISTS history_user_requested  ON history (user_id)
  WHERE vault_requested = true AND vault_synced = false;

ALTER TABLE history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "history: eigene Zeilen" ON history;
CREATE POLICY "history: eigene Zeilen" ON history
  FOR ALL USING (auth.uid() = user_id);


-- ── Notes ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  video_id    TEXT NOT NULL,
  content     TEXT NOT NULL,
  tags_json   TEXT,
  video_title TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS notes_user_video ON notes (user_id, video_id, created_at DESC);

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notes: eigene Zeilen" ON notes;
CREATE POLICY "notes: eigene Zeilen" ON notes
  FOR ALL USING (auth.uid() = user_id);


-- ── Queue (Inbox / Watchlist) ───────────────────────────────────────────────
-- Optional: Nutzer kann URLs als Watchlist vormerken, die ewtos-brain abholt.

CREATE TABLE IF NOT EXISTS queue (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  url          TEXT NOT NULL,
  title        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'done')),
  created_at   TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS queue_user_status ON queue (user_id, status);

ALTER TABLE queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "queue: eigene Zeilen" ON queue;
CREATE POLICY "queue: eigene Zeilen" ON queue
  FOR ALL USING (auth.uid() = user_id);


-- ── Playlists (kuratiert aus Vault) ────────────────────────────────────────
-- Wird von ewtos-brain resync befüllt (wiki/resources/playlists/*.md).
-- Metadaten-Quelle für die App: Titel, Beschreibung, Video-Reihenfolge.

CREATE TABLE IF NOT EXISTS playlists (
  slug         TEXT NOT NULL,
  user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  titel        TEXT,
  beschreibung TEXT,
  thema        TEXT,
  source_url   TEXT,
  status       TEXT DEFAULT 'aktiv',
  video_order  TEXT,            -- JSON-Array von video_ids in Reihenfolge
  last_synced  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (slug, user_id)
);

CREATE INDEX IF NOT EXISTS playlists_user ON playlists (user_id);

ALTER TABLE playlists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "playlists: eigene Zeilen" ON playlists;
CREATE POLICY "playlists: eigene Zeilen" ON playlists
  FOR ALL USING (auth.uid() = user_id);
