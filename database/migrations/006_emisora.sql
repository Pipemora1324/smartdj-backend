-- Emisora automática (AutoDJ): caché de pistas, estado del reproductor, cola e historial.
-- Idempotente: se puede ejecutar varias veces. Ver DECISIONES_DJ.md.

-- Metadatos de pistas (nunca el audio). Se renuevan cada 24 h desde el proveedor.
CREATE TABLE IF NOT EXISTS track_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(20) NOT NULL,
  external_id VARCHAR(40) NOT NULL,
  title VARCHAR(140) NOT NULL,
  artist VARCHAR(140) NOT NULL,
  genre VARCHAR(60) NOT NULL DEFAULT '',
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  artwork_url TEXT, audio_url TEXT NOT NULL, share_url TEXT,
  license_url TEXT, license_label VARCHAR(60) NOT NULL DEFAULT '',
  non_commercial BOOLEAN NOT NULL DEFAULT TRUE,
  bpm NUMERIC(6,2), musical_key VARCHAR(15), energy SMALLINT NOT NULL DEFAULT 0,
  waveform JSONB NOT NULL DEFAULT '[]',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, external_id)
);
CREATE INDEX IF NOT EXISTS track_cache_genre_idx ON track_cache(lower(genre));

-- Resultado de cada búsqueda al proveedor (ids de track_cache), para no repetirla durante 24 h.
CREATE TABLE IF NOT EXISTS track_search_cache (
  query_key VARCHAR(200) PRIMARY KEY,
  track_ids JSONB NOT NULL DEFAULT '[]',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  CREATE TYPE player_status AS ENUM ('playing','paused','stopped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE player_mode AS ENUM ('autodj','manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE queue_source AS ENUM ('autodj','request','manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Estado del reproductor de cada local. La posición viva es position_seconds + (NOW() - started_at) si suena.
CREATE TABLE IF NOT EXISTS player_state (
  establishment_id UUID PRIMARY KEY REFERENCES establishments(id) ON DELETE CASCADE,
  status player_status NOT NULL DEFAULT 'stopped',
  mode player_mode NOT NULL DEFAULT 'autodj',
  current_track_id UUID REFERENCES track_cache(id) ON DELETE SET NULL,
  current_meta JSONB NOT NULL DEFAULT '{}',
  position_seconds NUMERIC(8,2) NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  volume SMALLINT NOT NULL DEFAULT 80 CHECK (volume BETWEEN 0 AND 100),
  crossfade_seconds SMALLINT NOT NULL DEFAULT 8 CHECK (crossfade_seconds BETWEEN 0 AND 20),
  console_id VARCHAR(64),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cola de reproducción, ordenada por position.
CREATE TABLE IF NOT EXISTS play_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  establishment_id UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
  track_id UUID NOT NULL REFERENCES track_cache(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  source queue_source NOT NULL DEFAULT 'autodj',
  request_id UUID REFERENCES song_requests(id) ON DELETE SET NULL,
  score SMALLINT, reason TEXT,
  transition_at_seconds NUMERIC(8,2), crossfade_seconds NUMERIC(5,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS play_queue_venue_position_idx ON play_queue(establishment_id, position);

-- Historial: qué sonó, de dónde vino y si se saltó.
ALTER TABLE mix_history ADD COLUMN IF NOT EXISTS track_id UUID REFERENCES track_cache(id) ON DELETE SET NULL;
ALTER TABLE mix_history ADD COLUMN IF NOT EXISTS source queue_source;
ALTER TABLE mix_history ADD COLUMN IF NOT EXISTS skipped BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE mix_history ADD COLUMN IF NOT EXISTS ended_reason VARCHAR(20);
CREATE INDEX IF NOT EXISTS mix_history_venue_played_idx ON mix_history(establishment_id, played_at DESC);

-- Opción por local: no programar pistas con licencia no comercial.
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS exclude_non_commercial BOOLEAN NOT NULL DEFAULT FALSE;

-- En Supabase, las tablas de public quedan expuestas a la API REST con la clave anon (pública).
-- Con RLS activo y sin políticas solo las usa el backend (dueño de las tablas).
ALTER TABLE track_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE track_search_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE play_queue ENABLE ROW LEVEL SECURITY;
