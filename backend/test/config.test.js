// Pruebas de la validación de la configuración (sin conexiones: solo se analizan las variables).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const VALID = {
  DATABASE_URL: 'postgresql://smartdj:x@localhost:5432/smartdj',
  REDIS_URL: 'redis://localhost:6379',
  AI_SERVICE_URL: 'http://localhost:8000',
  SUPABASE_URL: 'https://ref.supabase.co',
  SUPABASE_JWKS_URL: 'https://ref.supabase.co/auth/v1/.well-known/jwks.json',
};
// config.js valida process.env al importarse: se le dan variables válidas de prueba.
Object.assign(process.env, { ...VALID, ...Object.fromEntries(Object.entries(VALID).map(([k, v]) => [k, process.env[k] || v])) });
const { parseConfig, ConfigError } = await import('../src/config.js');

const problems = (env) => {
  try {
    parseConfig(env);
    return '';
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.message;
  }
};

test('una configuración mínima válida usa valores por defecto seguros', () => {
  const config = parseConfig(VALID);
  assert.equal(config.port, 3000);
  assert.equal(config.aiGrpcTls, false);
  assert.equal(config.aiGrpcTimeoutMs, 10000);
  assert.equal(config.jamendoApiUrl, 'https://api.jamendo.com/v3.0');
  assert.equal(config.jamendoMonthlyBudget, 30000);
  assert.ok(config.origins.includes('https://smart-dj-platform-frontend.vercel.app'));
});

test('lista todas las variables que faltan en un solo error en español', () => {
  const message = problems({});
  for (const name of ['DATABASE_URL', 'REDIS_URL', 'AI_SERVICE_URL', 'SUPABASE_URL', 'SUPABASE_JWKS_URL'])
    assert.match(message, new RegExp(name));
  assert.match(message, /Configuración inválida/);
  assert.match(message, /falta/);
});

test('rechaza formatos inválidos', () => {
  assert.match(problems({ ...VALID, DATABASE_URL: 'mysql://x' }), /DATABASE_URL: debe ser una URL de Postgres/);
  assert.match(problems({ ...VALID, REDIS_URL: 'http://x' }), /REDIS_URL/);
  assert.match(problems({ ...VALID, PORT: 'abc' }), /PORT: debe ser un número/);
  assert.match(problems({ ...VALID, PORT: '70000' }), /puerto válido/);
  assert.match(problems({ ...VALID, AI_GRPC_URL: 'sin-puerto' }), /host:puerto/);
  assert.match(problems({ ...VALID, AI_GRPC_TLS: 'si' }), /true o false/);
});

test('no acepta secretos cortos ni servicios externos por http', () => {
  assert.match(problems({ ...VALID, SUPABASE_JWKS_URL: '', SUPABASE_JWT_SECRET: 'corto' }), /al menos 32 caracteres/);
  assert.match(problems({ ...VALID, JAMENDO_API_URL: 'http://api.jamendo.com/v3.0' }), /https/);
  assert.equal(parseConfig({ ...VALID, JAMENDO_API_URL: 'http://localhost:3997/v3.0' }).jamendoApiUrl, 'http://localhost:3997/v3.0');
  assert.match(problems({ ...VALID, ITUNES_API_URL: 'http://itunes.apple.com' }), /ITUNES_API_URL: debe ser una URL https/);
  assert.equal(parseConfig({ ...VALID, SUPABASE_JWKS_URL: '', SUPABASE_JWT_SECRET: 'x'.repeat(32) }).supabaseJwtSecret.length, 32);
});

test('corrige URLs de Upstash copiadas sin TLS', () => {
  assert.equal(
    parseConfig({ ...VALID, REDIS_URL: 'redis://default:x@demo.upstash.io:6379' }).redisUrl,
    'rediss://default:x@demo.upstash.io:6379',
  );
  assert.equal(parseConfig(VALID).redisUrl, 'redis://localhost:6379');
});

