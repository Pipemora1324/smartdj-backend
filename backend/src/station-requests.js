import { createHash } from 'node:crypto';
import { query, withTransaction } from './db.js';
import { redis } from './redis.js';
import { AppError } from './errors.js';
import { autoRequestsReady, hasColumn } from './schema-check.js';
import { findFreeVersion, upsertTracks } from './music-catalog.js';
import { itunesRequestTrack, trackKind } from './catalog-logic.js';
import { defaultTransition, previewTransition } from './player-logic.js';
import { enqueue, moveRequestFirst } from './player.js';
import { MAX_PLAY_FAILURES, MAX_VOTES } from './request-priority.js';
import { IP_CEILING_FACTOR } from './rate-limits.js';
import { config } from './config.js';
import { logger } from './logger.js';

// Peticiones del público dentro de la emisora (migración 008): qué pista suena por cada una,
// cuáles están pendientes y las acciones del dueño desde la consola. Ver DECISIONES_DJ.md.
export const PENDING_STATUSES = ['queued', 'accepted', 'bridging'];
const PENDING_WINDOW = '24 hours';

// Una petición repetida (voto) muestra el estado de la original: en la cola, sonando, etc.
const primaryId = () => (hasColumn('song_requests.duplicate_of') ? 'COALESCE(r.duplicate_of, r.id)' : 'r.id');
const requestSql = () => `SELECT r.*, t.provider AS track_provider, t.genre AS track_genre, t.energy AS track_energy,
    EXISTS (SELECT 1 FROM play_queue q WHERE q.request_id = ${primaryId()}) AS in_queue,
    COALESCE(s.current_meta ->> 'requestId' = (${primaryId()})::text, FALSE) AS playing
  FROM song_requests r
  LEFT JOIN track_cache t ON t.id = r.track_id
  LEFT JOIN player_state s ON s.establishment_id = r.establishment_id`;

// Peticiones pendientes del local (últimas 24 h), de la más antigua a la más nueva.
// Los votos (filas que apuntan a otra petición) no se listan aparte: suman a la original.
export const pendingRequests = async (venueId) =>
  (
    await query(
      `${requestSql()} WHERE r.establishment_id=$1 AND r.status = ANY($2::request_status[]) AND r.created_at > NOW() - INTERVAL '${PENDING_WINDOW}'
   ${hasColumn('song_requests.duplicate_of') ? 'AND r.duplicate_of IS NULL' : ''} ORDER BY r.created_at`,
      [venueId, PENDING_STATUSES],
    )
  ).rows;

// Varias peticiones por id, solo del local (estado para la página pública).
export const requestsByIds = async (venueId, ids) =>
  ids.length ? (await query(`${requestSql()} WHERE r.establishment_id=$1 AND r.id = ANY($2::uuid[])`, [venueId, ids])).rows : [];

const loadRequest = async (venueId, requestId) => {
  const row = (await query(`${requestSql()} WHERE r.establishment_id=$1 AND r.id=$2`, [venueId, requestId])).rows[0];
  if (!row) throw new AppError(404, 'Petición no encontrada.');
  return row;
};

export const publishRequestChange = (venueId, requestId, type = 'request_updated') =>
  redis
    .publish(`venue:${venueId}`, JSON.stringify({ type, requestId }))
    .catch((err) => logger.error('No se pudo avisar el cambio de la petición', { err: err }));

// Pista que sonó hace poco: la petición entra a la cola, pero no antes de esta hora (null si puede sonar ya).
const replayNotBefore = async (venueId, trackId) => {
  if (!hasColumn('mix_history.track_id')) return null;
  const r = await query(
    `SELECT MAX(played_at) + make_interval(mins => $3::int) AS not_before FROM mix_history
     WHERE establishment_id=$1 AND track_id=$2 AND played_at > NOW() - make_interval(mins => $3::int)
       AND ended_reason IS DISTINCT FROM 'error'`,
    [venueId, trackId, config.requests.replayWaitMinutes],
  );
  return r.rows[0]?.not_before ?? null;
};

