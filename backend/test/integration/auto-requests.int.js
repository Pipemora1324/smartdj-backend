// Integración: peticiones automáticas en AutoDJ (migración 010). Toda petición válida entra sola a la cola;
// la IA decide el orden. Postgres y Redis reales en Docker, motor y catálogos simulados.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor } from './harness.js';

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

const VALIO = '1440818840';
const METAL = '1440818841';
const VIVIR = '1440818839';
// Todos los celulares salen por la misma IP (el Wi-Fi del local) y cada uno tiene su identificador.
let clients = 0;
const newClient = () => ({ 'x-forwarded-for': '10.9.0.1', 'x-client-id': `cliente-${String((clients += 1)).padStart(5, '0')}` });
const ask = (body, headers = newClient()) =>
  stack.api(`/api/public/venues/${owner.venue.public_code}/requests`, { method: 'POST', body, headers });
const player = (path = '', options = {}) => stack.api(`/api/venues/${owner.venue.id}/player${path}`, { token: owner.token, ...options });
const requestRow = async (id) => (await stack.query('SELECT * FROM song_requests WHERE id=$1', [id])).rows[0];
const queueOf = async () => (await player()).body.queue;
const inQueue = (id) => waitFor(async () => (await queueOf()).find((q) => q.requestId === id), { timeoutMs: 15000 });
const seedCatalog = async () =>
  (await stack.api(`/api/venues/${owner.venue.id}/tracks/search?q=pista`, { token: owner.token })).body.tracks;
const mine = (ids) => stack.api(`/api/public/venues/${owner.venue.public_code}/requests?ids=${ids.join(',')}`);
const patchVenue = (body) => stack.api(`/api/venues/${owner.venue.id}`, { method: 'PATCH', token: owner.token, body });

test('en AutoDJ toda petición válida entra sola a la cola, también las que no encajan', async () => {
  await player();
  const metal = await ask({ trackId: METAL });
  const salsa = await ask({ trackId: VIVIR });
  assert.ok(await inQueue(metal.body.id), 'la que no encaja también entra');
  assert.ok(await inQueue(salsa.body.id));
  assert.equal((await requestRow(metal.body.id)).status, 'bridging', 'la evaluación queda como dato, no como filtro');
  const preview = (await queueOf()).find((q) => q.requestId === metal.body.id);
  assert.equal(preview.track.kindLabel, 'Preview 30 s', 'la de iTunes entra como corte de 30 s');
});

test('una petición repetida suma un voto: no se duplica y ambos clientes ven el mismo turno', async () => {
  await player();
  const first = await ask({ trackId: VALIO });
  await inQueue(first.body.id);
  const second = await ask({ trackId: VALIO });
  assert.equal(second.status, 202);
  assert.equal(second.body.duplicate, true);
  assert.match(second.body.message, /sumamos tu voto/);
  const items = (await queueOf()).filter((q) => q.track.externalId === VALIO);
  assert.equal(items.length, 1, 'una sola vez en la cola');
  assert.equal(items[0].votes, 2);
  const states = (await mine([first.body.id, second.body.id])).body.requests;
  assert.deepEqual(
    states.map((r) => r.state),
    ['in_queue', 'in_queue'],
  );
  assert.equal(states[0].position, states[1].position);
  assert.equal(states.find((r) => r.id === second.body.id).duplicate, true);
});

test('cada cliente tiene como máximo 3 pendientes; otro celular del mismo Wi-Fi puede pedir', async () => {
  const me = newClient();
  for (const trackId of [VALIO, METAL, VIVIR]) assert.equal((await ask({ trackId }, me)).status, 202);
  const fourth = await ask({ trackId: VALIO }, me);
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.code, 'too_many_pending');
  assert.match(fourth.body.error, /Ya tienes 3 peticiones esperando turno/);
  assert.equal((await ask({ trackId: VALIO })).status, 202, 'el vecino no se bloquea');
});

