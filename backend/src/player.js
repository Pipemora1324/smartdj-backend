import { query, withTransaction } from './db.js';
import { redis } from './redis.js';
import { AppError } from './errors.js';
import { hasColumn } from './schema-check.js';
import { toPublicTrack } from './catalog-logic.js';
import { insertAt, livePosition, reorderPositions, requestInsertIndex } from './player-logic.js';

// Estado del reproductor y cola de cada local (migración 006). Toda escritura va en una transacción
// con la fila de player_state bloqueada (FOR UPDATE), así dos consolas no avanzan la cola a la vez.

export const publishPlayerUpdate = (venueId) => redis.publish(`venue:${venueId}`, JSON.stringify({ type: 'player_updated' }))
  .catch((err) => console.error('No se pudo avisar el cambio del reproductor:', err.message));

const ensureState = (db, venueId) => db.query('INSERT INTO player_state(establishment_id) VALUES($1) ON CONFLICT DO NOTHING', [venueId]);
const lockState = async (client, venueId) => {
  await ensureState(client, venueId);
  return (await client.query('SELECT * FROM player_state WHERE establishment_id=$1 FOR UPDATE', [venueId])).rows[0];
};

const QUEUE_SQL = `SELECT q.id AS queue_id, q.position, q.source, q.request_id, q.score, q.reason, q.transition_at_seconds, q.crossfade_seconds, t.*
  FROM play_queue q JOIN track_cache t ON t.id = q.track_id WHERE q.establishment_id=$1 ORDER BY q.position, q.created_at LIMIT $2`;
export const loadQueue = async (db, venueId, limit = 100) => (await db.query(QUEUE_SQL, [venueId, limit])).rows;

const num = (value) => (value === null || value === undefined ? null : Number(value));
const toQueueItem = (row, options) => ({
  id: row.queue_id, position: row.position, source: row.source, requestId: row.request_id, score: row.score, reason: row.reason,
  transitionAtSeconds: num(row.transition_at_seconds), crossfadeSeconds: num(row.crossfade_seconds), track: toPublicTrack(row, options),
});

// Foto completa del reproductor. withAudio=false (página pública) quita URLs de audio, ids de petición y consola.
export const playerSnapshot = async (venueId, { withAudio = true, queueLimit = 100, create = true } = {}) => {
  if (create) await ensureState({ query }, venueId);
  const [stateResult, queue] = await Promise.all([
    query('SELECT s.*, row_to_json(t.*) AS track FROM player_state s LEFT JOIN track_cache t ON t.id = s.current_track_id WHERE s.establishment_id=$1', [venueId]),
    loadQueue({ query }, venueId, queueLimit),
  ]);
  const state = stateResult.rows[0];
  if (!state) return null;
  const meta = state.current_meta ?? {};
  const items = queue.map((row) => toQueueItem(row, { withAudio }));
  return {
    status: state.status, mode: state.mode, volume: state.volume, crossfadeSeconds: state.crossfade_seconds,
    positionSeconds: livePosition(state), updatedAt: state.updated_at,
    current: state.track ? {
      track: toPublicTrack(state.track, { withAudio }), source: meta.source ?? null, reason: meta.reason ?? null, score: meta.score ?? null,
      transitionAtSeconds: meta.transitionAtSeconds ?? null, crossfadeSeconds: meta.crossfadeSeconds ?? null, startedAt: state.started_at,
    } : null,
    queue: withAudio ? items : items.map(({ requestId: _r, ...item }) => item),
    ...(withAudio ? { consoleId: state.console_id } : {}),
  };
};

// Si la petición trae consoleId y otra consola tiene el control, se rechaza (evita dos pestañas sonando).
const checkConsole = (state, consoleId) => {
  if (consoleId && state.console_id && state.console_id !== consoleId) {
    throw new AppError(409, 'La emisora se está reproduciendo en otra consola. Toma el control para seguir aquí.', { code: 'console_taken' });
  }
};