// Pista que suena por una petición: la de Jamendo; si vino de iTunes, su versión completa en el catálogo libre
// (si existe) o el preview de 30 s. Queda guardada en song_requests.track_id. null si no hay audio posible.
export const resolveRequestTrack = async (venue, request) => {
  if (request.track_id) {
    const row = (await query('SELECT * FROM track_cache WHERE id=$1', [request.track_id])).rows[0];
    if (row) return row;
  }
  let row = null;
  try {
    row = await findFreeVersion({
      title: request.title,
      artist: request.artist,
      excludeNonCommercial: Boolean(venue.exclude_non_commercial),
    });
  } catch (err) {
    logger.error('No se pudo buscar la versión completa de la petición', { requestId: request.id, err });
  }
  if (!row) {
    const preview = itunesRequestTrack(request);
    if (preview) [row] = await upsertTracks([preview]);
  }
  if (row) await query('UPDATE song_requests SET track_id=$2 WHERE id=$1', [request.id, row.id]);
  return row;
};

export const transitionFor = (track) =>
  trackKind(track.provider) === 'preview' ? previewTransition(track.duration_seconds) : defaultTransition(track.duration_seconds);

// Pone una petición en la cola: intercalada (AutoDJ o "Añadir a la cola") o primera ("Reproducir ahora").
export const queueRequest = async (venue, request, { next = false, reason = 'Pedida por el público.' } = {}) => {
  if (request.status === 'played' || request.status === 'rejected') throw new AppError(409, 'Esa petición ya no está pendiente.');
  if (request.playing) throw new AppError(409, 'Esa petición ya está sonando.');
  if (request.in_queue && next) {
    await moveRequestFirst(venue.id, request.id);
    void publishRequestChange(venue.id, request.id);
    return null;
  }
  if (request.in_queue) throw new AppError(409, 'Esa petición ya está en la cola de la emisora.');
  const track = await resolveRequestTrack(venue, request);
  if (!track) throw new AppError(409, 'Esta petición no tiene audio para la emisora. Descártala o busca la canción en el catálogo.');
  await enqueue(venue.id, track, { source: 'request', requestId: request.id, reason, next, ...transitionFor(track) });
  void publishRequestChange(venue.id, request.id);
  return track;
};

export const queueRequestById = async (venue, requestId, options) => queueRequest(venue, await loadRequest(venue.id, requestId), options);

// Cambia el estado de una petición y de sus votos (las filas que apuntan a ella).
const closeRequest = async (venueId, requestId, { status = 'rejected', reason = null } = {}) => {
  const sets = ['status=$3::request_status'];
  if (reason) sets.push('ai_reason=$4');
  if (hasColumn('song_requests.status_updated_at')) sets.push('status_updated_at=NOW()');
  const target = hasColumn('song_requests.duplicate_of') ? '(id=$1 OR duplicate_of=$1)' : 'id=$1';
  await query(`UPDATE song_requests SET ${sets.join(',')} WHERE ${target} AND establishment_id=$2`, [
    requestId,
    venueId,
    status,
    ...(reason ? [reason] : []),
  ]);
};

export const dismissRequest = async (venue, requestId) => {
  const request = await loadRequest(venue.id, requestId);
  if (request.in_queue || request.playing) throw new AppError(409, 'Esa petición ya está en la cola: quítala de la cola primero.');
  await closeRequest(venue.id, requestId);
  void publishRequestChange(venue.id, requestId);
};

// ---------- Peticiones automáticas (migración 010) ----------

// Huella anónima (no reversible) del cliente o de la IP: sirve para contar, no para identificar a nadie.
export const anonymousKey = (value) => (value ? createHash('sha256').update(`smartdj|${value}`).digest('hex').slice(0, 32) : null);

