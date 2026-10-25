// Integración: reproductor de la emisora y AutoDJ (motor gRPC simulado, Jamendo simulado, Postgres y Redis reales).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from './harness.js';

let stack;
let owner;
before(async () => {
  stack = await startStack();
});
after(() => stack.close());
beforeEach(async () => {
  await stack.reset();
  owner = await stack.createOwnerVenue();
});

const player = (path = '', { method = 'GET', body, token = owner.token } = {}) =>
  stack.api(`/api/venues/${owner.venue.id}/player${path}`, { method, body, token });
const CONSOLE_A = 'consola-a-1234';
const CONSOLE_B = 'consola-b-5678';

test('la primera carga en AutoDJ llena la cola con lo que sugiere el motor', async () => {
  const res = await player();
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'autodj');
  assert.equal(res.body.status, 'stopped');
  assert.equal(res.body.queue.length, 5);
  for (const item of res.body.queue) {
    assert.equal(item.source, 'autodj');
    assert.equal(item.reason, 'Sugerida por el motor de prueba.');
    assert.equal(item.crossfadeSeconds, 8);
  }
  assert.equal(new Set(res.body.queue.map((q) => q.track.id)).size, 5, 'sin pistas repetidas');
  assert.ok(stack.engine.state.suggestCalls >= 5);
});

test('play, pausa, avance idempotente y salto quedan en el historial', async () => {
  await player();
  await player('/claim', { method: 'POST', body: { consoleId: CONSOLE_A } });
  const playing = await player('/play', { method: 'POST', body: { consoleId: CONSOLE_A } });
  assert.equal(playing.body.status, 'playing');
  const first = playing.body.current.track.id;
  assert.equal(playing.body.queue.length, 4);

  const paused = await player('/pause', { method: 'POST', body: { consoleId: CONSOLE_A, positionSeconds: 42.5 } });
  assert.equal(paused.body.status, 'paused');
  assert.equal(paused.body.positionSeconds, 42.5);
  await player('/play', { method: 'POST', body: { consoleId: CONSOLE_A } });

  const advanced = await player('/advance', { method: 'POST', body: { consoleId: CONSOLE_A, fromTrackId: first } });
  assert.equal(advanced.body.advanced, true);
  assert.notEqual(advanced.body.current.track.id, first);
  assert.equal(advanced.body.queue.length, 5, 'el AutoDJ rellena después de avanzar');
  // El mismo aviso repetido (fin de pista y botón a la vez) no avanza dos veces.
  const repeated = await player('/advance', { method: 'POST', body: { consoleId: CONSOLE_A, fromTrackId: first } });
  assert.equal(repeated.body.advanced, false);
  assert.equal(repeated.body.current.track.id, advanced.body.current.track.id);

  await player('/skip', { method: 'POST', body: { consoleId: CONSOLE_A, reason: 'error' } });
  const { rows } = await stack.query('SELECT ended_reason, skipped FROM mix_history WHERE establishment_id=$1 ORDER BY played_at', [
    owner.venue.id,
  ]);
  assert.deepEqual(rows, [
    { ended_reason: 'ended', skipped: false },
    { ended_reason: 'error', skipped: true },
  ]);
});

test('otra consola no puede controlar la emisora hasta tomar el control', async () => {
  await player();
  await player('/claim', { method: 'POST', body: { consoleId: CONSOLE_A } });
  const blocked = await player('/play', { method: 'POST', body: { consoleId: CONSOLE_B } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'console_taken');
  await player('/claim', { method: 'POST', body: { consoleId: CONSOLE_B } });
  assert.equal((await player('/play', { method: 'POST', body: { consoleId: CONSOLE_B } })).status, 200);
});

test('en modo manual la cola no se rellena y se puede reordenar y quitar', async () => {
  const initial = await player();
  const settings = await player('', { method: 'PATCH', body: { mode: 'manual', volume: 40, crossfadeSeconds: 12 } });
  assert.deepEqual([settings.body.mode, settings.body.volume, settings.body.crossfadeSeconds], ['manual', 40, 12]);

  const ids = initial.body.queue.map((q) => q.id);
  const reordered = await player('/queue', { method: 'PATCH', body: { order: [...ids].reverse() } });
  assert.deepEqual(
    reordered.body.queue.map((q) => q.id),
    [...ids].reverse(),
  );
  const removed = await player(`/queue/${ids[0]}`, { method: 'DELETE' });
  assert.equal(removed.body.queue.length, 4, 'en manual no se rellena');
  assert.deepEqual(
    removed.body.queue.map((q) => q.position),
    [1, 2, 3, 4],
  );
  assert.equal((await player(`/queue/${ids[0]}`, { method: 'DELETE' })).status, 404);
});

test('con la cola vacía en manual, play avisa en español', async () => {
  await player('', { method: 'PATCH', body: { mode: 'manual' } });
  const res = await player('/play', { method: 'POST', body: {} });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /cola está vacía/);
});

