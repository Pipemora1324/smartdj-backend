// Pruebas de los mensajes de Zod en español.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import '../src/zod-es.js';

const message = (schema, value) => {
  const r = schema.safeParse(value);
  return r.success ? null : r.error.issues[0].message;
};

test('tipos y campos faltantes', () => {
  assert.equal(message(z.object({ bpm: z.number() }), { bpm: 'rápido' }), 'El campo "bpm" debe ser un número.');
  assert.equal(message(z.object({ title: z.string() }), {}), 'Falta el campo "title".');
});

test('límites de números y textos', () => {
  assert.equal(message(z.object({ bpm: z.number().max(300) }), { bpm: 999 }), 'El campo "bpm" debe ser menor o igual a 300.');
  assert.equal(message(z.object({ bpm: z.number().positive() }), { bpm: 0 }), 'El campo "bpm" debe ser mayor que 0.');
  assert.equal(message(z.object({ name: z.string().min(2) }), { name: 'a' }), 'El campo "name" debe tener al menos 2 caracteres.');
  assert.equal(message(z.string().max(3), 'abcd'), 'El valor puede tener como máximo 3 caracteres.');
});

test('formatos y enumeraciones', () => {
  assert.equal(message(z.object({ id: z.string().uuid() }), { id: 'x' }), 'El campo "id" debe ser un identificador válido.');
  assert.equal(message(z.object({ kind: z.enum(['cafe', 'lounge']) }), { kind: 'bar' }), 'El campo "kind" debe ser uno de: cafe, lounge.');
});

test('los mensajes propios del esquema tienen prioridad', () => {
  assert.equal(message(z.string().min(2, 'Escribe al menos 2 letras.'), 'a'), 'Escribe al menos 2 letras.');
});
