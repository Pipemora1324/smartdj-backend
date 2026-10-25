-- Peticiones automáticas en AutoDJ: toda petición válida entra sola a la cola y la IA decide el orden y el momento.
-- Requiere la 006 y la 008. Idempotente: se puede ejecutar más de una vez. Ver DECISIONES_DJ.md.

-- Interruptor por local ("Aceptar peticiones automáticamente") y filtro opcional de canciones explícitas.
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS auto_accept_requests BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS block_explicit BOOLEAN NOT NULL DEFAULT FALSE;

-- Identidad de la canción pedida (proveedor:id) para detectar duplicados y bloqueos.
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS song_key VARCHAR(80);
-- Quién pidió, sin datos personales: hash del identificador anónimo del navegador y de la IP (límite por cliente).
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS client_key VARCHAR(64);
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS ip_key VARCHAR(64);
-- Votos: una petición repetida no se duplica; la nueva fila apunta a la original y suma un voto.
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS votes INTEGER NOT NULL DEFAULT 1;
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS duplicate_of UUID REFERENCES song_requests(id) ON DELETE SET NULL;
-- Orden justo: cuántas peticiones posteriores ya sonaron antes que esta (límite de aplazamiento) y ajuste del dueño.
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS passed_count SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS owner_priority SMALLINT NOT NULL DEFAULT 0;
-- Pista que sonó hace poco: no entra a la cola antes de esta hora.
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS not_before TIMESTAMPTZ;
-- Fallos al reproducirla en la consola: con el segundo queda como "No se pudo reproducir".
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS play_failures SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS explicit BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS song_requests_venue_song_pending_idx ON song_requests(establishment_id, song_key)
  WHERE status IN ('queued', 'accepted', 'bridging') AND duplicate_of IS NULL;
CREATE INDEX IF NOT EXISTS song_requests_venue_client_pending_idx ON song_requests(establishment_id, client_key)
  WHERE status IN ('queued', 'accepted', 'bridging');
CREATE INDEX IF NOT EXISTS song_requests_duplicate_idx ON song_requests(duplicate_of) WHERE duplicate_of IS NOT NULL;
-- Una petición ocupa como mucho un lugar en la cola de la emisora.
CREATE UNIQUE INDEX IF NOT EXISTS play_queue_request_unique_idx ON play_queue(request_id) WHERE request_id IS NOT NULL;

-- Canciones que el dueño bloqueó en su local: nuevas peticiones de ellas se rechazan.
CREATE TABLE IF NOT EXISTS blocked_songs (
  establishment_id UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
  song_key VARCHAR(80) NOT NULL,
  title VARCHAR(140),
  artist VARCHAR(140),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (establishment_id, song_key)
);
-- Como las demás tablas: la clave anon de Supabase es pública, así que nadie la lee por la API REST.
ALTER TABLE blocked_songs ENABLE ROW LEVEL SECURITY;

-- Peticiones existentes: se completa su identidad.
UPDATE song_requests SET song_key = provider || ':' || external_id
WHERE song_key IS NULL AND external_id IS NOT NULL AND provider IS NOT NULL;

-- Peticiones que quedaron pendientes sin evaluación (motor caído) pasan a evaluadas: con el interruptor activo,
-- el AutoDJ las mete a la cola por orden de llegada en el siguiente evento de la emisora.
UPDATE song_requests
SET status = 'accepted',
    evaluated_at = COALESCE(evaluated_at, NOW()),
    ai_reason = COALESCE(ai_reason, 'Entró a la cola sin evaluación del motor.')
WHERE status = 'queued' AND created_at < NOW() - INTERVAL '5 minutes';
