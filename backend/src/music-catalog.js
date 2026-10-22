import { query } from './db.js';
import { redis } from './redis.js';
import { config } from './config.js';
import { AppError } from './errors.js';
import { createJamendoClient } from './music-providers/jamendo.js';
import { createAudiusClient } from './music-providers/audius.js';
import {
  VENUE_RADIO,
  buildTrackUpsert,
  filterLicense,
  isFresh,
  matchesRequest,
  monthKey,
  searchKey,
  uniqueTracks,
} from './catalog-logic.js';
import { logger } from './logger.js';

// Catálogo de la emisora: busca en el proveedor solo si la búsqueda no está en caché (24 h, en la base de datos).
// Guarda metadatos, nunca audio (términos de Jamendo, ver DECISIONES_DJ.md).

// Tope mensual de consultas a Jamendo: contador en Redis por mes. Si Redis falla se permite la consulta
// (el caché en la base de datos sigue limitando las repeticiones).
export const allowJamendoCall = async (budget = config.jamendoMonthlyBudget) => {
  try {
    const key = monthKey();
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 40 * 24 * 60 * 60);
    if (count > budget) {
      if (count === budget + 1) logger.error('Se alcanzó el tope mensual de consultas a Jamendo; se usa solo el caché', { budget });
      return false;
    }
    return true;
  } catch (err) {
    logger.error('No se pudo contar la consulta a Jamendo', { err: err });
    return true;
  }
};

const providers = {
  jamendo: createJamendoClient({ clientId: config.jamendoClientId, apiUrl: config.jamendoApiUrl, allowCall: () => allowJamendoCall() }),
  audius: createAudiusClient({ apiKey: config.audiusApiKey }),
};
export const availableProviders = () =>
  Object.entries(providers)
    .filter(([, p]) => p.configured)
    .map(([name]) => name);
const providerFor = (name) => {
  const provider = providers[name];
  if (!provider) throw new AppError(400, 'Proveedor de música no válido.');
  if (!provider.configured)
    throw new AppError(
      503,
      name === 'jamendo' ? 'El catálogo de música no está configurado (falta JAMENDO_CLIENT_ID).' : 'Audius no está configurado.',
    );
  return provider;
};

// Inserta o actualiza pistas y devuelve las filas (con su id) en el mismo orden.
export const upsertTracks = async (tracks) => {
  const unique = uniqueTracks(tracks);
  if (!unique.length) return [];
  const { text, values } = buildTrackUpsert(unique);
  const r = await query(text, values);
  const byKey = new Map(r.rows.map((row) => [`${row.provider}|${row.external_id}`, row]));
  return unique.map((t) => byKey.get(`${t.provider}|${t.externalId}`)).filter(Boolean);
};

const loadTracks = async (ids) => {
  if (!ids.length) return [];
  const r = await query('SELECT * FROM track_cache WHERE id = ANY($1::uuid[])', [ids]);
  const byId = new Map(r.rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
};

// Búsqueda con caché. Devuelve filas de track_cache. Si el proveedor falla, usa el caché vencido si existe.
export const searchCatalog = async ({ provider = 'jamendo', q = '', tags = [], limit = 30, excludeNonCommercial = false }) => {
  const key = searchKey(provider, q, tags);
  const cached = await query('SELECT track_ids, fetched_at FROM track_search_cache WHERE query_key=$1', [key]);
  const entry = cached.rows[0];
  if (entry && isFresh(entry.fetched_at)) {
    return { tracks: filterLicense(await loadTracks(entry.track_ids), excludeNonCommercial), source: 'cache' };
  }
  try {
    const rows = await upsertTracks(await providerFor(provider).search({ q, tags, limit }));
    await query(
      'INSERT INTO track_search_cache(query_key, track_ids) VALUES($1,$2) ON CONFLICT (query_key) DO UPDATE SET track_ids=EXCLUDED.track_ids, fetched_at=NOW()',
      [key, JSON.stringify(rows.map((r) => r.id))],
    );
    return { tracks: filterLicense(rows, excludeNonCommercial), source: 'provider' };
  } catch (err) {
    if (!entry) throw err;
    logger.warn('Proveedor no disponible; se usa el caché vencido', { provider, err });
    return { tracks: filterLicense(await loadTracks(entry.track_ids), excludeNonCommercial), source: 'stale-cache' };
  }
};

// Pistas ya guardadas de ciertos géneros (sin consultar al proveedor), para el AutoDJ.
// Los previews de iTunes no son candidatas: solo suenan como corte de una petición.
export const cachedCandidates = async ({ tags, excludeIds = [], excludeNonCommercial = false, limit = 60 }) => {
  const r = await query(
    `SELECT * FROM track_cache WHERE provider <> 'itunes' AND lower(genre) = ANY($1::text[]) AND NOT (id = ANY($2::uuid[])) AND ($3::boolean = FALSE OR non_commercial = FALSE)
     ORDER BY fetched_at DESC LIMIT $4`,
    [tags.map((t) => t.toLowerCase()), excludeIds, excludeNonCommercial, limit],
  );
  return r.rows;
};

// Pista concreta por proveedor e id (para agregarla a la cola a mano). Debe estar en el caché (vino de una búsqueda).
export const findCachedTrack = async (provider, externalId) => {
  const r = await query('SELECT * FROM track_cache WHERE provider=$1 AND external_id=$2', [provider, externalId]);
  return r.rows[0] ?? null;
};

// Petición del público (iTunes) → la misma canción en el catálogo libre, si existe.
export const findFreeVersion = async ({ title, artist, excludeNonCommercial }) => {
  const { tracks } = await searchCatalog({ q: `${title} ${artist}`.slice(0, 100), limit: 10, excludeNonCommercial });
  return tracks.find((row) => matchesRequest(row, title, artist)) ?? null;
};

// Último recurso del AutoDJ: lo que suena en la radio de Jamendo del tipo de local (o en "bestof").
export const radioFallback = async (venueKind) => {
  for (const name of [...new Set([VENUE_RADIO[venueKind] ?? 'bestof', 'bestof'])]) {
    try {
      const track = await providers.jamendo.radioTrack(name);
      if (track) return (await upsertTracks([track]))[0];
    } catch (err) {
      logger.warn('Radio de Jamendo no disponible', { radio: name, err });
    }
  }
  return null;
};
