// Pruebas de los límites de uso con un Express real en un puerto local (sin red externa).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { LIMITS, MINUTE_MS, byOwner, createLimiter } from '../src/rate-limits.js';

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

test('todos los límites tienen valor y mensaje en español', () => {
  for (const [name, cfg] of Object.entries(LIMITS)) {
    assert.ok(cfg.limit > 0, name);
    assert.match(cfg.message, /\.$/, name);
  }
  assert.equal(LIMITS.authProfile.windowMs, 15 * MINUTE_MS);
});
