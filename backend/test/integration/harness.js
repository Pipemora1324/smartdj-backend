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
  const { closeQueue } = await import('../../src/queue.js');
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
    await query('TRUNCATE users, track_cache, track_search_cache RESTART IDENTITY CASCADE');
    await redis.flushdb();
    jamendo.state.failing = false;
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

  await reset();
  return { base, api, query, redis, reset, close, createOwnerVenue, supabase, jamendo, itunes, engine };
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
