import axios from 'axios';
import { AppError, sanitizeForLog } from '../errors.js';
import { logger } from '../logger.js';

// Proveedor de pistas completas con licencia Creative Commons (ver DECISIONES_DJ.md).
// Funciones puras (mapeo y licencias) + un cliente que recibe su configuración; no lee config.js
// para poder probarlo sin variables de entorno.
export const PROVIDER = 'jamendo';
const SPEED_ENERGY = { verylow: 1, low: 2, medium: 3, high: 4, veryhigh: 5 };
const WAVEFORM_POINTS = 120;
const CANDIDATE_DURATION = '90_480';
const IMAGE_HOST = /(^|\.)jamendo\.com$/i;

// El audio va siempre por mp3l.jamendo.com: responde CORS "*" (necesario para el EQ con Web Audio)
// y no lleva el client_id en la URL.
export const audioUrlFor = (trackId) =>
  /^\d{1,12}$/.test(String(trackId)) ? `https://mp3l.jamendo.com/?trackid=${trackId}&format=mp31` : null;
// Host de respaldo si mp3l no responde: sirve el mismo audio, pero su CORS no es fiable (ver DECISIONES_DJ.md),
// así que la consola lo usa sin Web Audio (sin EQ).
export const fallbackAudioUrlFor = (trackId) =>
  /^\d{1,12}$/.test(String(trackId)) ? `https://prod-1.storage.jamendo.com/?trackid=${trackId}&format=mp31` : null;
export const shareUrlFor = (trackId) => (/^\d{1,12}$/.test(String(trackId)) ? `https://www.jamendo.com/track/${trackId}` : null);

export const safeImageUrl = (value) => {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && IMAGE_HOST.test(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
};

// license_ccurl (p. ej. http://creativecommons.org/licenses/by-nc-sa/3.0/) → etiqueta, URL https y si es no comercial.
// Si no se reconoce, se trata como no comercial (lo más prudente).
export const licenseFromUrl = (value) => {
  const unknown = { label: 'Licencia desconocida', url: null, nonCommercial: true };
  if (typeof value !== 'string') return unknown;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/licenses\/([a-z-]+)\/(\d+(?:\.\d+)?)\/?/i);
    if (!/(^|\.)creativecommons\.org$/i.test(url.hostname) || !match) return unknown;
    const kind = match[1].toLowerCase();
    return {
      label: `CC ${kind.toUpperCase()} ${match[2]}`,
      url: `https://creativecommons.org/licenses/${kind}/${match[2]}/`,
      nonCommercial: kind.split('-').includes('nc'),
    };
  } catch {
    return unknown;
  }
};

// waveform de Jamendo (texto JSON {"peaks":[...]} u objeto) → hasta 120 picos entre 0 y 1.
export const reduceWaveform = (raw, points = WAVEFORM_POINTS) => {
  let peaks = raw;
  try {
    if (typeof peaks === 'string') peaks = JSON.parse(peaks);
  } catch {
    return [];
  }
  if (peaks && !Array.isArray(peaks)) peaks = peaks.peaks;
  if (!Array.isArray(peaks)) return [];
  const values = peaks.map((v) => Math.abs(Number(v))).filter(Number.isFinite);
  if (!values.length) return [];
  const size = Math.min(points, values.length);
  const bucket = values.length / size;
  const reduced = Array.from({ length: size }, (_, i) =>
    Math.max(...values.slice(Math.floor(i * bucket), Math.max(Math.floor((i + 1) * bucket), Math.floor(i * bucket) + 1))),
  );
  const max = Math.max(...reduced) || 1;
  return reduced.map((v) => Math.round((v / max) * 1000) / 1000);
};

const text = (value, max, fallback = '') =>
  String(value ?? fallback)
    .trim()
    .slice(0, max) || fallback;

