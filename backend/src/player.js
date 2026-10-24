import { query, withTransaction } from './db.js';
import { redis } from './redis.js';
import { AppError } from './errors.js';
import { autoRequestsReady, hasColumn } from './schema-check.js';
import { toPublicTrack } from './catalog-logic.js';
import { insertAt, livePosition, reorderPositions, requestInsertIndex } from './player-logic.js';
import { MAX_PLAY_FAILURES, layoutQueue, planRequestOrder, queueEta, remainingOfCurrent } from './request-priority.js';
import { createMemo } from './memo.js';
import { logger } from './logger.js';

// Estado del reproductor y cola de cada local (migración 006). Toda escritura va en una transacción
// con la fila de player_state bloqueada (FOR UPDATE), así dos consolas no avanzan la cola a la vez.

export const publishPlayerUpdate = (venueId) =>
  redis
    .publish(`venue:${venueId}`, JSON.stringify({ type: 'player_updated' }))
    .catch((err) => logger.error('No se pudo avisar el cambio del reproductor', { err: err }));

const ensureState = (db, venueId) => db.query('INSERT INTO player_state(establishment_id) VALUES($1) ON CONFLICT DO NOTHING', [venueId]);
// Crea el estado del reproductor si aún no existe (primera vez que el dueño abre la consola).
export const ensurePlayerState = (venueId) => ensureState({ query }, venueId);
const lockState = async (client, venueId) => {
  await ensureState(client, venueId);
  return (await client.query('SELECT * FROM player_state WHERE establishment_id=$1 FOR UPDATE', [venueId])).rows[0];
};

// Cada pista de la cola con su petición (si vino del público): quién la pidió, votos y datos para ordenarla.
const queueSql = () => {
  const extra = autoRequestsReady()
    ? ', r.votes AS request_votes, r.passed_count AS request_passed, r.owner_priority AS request_priority'
    : '';
  return `SELECT q.id AS queue_id, q.position, q.source, q.request_id, q.score, q.reason, q.transition_at_seconds, q.crossfade_seconds, t.*,
    r.guest_name AS request_guest, r.created_at AS request_created_at${extra}
  FROM play_queue q JOIN track_cache t ON t.id = q.track_id LEFT JOIN song_requests r ON r.id = q.request_id
  WHERE q.establishment_id=$1 ORDER BY q.position, q.created_at LIMIT $2`;
};
export const loadQueue = async (db, venueId, limit = 100) => (await db.query(queueSql(), [venueId, limit])).rows;

const num = (value) => (value === null || value === undefined ? null : Number(value));
const toQueueItem = (row, options, eta) => ({
  id: row.queue_id,
  position: row.position,
  etaSeconds: eta?.etaSeconds ?? null,
  source: row.source,
  requestId: row.request_id,
  votes: row.request_votes ?? (row.request_id ? 1 : null),
  score: row.score,
  reason: row.reason,
  transitionAtSeconds: num(row.transition_at_seconds),
  crossfadeSeconds: num(row.crossfade_seconds),
  track: toPublicTrack(row, options),
});

// Foto completa del reproductor. withAudio=false (página pública) quita URLs de audio, ids de petición y consola.
export const playerSnapshot = async (venueId, { withAudio = true, queueLimit = 100, create = true } = {}) => {
  if (create) await ensureState({ query }, venueId);
  const [stateResult, queue] = await Promise.all([
    query(
      'SELECT s.*, row_to_json(t.*) AS track FROM player_state s LEFT JOIN track_cache t ON t.id = s.current_track_id WHERE s.establishment_id=$1',
      [venueId],
    ),
    loadQueue({ query }, venueId, queueLimit),
  ]);
  const state = stateResult.rows[0];
  if (!state) return null;
  const meta = state.current_meta ?? {};
  const position = livePosition(state);
  const etas = queueEta(queue, { remainingSeconds: remainingOfCurrent(state, position) });
  const items = queue.map((row, i) => toQueueItem(row, { withAudio }, etas[i]));
  return {
    status: state.status,
    mode: state.mode,
    volume: state.volume,
    crossfadeSeconds: state.crossfade_seconds,
    positionSeconds: position,
    updatedAt: state.updated_at,
    current: state.track
      ? {
          track: toPublicTrack(state.track, { withAudio }),
          source: meta.source ?? null,
          reason: meta.reason ?? null,
          score: meta.score ?? null,
          transitionAtSeconds: meta.transitionAtSeconds ?? null,
          crossfadeSeconds: meta.crossfadeSeconds ?? null,
          startedAt: state.started_at,
        }
      : null,
    queue: withAudio ? items : items.map(({ requestId: _r, ...item }) => item),
    ...(withAudio ? { consoleId: state.console_id } : {}),
  };
};

