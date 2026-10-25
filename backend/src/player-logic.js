// Lógica pura del reproductor y de la cola (sin base de datos), para poder probarla aislada.
import { AppError } from './errors.js';

export const MIN_QUEUE = 5;
export const RECENT_LIMIT = 30;

// Posición viva: la guardada más lo que lleva sonando desde started_at.
export const livePosition = (state, now = Date.now()) => {
  const base = Number(state?.position_seconds) || 0;
  if (state?.status !== 'playing' || !state.started_at) return base;
  return Math.max(0, Math.round((base + (now - new Date(state.started_at).getTime()) / 1000) * 100) / 100);
};

// Nuevo orden de la cola: debe traer exactamente los mismos ids, sin repetir.
export const reorderPositions = (currentIds, orderIds) => {
  const current = new Set(currentIds);
  if (orderIds.length !== current.size || new Set(orderIds).size !== orderIds.length || !orderIds.every((id) => current.has(id))) {
    throw new AppError(409, 'La cola cambió mientras la reordenabas. Vuelve a intentarlo.');
  }
  return orderIds.map((id, index) => ({ id, position: index + 1 }));
};

// Dónde intercalar una petición aceptada: después de la siguiente pista (ya puede estar precargada)
// y nunca junto a otra petición, para que la emisora no se vuelva solo peticiones.
export const requestInsertIndex = (queue) => {
  let index = Math.min(1, queue.length);
  const isRequest = (i) => queue[i]?.source === 'request';
  while (index <= queue.length && (isRequest(index - 1) || isRequest(index))) index += 1;
  return Math.min(index, queue.length);
};

// Inserta en la posición index y devuelve el nuevo orden de ids (para renumerar 1..n).
export const insertAt = (ids, index, id) => [...ids.slice(0, index), id, ...ids.slice(index)];

// Energía objetivo por tipo de local (1 muy tranquila … 5 muy enérgica); la misma tabla que usa el motor.
export const VENUE_ENERGY = { restaurant: [2, 3], cafe: [2, 3], lounge: [2, 3], salsa_bar: [3, 4], nightclub: [4, 5], other: [3, 3] };

// Respaldo sin el motor: misma familia de géneros del local, energía cercana a la del local y sin repetir
// pistas ni artistas recientes. random permite pruebas deterministas.
export const pickFallback = ({ candidates, venueKind, venueTags = [], recentIds = [], recentArtists = [], random = Math.random }) => {
  const recent = new Set(recentIds);
  const artists = new Set(recentArtists.map((a) => String(a).toLowerCase()));
  const tags = new Set(venueTags.map((t) => t.toLowerCase()));
  const [low, high] = VENUE_ENERGY[venueKind] ?? VENUE_ENERGY.other;
  // Si todo sonó hace poco, repite antes que dejar la emisora en silencio (igual que el motor).
  const fresh = candidates.filter((c) => !recent.has(c.id));
  const pool = fresh.length ? fresh : candidates;
  if (!pool.length) return null;
  const energyFit = (energy) => {
    if (!energy) return 0.5;
    if (energy >= low && energy <= high) return 1;
    return Math.max(0, 1 - Math.min(Math.abs(energy - low), Math.abs(energy - high)) / 2);
  };
  const score = (c) =>
    (tags.has(String(c.genre).toLowerCase()) ? 1 : 0) +
    energyFit(Number(c.energy) || 0) -
    (artists.has(String(c.artist).toLowerCase()) ? 0.6 : 0) +
    random() * 0.3;
  return pool.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s)[0].c;
};

// Transición por defecto cuando no la sugiere el motor: crossfade fijo y salida antes del final.
export const defaultTransition = (durationSeconds, crossfadeSeconds = 8) => {
  const duration = Number(durationSeconds) || 0;
  const crossfade = Math.min(Number(crossfadeSeconds) || 0, Math.max(0, duration / 4));
  return {
    transitionAtSeconds: Math.max(0, Math.round((duration - crossfade - 1) * 100) / 100),
    crossfadeSeconds: Math.round(crossfade * 100) / 100,
  };
};

