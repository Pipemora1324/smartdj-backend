// Pruebas de la lógica del reproductor y de la cola.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultTransition, insertAt, livePosition, pickFallback, reorderPositions, requestInsertIndex } from '../src/player-logic.js';

test('la posición avanza solo mientras suena', () => {
  const now = Date.parse('2026-10-21T12:00:30Z');
  assert.equal(livePosition({ status: 'playing', position_seconds: '10', started_at: '2026-10-21T12:00:00Z' }, now), 40);
  assert.equal(livePosition({ status: 'paused', position_seconds: '10', started_at: null }, now), 10);
  assert.equal(livePosition(null, now), 0);
});

test('reordenar exige los mismos ids de la cola', () => {
  assert.deepEqual(reorderPositions(['a', 'b', 'c'], ['c', 'a', 'b']), [{ id: 'c', position: 1 }, { id: 'a', position: 2 }, { id: 'b', position: 3 }]);
  assert.throws(() => reorderPositions(['a', 'b'], ['a']), { status: 409 });
  assert.throws(() => reorderPositions(['a', 'b'], ['a', 'a']), { status: 409 });
  assert.throws(() => reorderPositions(['a', 'b'], ['a', 'x']), { status: 409 });
});

test('las peticiones se intercalan después de la siguiente pista y nunca juntas', () => {
  const q = (...sources) => sources.map((source, i) => ({ id: String(i), source }));
  assert.equal(requestInsertIndex([]), 0);
  assert.equal(requestInsertIndex(q('autodj')), 1);
  assert.equal(requestInsertIndex(q('autodj', 'autodj', 'autodj')), 1);
  assert.equal(requestInsertIndex(q('autodj', 'request', 'autodj', 'autodj')), 3);
  assert.equal(requestInsertIndex(q('autodj', 'request', 'autodj', 'request', 'autodj')), 5);
  assert.deepEqual(insertAt(['a', 'b', 'c'], 1, 'x'), ['a', 'x', 'b', 'c']);
});

test('el respaldo sin motor no repite y prefiere el género y la energía del local', () => {
  const candidates = [
    { id: '1', genre: 'electronic', energy: 5, artist: 'A' },
    { id: '2', genre: 'jazz', energy: 2, artist: 'B' },
    { id: '3', genre: 'jazz', energy: 2, artist: 'C' },
  ];
  const pick = (opts) => pickFallback({ candidates, venueKind: 'cafe', venueTags: ['jazz', 'lounge'], random: () => 0, ...opts });
  assert.equal(pick({}).genre, 'jazz');
  assert.equal(pick({ recentIds: ['2'] }).id, '3');
  assert.equal(pick({ recentArtists: ['b'] }).id, '3');
  assert.equal(pick({ recentIds: ['1', '2', '3'] }), null);
});

test('la transición por defecto sale antes del final', () => {
  assert.deepEqual(defaultTransition(200, 8), { transitionAtSeconds: 191, crossfadeSeconds: 8 });
  assert.deepEqual(defaultTransition(20, 8), { transitionAtSeconds: 14, crossfadeSeconds: 5 });
  assert.deepEqual(defaultTransition(0, 8), { transitionAtSeconds: 0, crossfadeSeconds: 0 });
});

test('convierte una pista guardada en datos para el motor', async () => {
  const { toFeatures } = await import('../src/player-logic.js');
  assert.deepEqual(toFeatures({ id: 'u1', genre: 'lounge', bpm: '120.50', musical_key: null, energy: 3, duration_seconds: 200, artist: 'Ana' }),
    { id: 'u1', genre: 'lounge', bpm: 120.5, key: '', energy: 3, duration_seconds: 200, artist: 'Ana' });
  assert.equal(toFeatures(null), undefined);
});