// Si la petición trae consoleId y otra consola tiene el control, se rechaza (evita dos pestañas sonando).
const checkConsole = (state, consoleId) => {
  if (consoleId && state.console_id && state.console_id !== consoleId) {
    throw new AppError(409, 'La emisora se está reproduciendo en otra consola. Toma el control para seguir aquí.', {
      code: 'console_taken',
    });
  }
};

const renumber = (client, venueId) =>
  client.query(
    `UPDATE play_queue q SET position = s.rn FROM (SELECT id, row_number() OVER (ORDER BY position, created_at) AS rn FROM play_queue WHERE establishment_id=$1) s
   WHERE q.id = s.id AND q.position IS DISTINCT FROM s.rn`,
    [venueId],
  );
const applyOrder = (client, venueId, ids) =>
  client.query(
    'UPDATE play_queue q SET position = o.pos FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, pos) WHERE q.id = o.id AND q.establishment_id=$1',
    [venueId, ids],
  );

// La petición del público que empieza a sonar queda como "sonada" (la página pública la deja de mostrar en la cola).
const markRequestPlayed = (client, requestId) => {
  const sets = ["status='played'"];
  if (hasColumn('song_requests.played_at')) sets.push('played_at=NOW()');
  if (hasColumn('song_requests.status_updated_at')) sets.push('status_updated_at=NOW()');
  // Los votos (peticiones repetidas de la misma canción) quedan sonadas junto con la original.
  const target = hasColumn('song_requests.duplicate_of') ? '(id=$1 OR duplicate_of=$1)' : 'id=$1';
  return client.query(`UPDATE song_requests SET ${sets.join(',')} WHERE ${target}`, [requestId]);
};

// Una petición que no cargó (error) se reintenta una vez; con el segundo fallo queda "No se pudo reproducir"
// junto con sus votos, y la emisora sigue con la siguiente pista.
const markRequestFailed = (client, requestId) =>
  client.query(
    `UPDATE song_requests SET play_failures = play_failures + 1,
       status = CASE WHEN play_failures + 1 >= $2 THEN 'rejected'::request_status ELSE status END,
       ai_reason = CASE WHEN play_failures + 1 >= $2 THEN 'No se pudo reproducir.' ELSE ai_reason END
     WHERE id=$1 OR duplicate_of=$1`,
    [requestId, MAX_PLAY_FAILURES],
  );

// Orden justo: cuando suena una petición, las que llegaron antes y siguen esperando cuentan un aplazamiento más.
const countDeferrals = (client, venueId, requestId) =>
  client.query(
    `UPDATE song_requests p SET passed_count = passed_count + 1 FROM song_requests played
     WHERE played.id=$2 AND p.establishment_id=$1 AND p.id <> played.id AND p.duplicate_of IS NULL
       AND p.status IN ('accepted', 'bridging') AND p.created_at < played.created_at
       AND (p.not_before IS NULL OR p.not_before <= NOW())`,
    [venueId, requestId],
  );

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
      [
        venueId,
        state.current_track_id,
        state.current_meta?.source ?? null,
        endedReason !== 'ended',
        endedReason,
        ...(withRequest ? [requestId] : []),
      ],
    );
    if (requestId && PLAYED_REASONS.has(endedReason)) await markRequestPlayed(client, requestId);
    if (requestId && endedReason === 'error' && autoRequestsReady()) await markRequestFailed(client, requestId);
  }
  const next = (
    await client.query('SELECT * FROM play_queue WHERE establishment_id=$1 ORDER BY position, created_at LIMIT 1 FOR UPDATE', [venueId])
  ).rows[0];
  if (next) {
    await client.query('DELETE FROM play_queue WHERE id=$1', [next.id]);
    await renumber(client, venueId);
    if (next.request_id && autoRequestsReady()) await countDeferrals(client, venueId, next.request_id);
  }
  const meta = next
    ? {
        source: next.source,
        requestId: next.request_id,
        score: next.score,
        reason: next.reason,
        transitionAtSeconds: num(next.transition_at_seconds),
        crossfadeSeconds: num(next.crossfade_seconds),
      }
    : {};
  const status = next ? nextStatus : 'stopped';
  await client.query(
    `UPDATE player_state SET current_track_id=$2, current_meta=$3, position_seconds=0, status=$4::player_status,
     started_at=CASE WHEN $4='playing' THEN NOW() END, updated_at=NOW() WHERE establishment_id=$1`,
    [venueId, next?.track_id ?? null, JSON.stringify(meta), status],
  );
  return Boolean(next);
};

