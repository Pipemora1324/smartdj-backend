import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requestQueue, evaluationJobOptions } from '../queue.js';
import { AppError } from '../errors.js';
import { LIMITS, createLimiter } from '../rate-limits.js';
import { redis } from '../redis.js';
import { publishRequestEvent } from '../request-status.js';
import { lookupTrack, searchTracks } from '../music-search.js';
import { hasColumn } from '../schema-check.js';
import { playerSnapshot } from '../player.js';
import { findVenue } from '../venue-lookup.js';
import { availableProviders, findCachedTrack, searchCatalog } from '../music-catalog.js';
import { requestsByIds } from '../station-requests.js';
import { toStationRequest } from '../player-logic.js';
import { requestIdsSchema } from '../owner-validation.js';
import { SEARCH_MIN_FULL, mergeSearchResults, toPublicTrack } from '../catalog-logic.js';
import { logger } from '../logger.js';
// BPM y tonalidad son opcionales: "", null o espacios cuentan como "sin dato".
const emptyToUndefined = (v) => (v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v);
const router = Router();
const optionalText = (max) => z.preprocess(emptyToUndefined, z.string().trim().min(1).max(max).optional());
// Con trackId (buscador) los datos de la canción se vuelven a pedir a iTunes; title/artist queda para clientes viejos.
const payload = z
  .object({
    guestName: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .trim()
        .min(2, 'El nombre debe tener al menos 2 caracteres.')
        .max(60, 'El nombre puede tener hasta 60 caracteres.')
        .optional(),
    ),
    trackId: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .trim()
        .regex(/^\d{1,20}$/, 'La canción elegida no es válida.')
        .optional(),
    ),
    // Pista completa del catálogo libre (Jamendo), elegida en el buscador.
    provider: z.preprocess(
      emptyToUndefined,
      z.enum(['jamendo'], { errorMap: () => ({ message: 'La canción elegida no es válida.' }) }).optional(),
    ),
    externalId: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .trim()
        .regex(/^\d{1,12}$/, 'La canción elegida no es válida.')
        .optional(),
    ),
    title: optionalText(140),
    artist: optionalText(140),
    genre: optionalText(60),
    bpm: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(300).optional()),
    musicalKey: z.preprocess(emptyToUndefined, z.string().trim().max(15).optional()),
  })
  .refine((d) => d.trackId || (d.provider && d.externalId) || (d.title && d.artist), { message: 'Elige una canción del buscador.' });
const searchQuery = z
  .string({ required_error: 'Escribe qué canción buscas.', invalid_type_error: 'Escribe qué canción buscas.' })
  .trim()
  .min(2, 'Escribe al menos 2 caracteres.')
  .max(100, 'La búsqueda puede tener hasta 100 caracteres.');
const requestLimiter = createLimiter(LIMITS.publicRequest);
const searchLimiter = createLimiter(LIMITS.publicSearch);
const nowLimiter = createLimiter(LIMITS.publicRead);
const SEARCH_CACHE_SECONDS = 600;

