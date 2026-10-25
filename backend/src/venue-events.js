import { createLiveHub } from './live-hub.js';
import { toPublicEvent } from './player-logic.js';

// Avisos en vivo por local para la página pública (SSE). Un solo suscriptor de Redis por proceso
// (psubscribe venue:*) reparte los mensajes a las conexiones abiertas: no se abre una conexión a Redis por visitante.
export const MAX_LISTENERS = 500;
// Dos vistas del mismo aviso: la página pública recibe solo los cambios que muestra (las peticiones nuevas o
// evaluadas de otras personas no cambian lo que ve, y reenviarlas haría que todos pidieran /now a la vez);
// la consola del DJ (view=console) recibe todos, porque muestra las peticiones apenas llegan.
export const PUBLIC_EVENT_TYPES = new Set(['player_updated', 'request_updated']);
// Como mucho un aviso por local cada AGGREGATE_MS: el primero sale enseguida y los que llegan en esa ventana se
// juntan en uno solo al final (con 150 personas conectadas, cada aviso son 150 consultas a /now).
// La página pública agrupa cada 5 s (con peticiones automáticas cada una que entra a la cola es un aviso);
// la consola, cada 2 s, porque el dueño necesita ver las peticiones casi al instante.
export const AGGREGATE_MS = { public: 5000, console: 2000 };

const hub = createLiveHub({
  prefix: 'venue:',
  label: 'los avisos de locales',
  maxListeners: Infinity,
  parse: toPublicEvent,
});

// Agrupa los avisos de cada local y vista antes de repartirlos a sus oyentes.
const venues = new Map();
const aggregated = (key, types, windowMs) => {
  let venue = venues.get(key);
  if (venue) return venue;
  venue = { listeners: new Set(), timer: null, pending: null, stop: null, starting: null };
  const deliver = (event) => {
    for (const listener of venue.listeners) listener(event);
  };
  venue.onEvent = (event) => {
    if (types && !types.has(event.type)) return;
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
      }, windowMs);
      venue.timer.unref?.();
    };
    wait();
  };
  venues.set(key, venue);
  return venue;
};

// Conexiones abiertas en este proceso (todas las de todos los locales).
let total = 0;

// Registra un oyente del local; devuelve la función para quitarlo. null si se llegó al máximo de conexiones.
export const listenVenue = async (venueId, listener, { view = 'public' } = {}) => {
  if (total >= MAX_LISTENERS) return null;
  const key = `${venueId}|${view}`;
  const venue = aggregated(key, view === 'console' ? null : PUBLIC_EVENT_TYPES, AGGREGATE_MS[view] ?? AGGREGATE_MS.public);
  // Una sola suscripción por local aunque lleguen varias conexiones a la vez.
  venue.starting ??= hub.listen(venueId, venue.onEvent);
  try {
    venue.stop = await venue.starting;
  } catch (err) {
    // Sin Redis no queda la suscripción fallida guardada: la próxima conexión lo vuelve a intentar.
    if (venues.get(key) === venue && !venue.listeners.size) venues.delete(key);
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
    if (!venue.listeners.size && venues.get(key) === venue) {
      venue.stop?.();
      clearTimeout(venue.timer);
      venues.delete(key);
    }
  };
};