// Ejecuta una acción con el estado bloqueado y avisa el cambio por Redis al terminar.
const mutate = async (venueId, fn) => {
  const result = await withTransaction(async (client) => fn(client, await lockState(client, venueId)));
  void publishPlayerUpdate(venueId);
  return result;
};

export const claimConsole = (venueId, consoleId) =>
  mutate(venueId, (client) =>
    client.query('UPDATE player_state SET console_id=$2, updated_at=NOW() WHERE establishment_id=$1', [venueId, consoleId]),
  );

export const play = (venueId, { consoleId, positionSeconds }) =>
  mutate(venueId, async (client, state) => {
    checkConsole(state, consoleId);
    if (!state.current_track_id) {
      if (!(await moveToNext(client, venueId, state, 'ended', 'playing')))
        throw new AppError(409, 'La cola está vacía: agrega pistas o activa el AutoDJ.');
      return;
    }
    const position = positionSeconds ?? livePosition(state);
    await client.query(
      "UPDATE player_state SET status='playing', position_seconds=$2, started_at=NOW(), updated_at=NOW() WHERE establishment_id=$1",
      [venueId, position],
    );
  });

export const pause = (venueId, { consoleId, positionSeconds }) =>
  mutate(venueId, async (client, state) => {
    checkConsole(state, consoleId);
    const position = positionSeconds ?? livePosition(state);
    await client.query(
      "UPDATE player_state SET status='paused', position_seconds=$2, started_at=NULL, updated_at=NOW() WHERE establishment_id=$1",
      [venueId, position],
    );
  });

// Saltar o avanzar. Con fromTrackId solo actúa si esa pista sigue siendo la actual: si dos avisos llegan
// a la vez (fin de pista y botón), la cola avanza una sola vez. Devuelve si avanzó.
export const advance = (venueId, { consoleId, fromTrackId, reason = 'ended' }) =>
  mutate(venueId, async (client, state) => {
    checkConsole(state, consoleId);
    if (fromTrackId !== undefined && fromTrackId !== state.current_track_id) return false;
    await moveToNext(client, venueId, state, reason, state.status === 'stopped' ? 'playing' : state.status);
    return true;
  });

export const updateSettings = (venueId, { volume, mode, crossfadeSeconds }) =>
  mutate(venueId, (client) =>
    client.query(
      `UPDATE player_state SET volume=COALESCE($2, volume), mode=COALESCE($3::player_mode, mode), crossfade_seconds=COALESCE($4, crossfade_seconds), updated_at=NOW()
   WHERE establishment_id=$1`,
      [venueId, volume ?? null, mode ?? null, crossfadeSeconds ?? null],
    ),
  );

// Agrega una pista al final de la cola (o en la posición de una petición, intercalada).
// next=true la pone primera ("Reproducir ahora": la consola pasa a ella enseguida).
export const enqueue = (
  venueId,
  track,
  {
    source = 'manual',
    requestId = null,
    score = null,
    reason = null,
    transitionAtSeconds = null,
    crossfadeSeconds = null,
    next = false,
  } = {},
) =>
  mutate(venueId, async (client) => {
    const queue = (
      await client.query('SELECT id, source FROM play_queue WHERE establishment_id=$1 ORDER BY position, created_at', [venueId])
    ).rows;
    const inserted = (
      await client.query(
        `INSERT INTO play_queue(establishment_id, track_id, position, source, request_id, score, reason, transition_at_seconds, crossfade_seconds)
       VALUES($1,$2,$3,$4::queue_source,$5,$6,$7,$8,$9) RETURNING id`,
        [venueId, track.id, queue.length + 1, source, requestId, score, reason, transitionAtSeconds, crossfadeSeconds],
      )
    ).rows[0];
    if (next)
      await applyOrder(
        client,
        venueId,
        insertAt(
          queue.map((q) => q.id),
          0,
          inserted.id,
        ),
      );
    else if (source === 'request')
      await applyOrder(
        client,
        venueId,
        insertAt(
          queue.map((q) => q.id),
          requestInsertIndex(queue),
          inserted.id,
        ),
      );
    return inserted.id;
  });

// Sube a la primera posición la pista de una petición que ya estaba en la cola ("Reproducir ahora").
export const moveRequestFirst = (venueId, requestId) =>
  mutate(venueId, async (client) => {
    const rows = (
      await client.query('SELECT id, request_id FROM play_queue WHERE establishment_id=$1 ORDER BY position, created_at FOR UPDATE', [
        venueId,
      ])
    ).rows;
    const item = rows.find((r) => r.request_id === requestId);
    if (!item) throw new AppError(404, 'Esa petición ya no está en la cola.');
    await applyOrder(client, venueId, [item.id, ...rows.filter((r) => r !== item).map((r) => r.id)]);
  });

