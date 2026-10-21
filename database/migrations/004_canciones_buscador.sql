-- Bloque B: las peticiones guardan la canción elegida en el buscador (iTunes): id externo, portada y preview de 30 s.
-- Idempotente: se puede ejecutar varias veces.
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS external_id VARCHAR(40);
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS artwork_url TEXT;
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS preview_url TEXT;
