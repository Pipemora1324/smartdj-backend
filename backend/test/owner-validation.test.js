// Pruebas de las validaciones del panel del dueño.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listLimit, requestStatusSchema, uuidParam, venuePatchSchema, venueSchema } from '../src/owner-validation.js';

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
