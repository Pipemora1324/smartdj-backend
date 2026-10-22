// Lógica pura del catálogo de la emisora (sin base de datos ni Redis), para poder probarla aislada.
import { fallbackAudioUrlFor } from './music-providers/jamendo.js';
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROVIDER_NAMES = { jamendo: 'Jamendo', audius: 'Audius', itunes: 'iTunes' };
// iTunes solo da previews de 30 s (corte de petición); Jamendo y Audius, pistas completas.
export const PREVIEW_PROVIDERS = new Set(['itunes']);
export const trackKind = (provider) => (PREVIEW_PROVIDERS.has(provider) ? 'preview' : 'full');
export const KIND_LABELS = { full: 'Completa', preview: 'Preview 30 s' };

// Géneros (tags de Jamendo) por tipo de local, y radio de Jamendo de respaldo.
export const VENUE_TAGS = {
  restaurant: ['lounge', 'jazz', 'acoustic', 'chillout'],
  cafe: ['jazz', 'acoustic', 'lounge', 'indie'],
  salsa_bar: ['latin', 'salsa', 'cumbia', 'reggaeton'],
  nightclub: ['electronic', 'house', 'dance', 'techno'],
  lounge: ['lounge', 'chillout', 'jazz', 'electronic'],
  other: ['pop', 'indie', 'rock', 'lounge'],
};
export const VENUE_RADIO = { restaurant: 'lounge', cafe: 'lounge', lounge: 'lounge', salsa_bar: 'world', nightclub: 'electro', other: 'bestof' };
export const tagsForVenue = (kind) => VENUE_TAGS[kind] ?? VENUE_TAGS.other;

export const monthKey = (date = new Date()) => `jamendo:calls:${date.toISOString().slice(0, 7)}`;

export const normalizeText = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const searchKey = (provider, q, tags) => {
  const sortedTags = [...tags].map(normalizeText).sort((a, b) => a.localeCompare(b)).join(',');
  return `${provider}|${normalizeText(q)}|${sortedTags}`.slice(0, 200);
};
export const isFresh = (fetchedAt, now = Date.now()) => now - new Date(fetchedAt).getTime() < CACHE_TTL_MS;

// INSERT ... ON CONFLICT para track_cache. Quita duplicados (Postgres no deja actualizar la misma fila dos veces).
export const TRACK_COLUMNS = ['provider', 'external_id', 'title', 'artist', 'genre', 'duration_seconds', 'artwork_url', 'audio_url', 'share_url', 'license_url', 'license_label', 'non_commercial', 'bpm', 'musical_key', 'energy', 'waveform'];
export const uniqueTracks = (tracks) => [...new Map(tracks.map((t) => [`${t.provider}|${t.externalId}`, t])).values()];
export const buildTrackUpsert = (tracks) => {
  const values = [];
  const rows = tracks.map((t) => {
    const start = values.length;
    values.push(t.provider, t.externalId, t.title, t.artist, t.genre, t.durationSeconds, t.artworkUrl, t.audioUrl, t.shareUrl, t.licenseUrl,
      t.licenseLabel, t.nonCommercial, t.bpm || null, t.musicalKey || null, t.energy, JSON.stringify(t.waveform ?? []));
    return `(${TRACK_COLUMNS.map((_, i) => '$' + (start + i + 1)).join(',')})`;
  });
  const updates = TRACK_COLUMNS.slice(2).map((c) => `${c}=EXCLUDED.${c}`).join(',');
  return {
    text: `INSERT INTO track_cache(${TRACK_COLUMNS.join(',')}) VALUES ${rows.join(',')} ON CONFLICT (provider, external_id) DO UPDATE SET ${updates}, fetched_at=NOW() RETURNING *`,
    values,
  };
};

// Pista guardada → formato de la API, con el crédito que exige la licencia. withAudio=false para la página pública.
export const toPublicTrack = (row, { withAudio = true } = {}) => row && ({
  id: row.id, provider: row.provider, externalId: row.external_id, title: row.title, artist: row.artist, genre: row.genre,
  kind: trackKind(row.provider), kindLabel: KIND_LABELS[trackKind(row.provider)],
  durationSeconds: row.duration_seconds, artworkUrl: row.artwork_url, energy: row.energy, bpm: Number(row.bpm) || 0, musicalKey: row.musical_key || '',
  ...(withAudio ? { audioUrl: row.audio_url, audioFallbackUrl: row.provider === 'jamendo' ? fallbackAudioUrlFor(row.external_id) : null, waveform: row.waveform ?? [] } : {}),
  credit: {
    artist: row.artist, title: row.title, url: row.share_url, source: PROVIDER_NAMES[row.provider] ?? row.provider,
    license: row.license_label, licenseUrl: row.license_url, nonCommercial: row.non_commercial,
  },
});

