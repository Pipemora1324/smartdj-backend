import axios from 'axios';
import { AppError } from './errors.js';
import { logger } from './logger.js';

// Búsqueda de canciones en iTunes Search API, siempre desde el servidor (el navegador nunca llama a APIs externas).
// ITUNES_API_URL solo cambia en pruebas locales (doble de iTunes); config.js valida que sea https o localhost.
const ITUNES_URL = process.env.ITUNES_API_URL || 'https://itunes.apple.com';
const TIMEOUT_MS = 5000;
export const MAX_RESULTS = 10;
const COUNTRY = process.env.MUSIC_SEARCH_COUNTRY || 'CO';
// Portadas y previews solo de dominios de Apple y por https; cualquier otra URL se descarta.
const MEDIA_HOST = /(^|\.)(mzstatic\.com|apple\.com)$/i;

export const safeMediaUrl = (value) => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && MEDIA_HOST.test(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
};

// Resultado de iTunes → canción para la app. Devuelve null si no es una canción válida.
export const toTrack = (item) => {
  if (!item?.trackId || !item.trackName || (item.kind && item.kind !== 'song')) return null;
  return {
    trackId: String(item.trackId),
    title: String(item.trackName).slice(0, 140),
    artist: String(item.artistName || 'Artista desconocido').slice(0, 140),
    genre: String(item.primaryGenreName || 'Sin género').slice(0, 60),
    artworkUrl: safeMediaUrl(item.artworkUrl100 ? item.artworkUrl100.replace('100x100bb', '300x300bb') : null),
    previewUrl: safeMediaUrl(item.previewUrl),
    durationMs: Number.isFinite(item.trackTimeMillis) ? item.trackTimeMillis : null,
    // Origen y enlace a la tienda: los términos de Apple piden atribución y enlace junto al preview.
    source: 'itunes',
    kind: 'preview',
    kindLabel: 'Preview 30 s',
    storeUrl: safeMediaUrl(item.trackViewUrl),
  };
};

const callItunes = async (path, params) => {
  try {
    const { data } = await axios.get(`${ITUNES_URL}${path}`, { params: { country: COUNTRY, ...params }, timeout: TIMEOUT_MS });
    return Array.isArray(data?.results) ? data.results : [];
  } catch (err) {
    logger.error('Error consultando iTunes', { path, err });
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')
      throw new AppError(504, 'El buscador de canciones tardó demasiado. Intenta de nuevo.');
    throw new AppError(502, 'El buscador de canciones no está disponible en este momento.');
  }
};

export const searchTracks = async (term) =>
  (await callItunes('/search', { term, media: 'music', entity: 'song', limit: MAX_RESULTS }))
    .map(toTrack)
    .filter(Boolean)
    .slice(0, MAX_RESULTS);

// Vuelve a pedir la canción por id para no confiar en los datos que manda el navegador.
export const lookupTrack = async (trackId) =>
  toTrack((await callItunes('/lookup', { id: trackId, entity: 'song' })).find((r) => String(r.trackId) === String(trackId)));
