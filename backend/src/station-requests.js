import { query } from './db.js';
import { redis } from './redis.js';
import { AppError } from './errors.js';
import { hasColumn } from './schema-check.js';
import { findFreeVersion, upsertTracks } from './music-catalog.js';
import { itunesRequestTrack, trackKind } from './catalog-logic.js';
import { defaultTransition, previewTransition } from './player-logic.js';
import { enqueue, moveRequestFirst } from './player.js';

// Peticiones del público dentro de la emisora (migración 008): qué pista suena por cada una,
// cuáles están pendientes y las acciones del dueño desde la consola. Ver DECISIONES_DJ.md.
export const PENDING_STATUSES = ['queued', 'accepted', 'bridging'];
const PENDING_WINDOW = '24 hours';

const REQUEST_SQL = `SELECT r.*, t.provider AS track_provider,
    EXISTS (SELECT 1 FROM play_queue q WHERE q.request_id = r.id) AS in_queue,
    COALESCE(s.current_meta ->> 'requestId' = r.id::text, FALSE) AS playing
  FROM song_requests r
  LEFT JOIN track_cache t ON t.id = r.track_id
  LEFT JOIN player_state s ON s.establishment_id = r.establishment_id`;

// Peticiones pendientes del local (últimas 24 h), de la más antigua a la más nueva.
export const pendingRequests = async (venueId) =>
  (
    await query(
      `${REQUEST_SQL} WHERE r.establishment_id=$1 AND r.status = ANY($2::request_status[]) AND r.created_at > NOW() - INTERVAL '${PENDING_WINDOW}'
   ORDER BY r.created_at`,
      [venueId, PENDING_STATUSES],
    )
  ).rows;

// Varias peticiones por id, solo del local (estado para la página pública).
export const requestsByIds = async (venueId, ids) =>
  ids.length ? (await query(`${REQUEST_SQL} WHERE r.establishment_id=$1 AND r.id = ANY($2::uuid[])`, [venueId, ids])).rows : [];

const loadRequest = async (venueId, requestId) => {
  const row = (await query(`${REQUEST_SQL} WHERE r.establishment_id=$1 AND r.id=$2`, [venueId, requestId])).rows[0];
  if (!row) throw new AppError(404, 'Petición no encontrada.');
  return row;
};

export const publishRequestChange = (venueId, requestId, type = 'request_updated') =>
  redis
    .publish(`venue:${venueId}`, JSON.stringify({ type, requestId }))
    .catch((err) => console.error('No se pudo avisar el cambio de la petición:', err.message));

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
    console.error(`No se pudo buscar la versión completa de la petición ${request.id}:`, err.message);
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

export const dismissRequest = async (venue, requestId) => {
  const request = await loadRequest(venue.id, requestId);
  if (request.in_queue || request.playing) throw new AppError(409, 'Esa petición ya está en la cola: quítala de la cola primero.');
  const sets = ["status='rejected'"];
  if (hasColumn('song_requests.status_updated_at')) sets.push('status_updated_at=NOW()');
  await query(`UPDATE song_requests SET ${sets.join(',')} WHERE id=$1 AND establishment_id=$2`, [requestId, venue.id]);
  void publishRequestChange(venue.id, requestId);
};