// Resultado de /tracks → pista normalizada (mismo formato para todos los proveedores). null si no se puede reproducir.
export const toJamendoTrack = (item) => {
  const id = item?.id;
  const audioUrl = audioUrlFor(id);
  if (!audioUrl || !item.name) return null;
  const license = licenseFromUrl(item.license_ccurl);
  const genres = item.musicinfo?.tags?.genres;
  return {
    provider: PROVIDER,
    externalId: String(id),
    title: text(item.name, 140),
    artist: text(item.artist_name, 140, 'Artista desconocido'),
    genre: text(Array.isArray(genres) ? genres[0] : '', 60),
    durationSeconds: Number.isFinite(Number(item.duration)) ? Math.max(0, Math.round(Number(item.duration))) : 0,
    artworkUrl: safeImageUrl(item.image) ?? safeImageUrl(item.album_image),
    audioUrl,
    shareUrl: shareUrlFor(id),
    licenseUrl: license.url,
    licenseLabel: license.label,
    nonCommercial: license.nonCommercial,
    energy: SPEED_ENERGY[item.musicinfo?.speed] ?? 0,
    bpm: 0,
    musicalKey: '',
    waveform: reduceWaveform(item.waveform),
  };
};

const failure = (err) => {
  if (err instanceof AppError) return err;
  logger.error('Error consultando Jamendo', { err });
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')
    return new AppError(504, 'El catálogo de música tardó demasiado. Intenta de nuevo.');
  return new AppError(502, 'El catálogo de música no está disponible en este momento.');
};

// Cliente de la API. allowCall() decide si queda cuota (contador mensual); si devuelve false no se llama a Jamendo.
export const createJamendoClient = ({
  clientId,
  apiUrl = 'https://api.jamendo.com/v3.0',
  timeoutMs = 5000,
  allowCall = async () => true,
  http = axios,
} = {}) => {
  const call = async (path, params) => {
    if (!clientId) throw new AppError(503, 'El catálogo de música no está configurado (falta JAMENDO_CLIENT_ID).');
    if (!(await allowCall())) throw new AppError(503, 'Se alcanzó el límite mensual de consultas al catálogo de música.');
    try {
      const { data } = await http.get(`${apiUrl}${path}`, {
        params: { client_id: clientId, format: 'json', ...params },
        timeout: timeoutMs,
      });
      if (data?.headers?.status && data.headers.status !== 'success') {
        logger.error('Jamendo respondió con error', {
          code: sanitizeForLog(data.headers.code, 20),
          detail: sanitizeForLog(data.headers.error_message),
        });
        throw new AppError(502, 'El catálogo de música respondió con un error.');
      }
      return Array.isArray(data?.results) ? data.results : [];
    } catch (err) {
      throw failure(err);
    }
  };
  return {
    configured: Boolean(clientId),
    // q: texto libre; tags: géneros (cualquiera de ellos).
    search: async ({ q, tags = [], limit = 30 }) => {
      const params = { limit, include: 'musicinfo', audioformat: 'mp31', imagesize: 300 };
      // Con texto, la relevancia se combina con la popularidad (boost). Sin texto (candidatas del AutoDJ),
      // las más escuchadas del mes y con duración de canción normal (sin fragmentos ni mezclas de una hora).
      if (q) Object.assign(params, { search: q, boost: 'popularity_total' });
      else Object.assign(params, { order: 'popularity_month', durationbetween: CANDIDATE_DURATION });
      if (tags.length) params.fuzzytags = tags.join(' ');
      return (await call('/tracks/', params)).map(toJamendoTrack).filter(Boolean);
    },
    // Respaldo: la pista que suena en una radio de Jamendo (el stream de la radio ya no funciona, ver DECISIONES_DJ.md).
    radioTrack: async (radioName) => {
      const [radio] = await call('/radios/stream/', { name: radioName });
      const playing = radio?.playingnow;
      if (!playing?.track_id) return null;
      const [item] = await call('/tracks/', { id: playing.track_id, include: 'musicinfo', audioformat: 'mp31', imagesize: 300 });
      return item ? toJamendoTrack(item) : null;
    },
  };
};