export const reorderQueue = (venueId, order) =>
  mutate(venueId, async (client) => {
    const ids = (await client.query('SELECT id FROM play_queue WHERE establishment_id=$1 FOR UPDATE', [venueId])).rows.map((r) => r.id);
    await applyOrder(
      client,
      venueId,
      reorderPositions(ids, order).map((p) => p.id),
    );
  });

export const removeFromQueue = (venueId, itemId) =>
  mutate(venueId, async (client) => {
    const r = await client.query('DELETE FROM play_queue WHERE id=$1 AND establishment_id=$2 RETURNING request_id', [itemId, venueId]);
    if (!r.rowCount) throw new AppError(404, 'Esa pista ya no está en la cola.');
    await renumber(client, venueId);
    // Una petición que el dueño quita de la cola queda descartada (si no, el AutoDJ la volvería a meter).
    const requestId = r.rows[0].request_id;
    if (requestId) {
      const target = hasColumn('song_requests.duplicate_of') ? '(id=$1 OR duplicate_of=$1)' : 'id=$1';
      await client.query(`UPDATE song_requests SET status='rejected', ai_reason='El DJ la quitó de la cola.' WHERE ${target}`, [requestId]);
    }
    return requestId;
  });

// Reordena la cola con el algoritmo de prioridad (request-priority.js): primero las peticiones, en orden justo,
// con una pista de la IA cada balanceEvery cuando hay muchas, y al final las demás pistas de la IA.
// La primera de la cola no se mueve mientras algo suena: la consola ya puede tenerla precargada.
export const reorderRequests = (venueId, { maxDeferral, balanceEvery }) =>
  mutate(venueId, async (client, state) => {
    const queue = await loadQueue(client, venueId);
    const locked = state.status !== 'stopped' && state.current_track_id && queue.length ? queue[0] : null;
    const rest = locked ? queue.slice(1) : queue;
    const current = state.current_track_id
      ? (await client.query('SELECT * FROM track_cache WHERE id=$1', [state.current_track_id])).rows[0]
      : null;
    const requests = rest
      .filter((row) => row.source === 'request' && row.request_id)
      .map((row) => ({
        id: row.queue_id,
        createdAt: row.request_created_at,
        votes: row.request_votes,
        passed: row.request_passed,
        ownerPriority: row.request_priority,
        genre: row.genre,
        energy: row.energy,
      }));
    const requestIds = planRequestOrder(requests, { prev: locked ?? current, maxDeferral }).map((r) => r.id);
    const requestSet = new Set(requestIds);
    const otherIds = rest.filter((row) => !requestSet.has(row.queue_id)).map((row) => row.queue_id);
    const order = [...(locked ? [locked.queue_id] : []), ...layoutQueue(requestIds, otherIds, { balanceEvery })];
    const changed = order.some((id, i) => id !== queue[i].queue_id);
    if (changed) await applyOrder(client, venueId, order);
    return changed;
  });

// Puesto y espera estimada de cada petición en la cola, para la página pública (se recalcula como mucho cada 1,5 s).
const positionsCache = createMemo({ ttlMs: 1500 });
export const requestPositions = (venueId) =>
  positionsCache.get(venueId, async () => {
    const snap = await playerSnapshot(venueId, { create: false });
    const positions = new Map();
    for (const item of snap?.queue ?? []) {
      if (item.requestId) positions.set(item.requestId, { position: item.position, etaSeconds: item.etaSeconds });
    }
    return positions;
  });

// Datos para el AutoDJ: estado, cola actual e historial reciente (ids y artistas) del local.
export const autodjContext = async (venueId, recentLimit) => {
  const [state, queue, recent] = await Promise.all([
    query(
      'SELECT s.mode, s.status, row_to_json(t.*) AS track FROM player_state s LEFT JOIN track_cache t ON t.id = s.current_track_id WHERE s.establishment_id=$1',
      [venueId],
    ),
    loadQueue({ query }, venueId),
    query(
      'SELECT h.track_id, t.artist FROM mix_history h JOIN track_cache t ON t.id = h.track_id WHERE h.establishment_id=$1 ORDER BY h.played_at DESC LIMIT $2',
      [venueId, recentLimit],
    ),
  ]);
  return { state: state.rows[0] ?? null, queue, recent: recent.rows };
};
