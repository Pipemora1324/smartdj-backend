import axios from 'axios';
import { AppError } from '../errors.js';

// Segundo proveedor (opcional): solo se activa con AUDIUS_API_KEY, que se usa únicamente en el servidor.
// Audius sí trae BPM y tonalidad; su licencia suele venir vacía, así que se trata como no comercial.
export const PROVIDER = 'audius';
const API_URL = 'https://api.audius.co/v1';
const APP_NAME = 'SmartDJ';
const ID_PATTERN = /^[A-Za-z0-9]{1,20}$/;

const httpsUrl = (value) => {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};
const text = (value, max, fallback = '') =>
  String(value ?? fallback)
    .trim()
    .slice(0, max) || fallback;

export const toAudiusTrack = (item) => {
  const id = item?.id;
  if (!ID_PATTERN.test(String(id ?? '')) || !item.title || item.is_streamable === false) return null;
  const bpm = Number(item.bpm);
  return {
    provider: PROVIDER,
    externalId: String(id),
    title: text(item.title, 140),
    artist: text(item.user?.name, 140, 'Artista desconocido'),
    genre: text(item.genre, 60),
    durationSeconds: Number.isFinite(Number(item.duration)) ? Math.max(0, Math.round(Number(item.duration))) : 0,
    artworkUrl: httpsUrl(item.artwork?.['480x480'] ?? item.artwork?.['150x150']),
    audioUrl: `${API_URL}/tracks/${id}/stream?app_name=${APP_NAME}`,
    shareUrl: typeof item.permalink === 'string' && item.permalink.startsWith('/') ? `https://audius.co${item.permalink}` : null,
    licenseUrl: null,
    licenseLabel: item.license ? text(item.license, 60) : 'Términos de Audius',
    nonCommercial: true,
    energy: 0,
    bpm: Number.isFinite(bpm) && bpm > 0 && bpm <= 300 ? Math.round(bpm * 100) / 100 : 0,
    musicalKey: text(item.musical_key, 15),
    waveform: [],
  };
};

export const createAudiusClient = ({ apiKey, timeoutMs = 5000, http = axios } = {}) => ({
  configured: Boolean(apiKey),
  search: async ({ q, tags = [], limit = 30 }) => {
    if (!apiKey) throw new AppError(503, 'Audius no está configurado.');
    const path = q ? '/tracks/search' : '/tracks/trending';
    const params = { app_name: APP_NAME, limit };
    if (q) params.query = q;
    if (tags[0]) params.genre = tags[0];
    try {
      const { data } = await http.get(`${API_URL}${path}`, { params, timeout: timeoutMs, headers: { Authorization: `Bearer ${apiKey}` } });
      return (Array.isArray(data?.data) ? data.data : []).map(toAudiusTrack).filter(Boolean).slice(0, limit);
    } catch (err) {
      console.error('Error consultando Audius:', err.code || err.message);
      throw new AppError(502, 'Audius no está disponible en este momento.');
    }
  },
});
