// Pruebas de la caché corta con deduplicación (sin red ni temporizadores reales).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemo } from '../src/memo.js';

test('llamadas simultáneas con la misma clave cargan una sola vez', async () => {
  const memo = createMemo();
  let loads = 0;
  const load = () => new Promise((resolve) => setTimeout(() => resolve(++loads), 10));
  const results = await Promise.all(Array.from({ length: 50 }, () => memo.get('jazz', load)));
  assert.equal(loads, 1);
  assert.ok(results.every((r) => r === 1));
  assert.equal(await memo.get('jazz', load), 2, 'sin ttl no guarda nada después');
});

test('con ttl reutiliza el resultado hasta que vence', async () => {
  let clock = 0;
  const memo = createMemo({ ttlMs: 1000, now: () => clock });
  let loads = 0;
  const load = async () => ++loads;
  assert.equal(await memo.get('k', load), 1);
  clock = 999;
  assert.equal(await memo.get('k', load), 1);
  clock = 1000;
  assert.equal(await memo.get('k', load), 2);
});

test('los errores no se guardan y no bloquean el siguiente intento', async () => {
  const memo = createMemo({ ttlMs: 1000 });
  await assert.rejects(
    memo.get('k', async () => {
      throw new Error('caído');
    }),
    /caído/,
  );
  assert.equal(await memo.get('k', async () => 'ok'), 'ok');
});

test('respeta el máximo de entradas y clear() vacía la caché', async () => {
  const memo = createMemo({ ttlMs: 1000, maxEntries: 2 });
  let loads = 0;
  const load = async () => ++loads;
  await memo.get('a', load);
  await memo.get('b', load);
  await memo.get('c', load);
  assert.equal(await memo.get('a', load), 4, 'la más vieja se descartó');
  memo.clear();
  assert.equal(await memo.get('c', load), 5);
});
