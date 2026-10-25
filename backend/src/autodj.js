import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { config } from './config.js';
import { query } from './db.js';
import { redis } from './redis.js';
import { grpcEnabled, suggestNext } from './ai-client.js';
import { autodjContext, enqueue, reorderRequests } from './player.js';
import { cachedCandidates, radioFallback, searchCatalog } from './music-catalog.js';
import { tagsForGenre, tagsForVenueProfile } from './catalog-logic.js';
import { MIN_QUEUE, RECENT_LIMIT, defaultTransition, pickFallback, toFeatures } from './player-logic.js';
import { autoRequestsReady, hasColumn } from './schema-check.js';
import {
  autoAcceptsRequests,
  autoQueueRequests,
  pendingRequests,
  publishRequestChange,
  resolveRequestTrack,
  transitionFor,
} from './station-requests.js';
import { aiTracksNeeded } from './request-priority.js';
import { logger } from './logger.js';

// AutoDJ: mantiene al menos MIN_QUEUE pistas en la cola de cada local. Solo se ejecuta por eventos
// (avanzar, saltar, quitar, cambiar a AutoDJ, petición aceptada, primera carga de la consola): sin temporizadores.
const MIN_CANDIDATES = 20;
const MAX_CANDIDATES = 120;
const LOCK_SECONDS = 30;
// Pistas de la IA que se piden al motor en una sola pasada (cada una es una llamada a SuggestNext).
const MAX_AI_PICKS = 8;
// Peticiones que el AutoDJ intercala solo (las que el motor aceptó); las demás las decide el dueño.
const MAX_REQUESTS_IN_QUEUE = 2;
// Si el motor falla, no se le vuelve a preguntar durante un minuto: cada intento esperaría el timeout de conexión
// y la consola tardaría en recibir la respuesta de "saltar" o "avanzar".
const ENGINE_RETRY_MS = 60 * 1000;
let engineDownUntil = 0;

// Pide la siguiente pista al motor (gRPC o HTTP); si falla, elige por género y energía sin repetir.
const choose = async (venue, current, candidates, recentIds, recentArtists, crossfadeSeconds, hints) => {
  const request = {
    venue_type: venue.kind,
    current: toFeatures(current),
    candidates: candidates.slice(0, 200).map(toFeatures),
    recent_ids: recentIds.filter(Boolean),
    recent_artists: recentArtists.filter(Boolean).slice(0, 10),
    request_genres: hints.genres,
    request_artists: hints.artists,
  };
  if (Date.now() >= engineDownUntil) {
    try {
      const result = grpcEnabled()
        ? await suggestNext(request)
        : (await axios.post(`${config.aiUrl}/suggest-next`, request, { timeout: config.aiGrpcTimeoutMs })).data;
      const track = candidates.find((c) => c.id === result?.track_id);
      if (track) {
        return {
          track,
          score: result.score,
          reason: result.reason,
          transitionAtSeconds: result.transition_at_seconds,
          crossfadeSeconds: result.crossfade_seconds,
        };
      }
    } catch (err) {
      engineDownUntil = Date.now() + ENGINE_RETRY_MS;
      logger.error('El motor no pudo sugerir la siguiente pista; uso el respaldo por género durante un minuto', { venueId: venue.id, err });
    }
  }
  const track = pickFallback({ candidates, venueKind: venue.kind, venueTags: tagsForVenueProfile(venue), recentIds, recentArtists });
  if (!track) return null;
  return {
    track,
    score: null,
    reason: 'Elegida por género y energía del local (motor no disponible).',
    ...defaultTransition(track.duration_seconds, crossfadeSeconds),
  };
};

// Candidatas: primero las guardadas; si son pocas, una búsqueda por género (cacheada 24 h);
// si no hay nada (Jamendo caído y sin caché), la pista de la radio de Jamendo del local.
const loadCandidates = async (venue, tags, excludeIds) => {
  const exclude = new Set(excludeIds);
  let candidates = await cachedCandidates({
    tags,
    excludeIds: [...exclude],
    excludeNonCommercial: venue.exclude_non_commercial,
    limit: MAX_CANDIDATES,
  });
  if (candidates.length < MIN_CANDIDATES) {
    try {
      const { tracks } = await searchCatalog({ tags, limit: 50, excludeNonCommercial: venue.exclude_non_commercial });
      const known = new Set(candidates.map((c) => c.id));
      candidates = [...candidates, ...tracks.filter((t) => !known.has(t.id) && !exclude.has(t.id))];
    } catch (err) {
      logger.error('No se pudieron buscar pistas nuevas', { venueId: venue.id, err });
    }
  }
  if (!candidates.length) {
    const radio = await radioFallback(venue.kind);
    if (radio && !exclude.has(radio.id) && !(venue.exclude_non_commercial && radio.non_commercial)) candidates = [radio];
  }
  return candidates;
};

// Géneros y artistas de las peticiones pendientes: orientan la elección del motor (SuggestNext).
const requestHints = (requests) => ({
  genres: [...new Set(requests.map((r) => r.genre).filter((g) => g && g !== 'Sin género'))].slice(0, 10),
  artists: [...new Set(requests.map((r) => r.artist).filter(Boolean))].slice(0, 10),
});

