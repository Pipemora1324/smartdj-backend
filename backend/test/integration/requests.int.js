// Integración: peticiones del público. Cola de BullMQ con el worker real, evaluación por el motor gRPC simulado,
// estado en vivo (polling y SSE), panel del dueño, intercalado del AutoDJ y límite por IP.
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

const VIVIR = '1440818839';
const VALIO = '1440818840';
const METAL = '1440818841';
// Cada prueba usa su propia IP (X-Forwarded-For, con trust proxy) para no gastar el límite de las demás.
let ip = 0;
const nextIp = () => `10.0.0.${(ip += 1)}`;
const ask = (body, headers = { 'x-forwarded-for': nextIp() }) =>
  stack.api(`/api/public/venues/${owner.venue.public_code}/requests`, { method: 'POST', body, headers });
const statusRow = (id) => stack.query('SELECT status, guest_name, track_id FROM song_requests WHERE id=$1', [id]).then((r) => r.rows[0]);

test('una petición de iTunes se encola, el motor la evalúa y el estado queda en la base', async () => {
  const res = await ask({ guestName: 'Lucía', trackId: VIVIR });
  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'queued');
  await waitFor(async () => (await statusRow(res.body.id)).status === 'accepted');
  const live = await stack.api(`/api/public/requests/${res.body.id}`);
  assert.equal(live.body.title, 'Vivir Mi Vida');
  assert.equal(live.body.live.stage, 'result');
  assert.equal(live.body.live.result.accepted, true);
  assert.ok(!JSON.stringify(live.body).includes('Lucía'), 'el estado público no expone el nombre');
});

test('una petición que no encaja queda en puente con la secuencia sugerida', async () => {
  const res = await ask({ trackId: METAL });
  await waitFor(async () => (await statusRow(res.body.id)).status === 'bridging');
  const live = await stack.api(`/api/public/requests/${res.body.id}`);
  assert.equal(live.body.live.result.accepted, false);
  assert.equal(live.body.live.result.bridgeSequence[0].genre, 'rock');
  assert.equal((await statusRow(res.body.id)).guest_name, 'Invitado');
});

test('el SSE de la petición entrega la foto actual y luego el resultado', async () => {
  const res = await ask({ trackId: VALIO });
  const { events } = await stack.sse(`/api/public/requests/${res.body.id}/events`, {
    until: (evs) => evs.some((e) => e.data.stage === 'result'),
  });
  assert.equal(events[0].event, 'status');
  assert.equal(events.at(-1).data.stage, 'result');
  assert.equal(events.at(-1).data.result.accepted, true);
});

test('si el motor cae, la petición entra igual a la cola sin evaluación', async () => {
  stack.engine.state.down = true;
  const res = await ask({ trackId: VALIO });
  // Con 3 intentos y espera exponencial (2 s y 4 s), el estado final llega en unos 6 s.
  const live = await waitFor(
    async () => {
      const r = await stack.api(`/api/public/requests/${res.body.id}`);
      return r.body.live.stage === 'result' && r.body;
    },
    { timeoutMs: 20000, intervalMs: 300 },
  );
  assert.match(live.live.message, /no respondió a tiempo/);
  assert.equal((await statusRow(res.body.id)).status, 'accepted');
});

test('una pista de Jamendo se pide desde el caché del buscador y respeta la licencia del local', async () => {
  const found = await stack.api(`/api/public/venues/${owner.venue.public_code}/search?q=Pista`);
  const nc = found.body.find((t) => t.kind === 'full' && /NC/.test(t.credit.license));
  const ok = await ask({ provider: 'jamendo', externalId: nc.externalId });
  assert.equal(ok.status, 202);
  assert.ok((await statusRow(ok.body.id)).track_id, 'queda vinculada a la pista del catálogo');
  assert.equal((await ask({ provider: 'jamendo', externalId: '99999999' })).status, 404);
  await stack.api(`/api/venues/${owner.venue.id}`, { method: 'PATCH', token: owner.token, body: { exclude_non_commercial: true } });
  const refused = await ask({ provider: 'jamendo', externalId: nc.externalId });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /licencia comercial/);
});