test('con el interruptor apagado o en Manual esperan al DJ; al activarlo entran a la cola', async () => {
  await player();
  assert.equal((await patchVenue({ auto_accept_requests: false })).status, 200);
  const off = await ask({ trackId: VALIO });
  await waitFor(async () => (await requestRow(off.body.id)).status === 'accepted');
  await player();
  assert.ok(!(await queueOf()).some((q) => q.requestId === off.body.id), 'apagado: queda para revisar');
  const listed = (await player('/requests')).body;
  assert.equal(listed.autoAccept, false);
  assert.equal(listed.requests[0].stateLabel, 'Esperando al DJ');
  await patchVenue({ auto_accept_requests: true });
  assert.ok(await inQueue(off.body.id), 'al activarlo entra sin esperar otro evento');

  await player('', { method: 'PATCH', body: { mode: 'manual' } });
  const manual = await ask({ trackId: METAL });
  await waitFor(async () => (await requestRow(manual.body.id)).status === 'bridging');
  assert.ok(!(await queueOf()).some((q) => q.requestId === manual.body.id), 'en Manual decide el dueño');
  assert.equal((await player('/requests')).body.autoAccept, false);
});

test('una pista que sonó hace poco entra con espera y el cliente lo ve', async () => {
  await player();
  const [track] = await seedCatalog();
  await stack.query("INSERT INTO mix_history(establishment_id, track_id, played_at) VALUES($1, $2, NOW() - INTERVAL '5 minutes')", [
    owner.venue.id,
    track.id,
  ]);
  const res = await ask({ provider: 'jamendo', externalId: track.externalId });
  const state = await waitFor(async () => {
    const [r] = (await mine([res.body.id])).body.requests;
    return r.state === 'waiting' && r;
  });
  assert.equal(state.stateLabel, 'En la cola');
  assert.ok(state.etaSeconds > 20 * 60 && state.etaSeconds <= 25 * 60, `espera de ~25 min, fue ${state.etaSeconds}`);
  assert.ok(!(await queueOf()).some((q) => q.requestId === res.body.id), 'no suena antes de la espera');
});