const renumber = (client, venueId) => client.query(
  `UPDATE play_queue q SET position = s.rn FROM (SELECT id, row_number() OVER (ORDER BY position, created_at) AS rn FROM play_queue WHERE establishment_id=$1) s
   WHERE q.id = s.id AND q.position IS DISTINCT FROM s.rn`, [venueId]);
const applyOrder = (client, venueId, ids) => client.query(
  'UPDATE play_queue q SET position = o.pos FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, pos) WHERE q.id = o.id AND q.establishment_id=$1', [venueId, ids]);

// La petición del público que empieza a sonar queda como "sonada" (la página pública la deja de mostrar en la cola).
const markRequestPlayed = (client, requestId) => {
  const sets = ["status='played'"];
  if (hasColumn('song_requests.played_at')) sets.push('played_at=NOW()');
  if (hasColumn('song_requests.status_updated_at')) sets.push('status_updated_at=NOW()');
  return client.query(`UPDATE song_requests SET ${sets.join(',')} WHERE id=$1`, [requestId]);
};

// Pasa a la siguiente pista de la cola. endedReason: ended (terminó), user (saltada) o error (no cargó).
// Una petición solo queda "sonada" cuando sale de la emisora después de sonar (terminó o se saltó);
// si no cargó (error), sigue pendiente para que el dueño decida.
const PLAYED_REASONS = new Set(['ended', 'user']);
const moveToNext = async (client, venueId, state, endedReason, nextStatus = state.status) => {
  const requestId = state.current_meta?.requestId ?? null;
  if (state.current_track_id) {
    const withRequest = hasColumn('mix_history.request_id');
    await client.query(
      `INSERT INTO mix_history(establishment_id, track_id, source, skipped, ended_reason, bpm, musical_key${withRequest ? ', request_id' : ''})
       SELECT $1, id, $3::queue_source, $4, $5, bpm, musical_key${withRequest ? ', $6' : ''} FROM track_cache WHERE id=$2`,
      [venueId, state.current_track_id, state.current_meta?.source ?? null, endedReason !== 'ended', endedReason, ...(withRequest ? [requestId] : [])]);
    if (requestId && PLAYED_REASONS.has(endedReason)) await markRequestPlayed(client, requestId);
  }
  const next = (await client.query('SELECT * FROM play_queue WHERE establishment_id=$1 ORDER BY position, created_at LIMIT 1 FOR UPDATE', [venueId])).rows[0];
  if (next) {
    await client.query('DELETE FROM play_queue WHERE id=$1', [next.id]);
    await renumber(client, venueId);
  }
  const meta = next ? {
    source: next.source, requestId: next.request_id, score: next.score, reason: next.reason,
    transitionAtSeconds: num(next.transition_at_seconds), crossfadeSeconds: num(next.crossfade_seconds),
  } : {};
  const status = next ? nextStatus : 'stopped';
  await client.query(
    `UPDATE player_state SET current_track_id=$2, current_meta=$3, position_seconds=0, status=$4::player_status,
     started_at=CASE WHEN $4='playing' THEN NOW() END, updated_at=NOW() WHERE establishment_id=$1`,
    [venueId, next?.track_id ?? null, JSON.stringify(meta), status]);
  return Boolean(next);
};

// Ejecuta una acción con el estado bloqueado y avisa el cambio por Redis al terminar.
const mutate = async (venueId, fn) => {
  const result = await withTransaction(async (client) => fn(client, await lockState(client, venueId)));
  void publishPlayerUpdate(venueId);
  return result;
};

export const claimConsole = (venueId, consoleId) => mutate(venueId, (client) =>
  client.query('UPDATE player_state SET console_id=$2, updated_at=NOW() WHERE establishment_id=$1', [venueId, consoleId]));

export const play = (venueId, { consoleId, positionSeconds }) => mutate(venueId, async (client, state) => {
  checkConsole(state, consoleId);
  if (!state.current_track_id) {
    if (!(await moveToNext(client, venueId, state, 'ended', 'playing'))) throw new AppError(409, 'La cola está vacía: agrega pistas o activa el AutoDJ.');
    return;
  }
  const position = positionSeconds ?? livePosition(state);
  await client.query("UPDATE player_state SET status='playing', position_seconds=$2, started_at=NOW(), updated_at=NOW() WHERE establishment_id=$1", [venueId, position]);
});

