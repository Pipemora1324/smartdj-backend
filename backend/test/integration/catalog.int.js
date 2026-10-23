// Integración: catálogo de la emisora (Jamendo simulado), caché de 24 h, caché vencido, cuota mensual y
// buscador público (Jamendo + iTunes simulados, con caché en Redis).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from './harness.js';
import { monthKey } from '../../src/catalog-logic.js';

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

const search = (q, extra = '') =>
  stack.api(`/api/venues/${owner.venue.id}/tracks/search?q=${encodeURIComponent(q)}${extra}`, { token: owner.token });

test('la primera búsqueda consulta Jamendo y la repetida sale del caché', async () => {
  const first = await search('jazz');
  assert.equal(first.status, 200);
  assert.equal(first.body.source, 'provider');
  assert.ok(first.body.tracks.length > 0);
  const track = first.body.tracks[0];
  assert.equal(track.provider, 'jamendo');
  assert.match(track.audioUrl, /^https:\/\/mp3l\.jamendo\.com\//);
  assert.ok(track.credit.license && track.credit.url);
  const calls = stack.jamendo.state.calls;
  const again = await search('  JAZZ ');
  assert.equal(again.body.source, 'cache');
  assert.equal(stack.jamendo.state.calls, calls, 'la búsqueda repetida no llama a Jamendo');
  assert.deepEqual(
    again.body.tracks.map((t) => t.id),
    first.body.tracks.map((t) => t.id),
  );
});

test('si Jamendo cae se usa el caché vencido y, sin caché, responde 502 en español', async () => {
  await search('lounge');
  await stack.query("UPDATE track_search_cache SET fetched_at = NOW() - INTERVAL '2 days'");
  stack.jamendo.state.failing = true;
  const stale = await search('lounge');
  assert.equal(stale.status, 200);
  assert.equal(stale.body.source, 'stale-cache');
  const fresh = await search('salsa');
  assert.equal(fresh.status, 502);
  assert.equal(fresh.body.code, 'upstream_error');
  assert.match(fresh.body.error, /catálogo de música/);
});

test('con el tope mensual alcanzado no se llama a Jamendo', async () => {
  await stack.redis.set(monthKey(), 30000);
  const calls = stack.jamendo.state.calls;
  const res = await search('house');
  assert.equal(res.status, 503);
  assert.match(res.body.error, /límite mensual/);
  assert.equal(stack.jamendo.state.calls, calls);
});

test('el contador de la cuota sube una vez por consulta real y vence', async () => {
  await search('acoustic');
  await search('acoustic');
  assert.equal(Number(await stack.redis.get(monthKey())), 1);
  assert.ok((await stack.redis.ttl(monthKey())) > 0);
});

test('el local que excluye pistas no comerciales no las recibe', async () => {
  await stack.api(`/api/venues/${owner.venue.id}`, { method: 'PATCH', token: owner.token, body: { exclude_non_commercial: true } });
  // En el doble, las de lounge tienen licencia comercial y todas las de jazz son NC.
  const lounge = await search('', '&genre=lounge');
  assert.ok(lounge.body.tracks.length > 0);
  for (const t of lounge.body.tracks) assert.doesNotMatch(t.credit.license, /NC/);
  assert.equal((await search('', '&genre=jazz')).body.tracks.length, 0);
});

test('valida la búsqueda del dueño', async () => {
  const res = await search('x', '&provider=spotify');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /jamendo o audius/);
  assert.equal((await search('', '&genre=<script>')).status, 400);
});

test('el buscador público combina Jamendo e iTunes y guarda iTunes en Redis', async () => {
  const code = owner.venue.public_code;
  const res = await stack.api(`/api/public/venues/${code}/search?q=Marc%20Anthony`);
  assert.equal(res.status, 200);
  const kinds = new Set(res.body.map((t) => t.kind));
  assert.ok(kinds.has('full'), 'trae la versión completa de Jamendo');
  assert.ok(kinds.has('preview'), 'completa con previews de iTunes');
  for (const t of res.body) assert.equal(t.audioUrl, undefined, 'la página pública no recibe URLs de audio');
  const itunesCalls = stack.itunes.state.calls;
  await stack.api(`/api/public/venues/${code}/search?q=marc%20anthony`);
  assert.equal(stack.itunes.state.calls, itunesCalls, 'la misma búsqueda no vuelve a iTunes');
});

test('el buscador público valida el texto y el código del local', async () => {
  const short = await stack.api(`/api/public/venues/${owner.venue.public_code}/search?q=a`);
  assert.equal(short.status, 400);
  assert.match(short.body.error, /al menos 2/);
  assert.equal((await stack.api('/api/public/venues/no-existe/search?q=hola')).status, 404);
  assert.equal((await stack.api(`/api/public/venues/${'x'.repeat(40)}/search?q=hola`)).status, 404);
});
