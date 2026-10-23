// Caché corta en memoria con deduplicación: si 100 personas piden lo mismo a la vez, se calcula una sola vez y
// todas reciben el mismo resultado (single-flight). Con ttlMs > 0 el resultado se reutiliza ese tiempo.
// Los errores no se guardan: la siguiente llamada lo vuelve a intentar.
export const createMemo = ({ ttlMs = 0, maxEntries = 1000, now = () => Date.now() } = {}) => {
  const inFlight = new Map();
  const done = new Map();

  const remember = (key, value) => {
    if (!ttlMs) return;
    if (done.size >= maxEntries) done.delete(done.keys().next().value);
    done.set(key, { value, expires: now() + ttlMs });
  };

  return {
    get(key, load) {
      const hit = done.get(key);
      if (hit && hit.expires > now()) return Promise.resolve(hit.value);
      if (hit) done.delete(key);
      if (inFlight.has(key)) return inFlight.get(key);
      const promise = Promise.resolve()
        .then(load)
        .then((value) => {
          remember(key, value);
          return value;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return promise;
    },
    clear: () => done.clear(),
  };
};
