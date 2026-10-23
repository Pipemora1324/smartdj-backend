import { createLiveHub } from './live-hub.js';
import { toPublicEvent } from './player-logic.js';

// Avisos en vivo por local para la página pública (SSE). Un solo suscriptor de Redis por proceso
// (psubscribe venue:*) reparte los mensajes a las conexiones abiertas: no se abre una conexión a Redis por visitante.
export const MAX_LISTENERS = 500;
// Solo los cambios que la página pública muestra. Las peticiones nuevas o evaluadas de otras personas no cambian
// lo que ve cada cliente (su propia petición le llega por su SSE): reenviarlas haría que todos pidieran /now a la vez.
export const PUBLIC_EVENT_TYPES = new Set(['player_updated', 'request_updated']);
// Como mucho un aviso por local cada AGGREGATE_MS: el primero sale enseguida y los que llegan en esa ventana se
// juntan en uno solo al final (con 150 personas conectadas, cada aviso son 150 consultas a /now).
export const AGGREGATE_MS = 2000;

const hub = createLiveHub({
  prefix: 'venue:',
  label: 'los avisos de locales',
  maxListeners: Infinity,
  parse: (message) => {
    const event = toPublicEvent(message);
    return event && PUBLIC_EVENT_TYPES.has(event.type) ? event : null;
  },
});

// Agrupa los avisos de cada local antes de repartirlos a sus oyentes.
const venues = new Map();
const aggregated = (venueId) => {
  let venue = venues.get(venueId);
  if (venue) return venue;
  venue = { listeners: new Set(), timer: null, pending: null, stop: null, starting: null };
  const deliver = (event) => {
    for (const listener of venue.listeners) listener(event);
  };
  venue.onEvent = (event) => {
    if (venue.timer) {
      venue.pending = event;
      return;
    }
    deliver(event);
    const wait = () => {
      venue.timer = setTimeout(() => {
        venue.timer = null;
        if (!venue.pending) return;
        const next = venue.pending;
        venue.pending = null;
        deliver(next);
        wait();
      }, AGGREGATE_MS);
      venue.timer.unref?.();
    };
    wait();
  };
  venues.set(venueId, venue);
  return venue;
};

// Conexiones abiertas en este proceso (todas las de todos los locales).
let total = 0;

// Registra un oyente del local; devuelve la función para quitarlo. null si se llegó al máximo de conexiones.
export const listenVenue = async (venueId, listener) => {
  if (total >= MAX_LISTENERS) return null;
  const venue = aggregated(venueId);
  // Una sola suscripción por local aunque lleguen varias conexiones a la vez.
  venue.starting ??= hub.listen(venueId, venue.onEvent);
  try {
    venue.stop = await venue.starting;
  } catch (err) {
    // Sin Redis no queda la suscripción fallida guardada: la próxima conexión lo vuelve a intentar.
    if (venues.get(venueId) === venue && !venue.listeners.size) venues.delete(venueId);
    venue.starting = null;
    throw err;
  }
  venue.listeners.add(listener);
  total += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    total -= 1;
    venue.listeners.delete(listener);
    if (!venue.listeners.size && venues.get(venueId) === venue) {
      venue.stop?.();
      clearTimeout(venue.timer);
      venues.delete(venueId);
    }
  };
};