export const filterLicense = (rows, excludeNonCommercial) => (excludeNonCommercial ? rows.filter((r) => !r.non_commercial) : rows);

// Petición del público (iTunes) ↔ pista del catálogo libre: mismo título (o con sufijo) y artista que se contiene.
export const matchesRequest = (row, title, artist) => {
  const a = normalizeText(row.title);
  const b = normalizeText(title);
  const x = normalizeText(row.artist);
  const y = normalizeText(artist);
  const artistMatch = Boolean(x && y && (x.includes(y) || y.includes(x)));
  return Boolean(a && b && artistMatch && (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `)));
};

// Género de una petición del público (texto de iTunes, p. ej. "Salsa y Tropical") → tags de Jamendo,
// para que el AutoDJ favorezca ese estilo cuando la canción pedida no está en el catálogo libre.
const GENRE_HINTS = [
  [/salsa|tropical|cumbia|bachata|merengue|vallenato|latin|reggaeton|urbano/, ['latin', 'reggaeton']],
  [/hip.?hop|rap|trap/, ['hiphop']],
  [/electr|house|techno|dance|edm|trance/, ['electronic', 'house']],
  [/jazz|soul|blues|bossa/, ['jazz']],
  [/lounge|chill|ambient|lo.?fi/, ['lounge', 'chillout']],
  [/rock|metal|alternativ|punk/, ['rock']],
  [/acoust|acust|folk|indie/, ['acoustic', 'indie']],
  [/pop|balada/, ['pop']],
];
export const tagsForGenre = (genre) => {
  const text = normalizeText(genre);
  return GENRE_HINTS.find(([pattern]) => pattern.test(text))?.[1] ?? [];
};

// Todos los géneros que aparecen en un texto libre (p. ej. el ambiente del local: "jazz y lounge suave").
export const tagsInText = (text) => {
  const normalized = normalizeText(text);
  return [...new Set(GENRE_HINTS.filter(([pattern]) => pattern.test(normalized)).flatMap(([, tags]) => tags))];
};
// Géneros para las candidatas del AutoDJ: primero los del ambiente que escribió el dueño, luego los del tipo de local.
export const tagsForVenueProfile = (venue) => [...new Set([...tagsInText(venue?.ambience), ...tagsForVenue(venue?.kind)])];

// Petición de iTunes → pista para la cola: el preview de 30 s (solo la URL; el audio se reproduce desde Apple).
export const PREVIEW_SECONDS = 30;
export const itunesRequestTrack = (request) => (request?.preview_url && request.external_id ? {
  provider: 'itunes', externalId: String(request.external_id), title: request.title, artist: request.artist, genre: request.genre || '',
  durationSeconds: PREVIEW_SECONDS, artworkUrl: request.artwork_url ?? null, audioUrl: request.preview_url, shareUrl: request.store_url ?? null,
  licenseUrl: null, licenseLabel: 'Preview cortesía de iTunes', nonCommercial: true, energy: 0,
  bpm: Number(request.bpm) || 0, musicalKey: request.musical_key || '', waveform: [],
} : null);

// Buscador público: primero las pistas completas (Jamendo); si hay menos de minFull, se completa con previews
// de iTunes sin repetir canciones que ya están completas. Sin URLs de audio (la página pública no reproduce).
export const SEARCH_MIN_FULL = 5;
export const SEARCH_MAX_RESULTS = 10;
export const mergeSearchResults = (fullTracks, previewTracks, { minFull = SEARCH_MIN_FULL, max = SEARCH_MAX_RESULTS } = {}) => {
  const full = fullTracks.slice(0, max).map((t) => ({
    source: t.provider, kind: 'full', kindLabel: KIND_LABELS.full, provider: t.provider, externalId: t.externalId,
    title: t.title, artist: t.artist, genre: t.genre, artworkUrl: t.artworkUrl, durationSeconds: t.durationSeconds, credit: t.credit,
  }));
  if (full.length >= minFull) return full;
  const previews = previewTracks
    .filter((p) => !full.some((f) => matchesRequest(f, p.title, p.artist)))
    .map((p) => ({
      source: 'itunes', kind: 'preview', kindLabel: KIND_LABELS.preview, trackId: p.trackId,
      title: p.title, artist: p.artist, genre: p.genre, artworkUrl: p.artworkUrl, durationSeconds: 30, storeUrl: p.storeUrl ?? null,
    }));
  return [...full, ...previews].slice(0, max);
};