test('valida la petición y el id del estado', async () => {
  const empty = await ask({ guestName: 'Ana' });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /Elige una canción/);
  assert.equal((await ask({ trackId: 'abc' })).status, 400);
  assert.equal((await ask({ trackId: '123456' })).status, 404);
  assert.equal((await stack.api('/api/public/requests/no-es-uuid')).status, 400);
  assert.equal((await stack.api('/api/public/requests/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await stack.api('/api/public/venues/zzz/requests?ids=x')).status, 400);
});

test('el cliente consulta sus peticiones por id sin ver nombres', async () => {
  const a = await ask({ guestName: 'Lucía', trackId: VIVIR });
  const mine = await stack.api(`/api/public/venues/${owner.venue.public_code}/requests?ids=${a.body.id}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.requests.length, 1);
  assert.ok(!JSON.stringify(mine.body).includes('Lucía'));
});

test('el dueño ve las pendientes, pone una ahora y descarta otra', async () => {
  await stack.api(`/api/venues/${owner.venue.id}/player`, { method: 'PATCH', token: owner.token, body: { mode: 'manual' } });
  const a = await ask({ guestName: 'Lucía', trackId: VALIO });
  const b = await ask({ trackId: METAL });
  await waitFor(async () => (await statusRow(b.body.id)).status === 'bridging');
  const pending = await stack.api(`/api/venues/${owner.venue.id}/player/requests`, { token: owner.token });
  assert.deepEqual(
    pending.body.requests.map((r) => r.id).sort((a, b) => a.localeCompare(b)),
    [a.body.id, b.body.id].sort((a, b) => a.localeCompare(b)),
  );

  const queued = await stack.api(`/api/venues/${owner.venue.id}/player/requests/${a.body.id}/queue`, {
    method: 'POST',
    token: owner.token,
    body: { next: true },
  });
  assert.equal(queued.status, 200);
  assert.equal(queued.body.queue[0].source, 'request');
  assert.equal(queued.body.queue[0].requestId, a.body.id);
  // Ya en la cola: no se puede descartar ni volver a agregar.
  const dismissQueued = await stack.api(`/api/venues/${owner.venue.id}/player/requests/${a.body.id}/dismiss`, {
    method: 'POST',
    token: owner.token,
  });
  assert.equal(dismissQueued.status, 409);

  const dismissed = await stack.api(`/api/venues/${owner.venue.id}/player/requests/${b.body.id}/dismiss`, {
    method: 'POST',
    token: owner.token,
  });
  assert.equal(dismissed.status, 200);
  assert.equal((await statusRow(b.body.id)).status, 'rejected');

  // Al sonar y terminar, la petición queda como sonada.
  await stack.api(`/api/venues/${owner.venue.id}/player/play`, { method: 'POST', token: owner.token, body: {} });
  await stack.api(`/api/venues/${owner.venue.id}/player/advance`, { method: 'POST', token: owner.token, body: { fromTrackId: null } });
  const state = await stack.api(`/api/venues/${owner.venue.id}/player`, { token: owner.token });
  await stack.api(`/api/venues/${owner.venue.id}/player/advance`, {
    method: 'POST',
    token: owner.token,
    body: { fromTrackId: state.body.current?.track.id ?? null },
  });
  assert.equal((await statusRow(a.body.id)).status, 'played');
});

test('en AutoDJ una petición aceptada se intercala sola con su versión libre', async () => {
  await stack.api(`/api/venues/${owner.venue.id}/player`, { token: owner.token });
  const res = await ask({ trackId: VIVIR });
  const queue = await waitFor(async () => {
    const r = await stack.api(`/api/venues/${owner.venue.id}/player`, { token: owner.token });
    return r.body.queue.find((q) => q.source === 'request') && r.body.queue;
  });
  const item = queue.find((q) => q.source === 'request');
  assert.equal(item.requestId, res.body.id);
  assert.equal(item.track.provider, 'jamendo', 'usa la versión completa del catálogo libre');
  assert.equal(item.track.title, 'Vivir Mi Vida');
  assert.equal(queue[0].source, 'request', 'con la emisora detenida, la petición va primero');
});

test('el SSE del local avisa los cambios de la emisora y no las peticiones de otros', async () => {
  let acted = false;
  const { events } = await stack.sse(`/api/public/venues/${owner.venue.public_code}/events`, {
    onEvent: async (event) => {
      if (event.event === 'ready' && !acted) {
        acted = true;
        // Una petición nueva de otra persona no cambia lo que ve este cliente: no debe llegar.
        await stack.redis.publish(`venue:${owner.venue.id}`, JSON.stringify({ type: 'request_created', requestId: 'x' }));
        await stack.api(`/api/venues/${owner.venue.id}/player`, { method: 'PATCH', token: owner.token, body: { volume: 50 } });
      }
    },
    until: (evs) => evs.some((e) => e.event === 'update'),
  });
  assert.equal(events[0].event, 'ready');
  const updates = events.filter((e) => e.event === 'update');
  assert.deepEqual(
    updates.map((e) => e.data),
    [{ type: 'player_updated' }],
    'solo el tipo de cambio de la emisora',
  );
});

test('la consola del DJ (view=console) sí recibe las peticiones nuevas', async () => {
  let sent = false;
  const { events } = await stack.sse(`/api/public/venues/${owner.venue.public_code}/events?view=console`, {
    onEvent: async (event) => {
      if (event.event === 'ready' && !sent) {
        sent = true;
        await ask({ trackId: VIVIR });
      }
    },
    until: (evs) => evs.some((e) => e.event === 'update'),
  });
  assert.deepEqual(events.find((e) => e.event === 'update').data, { type: 'request_created' });
});

test('una ráfaga de avisos llega agrupada: el primero enseguida y uno al final', async () => {
  let burst = false;
  const { events } = await stack.sse(`/api/public/venues/${owner.venue.public_code}/events`, {
    onEvent: async (event) => {
      if (event.event === 'ready' && !burst) {
        burst = true;
        for (let i = 0; i < 10; i += 1) await stack.redis.publish(`venue:${owner.venue.id}`, JSON.stringify({ type: 'player_updated' }));
      }
    },
    until: (evs) => evs.filter((e) => e.event === 'update').length >= 2,
    timeoutMs: 9000,
  });
  assert.equal(events.filter((e) => e.event === 'update').length, 2);
});

test('varios SSE de peticiones comparten una sola conexión a Redis', async () => {
  const clients = async () => (await stack.redis.client('LIST')).trim().split('\n').length;
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push((await ask({ trackId: METAL })).body.id);
  // Abiertas a la vez; se cierran solas al llegar el resultado de cada una.
  const before = await clients();
  const streams = ids.map((id) =>
    stack.sse(`/api/public/requests/${id}/events`, { until: (evs) => evs.some((e) => e.data.stage === 'result') }),
  );
  const during = await clients();
  const results = await Promise.all(streams);
  for (const { events } of results) assert.equal(events.at(-1).data.stage, 'result');
  assert.ok(during - before <= 1, `abrió ${during - before} conexiones a Redis para 6 SSE`);
});

test('el límite de peticiones por minuto responde 429 en español', async () => {
  // Las inválidas también cuentan: así se llega al límite sin chocar con el de pendientes por cliente.
  const headers = { 'x-forwarded-for': '203.0.113.7', 'x-client-id': 'cliente-limite-1' };
  const statuses = [];
  for (let i = 0; i < 10; i += 1) statuses.push((await ask({}, headers)).status);
  assert.deepEqual(statuses, Array(10).fill(400));
  const last = await ask({ trackId: VIVIR }, headers);
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 'rate_limited');
  const neighbor = await ask({ trackId: VIVIR }, { ...headers, 'x-client-id': 'cliente-limite-2' });
  assert.equal(neighbor.status, 202, 'otro celular en el mismo Wi-Fi no se ve afectado');
});
