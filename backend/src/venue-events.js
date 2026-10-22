import { redis } from './redis.js';
import { toPublicEvent } from './player-logic.js';
import { logger } from './logger.js';

// Avisos en vivo por local para la página pública (SSE). Un solo suscriptor de Redis por proceso
// (psubscribe venue:*) reparte los mensajes a las conexiones abiertas: no se abre una conexión a Redis por visitante.
export const MAX_LISTENERS = 500;
const listeners = new Map();
let total = 0;
let subscriber = null;
let ready = null;

const start = () => {
  ready ??= (async () => {
    subscriber = redis.duplicate();
    subscriber.on('error', (err) => logger.error('Error de Redis en los avisos de locales', { err: err }));
    subscriber.on('pmessage', (_pattern, channel, message) => {
      const event = toPublicEvent(message);
      const set = listeners.get(channel.slice('venue:'.length));
      if (!event || !set) return;
      for (const listener of set) listener(event);
    });
    await subscriber.psubscribe('venue:*');
  })().catch((err) => {
    ready = null;
    subscriber?.disconnect();
    throw err;
  });
  return ready;
};

// Registra un oyente del local; devuelve la función para quitarlo. null si se llegó al máximo de conexiones.
export const listenVenue = async (venueId, listener) => {
  if (total >= MAX_LISTENERS) return null;
  await start();
  if (!listeners.has(venueId)) listeners.set(venueId, new Set());
  listeners.get(venueId).add(listener);
  total += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    total -= 1;
    const set = listeners.get(venueId);
    set?.delete(listener);
    if (set && !set.size) listeners.delete(venueId);
  };
};