// Intercala las peticiones que el motor aceptó (encajan en género y energía), sin repetir pistas recientes.
const interleaveRequests = async (venue, queue, recentIds, requests) => {
  let inQueue = queue.filter((q) => q.source === 'request').length;
  let added = 0;
  for (const request of requests) {
    if (inQueue >= MAX_REQUESTS_IN_QUEUE) break;
    if (request.status !== 'accepted' || request.in_queue || request.playing) continue;
    const track = await resolveRequestTrack(venue, request).catch((err) => {
      logger.error('No se pudo preparar la petición', { requestId: request.id, err });
      return null;
    });
    if (!track || recentIds.has(track.id)) continue;
    await enqueue(venue.id, track, {
      source: 'request',
      requestId: request.id,
      reason: 'Petición del público: encaja con el ambiente.',
      ...transitionFor(track),
    });
    void publishRequestChange(venue.id, request.id);
    inQueue += 1;
    added += 1;
  }
  return added;
};

// Una pasada del AutoDJ: mete las peticiones listas, completa con pistas de la IA y reordena. Devuelve cuántas agregó.
const fillQueue = async (venue) => {
  let added = 0;
  let { state, queue, recent } = await autodjContext(venue.id, RECENT_LIMIT);
  if (!state || state.mode !== 'autodj') return 0;
  const requests = hasColumn('song_requests.track_id') ? await pendingRequests(venue.id) : [];
  // Con "Aceptar peticiones automáticamente" (010) toda petición lista entra a la cola y luego se ordena.
  // Con el interruptor apagado decide el dueño. Sin la 010 se mantiene el intercalado anterior (solo las que encajan).
  const auto = autoAcceptsRequests(venue, state.mode);
  if (auto) added += await autoQueueRequests(venue, requests);
  else if (!autoRequestsReady()) added += await interleaveRequests(venue, queue, new Set(recent.map((r) => r.track_id)), requests);
  if (added) ({ state, queue, recent } = await autodjContext(venue.id, RECENT_LIMIT));
  const requestCount = queue.filter((q) => q.source === 'request').length;
  const picksNeeded = auto
    ? Math.min(
        MAX_AI_PICKS,
        aiTracksNeeded(requestCount, { minQueue: MIN_QUEUE, balanceEvery: config.requests.balanceEvery }) - (queue.length - requestCount),
      )
    : MIN_QUEUE - queue.length;
  if (picksNeeded <= 0) {
    if (auto) await reorderRequests(venue.id, config.requests);
    return added;
  }
  const hints = requestHints(requests);
  const tags = [...new Set([...hints.genres.flatMap(tagsForGenre), ...tagsForVenueProfile(venue)])];
  // Las pistas de peticiones pendientes no son candidatas: deben sonar como petición (y quedar "sonadas").
  const exclude = [state.track?.id, ...queue.map((q) => q.id), ...requests.map((r) => r.track_id)].filter(Boolean);
  let candidates = await loadCandidates(venue, tags, exclude);
  const recentIds = [...recent.map((r) => r.track_id), ...exclude];
  const recentArtists = [...queue.map((q) => q.artist).reverse(), state.track?.artist, ...recent.map((r) => r.artist)];
  let current = queue.at(-1) ?? state.track ?? null;
  for (let i = 0; i < picksNeeded && candidates.length; i += 1) {
    const pick = await choose(venue, current, candidates, recentIds, recentArtists, state.crossfade_seconds, hints);
    if (!pick) break;
    await enqueue(venue.id, pick.track, {
      source: 'autodj',
      score: pick.score,
      reason: pick.reason,
      transitionAtSeconds: pick.transitionAtSeconds,
      crossfadeSeconds: pick.crossfadeSeconds,
    });
    added += 1;
    candidates = candidates.filter((c) => c.id !== pick.track.id);
    recentIds.push(pick.track.id);
    recentArtists.unshift(pick.track.artist);
    current = pick.track;
  }
  if (auto) await reorderRequests(venue.id, config.requests);
  return added;
};

// Rellena la cola del local. Nunca lanza: un fallo del AutoDJ no debe romper la acción que lo disparó.
// Si otro proceso ya está rellenando (candado), se le pide una pasada más: así una petición evaluada mientras
// tanto entra enseguida y no espera al siguiente evento de la emisora.
const MAX_PASSES = 5;
export const ensureQueue = async (venue) => {
  const lockKey = `autodj:lock:${venue.id}`;
  const againKey = `autodj:again:${venue.id}`;
  const token = randomUUID();
  // Si Redis no responde se sigue sin candado: la transacción de enqueue protege la cola igual.
  const locked = await redis.set(lockKey, token, 'EX', LOCK_SECONDS, 'NX').catch(() => 'OK');
  if (!locked) {
    await redis.set(againKey, '1', 'EX', LOCK_SECONDS).catch(() => {});
    return 0;
  }
  let added = 0;
  try {
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      await redis.del(againKey).catch(() => {});
      added += await fillQueue(venue);
      if (!(await redis.exists(againKey).catch(() => 0))) break;
    }
  } catch (err) {
    logger.error('El AutoDJ no pudo rellenar la cola', { venueId: venue.id, err });
  } finally {
    const owner = await redis.get(lockKey).catch(() => null);
    if (owner === token) await redis.del(lockKey).catch(() => {});
  }
  // Un pedido de pasada que llegó justo al soltar el candado no se pierde.
  if (await redis.exists(againKey).catch(() => 0)) added += await ensureQueue(venue);
  return added;
};

// Después de evaluar una petición (worker): si el local tiene emisora en AutoDJ, se intenta intercalar.
export const afterRequestEvaluated = async (venueId) => {
  if (!hasColumn('player_state.establishment_id')) return;
  const venue = (await query('SELECT * FROM establishments WHERE id=$1', [venueId])).rows[0];
  if (venue) await ensureQueue(venue);
};
