// Pruebas de los límites de uso con un Express real en un puerto local (sin red externa).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  IP_CEILING_FACTOR,
  LIMITS,
  MINUTE_MS,
  byClient,
  byOwner,
  clientIdOf,
  createLimiter,
  createPublicLimiter,
} from '../src/rate-limits.js';

const servers = [];
const serve = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
after(() => servers.forEach((s) => s.close()));

test('al pasar el límite responde 429 con mensaje en español y código', async () => {
  const app = express();
  app.get('/x', createLimiter({ limit: 2, message: 'Espera un momento.' }), (_req, res) => res.json({ ok: true }));
  const base = await serve(app);
  const statuses = [];
  for (let i = 0; i < 3; i += 1) statuses.push((await fetch(`${base}/x`)).status);
  assert.deepEqual(statuses, [200, 200, 429]);
  const res = await fetch(`${base}/x`);
  assert.deepEqual(await res.json(), { error: 'Espera un momento.', code: 'rate_limited' });
  assert.ok(res.headers.get('ratelimit-policy'));
});

test('el límite del dueño se cuenta por cuenta, no por IP', async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { sub: req.get('x-user') };
    next();
  });
  app.get('/x', createLimiter({ limit: 1, message: 'Espera.', keyGenerator: byOwner }), (_req, res) => res.json({ ok: true }));
  const base = await serve(app);
  const call = (user) => fetch(`${base}/x`, { headers: { 'x-user': user } }).then((r) => r.status);
  assert.equal(await call('ana'), 200);
  assert.equal(await call('beto'), 200);
  assert.equal(await call('ana'), 429);
});

test('en una ruta pública, quienes comparten IP tienen cada uno su límite', async () => {
  const app = express();
  app.get('/x', createPublicLimiter({ limit: 2, message: 'Espera.' }), (_req, res) => res.json({ ok: true }));
  const base = await serve(app);
  const call = (client) => fetch(`${base}/x`, { headers: client ? { 'x-client-id': client } : {} }).then((r) => r.status);
  assert.deepEqual([await call('cliente-aaaa'), await call('cliente-aaaa'), await call('cliente-aaaa')], [200, 200, 429]);
  assert.equal(await call('cliente-bbbb'), 200, 'otro celular en el mismo Wi-Fi no queda bloqueado');
  // Sin identificador (o con uno inválido) se cuenta por IP, como antes.
  assert.deepEqual([await call(), await call('x'), await call()], [200, 200, 429]);
});

test('el tope por IP frena a quien invente identificadores', async () => {
  const app = express();
  app.get('/x', createPublicLimiter({ limit: 1, message: 'Espera.' }), (_req, res) => res.json({ ok: true }));
  const base = await serve(app);
  const statuses = [];
  for (let i = 0; i <= IP_CEILING_FACTOR; i += 1) {
    statuses.push((await fetch(`${base}/x`, { headers: { 'x-client-id': `inventado-${String(i).padStart(4, '0')}` } })).status);
  }
  assert.equal(statuses.filter((s) => s === 200).length, IP_CEILING_FACTOR);
  assert.equal(statuses.at(-1), 429);
});

test('el identificador de cliente se lee de la cabecera o del query (EventSource)', () => {
  const req = (headers, query = {}) => ({ ip: '1.2.3.4', query, get: (name) => headers[name] });
  assert.equal(byClient(req({ 'x-client-id': 'abcd1234-ef' })), '1.2.3.4|abcd1234-ef');
  assert.equal(byClient(req({}, { client: 'abcd1234-ef' })), '1.2.3.4|abcd1234-ef');
  assert.equal(clientIdOf(req({ 'x-client-id': '<script>alert(1)</script>' })), null);
  assert.equal(byClient(req({}, { client: ['a', 'b'] })), '1.2.3.4');
});

test('todos los límites tienen valor y mensaje en español', () => {
  for (const [name, cfg] of Object.entries(LIMITS)) {
    assert.ok(cfg.limit > 0, name);
    assert.match(cfg.message, /\.$/, name);
  }
  assert.equal(LIMITS.authProfile.windowMs, 15 * MINUTE_MS);
});
