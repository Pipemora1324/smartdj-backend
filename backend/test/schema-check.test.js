// Pruebas de la comparación de esquema (sin base de datos).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.js exige estas variables; son ficticias y no se abre ninguna conexión.
Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://x:y@localhost/z', REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  AI_SERVICE_URL: process.env.AI_SERVICE_URL || 'http://localhost:1', SUPABASE_URL: process.env.SUPABASE_URL || 'https://test.supabase.co',
  SUPABASE_JWKS_URL: process.env.SUPABASE_JWKS_URL || 'http://localhost:1/jwks',
});
const { findMissing, REQUIRED_SCHEMA, REQUIRED_TYPES } = await import('../src/schema-check.js');

const rowsFor = (schema) => Object.entries(schema).flatMap(([table, cols]) => cols.map((column) => ({ table_name: table, column_name: column })));

test('un esquema completo no reporta faltantes', () => {
  assert.deepEqual(findMissing(rowsFor(REQUIRED_SCHEMA), REQUIRED_TYPES), []);
});

test('reporta tablas, columnas y tipos faltantes', () => {
  const { song_requests: _ignored, ...withoutRequests } = REQUIRED_SCHEMA;
  const rows = rowsFor(withoutRequests).filter((r) => !(r.table_name === 'users' && r.column_name === 'auth_id'));
  const missing = findMissing(rows, ['venue_kind']);
  assert.ok(missing.includes('tabla song_requests'));
  assert.ok(missing.includes('columna users.auth_id'));
  assert.ok(missing.includes('tipo request_status'));
  assert.equal(missing.length, 3);
});
