-- Asegura las tablas y tipos base de init.sql en bases creadas a mano (por ejemplo, Supabase).
-- Idempotente: no toca lo que ya existe ni borra datos.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE venue_kind AS ENUM ('restaurant','cafe','salsa_bar','nightclub','lounge','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE request_status AS ENUM ('queued','accepted','bridging','rejected','played');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS songs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(140) NOT NULL, artist VARCHAR(140) NOT NULL, genre VARCHAR(60) NOT NULL,
  bpm NUMERIC(6,2), musical_key VARCHAR(15), preview_url TEXT, source VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS song_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  establishment_id UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
  guest_name VARCHAR(60) NOT NULL, title VARCHAR(140) NOT NULL, artist VARCHAR(140) NOT NULL, genre VARCHAR(60) NOT NULL,
  bpm NUMERIC(6,2), musical_key VARCHAR(15),
  status request_status NOT NULL DEFAULT 'queued',
  ai_reason TEXT, bridge_sequence JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), evaluated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mix_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  establishment_id UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
  song_id UUID REFERENCES songs(id), bpm NUMERIC(6,2), musical_key VARCHAR(15),
  played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS song_requests_venue_created_idx ON song_requests(establishment_id, created_at DESC);
