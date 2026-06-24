-- video-brain: Zentrale Lizenz-Supabase Schema (Dario's eigenes Projekt)
-- ewtos.com
--
-- Einmalig im SQL-Editor des ZENTRALEN Supabase-Projekts (Dario) ausführen.
-- Dieses Projekt kennt NUR Lizenz-Keys — KEINE Kundendaten (Zero-Custody).
--
-- Nach Deployment:
--   1. _LICENSE_SUPABASE_URL in server/tools/video_brain_sync.py setzen
--   2. _LICENSE_SUPABASE_ANON_KEY setzen (public-safe: nur RPC-Execute, kein Table-Select)
--   3. Test-Lizenz anlegen: INSERT INTO licenses (license_key, ...) VALUES (...)


-- ── Lizenzen ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS licenses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key   TEXT NOT NULL UNIQUE,
  customer_email TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'expired')),
  plan          TEXT DEFAULT 'basic',
  valid_until   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now(),
  notes         TEXT
);

-- Kein RLS auf Tabellen-Ebene für anon (anon darf NICHT direkt lesen).
-- Zugriff nur über die check_license RPC (SECURITY DEFINER).
ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;

-- Nur eingeloggte Admins (Service-Key) lesen/schreiben direkt.
DROP POLICY IF EXISTS "licenses: nur service-role" ON licenses;
CREATE POLICY "licenses: nur service-role" ON licenses
  FOR ALL USING (false);  -- anon + authenticated: kein direkter Zugriff


-- ── RPC: check_license ─────────────────────────────────────────────────────
-- SECURITY DEFINER: läuft als DB-Owner, umgeht RLS.
-- Gibt nur die Zeile zum übergebenen Key zurück — kein Leak aller Keys.
-- anon darf diese RPC aufrufen (für ewtos-brain ohne eingeloggten User).

DROP FUNCTION IF EXISTS public.check_license(text);

CREATE FUNCTION public.check_license(p_key text)
  RETURNS TABLE(status text, valid_until timestamptz, plan text)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT status, valid_until, plan
  FROM licenses
  WHERE license_key = p_key
  LIMIT 1;
$$;

-- anon darf die RPC aufrufen
GRANT EXECUTE ON FUNCTION public.check_license(text) TO anon;
