// Integración: sesión de Supabase (JWKS local), perfil, locales del dueño y autorización por propiedad.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from './harness.js';

let stack;
before(async () => {
  stack = await startStack();
});
after(() => stack.close());

test('health responde ok sin sesión', async () => {
  assert.deepEqual((await stack.api('/api/health')).body, { status: 'ok' });
});

test('sin token, con token falso o vencido responde 401 en español', async () => {
  const none = await stack.api('/api/auth/me');
  assert.equal(none.status, 401);
  assert.equal(none.body.code, 'unauthorized');
  assert.match(none.body.error, /falta el token/);
  assert.equal((await stack.api('/api/auth/me', { token: 'no-es-un-jwt' })).status, 401);
  const expired = await stack.api('/api/auth/me', { token: stack.supabase.token({ expiresIn: -10 }) });
  assert.equal(expired.status, 401);
  assert.match(expired.body.error, /expiró/);
});

test('un token con otra audiencia o rol se rechaza', async () => {
  assert.equal((await stack.api('/api/auth/me', { token: stack.supabase.token({ role: 'anon' }) })).status, 401);
  assert.equal((await stack.api('/api/auth/me', { token: stack.supabase.token({ is_anonymous: true }) })).status, 401);
});

test('el correo sin confirmar no crea perfil', async () => {
  const res = await stack.api('/api/auth/me', { token: stack.supabase.token({ verified: false }) });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'EMAIL_NOT_VERIFIED');
});

test('la primera sesión crea el perfil local y las siguientes lo reutilizan', async () => {
  const sub = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const first = await stack.api('/api/auth/me', { token: stack.supabase.token({ sub, email: 'Ana@Prueba.test' }) });
  assert.equal(first.status, 200);
  const again = await stack.api('/api/auth/me', { token: stack.supabase.token({ sub }) });
  assert.equal(again.body.user?.id ?? again.body.id, first.body.user?.id ?? first.body.id);
  const { rows } = await stack.query('SELECT email FROM users WHERE auth_id=$1', [sub]);
  assert.deepEqual(rows, [{ email: 'ana@prueba.test' }]);
});

test('el dueño crea, lista y edita sus locales con validación en español', async () => {
  const token = stack.supabase.token();
  const bad = await stack.api('/api/venues', { method: 'POST', token, body: { name: 'X', kind: 'casino', ambience: '' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'invalid_input');
  assert.match(JSON.stringify(bad.body), /al menos 2 caracteres/);

  const created = await stack.api('/api/venues', {
    method: 'POST',
    token,
    body: { name: 'Café Uno', kind: 'cafe', ambience: 'jazz suave' },
  });
  assert.equal(created.status, 201);
  assert.match(created.body.public_code, /^[0-9a-f]{12}$/);

  const list = await stack.api('/api/venues', { token });
  assert.deepEqual(
    list.body.map((v) => v.name),
    ['Café Uno'],
  );

  const edited = await stack.api(`/api/venues/${created.body.id}`, {
    method: 'PATCH',
    token,
    body: { name: 'Café Dos', exclude_non_commercial: true },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.name, 'Café Dos');
  assert.equal(edited.body.exclude_non_commercial, true);
  assert.equal((await stack.api(`/api/venues/${created.body.id}`, { method: 'PATCH', token, body: {} })).status, 400);
});

test('otro dueño no puede ver ni tocar un local ajeno (404, sin revelar que existe)', async () => {
  const { venue } = await stack.createOwnerVenue();
  const intruder = stack.supabase.token();
  for (const [method, path, body] of [
    ['PATCH', `/api/venues/${venue.id}`, { name: 'Robado' }],
    ['GET', `/api/venues/${venue.id}/tracks/search?q=jazz`],
    ['GET', `/api/venues/${venue.id}/player`],
    ['POST', `/api/venues/${venue.id}/player/play`, {}],
    ['GET', `/api/venues/${venue.id}/player/requests`],
  ]) {
    const res = await stack.api(path, { method, token: intruder, body });
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.body.code, 'not_found');
  }
  assert.equal((await stack.api('/api/venues', { token: intruder })).body.length, 0);
  assert.equal((await stack.api('/api/venues/no-es-uuid', { method: 'PATCH', token: intruder, body: { name: 'X1' } })).status, 400);
});

test('CORS acepta el frontend conocido y rechaza otros orígenes', async () => {
  const ok = await stack.api('/api/health', { headers: { origin: 'http://localhost:8080' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:8080');
  assert.equal(ok.headers.get('access-control-allow-credentials'), null);
  const bad = await stack.api('/api/health', { headers: { origin: 'https://malicioso.example' } });
  assert.equal(bad.status, 403);
});

test('rutas inexistentes, JSON roto y cuerpos grandes responden con código estable', async () => {
  assert.equal((await stack.api('/api/nada')).body.code, 'not_found');
  const broken = await fetch(`${stack.base}/api/public/venues/abc/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"title":',
  });
  assert.equal((await broken.json()).code, 'invalid_input');
  const big = await stack.api('/api/public/venues/abc/requests', { method: 'POST', body: { title: 'a'.repeat(40000) } });
  assert.equal(big.status, 413);
  assert.equal(big.body.code, 'payload_too_large');
});