// Peticiones pendientes por cliente: máximo maxPendingPerClient por navegador y un tope por IP (el Wi-Fi del local)
// IP_CEILING_FACTOR veces mayor, igual que los límites de uso. Cuentan las que aún no sonaron ni se descartaron.
export const checkPendingLimit = async (venueId, { clientKey, ipKey }) => {
  const max = config.requests.maxPendingPerClient;
  const r = await query(
    `SELECT COUNT(*) FILTER (WHERE client_key=$2)::int AS client, COUNT(*) FILTER (WHERE ip_key=$3)::int AS ip
     FROM song_requests WHERE establishment_id=$1 AND status = ANY($4::request_status[]) AND created_at > NOW() - INTERVAL '${PENDING_WINDOW}'`,
    [venueId, clientKey, ipKey, PENDING_STATUSES],
  );
  const { client, ip } = r.rows[0];
  if (clientKey && client >= max) {
    throw new AppError(429, `Ya tienes ${max} peticiones esperando turno. Cuando suene alguna podrás pedir otra.`, {
      code: 'too_many_pending',
    });
  }
  if (ipKey && ip >= max * IP_CEILING_FACTOR) {
    throw new AppError(429, 'Hay demasiadas peticiones pendientes desde esta red. Espera a que suenen algunas.', {
      code: 'too_many_pending',
    });
  }
};

export const isSongBlocked = async (venueId, songKey) =>
  Boolean(songKey) &&
  (await query('SELECT 1 FROM blocked_songs WHERE establishment_id=$1 AND song_key=$2', [venueId, songKey])).rowCount > 0;

// La petición pendiente de la misma canción (la original, no un voto), si existe y aún no suena.
export const findPendingSong = async (db, venueId, songKey) =>
  songKey
    ? ((
        await db.query(
          `SELECT r.id, r.status FROM song_requests r LEFT JOIN player_state s ON s.establishment_id = r.establishment_id
           WHERE r.establishment_id=$1 AND r.song_key=$2 AND r.duplicate_of IS NULL AND r.status = ANY($3::request_status[])
             AND COALESCE(s.current_meta ->> 'requestId', '') <> r.id::text
           ORDER BY r.created_at LIMIT 1`,
          [venueId, songKey, PENDING_STATUSES],
        )
      ).rows[0] ?? null)
    : null;

export const addVote = (db, requestId) =>
  db.query('UPDATE song_requests SET votes = LEAST(votes + 1, $2) WHERE id=$1', [requestId, MAX_VOTES]);