export const pause = (venueId, { consoleId, positionSeconds }) => mutate(venueId, async (client, state) => {
  checkConsole(state, consoleId);
  const position = positionSeconds ?? livePosition(state);
  await client.query("UPDATE player_state SET status='paused', position_seconds=$2, started_at=NULL, updated_at=NOW() WHERE establishment_id=$1", [venueId, position]);
});

// Saltar o avanzar. Con fromTrackId solo actúa si esa pista sigue siendo la actual: si dos avisos llegan
// a la vez (fin de pista y botón), la cola avanza una sola vez. Devuelve si avanzó.
export const advance = (venueId, { consoleId, fromTrackId, reason = 'ended' }) => mutate(venueId, async (client, state) => {
  checkConsole(state, consoleId);
  if (fromTrackId !== undefined && fromTrackId !== state.current_track_id) return false;
  await moveToNext(client, venueId, state, reason, state.status === 'stopped' ? 'playing' : state.status);
  return true;
});

export const updateSettings = (venueId, { volume, mode, crossfadeSeconds }) => mutate(venueId, (client) => client.query(
  `UPDATE player_state SET volume=COALESCE($2, volume), mode=COALESCE($3::player_mode, mode), crossfade_seconds=COALESCE($4, crossfade_seconds), updated_at=NOW()
   WHERE establishment_id=$1`, [venueId, volume ?? null, mode ?? null, crossfadeSeconds ?? null]));

// Agrega una pista al final de la cola (o en la posición de una petición, intercalada).
export const enqueue = (venueId, track, { source = 'manual', requestId = null, score = null, reason = null, transitionAtSeconds = null, crossfadeSeconds = null } = {}) =>
  mutate(venueId, async (client) => {
    const queue = (await client.query('SELECT id, source FROM play_queue WHERE establishment_id=$1 ORDER BY position, created_at', [venueId])).rows;
    const inserted = (await client.query(
      `INSERT INTO play_queue(establishment_id, track_id, position, source, request_id, score, reason, transition_at_seconds, crossfade_seconds)
       VALUES($1,$2,$3,$4::queue_source,$5,$6,$7,$8,$9) RETURNING id`,
      [venueId, track.id, queue.length + 1, source, requestId, score, reason, transitionAtSeconds, crossfadeSeconds])).rows[0];
    if (source === 'request') await applyOrder(client, venueId, insertAt(queue.map((q) => q.id), requestInsertIndex(queue), inserted.id));
    return inserted.id;
  });

export const reorderQueue = (venueId, order) => mutate(venueId, async (client) => {
  const ids = (await client.query('SELECT id FROM play_queue WHERE establishment_id=$1 FOR UPDATE', [venueId])).rows.map((r) => r.id);
  await applyOrder(client, venueId, reorderPositions(ids, order).map((p) => p.id));
});

export const removeFromQueue = (venueId, itemId) => mutate(venueId, async (client) => {
  const r = await client.query('DELETE FROM play_queue WHERE id=$1 AND establishment_id=$2', [itemId, venueId]);
  if (!r.rowCount) throw new AppError(404, 'Esa pista ya no está en la cola.');
  await renumber(client, venueId);
});

// Datos para el AutoDJ: estado, cola actual e historial reciente (ids y artistas) del local.
export const autodjContext = async (venueId, recentLimit) => {
  const [state, queue, recent] = await Promise.all([
    query('SELECT s.mode, s.status, row_to_json(t.*) AS track FROM player_state s LEFT JOIN track_cache t ON t.id = s.current_track_id WHERE s.establishment_id=$1', [venueId]),
    loadQueue({ query }, venueId),
    query('SELECT h.track_id, t.artist FROM mix_history h JOIN track_cache t ON t.id = h.track_id WHERE h.establishment_id=$1 ORDER BY h.played_at DESC LIMIT $2', [venueId, recentLimit]),
  ]);
  return { state: state.rows[0] ?? null, queue, recent: recent.rows };
};
