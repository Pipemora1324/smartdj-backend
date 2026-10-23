// Monta la API real contra Postgres y Redis de Docker (los levanta scripts/test.mjs) y los dobles de fakes.js.
// Las variables se fijan antes de importar la app porque config.js las valida al cargarse.
import { once } from 'node:events';
import { JAMENDO_CLIENT_ID, SUPABASE_URL, startEngine, startItunes, startJamendo, startSupabase } from './fakes.js';

export const startStack = async () => {
  if (!process.env.TEST_DATABASE_URL || !process.env.TEST_REDIS_URL)
    throw new Error('Faltan TEST_DATABASE_URL y TEST_REDIS_URL: corre las pruebas con npm test (levanta Docker solo).');
  const [supabase, jamendo, itunes, engine] = await Promise.all([startSupabase(), startJamendo(), startItunes(), startEngine()]);
  Object.assign(process.env, {
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    REDIS_URL: process.env.TEST_REDIS_URL,
    AI_SERVICE_URL: 'http://127.0.0.1:9',
    AI_GRPC_URL: engine.url,
    AI_GRPC_TIMEOUT_MS: '3000',
    AI_GRPC_CONNECT_TIMEOUT_MS: '1000',
    SUPABASE_URL,
    SUPABASE_JWKS_URL: supabase.jwksUrl,
    JAMENDO_CLIENT_ID,
    JAMENDO_API_URL: jamendo.apiUrl,
    ITUNES_API_URL: itunes.url,
    CORS_ORIGIN: 'http://localhost:8080',
  });
  const { createApp } = await import('../../src/app.js');
  const { checkSchema } = await import('../../src/schema-check.js');
  const { pool, query } = await import('../../src/db.js');
  const { redis } = await import('../../src/redis.js');
  const { closeQueue, requestQueue } = await import('../../src/queue.js');
  await checkSchema();
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  // Cliente HTTP de prueba: JSON de ida y vuelta; token opcional del dueño.
  const api = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, body: json, headers: res.headers };
  };

  // Deja la base y Redis vacíos entre archivos de prueba (el esquema queda).
  const reset = async () => {
    // Trabajos pendientes o en reintento de pruebas anteriores apuntan a filas que se van a borrar.
    await requestQueue.drain(true);
    // Una evaluación que sigue en curso (y el AutoDJ que dispara) escribe en las tablas: se espera a que termine
    // y, si aun así el TRUNCATE choca con ella (deadlock), se reintenta.
    await waitFor(async () => (await requestQueue.getActiveCount()) === 0, { timeoutMs: 15000 }).catch(() => {});
    for (let attempt = 1; ; attempt += 1) {
      try {
        await query('TRUNCATE users, track_cache, track_search_cache RESTART IDENTITY CASCADE');
        break;
      } catch (err) {
        if (err.code !== '40P01' || attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
    // Se borra todo menos la cola de BullMQ: vaciarla con el worker activo reutiliza ids de trabajo y lo confunde.
    const keys = (await redis.keys('*')).filter((key) => !key.startsWith('bull:'));
    if (keys.length) await redis.del(...keys);
    jamendo.state.failing = false;
    jamendo.state.searchDown = false;
    engine.state.down = false;
  };

  // Crea un dueño (por su primera petición autenticada) y un local suyo.
  const createOwnerVenue = async ({ kind = 'restaurant', ambience = 'lounge tranquilo con jazz', name = 'Local de prueba' } = {}) => {
    const token = supabase.token();
    const res = await api('/api/venues', { method: 'POST', token, body: { name, kind, ambience } });
    if (res.status !== 201) throw new Error(`No se pudo crear el local: ${res.status} ${JSON.stringify(res.body)}`);
    return { token, venue: res.body };
  };

  const close = async () => {
    server.closeAllConnections();
    server.close();
    await closeQueue().catch(() => {});
    await pool.end();
    redis.disconnect();
    supabase.close();
    jamendo.close();
    itunes.close();
    engine.close();
  };

  // Lee un stream SSE y devuelve sus eventos cuando until(eventos) es verdadero (o al vencer el tiempo).
  // onEvent permite actuar a mitad del stream, por ejemplo crear una petición al recibir "ready".
  const sse = async (path, { until, onEvent = () => {}, timeoutMs = 8000 } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const events = [];
    try {
      const res = await fetch(`${base}${path}`, { signal: controller.signal });
      if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return { status: res.status, events, body: await res.json() };
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const fields = Object.fromEntries(
            buffer
              .slice(0, end)
              .split('\n')
              .filter((line) => line && !line.startsWith(':'))
              .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
          );
          buffer = buffer.slice(end + 2);
          if (!fields.data) continue;
          const event = { event: fields.event, data: JSON.parse(fields.data) };
          events.push(event);
          await onEvent(event);
          if (until?.(events)) return { status: res.status, events };
        }
      }
      return { status: res.status, events };
    } catch (err) {
      if (controller.signal.aborted) return { status: 0, events };
      throw err;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };

  await reset();
  return { base, api, sse, query, redis, reset, close, createOwnerVenue, supabase, jamendo, itunes, engine };
};

// Espera hasta que check() devuelva algo verdadero (trabajos asíncronos como el worker de BullMQ).
export const waitFor = async (check, { timeoutMs = 10000, intervalMs = 100 } = {}) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('Se agotó la espera');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
};
