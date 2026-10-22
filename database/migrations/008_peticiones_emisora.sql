-- Peticiones dentro de la emisora: de dónde viene cada petición (Jamendo completa o preview de iTunes),
-- su pista en el caché y la constancia de que sonó. Requiere la 006. Idempotente. Ver DECISIONES_DJ.md.
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS provider VARCHAR(20) NOT NULL DEFAULT 'itunes';
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS track_id UUID REFERENCES track_cache(id) ON DELETE SET NULL;
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS store_url TEXT;
CREATE INDEX IF NOT EXISTS song_requests_venue_pending_idx ON song_requests(establishment_id, created_at DESC) WHERE status IN ('queued', 'accepted', 'bridging');

-- Qué petición sonó en cada entrada del historial.
ALTER TABLE mix_history ADD COLUMN IF NOT EXISTS request_id UUID REFERENCES song_requests(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS mix_history_request_idx ON mix_history(request_id) WHERE request_id IS NOT NULL;

-- Corrección: una petición solo es "sonada" si sonó en la emisora (queda en mix_history al terminar).
-- Las que se marcaron a mano sin sonar vuelven a "aceptada" y el dueño las ve otra vez en la consola.
UPDATE song_requests r SET status = 'accepted', played_at = NULL
WHERE r.status = 'played'
  AND NOT EXISTS (SELECT 1 FROM mix_history h WHERE h.request_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM player_state s WHERE s.current_meta ->> 'requestId' = r.id::text);
