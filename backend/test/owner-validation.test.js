// Pruebas de las validaciones del panel del dueño.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listLimit, requestStatusSchema, trackSearchSchema, uuidParam, venuePatchSchema, venueSchema } from '../src/owner-validation.js';

const message = (fn) => { try { fn(); return null; } catch (e) { return e.issues[0].message; } };

test('crear local exige nombre, tipo y ambiente válidos', () => {
  assert.deepEqual(venueSchema.parse({ name: '  Café Luna ', kind: 'cafe', ambience: 'Tranquilo' }), { name: 'Café Luna', kind: 'cafe', ambience: 'Tranquilo' });
  assert.equal(message(() => venueSchema.parse({ name: 'A', kind: 'cafe', ambience: 'ok ok' })), 'El nombre debe tener al menos 2 caracteres.');
  assert.equal(message(() => venueSchema.parse({ name: 'Café', kind: 'discoteca', ambience: 'ok ok' })), 'Elige un tipo de local válido.');
});

test('editar local acepta campos parciales pero no un cuerpo vacío', () => {
  assert.deepEqual(venuePatchSchema.parse({ ambience: 'Más energía' }), { ambience: 'Más energía' });
  assert.equal(message(() => venuePatchSchema.parse({})), 'No hay cambios para guardar.');
});

test('el estado de una petición solo puede ser accepted, rejected o played', () => {
  for (const status of ['accepted', 'rejected', 'played']) assert.equal(requestStatusSchema.parse({ status }).status, status);
  assert.equal(message(() => requestStatusSchema.parse({ status: 'queued' })), 'El estado debe ser accepted, rejected o played.');
});

test('los ids deben ser UUID', () => {
  assert.equal(uuidParam.parse('6f1c2a7e-0b1d-4c8e-9a3f-2b5d7e9c1a40'), '6f1c2a7e-0b1d-4c8e-9a3f-2b5d7e9c1a40');
  assert.equal(message(() => uuidParam.parse('1 OR 1=1')), 'El identificador no es válido.');
});

test('el límite de la lista va de 1 a 100 con 50 por defecto', () => {
  assert.equal(listLimit.parse(undefined), 50);
  assert.equal(listLimit.parse('20'), 20);
  assert.ok(message(() => listLimit.parse('500')));
});

test('el buscador de pistas valida texto, género y proveedor', () => {
  assert.deepEqual(trackSearchSchema.parse({}), { q: '', genre: '', provider: 'jamendo' });
  assert.deepEqual(trackSearchSchema.parse({ q: ' lounge ', genre: 'Jazz', provider: 'audius' }), { q: 'lounge', genre: 'jazz', provider: 'audius' });
  assert.throws(() => trackSearchSchema.parse({ provider: 'spotify' }), /jamendo o audius/);
  assert.throws(() => trackSearchSchema.parse({ genre: 'rock<script>' }), /género no es válido/);
  assert.throws(() => trackSearchSchema.parse({ q: 'x'.repeat(101) }), /100 caracteres/);
});

test('el local puede excluir las pistas no comerciales', () => {
  assert.deepEqual(venuePatchSchema.parse({ exclude_non_commercial: true }), { exclude_non_commercial: true });
  assert.throws(() => venuePatchSchema.parse({ exclude_non_commercial: 'si' }), /true o false/);
});

test('el reproductor valida consola, posición, volumen, modo y cola', async () => {
  const v = await import('../src/owner-validation.js');
  assert.deepEqual(v.claimSchema.parse({ consoleId: 'consola-1234' }), { consoleId: 'consola-1234' });
  assert.throws(() => v.claimSchema.parse({ consoleId: '<x>' }), /consola no es válido/);
  assert.throws(() => v.pauseSchema.parse({ positionSeconds: -1 }), /negativa/);
  assert.equal(v.skipSchema.parse({}).reason, 'user');
  assert.throws(() => v.skipSchema.parse({ reason: 'boring' }), /user o error/);
  assert.deepEqual(v.advanceSchema.parse({ fromTrackId: null }), { fromTrackId: null });
  assert.throws(() => v.advanceSchema.parse({}), Error);
  assert.deepEqual(v.playerSettingsSchema.parse({ volume: 50, mode: 'manual' }), { volume: 50, mode: 'manual' });
  assert.throws(() => v.playerSettingsSchema.parse({ volume: 101 }), /0 a 100/);
  assert.throws(() => v.playerSettingsSchema.parse({ mode: 'random' }), /autodj o manual/);
  assert.throws(() => v.playerSettingsSchema.parse({}), /No hay cambios/);
  assert.throws(() => v.queueAddSchema.parse({ provider: 'jamendo', externalId: '1;DROP' }), /no es válida/);
  assert.throws(() => v.queueOrderSchema.parse({ order: ['no-uuid'] }), Error);
});
