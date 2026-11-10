// Integración: seed de demostración (database/seeds). La cuenta demo entra con el Supabase simulado y ve sus
// 4 locales; el seed se puede repetir sin duplicar, no deja peticiones pendientes y la limpieza lo quita todo.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startStack } from './harness.js';

const DEMO_EMAIL = 'admin123@example.com';
const seedFile = (name) => readFile(new URL(`../../../database/seeds/${name}`, import.meta.url), 'utf8');

let stack;
let seedSql;
let cleanupSql;
before(async () => {
  stack = await startStack();
  [seedSql, cleanupSql] = await Promise.all([seedFile('demo_admin.sql'), seedFile('demo_admin_cleanup.sql')]);
});
after(() => stack.close());
beforeEach(() => stack.reset());

// Primera sesión de la cuenta demo: crea su fila en users, como al entrar a la app con correo y contraseña.
const demoLogin = async () => {
  const token = stack.supabase.token({ email: DEMO_EMAIL });
  const me = await stack.api('/api/auth/me', { token });
  assert.equal(me.status, 200);
  return token;
};
const count = async (sql) => Number((await stack.query(sql)).rows[0].n);

test('sin la cuenta demo en users, el seed no crea nada', async () => {
  await stack.query(seedSql);
  assert.equal(await count('SELECT COUNT(*) AS n FROM establishments'), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM song_requests'), 0);
});

test('la cuenta demo ve sus 4 locales aunque el seed se ejecute dos veces', async () => {
  const token = await demoLogin();
  await stack.query(seedSql);
  const first = (await stack.api('/api/venues', { token })).body;
  await stack.query(seedSql);
  const venues = (await stack.api('/api/venues', { token })).body;

  assert.equal(venues.length, 4);
  assert.deepEqual(
    venues.map((v) => v.kind),
    ['nightclub', 'salsa_bar', 'cafe', 'restaurant'],
  );
  // Códigos estables: los links y los QR no cambian al repetir el seed.
  assert.deepEqual(
    venues.map((v) => v.public_code),
    first.map((v) => v.public_code),
  );
  for (const venue of venues) assert.match(venue.public_code, /^[0-9a-f]{12}$/);

  assert.equal(await count("SELECT COUNT(*) AS n FROM song_requests WHERE client_key='demo-seed'"), 12);
  assert.equal(
    await count("SELECT COUNT(*) AS n FROM mix_history h JOIN song_requests r ON r.id=h.request_id WHERE r.client_key='demo-seed'"),
    8,
  );
  // Ninguna queda pendiente: el AutoDJ no tiene nada que poner en la cola.
  assert.equal(await count("SELECT COUNT(*) AS n FROM song_requests WHERE status IN ('queued','accepted','bridging')"), 0);

  // La página pública de cada local responde con su código y la consola no muestra peticiones pendientes.
  const venue = venues[0];
  assert.equal((await stack.api(`/api/public/venues/${venue.public_code}`)).status, 200);
  const pending = await stack.api(`/api/venues/${venue.id}/player/requests`, { token });
  assert.equal(pending.status, 200);
  assert.deepEqual(pending.body.requests, []);
});

test('la limpieza borra solo los datos demo y la fila de la cuenta en users', async () => {
  await demoLogin();
  const other = await stack.createOwnerVenue({ name: 'Local real' });
  await stack.query(seedSql);
  await stack.query(cleanupSql);

  assert.equal(await count(`SELECT COUNT(*) AS n FROM users WHERE email='${DEMO_EMAIL}'`), 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM song_requests WHERE client_key='demo-seed'"), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM mix_history'), 0);
  const left = (await stack.api('/api/venues', { token: other.token })).body;
  assert.deepEqual(
    left.map((v) => v.name),
    ['Local real'],
  );
  // Repetirla no falla.
  await stack.query(cleanupSql);
});