test('suma los orígenes de CORS_ORIGIN a los conocidos sin repetir', () => {
  const config = parseConfig({ ...VALID, CORS_ORIGIN: 'https://mi-front.vercel.app, http://localhost:5173' });
  assert.ok(config.origins.includes('https://mi-front.vercel.app'));
  assert.equal(config.origins.filter((o) => o === 'http://localhost:5173').length, 1);
});

test('ignora orígenes de CORS inválidos con un aviso, sin impedir el arranque', () => {
  const config = parseConfig({ ...VALID, CORS_ORIGIN: 'https://ok.app,https://mal.app/ruta,*,ftp://mal.app' });
  assert.ok(config.origins.includes('https://ok.app'));
  assert.ok(!config.origins.some((o) => o.includes('mal.app') || o === '*'));
  assert.equal(config.warnings.length, 3);
  assert.match(config.warnings[0], /se ignora "https:\/\/mal.app\/ruta"/);
});

test('acepta orígenes con barra final y la quita', () => {
  assert.ok(parseConfig({ ...VALID, CORS_ORIGIN: 'https://mi-front.vercel.app/' }).origins.includes('https://mi-front.vercel.app'));
});

test('acepta valores reales del panel del hosting que antes funcionaban', () => {
  // Variables definidas pero vacías usan su valor por defecto.
  const blank = parseConfig({ ...VALID, PORT: '', JAMENDO_MONTHLY_BUDGET: ' ', AI_GRPC_TIMEOUT_MS: '', JAMENDO_API_URL: '' });
  assert.equal(blank.port, 3000);
  assert.equal(blank.jamendoMonthlyBudget, 30000);
  assert.equal(blank.aiGrpcTimeoutMs, 10000);
  assert.equal(blank.jamendoApiUrl, 'https://api.jamendo.com/v3.0');
  assert.equal(parseConfig({ ...VALID, AI_GRPC_TLS: 'True' }).aiGrpcTls, true);
  // Contraseñas con caracteres que new URL() rechaza, pero pg e ioredis aceptan.
  assert.equal(
    parseConfig({ ...VALID, DATABASE_URL: 'postgresql://u:p#a^[s@db.host:5432/x' }).dbUrl,
    'postgresql://u:p#a^[s@db.host:5432/x',
  );
  assert.equal(
    parseConfig({ ...VALID, REDIS_URL: 'redis://default:a@b#c@demo.upstash.io:6379' }).redisUrl,
    'rediss://default:a@b#c@demo.upstash.io:6379',
  );
  assert.equal(parseConfig({ ...VALID, REDIS_URL: 'redis://cache.local:6379' }).redisUrl, 'redis://cache.local:6379');
});

test('el pool de Postgres es de 10 por defecto y se limita a 50', () => {
  assert.equal(parseConfig(VALID).dbPoolMax, 10);
  assert.equal(parseConfig({ ...VALID, DATABASE_POOL_MAX: '15' }).dbPoolMax, 15);
  assert.match(problems({ ...VALID, DATABASE_POOL_MAX: '500' }), /DATABASE_POOL_MAX: debe ser como mucho 50/);
});

test('las reglas de las peticiones automáticas tienen valores por defecto y topes', () => {
  assert.deepEqual(parseConfig(VALID).requests, { maxDeferral: 3, balanceEvery: 4, maxPendingPerClient: 3, replayWaitMinutes: 30 });
  assert.equal(parseConfig({ ...VALID, REQUEST_MAX_DEFERRAL: '5' }).requests.maxDeferral, 5);
  assert.match(problems({ ...VALID, REQUEST_BALANCE_EVERY: '0' }), /REQUEST_BALANCE_EVERY: debe ser mayor que 0/);
  assert.match(problems({ ...VALID, REQUEST_MAX_PENDING_PER_CLIENT: '99' }), /como mucho 20/);
});
