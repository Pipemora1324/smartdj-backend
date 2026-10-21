// Lógica pura del catálogo de la emisora (sin base de datos ni Redis), para poder probarla aislada.
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROVIDER_NAMES = { jamendo: 'Jamendo', audius: 'Audius' };

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
export const searchKey = (provider, q, tags) => `${provider}|${normalizeText(q)}|${[...tags].map(normalizeText).sort().join(',')}`.slice(0, 200);
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
    return `(${TRACK_COLUMNS.map((_, i) => `$${start + i + 1}`).join(',')})`;
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
  durationSeconds: row.duration_seconds, artworkUrl: row.artwork_url, energy: row.energy, bpm: Number(row.bpm) || 0, musicalKey: row.musical_key || '',
  ...(withAudio ? { audioUrl: row.audio_url, waveform: row.waveform ?? [] } : {}),
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
