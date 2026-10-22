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
  assert.match(problems({ ...VALID, CORS_ORIGIN: 'https://ok.app,https://mal.app/ruta' }), /mal\.app\/ruta" no es un origen válido/);
  assert.match(problems({ ...VALID, CORS_ORIGIN: 'ftp://mal.app' }), /no es un origen válido/);
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

test('acepta orígenes con barra final y la quita', () => {
  assert.ok(parseConfig({ ...VALID, CORS_ORIGIN: 'https://mi-front.vercel.app/' }).origins.includes('https://mi-front.vercel.app'));
});