// Caché corta en Redis para no repetir la misma búsqueda contra iTunes; si Redis falla, se busca directo.
const cachedSearch = async (term) => {
  const key = `music-search:${term.toLowerCase()}`;
  const cached = await redis.get(key).catch(() => null);
  if (cached) return JSON.parse(cached);
  const tracks = await searchTracks(term);
  await redis.set(key, JSON.stringify(tracks), 'EX', SEARCH_CACHE_SECONDS).catch(() => {});
  return tracks;
};
// Inserta la petición; las columnas de la canción solo si la migración 004 ya se aplicó.
const insertRequest = async (venueId, guestName, song, extra) => {
  const columns = ['establishment_id', 'guest_name', 'title', 'artist', 'genre', 'bpm', 'musical_key'];
  const values = [venueId, guestName, song.title, song.artist, song.genre, extra.bpm || null, extra.musicalKey || null];
  for (const [column, value] of [
    ['external_id', song.trackId],
    ['artwork_url', song.artworkUrl],
    ['preview_url', song.previewUrl],
    ['provider', song.provider],
    ['track_id', song.trackCacheId],
    ['store_url', song.storeUrl],
  ]) {
    // Sin valor se omite la columna y Postgres usa su valor por defecto (provider es NOT NULL con 'itunes').
    if (hasColumn(`song_requests.${column}`) && value !== undefined) {
      columns.push(column);
      values.push(value);
    }
  }
  const r = await query(
    `INSERT INTO song_requests(${columns.join(',')}) VALUES(${values.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    values,
  );
  return r.rows[0];
};

router.get('/venues/:code', nowLimiter, async (req, res, next) => {
  try {
    res.json(await findVenue(req.params.code));
  } catch (e) {
    next(e);
  }
});
// Interfaz de DJ del link público: lo que suena (última marcada como sonada) y la cola de aceptadas.
// Sin nombres de invitados. Sin la migración 005 se ordena por evaluated_at.
const NOW_QUEUE_LIMIT = 10;
const publicSong = (r) => ({
  id: r.id,
  title: r.title,
  artist: r.artist,
  genre: r.genre,
  artworkUrl: r.artwork_url ?? null,
  previewUrl: r.preview_url ?? null,
});
// Emisora (006): si el local tiene reproductor con una pista, se muestra esa pista con su crédito y la cola de la emisora.
const STATION_QUEUE_LIMIT = 5;
const stationSong = (track, extra = {}) => ({
  id: track.id,
  title: track.title,
  artist: track.artist,
  genre: track.genre,
  artworkUrl: track.artworkUrl,
  previewUrl: null,
  kind: track.kind,
  kindLabel: track.kindLabel,
  credit: track.credit,
  ...extra,
});
const stationNow = async (venueId) => {
  if (!hasColumn('player_state.establishment_id')) return null;
  const snap = await playerSnapshot(venueId, { withAudio: false, queueLimit: STATION_QUEUE_LIMIT, create: false });
  if (!snap?.current) return null;
  return {
    station: { status: snap.status, mode: snap.mode },
    nowPlaying: stationSong(snap.current.track, { playedAt: snap.current.startedAt, source: snap.current.source }),
    queue: snap.queue.map((item) => stationSong(item.track, { source: item.source })),
  };
};
router.get('/venues/:code/now', nowLimiter, async (req, res, next) => {
  try {
    const venue = await findVenue(req.params.code);
    const station = await stationNow(venue.id);
    if (station) return res.json(station);
    const playedOrder = hasColumn('song_requests.played_at')
      ? 'played_at DESC NULLS LAST, evaluated_at DESC'
      : 'evaluated_at DESC NULLS LAST, created_at DESC';
    const queueOrder = hasColumn('song_requests.status_updated_at')
      ? 'COALESCE(status_updated_at, evaluated_at, created_at)'
      : 'COALESCE(evaluated_at, created_at)';
    const [playing, queue] = await Promise.all([
      query(`SELECT * FROM song_requests WHERE establishment_id=$1 AND status='played' ORDER BY ${playedOrder} LIMIT 1`, [venue.id]),
      query(`SELECT * FROM song_requests WHERE establishment_id=$1 AND status='accepted' ORDER BY ${queueOrder} ASC LIMIT $2`, [
        venue.id,
        NOW_QUEUE_LIMIT,
      ]),
    ]);
    res.json({
      nowPlaying: playing.rows[0]
        ? { ...publicSong(playing.rows[0]), playedAt: playing.rows[0].played_at ?? playing.rows[0].evaluated_at }
        : null,
      queue: queue.rows.map(publicSong),
    });
  } catch (e) {
    next(e);
  }
});
// Buscador: primero pistas completas de Jamendo (caché de 24 h en la base de datos); si son pocas, previews de iTunes.
const searchFull = async (venue, term) => {
  if (!hasColumn('track_cache.id') || !availableProviders().includes('jamendo')) return [];
  try {
    return (
      await searchCatalog({ provider: 'jamendo', q: term, limit: 10, excludeNonCommercial: Boolean(venue.exclude_non_commercial) })
    ).tracks.map((row) => toPublicTrack(row, { withAudio: false }));
  } catch (err) {
    logger.error('Buscador público sin Jamendo; se usa iTunes', { err: err });
    return [];
  }
};
router.get('/venues/:code/search', searchLimiter, async (req, res, next) => {
  try {
    const term = searchQuery.parse(req.query.q);
    const venue = await findVenue(req.params.code);
    const full = await searchFull(venue, term);
    let previews = [];
    if (full.length < SEARCH_MIN_FULL) {
      try {
        previews = await cachedSearch(term);
      } catch (err) {
        if (!full.length) throw err;
      }
    }
    res.json(mergeSearchResults(full, previews));
  } catch (e) {
    next(e);
  }
});
// Canción pedida: pista completa de Jamendo (ya en el caché por el buscador), preview de iTunes o texto (clientes viejos).
const requestedSong = async (venue, d) => {
  if (d.provider === 'jamendo') {
    const row = hasColumn('track_cache.id') ? await findCachedTrack('jamendo', d.externalId) : null;
    if (!row) throw new AppError(404, 'No encontramos esa canción. Búscala de nuevo.');
    if (row.non_commercial && venue.exclude_non_commercial)
      throw new AppError(409, 'Este local solo programa canciones con licencia comercial. Elige otra.');
    return {
      title: row.title,
      artist: row.artist,
      genre: row.genre || 'Sin género',
      trackId: row.external_id,
      artworkUrl: row.artwork_url,
      provider: 'jamendo',
      trackCacheId: row.id,
    };
  }
  if (d.trackId) {
    const track = await lookupTrack(d.trackId);
    if (!track) throw new AppError(404, 'No encontramos esa canción. Busca otra.');
    return { ...track, provider: 'itunes' };
  }
  return { title: d.title, artist: d.artist, genre: d.genre || 'Sin género' };
};
router.post('/venues/:code/requests', requestLimiter, async (req, res, next) => {
  try {
    const d = payload.parse(req.body);
    const venue = await findVenue(req.params.code);
    const song = await requestedSong(venue, d);
    const row = await insertRequest(venue.id, d.guestName || 'Invitado', song, d);
    void redis
      .publish(`venue:${venue.id}`, JSON.stringify({ type: 'request_created', requestId: row.id }))
      .catch((err) => logger.error('No se pudo avisar la petición nueva', { err: err }));
    await publishRequestEvent(row.id, { stage: 'queued', message: 'Tu petición está en la cola.', partialScore: 0 }).catch((err) =>
      logger.error('No se pudo publicar el estado inicial de la petición', { err: err }),
    );
    try {
      await requestQueue.add('evaluate', { requestId: row.id }, evaluationJobOptions);
    } catch (err) {
      logger.error('No se pudo encolar la petición', { err: err });
      throw new AppError(503, 'Recibimos tu petición, pero no pudimos ponerla en la cola. Intenta de nuevo en un momento.');
    }
    res.status(202).json({ id: row.id, status: 'queued', message: 'Tu petición será evaluada por Smart DJ.' });
  } catch (e) {
    next(e);
  }
});

// Estado de las peticiones propias del cliente (ids guardados en su navegador). Sin nombres de quien pidió.
router.get('/venues/:code/requests', nowLimiter, async (req, res, next) => {
  try {
    const ids = requestIdsSchema.parse(req.query.ids);
    const venue = await findVenue(req.params.code);
    if (!hasColumn('song_requests.track_id')) return res.json({ requests: [] });
    res.json({ requests: (await requestsByIds(venue.id, ids)).map((row) => toStationRequest(row, { withGuest: false })) });
  } catch (e) {
    next(e);
  }
});
export default router;