test('quitar una petición de la cola la descarta y no vuelve a entrar', async () => {
  await player();
  const res = await ask({ trackId: VALIO });
  const item = await inQueue(res.body.id);
  assert.equal((await player(`/queue/${item.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await requestRow(res.body.id)).status, 'rejected');
  await player();
  assert.ok(!(await queueOf()).some((q) => q.requestId === res.body.id));
});

test('bloquear descarta la petición y la canción ya no se acepta en el local', async () => {
  await player();
  const res = await ask({ trackId: VALIO });
  await inQueue(res.body.id);
  const blocked = await player(`/requests/${res.body.id}/block`, { method: 'POST' });
  assert.equal(blocked.status, 200);
  assert.ok(!(await queueOf()).some((q) => q.requestId === res.body.id));
  const again = await ask({ trackId: VALIO });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /no acepta esta canción/);
});

test('el dueño sube una petición en el orden', async () => {
  await player();
  await player('', { method: 'PATCH', body: { crossfadeSeconds: 8 } });
  const a = await ask({ trackId: VALIO });
  const b = await ask({ trackId: VIVIR });
  await inQueue(a.body.id);
  await inQueue(b.body.id);
  const order = async () => (await queueOf()).filter((q) => q.requestId).map((q) => q.requestId);
  assert.deepEqual(await order(), [a.body.id, b.body.id], 'por orden de llegada');
  const up = await player(`/requests/${b.body.id}/priority`, { method: 'POST', body: { delta: 1 } });
  assert.equal(up.status, 200);
  assert.deepEqual(await order(), [b.body.id, a.body.id]);
  assert.equal((await player(`/requests/${b.body.id}/priority`, { method: 'POST', body: { delta: 3 } })).status, 400);
});

test('una petición que falla se reintenta una vez y luego queda como No se pudo reproducir', async () => {
  await player();
  const res = await ask({ trackId: VALIO });
  await inQueue(res.body.id);
  await player('/play', { method: 'POST', body: {} });
  const failOnce = async () => {
    let state = (await player()).body;
    // Avanza hasta que suene la petición.
    for (let i = 0; i < 10 && state.current?.requestId !== res.body.id && state.current?.track.externalId !== VALIO; i += 1) {
      state = (await player('/advance', { method: 'POST', body: { fromTrackId: state.current?.track.id ?? null } })).body;
    }
    assert.equal(state.current.track.externalId, VALIO);
    return (await player('/skip', { method: 'POST', body: { reason: 'error', fromTrackId: state.current.track.id } })).body;
  };
  const afterFirst = await failOnce();
  assert.ok(afterFirst.current, 'la emisora no queda en silencio');
  assert.equal((await requestRow(res.body.id)).status, 'accepted', 'primer fallo: se reintenta');
  await inQueue(res.body.id);
  await failOnce();
  const [state] = (await mine([res.body.id])).body.requests;
  assert.equal(state.stateLabel, 'No se pudo reproducir');
});

test('el local puede no aceptar canciones explícitas', async () => {
  await patchVenue({ block_explicit: true });
  const explicit = await ask({ trackId: METAL });
  assert.equal(explicit.status, 409);
  assert.match(explicit.body.error, /letra explícita/);
  assert.equal((await ask({ trackId: VALIO })).status, 202);
});

test('la página pública ve su puesto y la espera estimada', async () => {
  await player();
  await player('/play', { method: 'POST', body: {} });
  const res = await ask({ trackId: VALIO });
  await inQueue(res.body.id);
  const [state] = (await mine([res.body.id])).body.requests;
  assert.equal(state.state, 'in_queue');
  assert.equal(state.position, 2, 'después de la siguiente, que ya puede estar precargada');
  assert.ok(state.etaSeconds > 0);
});

test('30 clientes piden a la vez: todas entran, suenan sin duplicados ni pérdidas y en orden justo', async () => {
  await player();
  const initial = new Set((await queueOf()).map((q) => q.track.id));
  const songs = (await seedCatalog()).filter((t) => !initial.has(t.id)).slice(0, 25);
  assert.equal(songs.length, 25);
  const bodies = [
    ...songs.map((t) => ({ provider: 'jamendo', externalId: t.externalId })),
    { trackId: VALIO },
    { trackId: METAL },
    { trackId: VIVIR },
    { trackId: VALIO },
    { provider: 'jamendo', externalId: songs[0].externalId },
  ];
  const responses = await Promise.all(bodies.map((body) => ask(body)));
  assert.deepEqual(
    responses.map((r) => r.status),
    Array(30).fill(202),
  );
  const primaries = responses.filter((r) => !r.body.duplicate).map((r) => r.body.id);
  assert.equal(primaries.length, 28, 'dos votos, sin filas duplicadas en la cola');

  const queue = await waitFor(
    async () => {
      const q = await queueOf();
      return primaries.every((id) => q.some((item) => item.requestId === id)) && q;
    },
    { timeoutMs: 30000, intervalMs: 300 },
  );
  const requestTracks = queue.filter((q) => q.requestId).map((q) => q.track.id);
  assert.equal(new Set(requestTracks).size, requestTracks.length, 'ninguna pista dos veces');
  // Equilibrio: con muchas pendientes, nunca más de 4 peticiones seguidas mientras haya pistas de la IA.
  let run = 0;
  let maxRun = 0;
  for (const item of queue) {
    run = item.requestId ? run + 1 : 0;
    maxRun = Math.max(maxRun, run);
  }
  assert.ok(maxRun <= 4, `racha de ${maxRun} peticiones seguidas`);

  // Suena la emisora hasta que no quede ninguna petición.
  let state = (await player('/play', { method: 'POST', body: {} })).body;
  for (let i = 0; i < 80; i += 1) {
    const pending = await stack.query("SELECT COUNT(*)::int AS n FROM song_requests WHERE establishment_id=$1 AND status <> 'played'", [
      owner.venue.id,
    ]);
    if (!pending.rows[0].n) break;
    state = (await player('/advance', { method: 'POST', body: { fromTrackId: state.current?.track.id ?? null } })).body;
  }
  const played = (
    await stack.query(
      `SELECT h.request_id, r.created_at FROM mix_history h JOIN song_requests r ON r.id = h.request_id
       WHERE h.establishment_id=$1 ORDER BY h.played_at, h.id`,
      [owner.venue.id],
    )
  ).rows;
  assert.deepEqual(
    [...played.map((p) => p.request_id)].sort((a, b) => a.localeCompare(b)),
    [...primaries].sort((a, b) => a.localeCompare(b)),
    'cada petición sonó una sola vez',
  );
  const statuses = await stack.query('SELECT DISTINCT status FROM song_requests WHERE establishment_id=$1', [owner.venue.id]);
  assert.deepEqual(
    statuses.rows.map((r) => r.status),
    ['played'],
    'también los votos',
  );
  // Justicia: ninguna fue adelantada por más de 3 que llegaron después.
  played.forEach((p, index) => {
    const passedBy = played.slice(0, index).filter((q) => new Date(q.created_at) > new Date(p.created_at)).length;
    assert.ok(passedBy <= 3, `una petición fue aplazada ${passedBy} veces`);
  });
});

test('el tope de pendientes por red frena a quien invente identificadores', async () => {
  const { anonymousKey } = await import('../../src/station-requests.js');
  // 90 pendientes (3 × 30) desde la misma IP: se cargan directo para no depender de los límites por minuto.
  await stack.query(
    `INSERT INTO song_requests(establishment_id, guest_name, title, artist, genre, status, ip_key)
     SELECT $1, 'X', 'T' || g, 'A', 'Pop', 'accepted', $2 FROM generate_series(1, 90) g`,
    [owner.venue.id, anonymousKey('10.9.0.250')],
  );
  const res = await ask({ trackId: VALIO }, { 'x-forwarded-for': '10.9.0.250', 'x-client-id': 'cliente-nuevo-0001' });
  assert.equal(res.status, 429);
  assert.match(res.body.error, /desde esta red/);
});

test('una petición sin audio posible queda descartada con un aviso', async () => {
  await player();
  const { rows } = await stack.query(
    `INSERT INTO song_requests(establishment_id, guest_name, title, artist, genre, status, evaluated_at)
     VALUES($1, 'X', 'Canción inexistente', 'Nadie', 'Pop', 'accepted', NOW()) RETURNING id`,
    [owner.venue.id],
  );
  await player();
  const row = await requestRow(rows[0].id);
  assert.equal(row.status, 'rejected');
  assert.match(row.ai_reason, /No encontramos audio/);
});

test('dos peticiones distintas que suenan con la misma pista quedan como una sola con dos votos', async () => {
  await player();
  // "Vivir Mi Vida" de iTunes tiene versión completa en Jamendo: pedir las dos es pedir la misma pista.
  await stack.api(`/api/public/venues/${owner.venue.public_code}/search?q=vivir`);
  const itunes = await ask({ trackId: VIVIR });
  await inQueue(itunes.body.id);
  const jamendo = await ask({ provider: 'jamendo', externalId: '2000000' });
  await waitFor(async () => (await requestRow(jamendo.body.id)).duplicate_of === itunes.body.id);
  const items = (await queueOf()).filter((q) => q.track.externalId === '2000000');
  assert.equal(items.length, 1);
  assert.equal(items[0].votes, 2);
});

test('un voto que llega mientras se evalúa la original toma su resultado y no queda pendiente', async () => {
  await player();
  const [first, second] = await Promise.all([ask({ trackId: VALIO }), ask({ trackId: VALIO })]);
  const vote = first.body.duplicate ? first : second;
  const original = first.body.duplicate ? second : first;
  await inQueue(original.body.id);
  const [voteRow, originalRow] = await Promise.all([requestRow(vote.body.id), requestRow(original.body.id)]);
  assert.equal(voteRow.status, originalRow.status, 'el voto no se queda "En evaluación"');
  const [state] = (await mine([vote.body.id])).body.requests;
  assert.equal(state.state, 'in_queue');
  assert.equal(state.votes, 2);
});

test('pedir la canción que está sonando la deja en espera, no se repite enseguida', async () => {
  await player();
  const playing = (await player('/play', { method: 'POST', body: {} })).body.current.track;
  const res = await ask({ provider: playing.provider, externalId: playing.externalId });
  const [state] = await waitFor(async () => {
    const requests = (await mine([res.body.id])).body.requests;
    return requests[0]?.state === 'waiting' && requests;
  });
  assert.equal(state.stateLabel, 'En la cola');
  assert.match(state.waitUntil, /^\d{4}-/);
  assert.ok(!(await queueOf()).some((q) => q.requestId === res.body.id));
});