test('agregar a mano exige una pista del catálogo y respeta la licencia del local', async () => {
  await player('', { method: 'PATCH', body: { mode: 'manual' } });
  const found = await stack.api(`/api/venues/${owner.venue.id}/tracks/search?q=pista`, { token: owner.token });
  const nc = found.body.tracks.find((t) => /NC/.test(t.credit.license));
  const free = found.body.tracks.find((t) => !/NC/.test(t.credit.license));
  const added = await player('/queue', { method: 'POST', body: { provider: 'jamendo', externalId: free.externalId } });
  assert.equal(added.body.queue.at(-1).source, 'manual');
  assert.equal((await player('/queue', { method: 'POST', body: { provider: 'jamendo', externalId: '999999' } })).status, 404);
  await stack.api(`/api/venues/${owner.venue.id}`, { method: 'PATCH', token: owner.token, body: { exclude_non_commercial: true } });
  const refused = await player('/queue', { method: 'POST', body: { provider: 'jamendo', externalId: nc.externalId } });
  assert.equal(refused.status, 409);
});

test('valida los datos del reproductor', async () => {
  for (const [path, method, body, pattern] of [
    ['', 'PATCH', { volume: 150 }, /0 a 100/],
    ['', 'PATCH', {}, /No hay cambios/],
    ['/claim', 'POST', { consoleId: 'x' }, /consola no es válido/],
    ['/skip', 'POST', { reason: 'aburrida' }, /user o error/],
    ['/queue', 'PATCH', { order: [] }, /vacía/],
  ]) {
    const res = await player(path, { method, body });
    assert.equal(res.status, 400, `${method} ${path}`);
    assert.match(res.body.error, pattern);
  }
});

test('la página pública muestra lo que suena sin datos internos', async () => {
  await player();
  await player('/play', { method: 'POST', body: {} });
  const now = await stack.api(`/api/public/venues/${owner.venue.public_code}/now`);
  assert.equal(now.status, 200);
  assert.equal(now.body.station.status, 'playing');
  assert.ok(now.body.nowPlaying.credit.url);
  assert.equal(now.body.queue.length, 4);
  const text = JSON.stringify(now.body);
  for (const secret of ['audioUrl', 'consoleId', 'requestId', 'owner_id', 'requestedBy']) assert.ok(!text.includes(secret), secret);
});

test('si otro proceso tiene el candado del AutoDJ, no se duplica el trabajo', async () => {
  await stack.redis.set(`autodj:lock:${owner.venue.id}`, 'otro', 'EX', 5);
  assert.equal((await player()).body.queue.length, 0);
});

test('si las búsquedas de Jamendo caen y no hay caché, el AutoDJ usa la radio de Jamendo', async () => {
  stack.jamendo.state.searchDown = true;
  const res = await player();
  assert.equal(res.body.queue.length, 1, 'la radio aporta una sola pista');
  assert.equal(res.body.queue[0].track.externalId, '2000005');
});

// Va al final: tras una caída, el AutoDJ no vuelve a preguntar al motor durante un minuto.
test('si el motor cae, el AutoDJ elige por género y energía del local', async () => {
  stack.engine.state.down = true;
  const res = await player();
  assert.equal(res.body.queue.length, 5);
  for (const item of res.body.queue) assert.match(item.reason, /motor no disponible/);
});
