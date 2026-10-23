import { redis } from './redis.js';
import { logger } from './logger.js';

// Reparte avisos de Redis a las conexiones SSE abiertas con UNA sola conexión de suscripción por proceso
// (PSUBSCRIBE <prefijo>*), en lugar de una conexión a Redis por visitante. Así 100 celulares usan 1 conexión
// de Upstash y no 100.
export const createLiveHub = ({ prefix, parse = (message) => message, maxListeners = 500, label }) => {
  const listeners = new Map();
  let total = 0;
  let subscriber = null;
  let ready = null;

  const start = () => {
    ready ??= (async () => {
      subscriber = redis.duplicate();
      subscriber.on('error', (err) => logger.error(`Error de Redis en ${label}`, { err: err }));
      subscriber.on('pmessage', (_pattern, channel, message) => {
        const set = listeners.get(channel.slice(prefix.length));
        if (!set) return;
        const event = parse(message);
        if (event === null || event === undefined) return;
        for (const listener of set) listener(event);
      });
      await subscriber.psubscribe(`${prefix}*`);
    })().catch((err) => {
      ready = null;
      subscriber?.disconnect();
      throw err;
    });
    return ready;
  };

  // Registra un oyente del canal <prefijo><id>; devuelve la función para quitarlo. null si se llegó al máximo.
  const listen = async (id, listener) => {
    if (total >= maxListeners) return null;
    await start();
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(listener);
    total += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      total -= 1;
      const set = listeners.get(id);
      set?.delete(listener);
      if (set && !set.size) listeners.delete(id);
    };
  };

  return { listen, size: () => total };
};
