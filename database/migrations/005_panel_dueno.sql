-- Bloque C/D: el dueño marca peticiones como sonadas; played_at permite saber qué está "sonando" en cada local.
-- Idempotente: se puede ejecutar varias veces.
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS played_at TIMESTAMPTZ;
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS song_requests_venue_played_idx ON song_requests(establishment_id, played_at DESC) WHERE played_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS song_requests_venue_status_idx ON song_requests(establishment_id, status, created_at);
