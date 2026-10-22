import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { config } from './config.js';
import { query } from './db.js';
import { redis } from './redis.js';
import { grpcEnabled, suggestNext } from './ai-client.js';
import { autodjContext, enqueue } from './player.js';
import { cachedCandidates, radioFallback, searchCatalog } from './music-catalog.js';
import { tagsForGenre, tagsForVenueProfile } from './catalog-logic.js';
import { MIN_QUEUE, RECENT_LIMIT, defaultTransition, pickFallback, toFeatures } from './player-logic.js';
import { hasColumn } from './schema-check.js';
import { pendingRequests, publishRequestChange, resolveRequestTrack, transitionFor } from './station-requests.js';

// AutoDJ: mantiene al menos MIN_QUEUE pistas en la cola de cada local. Solo se ejecuta por eventos
// (avanzar, saltar, quitar, cambiar a AutoDJ, petición aceptada, primera carga de la consola): sin temporizadores.
const MIN_CANDIDATES = 20;
const MAX_CANDIDATES = 120;
const LOCK_SECONDS = 30;
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
      console.error(
        `El motor no pudo sugerir la siguiente pista del local ${venue.id}; uso el respaldo por género durante un minuto:`,
        err.message,
      );
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
      console.error(`No se pudieron buscar pistas nuevas para el local ${venue.id}:`, err.message);
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
      console.error(`No se pudo preparar la petición ${request.id}:`, err.message);
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

// Rellena la cola del local. Nunca lanza: un fallo del AutoDJ no debe romper la acción que lo disparó.
export const ensureQueue = async (venue) => {
  const lockKey = `autodj:lock:${venue.id}`;
  const token = randomUUID();
  // Si Redis no responde se sigue sin candado: la transacción de enqueue protege la cola igual.
  const locked = await redis.set(lockKey, token, 'EX', LOCK_SECONDS, 'NX').catch(() => 'OK');
  if (!locked) return 0;
  let added = 0;
  try {
    let { state, queue, recent } = await autodjContext(venue.id, RECENT_LIMIT);
    if (!state || state.mode !== 'autodj') return 0;
    const requests = hasColumn('song_requests.track_id') ? await pendingRequests(venue.id) : [];
    added += await interleaveRequests(venue, queue, new Set(recent.map((r) => r.track_id)), requests);
    if (added) ({ state, queue, recent } = await autodjContext(venue.id, RECENT_LIMIT));
    if (queue.length >= MIN_QUEUE) return added;
    const hints = requestHints(requests);
    const tags = [...new Set([...hints.genres.flatMap(tagsForGenre), ...tagsForVenueProfile(venue)])];
    // Las pistas de peticiones pendientes no son candidatas: deben sonar como petición (y quedar "sonadas").
    const exclude = [state.track?.id, ...queue.map((q) => q.id), ...requests.map((r) => r.track_id)].filter(Boolean);
    let candidates = await loadCandidates(venue, tags, exclude);
    const recentIds = [...recent.map((r) => r.track_id), ...exclude];
    const recentArtists = [...queue.map((q) => q.artist).reverse(), state.track?.artist, ...recent.map((r) => r.artist)];
    let current = queue.at(-1) ?? state.track ?? null;
    for (let i = queue.length; i < MIN_QUEUE && candidates.length; i += 1) {
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
  } catch (err) {
    console.error(`El AutoDJ no pudo rellenar la cola del local ${venue.id}:`, err.message);
  } finally {
    const owner = await redis.get(lockKey).catch(() => null);
    if (owner === token) await redis.del(lockKey).catch(() => {});
  }
  return added;
};

// Después de evaluar una petición (worker): si el local tiene emisora en AutoDJ, se intenta intercalar.
export const afterRequestEvaluated = async (venueId) => {
  if (!hasColumn('player_state.establishment_id')) return;
  const venue = (await query('SELECT * FROM establishments WHERE id=$1', [venueId])).rows[0];
  if (venue) await ensureQueue(venue);
};
