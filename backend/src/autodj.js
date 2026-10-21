import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { config } from './config.js';
import { query } from './db.js';
import { redis } from './redis.js';
import { grpcEnabled, suggestNext } from './ai-client.js';
import { autodjContext, enqueue } from './player.js';
import { cachedCandidates, findFreeVersion, radioFallback, searchCatalog } from './music-catalog.js';
import { tagsForGenre, tagsForVenue } from './catalog-logic.js';
import { MIN_QUEUE, RECENT_LIMIT, defaultTransition, pickFallback, toFeatures } from './player-logic.js';

// AutoDJ: mantiene al menos MIN_QUEUE pistas en la cola de cada local. Solo se ejecuta por eventos
// (avanzar, saltar, quitar, cambiar a AutoDJ, petición aceptada, primera carga de la consola): sin temporizadores.
const MIN_CANDIDATES = 20;
const MAX_CANDIDATES = 120;
const LOCK_SECONDS = 30;
const PREFER_SECONDS = 30 * 60;
const preferKey = (venueId) => `autodj:prefer:${venueId}`;
// Si el motor falla, no se le vuelve a preguntar durante un minuto: cada intento esperaría el timeout de conexión
// y la consola tardaría en recibir la respuesta de "saltar" o "avanzar".
const ENGINE_RETRY_MS = 60 * 1000;
let engineDownUntil = 0;

// Pide la siguiente pista al motor (gRPC o HTTP); si falla, elige por género y energía sin repetir.
const choose = async (venue, current, candidates, recentIds, recentArtists, crossfadeSeconds) => {
  const request = {
    venue_type: venue.kind, current: toFeatures(current), candidates: candidates.slice(0, 200).map(toFeatures),
    recent_ids: recentIds.filter(Boolean), recent_artists: recentArtists.filter(Boolean).slice(0, 10),
  };
  if (Date.now() >= engineDownUntil) {
    try {
      const result = grpcEnabled()
        ? await suggestNext(request)
        : (await axios.post(`${config.aiUrl}/suggest-next`, request, { timeout: config.aiGrpcTimeoutMs })).data;
      const track = candidates.find((c) => c.id === result?.track_id);
      if (track) {
        return { track, score: result.score, reason: result.reason, transitionAtSeconds: result.transition_at_seconds, crossfadeSeconds: result.crossfade_seconds };
      }
    } catch (err) {
      engineDownUntil = Date.now() + ENGINE_RETRY_MS;
      console.error(`El motor no pudo sugerir la siguiente pista del local ${venue.id}; uso el respaldo por género durante un minuto:`, err.message);
    }
  }
  const track = pickFallback({ candidates, venueKind: venue.kind, venueTags: tagsForVenue(venue.kind), recentIds, recentArtists });
  if (!track) return null;
  return { track, score: null, reason: 'Elegida por género y energía del local (motor no disponible).', ...defaultTransition(track.duration_seconds, crossfadeSeconds) };
};

// Candidatas: primero las guardadas; si son pocas, una búsqueda por género (cacheada 24 h);
// si no hay nada (Jamendo caído y sin caché), la pista de la radio de Jamendo del local.
const loadCandidates = async (venue, tags, excludeIds) => {
  const exclude = new Set(excludeIds);
  let candidates = await cachedCandidates({ tags, excludeIds: [...exclude], excludeNonCommercial: venue.exclude_non_commercial, limit: MAX_CANDIDATES });
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

// Rellena la cola del local. Nunca lanza: un fallo del AutoDJ no debe romper la acción que lo disparó.
export const ensureQueue = async (venue) => {
  const lockKey = `autodj:lock:${venue.id}`;
  const token = randomUUID();
  // Si Redis no responde se sigue sin candado: la transacción de enqueue protege la cola igual.
  const locked = await redis.set(lockKey, token, 'EX', LOCK_SECONDS, 'NX').catch(() => 'OK');
  if (!locked) return 0;
  let added = 0;
  try {
    const { state, queue, recent } = await autodjContext(venue.id, RECENT_LIMIT);
    if (!state || state.mode !== 'autodj' || queue.length >= MIN_QUEUE) return 0;
    const preferred = await redis.get(preferKey(venue.id)).catch(() => null);
    const preferredTags = preferred ? tagsForGenre(preferred) : [];
    const tags = [...new Set([...preferredTags, ...tagsForVenue(venue.kind)])];
    const exclude = [state.track?.id, ...queue.map((q) => q.id)].filter(Boolean);
    let candidates = await loadCandidates(venue, tags, exclude);
    const recentIds = [...recent.map((r) => r.track_id), ...exclude];
    const recentArtists = [...queue.map((q) => q.artist).reverse(), state.track?.artist, ...recent.map((r) => r.artist)];
    // La referencia de continuidad es la última pista de la cola. Si hay un género pedido que no está
    // en el catálogo libre, la primera elección lo usa como referencia para acercarse a ese estilo.
    let current = queue.at(-1) ?? state.track ?? null;
    if (preferredTags.length) current = { ...(current ?? {}), id: current?.id ?? '', genre: preferredTags[0] };
    for (let i = queue.length; i < MIN_QUEUE && candidates.length; i += 1) {
      const pick = await choose(venue, current, candidates, recentIds, recentArtists, state.crossfade_seconds);
      if (!pick) break;
      await enqueue(venue.id, pick.track, { source: 'autodj', score: pick.score, reason: pick.reason, transitionAtSeconds: pick.transitionAtSeconds, crossfadeSeconds: pick.crossfadeSeconds });
      added += 1;
      candidates = candidates.filter((c) => c.id !== pick.track.id);
      recentIds.push(pick.track.id);
      recentArtists.unshift(pick.track.artist);
      current = pick.track;
    }
    if (preferred && added) await redis.del(preferKey(venue.id)).catch(() => {});
  } catch (err) {
    console.error(`El AutoDJ no pudo rellenar la cola del local ${venue.id}:`, err.message);
  } finally {
    const owner = await redis.get(lockKey).catch(() => null);
    if (owner === token) await redis.del(lockKey).catch(() => {});
  }
  return added;
};

// Petición aceptada por el dueño: si la canción existe en el catálogo libre se intercala en la cola;
// si no, el AutoDJ favorece su género durante 30 minutos. Devuelve el aviso para el panel.
export const scheduleAcceptedRequest = async (venue, request) => {
  try {
    const track = await findFreeVersion({ title: request.title, artist: request.artist, excludeNonCommercial: venue.exclude_non_commercial });
    if (track) {
      const already = await query('SELECT 1 FROM play_queue WHERE establishment_id=$1 AND track_id=$2 UNION ALL SELECT 1 FROM player_state WHERE establishment_id=$1 AND current_track_id=$2 LIMIT 1', [venue.id, track.id]);
      if (already.rowCount) return { queued: true, message: 'La canción ya está sonando o en la cola de la emisora.' };
      await enqueue(venue.id, track, { source: 'request', requestId: request.id, reason: 'Pedida por el público.', ...defaultTransition(track.duration_seconds) });
      return { queued: true, message: 'La canción está en el catálogo libre y entró a la cola de la emisora.' };
    }
  } catch (err) {
    console.error(`No se pudo buscar la petición ${request.id} en el catálogo libre:`, err.message);
  }
  if (request.genre) await redis.set(preferKey(venue.id), request.genre, 'EX', PREFER_SECONDS).catch(() => {});
  void ensureQueue(venue);
  return { queued: false, message: 'No está en el catálogo libre: la emisora pondrá música de un estilo parecido.' };
};