// Inserta una petición. Si ya hay una pendiente de la misma canción, la nueva queda como voto de esa
// (duplicate_of) y no se evalúa ni entra a la cola otra vez. El candado por local y canción evita que dos
// pedidos simultáneos creen dos originales. Devuelve { id, duplicateOf }.
export const insertStationRequest = async (venueId, columns, values, songKey) =>
  withTransaction(async (client) => {
    if (songKey) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${venueId}|${songKey}`]);
    const original = await findPendingSong(client, venueId, songKey);
    const cols = [...columns];
    const vals = [...values];
    if (original) {
      cols.push('duplicate_of', 'status');
      vals.push(original.id, original.status);
    }
    const r = await client.query(
      `INSERT INTO song_requests(${cols.join(',')}) VALUES(${vals.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      vals,
    );
    if (original) await addVote(client, original.id);
    return { id: r.rows[0].id, duplicateOf: original?.id ?? null };
  });

// El dueño sube (+1) o baja (-1) una petición en el orden, dentro del límite de aplazamiento.
export const OWNER_PRIORITY_LIMIT = 5;
export const adjustPriority = async (venue, requestId, delta) => {
  const request = await loadRequest(venue.id, requestId);
  if (request.status === 'played' || request.status === 'rejected') throw new AppError(409, 'Esa petición ya no está pendiente.');
  await query('UPDATE song_requests SET owner_priority = GREATEST(-$3::int, LEAST($3::int, owner_priority + $2)) WHERE id=$1', [
    requestId,
    delta,
    OWNER_PRIORITY_LIMIT,
  ]);
  void publishRequestChange(venue.id, requestId);
};

// Bloquear: descarta la petición (aunque esté en la cola) y la canción ya no se acepta en el local.
export const blockRequest = async (venue, requestId) => {
  const request = await loadRequest(venue.id, requestId);
  const songKey = request.song_key;
  if (!songKey) throw new AppError(409, 'Esta petición no se puede bloquear: no tiene una canción identificada.');
  await query(
    'INSERT INTO blocked_songs(establishment_id, song_key, title, artist) VALUES($1,$2,$3,$4) ON CONFLICT (establishment_id, song_key) DO NOTHING',
    [venue.id, songKey, request.title, request.artist],
  );
  if (!request.playing) {
    await query('DELETE FROM play_queue WHERE establishment_id=$1 AND request_id=$2', [venue.id, request.duplicate_of ?? request.id]);
    await closeRequest(venue.id, request.duplicate_of ?? request.id, { reason: 'El DJ no acepta esta canción.' });
  }
  void publishRequestChange(venue.id, requestId);
};

// Peticiones listas para entrar solas a la cola: evaluadas, originales (no votos), sin fallar dos veces y sin
// espera por haber sonado hace poco. Las que siguen en evaluación entran cuando el worker termina.
export const isReadyForQueue = (row, now = Date.now()) =>
  (row.status === 'accepted' || row.status === 'bridging') &&
  !row.duplicate_of &&
  !row.in_queue &&
  !row.playing &&
  (Number(row.play_failures) || 0) < MAX_PLAY_FAILURES &&
  (!row.not_before || new Date(row.not_before).getTime() <= now);

// AutoDJ con "Aceptar peticiones automáticamente": mete a la cola toda petición lista, por orden de llegada.
// El orden fino lo decide después reorderRequests() en player.js. Devuelve cuántas entraron.
export const autoQueueRequests = async (venue, requests) => {
  let added = 0;
  const queuedTracks = new Map(
    (await query('SELECT track_id, request_id FROM play_queue WHERE establishment_id=$1 AND request_id IS NOT NULL', [venue.id])).rows.map(
      (r) => [r.track_id, r.request_id],
    ),
  );
  for (const request of requests.filter((r) => isReadyForQueue(r))) {
    const track = await resolveRequestTrack(venue, request).catch((err) => {
      logger.error('No se pudo preparar la petición', { requestId: request.id, err });
      return undefined;
    });
    if (track === undefined) continue;
    if (!track) {
      await closeRequest(venue.id, request.id, { reason: 'No encontramos audio para esta canción.' });
      void publishRequestChange(venue.id, request.id);
      continue;
    }
    // La misma pista ya está en la cola por otra petición (por ejemplo, una de iTunes con su versión completa): voto.
    const sameTrack = queuedTracks.get(track.id);
    if (sameTrack && sameTrack !== request.id) {
      await query('UPDATE song_requests SET duplicate_of=$2 WHERE id=$1', [request.id, sameTrack]);
      await addVote({ query }, sameTrack);
      void publishRequestChange(venue.id, request.id);
      continue;
    }
    const notBefore = await replayNotBefore(venue.id, track.id);
    if (notBefore && new Date(notBefore).getTime() > Date.now()) {
      await query('UPDATE song_requests SET not_before=$2 WHERE id=$1', [request.id, notBefore]);
      void publishRequestChange(venue.id, request.id);
      continue;
    }
    await enqueue(venue.id, track, { source: 'request', requestId: request.id, reason: 'Pedida por el público.', ...transitionFor(track) });
    queuedTracks.set(track.id, request.id);
    void publishRequestChange(venue.id, request.id);
    added += 1;
  }
  return added;
};

// true si el local mete las peticiones solas a la cola (AutoDJ, interruptor activo y migración 010).
export const autoAcceptsRequests = (venue, mode) => mode === 'autodj' && autoRequestsReady() && venue.auto_accept_requests !== false;