// Fila de track_cache → TrackFeatures del proto (0 y '' = desconocido para el motor).
export const toFeatures = (row) =>
  row
    ? {
        id: row.id,
        genre: row.genre || '',
        bpm: Number(row.bpm) || 0,
        key: row.musical_key || '',
        energy: Number(row.energy) || 0,
        duration_seconds: Number(row.duration_seconds) || 0,
        artist: row.artist || '',
      }
    : undefined;

// Solo se reenvía el tipo de aviso: el contenido (ids de petición, resultados) no sale a la página pública.
export const toPublicEvent = (message) => {
  try {
    const { type } = JSON.parse(message);
    return typeof type === 'string' && /^[a-z_]{1,40}$/.test(type) ? { type } : null;
  } catch {
    return null;
  }
};

// Corte de petición (preview de 30 s): fundido de salida en los últimos segundos y luego sigue la emisora.
export const PREVIEW_FADE_SECONDS = 4;
export const previewTransition = (durationSeconds) => {
  const duration = Number(durationSeconds) || 0;
  return { transitionAtSeconds: Math.max(0, duration - PREVIEW_FADE_SECONDS), crossfadeSeconds: Math.min(PREVIEW_FADE_SECONDS, duration) };
};

// Estado de una petición tal como lo ven el dueño (consola) y el cliente (página pública).
export const REQUEST_STATE_LABELS = {
  queued: 'En evaluación',
  accepted: 'Esperando al DJ',
  bridging: 'El DJ la revisará',
  rejected: 'Descartada',
  played: 'Sonada',
  in_queue: 'En la cola',
  playing: 'Sonando ahora',
  // Sonó hace poco: ya está aceptada y entra a la cola sola al terminar la espera.
  waiting: 'En la cola',
  unplayable: 'No se pudo reproducir',
  // Evaluada y con "Aceptar peticiones automáticamente": el AutoDJ la está metiendo a la cola.
  entering: 'Entrando a la cola',
};
// Fallos de reproducción con los que una petición se da por perdida (ver request-priority.js).
const UNPLAYABLE_FAILURES = 2;
export const requestState = (row, now = Date.now(), autoAccept = false) => {
  if (row.status === 'played') return 'played';
  if (row.status === 'rejected') return (Number(row.play_failures) || 0) >= UNPLAYABLE_FAILURES ? 'unplayable' : 'rejected';
  if (row.playing) return 'playing';
  if (row.in_queue) return 'in_queue';
  if (row.not_before && new Date(row.not_before).getTime() > now) return 'waiting';
  if (autoAccept && (row.status === 'accepted' || row.status === 'bridging')) return 'entering';
  return row.status;
};
// Completa (pista de Jamendo, también si una petición de iTunes se encontró completa) o preview de 30 s.
export const requestKind = (row) => {
  const provider = row.track_provider ?? row.provider ?? 'itunes';
  return provider === 'itunes' ? 'preview' : 'full';
};
// withGuest=false para la página pública: nunca expone el nombre de quien pidió.
// positions: Map de la petición original → { position, etaSeconds } en la cola (los votos usan la de la original).
export const toStationRequest = (row, { withGuest = true, positions = null, now = Date.now(), autoAccept = false } = {}) => {
  const state = requestState(row, now, autoAccept);
  const kind = requestKind(row);
  const queued = positions?.get(row.duplicate_of ?? row.id);
  const waitUntil = state === 'waiting' ? new Date(row.not_before).toISOString() : null;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    genre: row.genre,
    artworkUrl: row.artwork_url ?? null,
    kind,
    kindLabel: kind === 'full' ? 'Completa' : 'Preview 30 s',
    state,
    stateLabel: REQUEST_STATE_LABELS[state] ?? state,
    fits: row.status === 'accepted',
    reason: row.ai_reason ?? null,
    createdAt: row.created_at,
    // En la cola: puesto (desde 1, contando todo lo que va antes) y segundos estimados hasta que suene.
    position: state === 'in_queue' ? (queued?.position ?? null) : null,
    etaSeconds:
      state === 'in_queue' ? (queued?.etaSeconds ?? null) : waitUntil ? Math.max(0, Math.round((new Date(waitUntil) - now) / 1000)) : null,
    waitUntil,
    votes: Number(row.votes) || 1,
    // Esta petición es un voto de otra igual que ya estaba pendiente.
    duplicate: Boolean(row.duplicate_of),
    ...(withGuest ? { guestName: row.guest_name } : {}),
  };
};
