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
  assert.deepEqual(reorderPositions(['a', 'b', 'c'], ['c', 'a', 'b']), [
    { id: 'c', position: 1 },
    { id: 'a', position: 2 },
    { id: 'b', position: 3 },
  ]);
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

test('el respaldo sin motor evita repetir, prefiere el género y la energía del local', () => {
  const candidates = [
    { id: '1', genre: 'electronic', energy: 5, artist: 'A' },
    { id: '2', genre: 'jazz', energy: 2, artist: 'B' },
    { id: '3', genre: 'jazz', energy: 2, artist: 'C' },
  ];
  const pick = (opts) => pickFallback({ candidates, venueKind: 'cafe', venueTags: ['jazz', 'lounge'], random: () => 0, ...opts });
  assert.equal(pick({}).genre, 'jazz');
  assert.equal(pick({ recentIds: ['2'] }).id, '3');
  assert.equal(pick({ recentArtists: ['b'] }).id, '3');
  assert.equal(pick({ recentIds: ['1', '2', '3'] }).genre, 'jazz');
  assert.equal(pick({ candidates: [] }), null);
});

test('la transición por defecto sale antes del final', () => {
  assert.deepEqual(defaultTransition(200, 8), { transitionAtSeconds: 191, crossfadeSeconds: 8 });
  assert.deepEqual(defaultTransition(20, 8), { transitionAtSeconds: 14, crossfadeSeconds: 5 });
  assert.deepEqual(defaultTransition(0, 8), { transitionAtSeconds: 0, crossfadeSeconds: 0 });
});

test('convierte una pista guardada en datos para el motor', async () => {
  const { toFeatures } = await import('../src/player-logic.js');
  assert.deepEqual(
    toFeatures({ id: 'u1', genre: 'lounge', bpm: '120.50', musical_key: null, energy: 3, duration_seconds: 200, artist: 'Ana' }),
    { id: 'u1', genre: 'lounge', bpm: 120.5, key: '', energy: 3, duration_seconds: 200, artist: 'Ana' },
  );
  assert.equal(toFeatures(null), undefined);
});

test('a la página pública solo llega el tipo de aviso', async () => {
  const { toPublicEvent } = await import('../src/player-logic.js');
  assert.deepEqual(toPublicEvent(JSON.stringify({ type: 'request_evaluated', requestId: 'x', result: { reason: 'secreto' } })), {
    type: 'request_evaluated',
  });
  assert.equal(toPublicEvent('no es json'), null);
  assert.equal(toPublicEvent(JSON.stringify({ type: '<script>' })), null);
  assert.equal(toPublicEvent(JSON.stringify({})), null);
});

test('el corte de un preview termina con un fundido de salida', async () => {
  const { previewTransition } = await import('../src/player-logic.js');
  assert.deepEqual(previewTransition(30), { transitionAtSeconds: 26, crossfadeSeconds: 4 });
  assert.deepEqual(previewTransition(0), { transitionAtSeconds: 0, crossfadeSeconds: 0 });
});

test('el estado de una petición combina la evaluación, la cola y lo que suena', async () => {
  const { toStationRequest, requestState } = await import('../src/player-logic.js');
  const base = {
    id: 'r1',
    title: 'T',
    artist: 'A',
    genre: 'Salsa',
    status: 'accepted',
    guest_name: 'Caro',
    provider: 'itunes',
    created_at: 'x',
  };
  assert.equal(requestState(base), 'accepted');
  assert.equal(requestState({ ...base, in_queue: true }), 'in_queue');
  assert.equal(requestState({ ...base, in_queue: true, playing: true }), 'playing');
  assert.equal(requestState({ ...base, status: 'played', playing: true }), 'played');
  const owner = toStationRequest({ ...base, in_queue: true });
  assert.deepEqual(
    [owner.kind, owner.kindLabel, owner.stateLabel, owner.guestName, owner.fits],
    ['preview', 'Preview 30 s', 'En la cola', 'Caro', true],
  );
  assert.equal(toStationRequest({ ...base, track_provider: 'jamendo' }).kindLabel, 'Completa');
  assert.equal('guestName' in toStationRequest(base, { withGuest: false }), false);
});

test('estados de las peticiones automáticas: puesto, espera, votos y fallos', async () => {
  const { toStationRequest, requestState } = await import('../src/player-logic.js');
  const now = Date.parse('2026-10-24T20:00:00Z');
  const base = { id: 'r1', title: 'T', artist: 'A', status: 'accepted', provider: 'itunes', votes: 3 };
  const positions = new Map([['r1', { position: 3, etaSeconds: 540 }]]);
  const queued = toStationRequest({ ...base, in_queue: true }, { positions, now });
  assert.deepEqual([queued.state, queued.position, queued.etaSeconds, queued.votes], ['in_queue', 3, 540, 3]);
  // Un voto muestra el puesto de la original.
  const vote = toStationRequest({ ...base, id: 'r2', duplicate_of: 'r1', in_queue: true }, { positions, now });
  assert.deepEqual([vote.position, vote.duplicate], [3, true]);
  // Pista que sonó hace poco: en la cola, con la hora desde la que puede sonar.
  const waiting = toStationRequest({ ...base, not_before: '2026-10-24T20:10:00Z' }, { now });
  assert.deepEqual([waiting.state, waiting.stateLabel, waiting.etaSeconds], ['waiting', 'En la cola', 600]);
  assert.equal(requestState({ ...base, not_before: '2026-10-24T19:00:00Z' }, now), 'accepted');
  assert.equal(toStationRequest({ ...base, status: 'rejected', play_failures: 2 }).stateLabel, 'No se pudo reproducir');
  assert.equal(toStationRequest({ ...base, status: 'rejected', play_failures: 1 }).stateLabel, 'Descartada');
  assert.equal(toStationRequest(base).stateLabel, 'Esperando al DJ');
  // Con peticiones automáticas, una evaluada que aún no está en la cola ya va entrando.
  assert.equal(toStationRequest({ ...base, status: 'bridging' }, { autoAccept: true }).stateLabel, 'Entrando a la cola');
  assert.equal(toStationRequest({ ...base, in_queue: true }, { autoAccept: true }).state, 'in_queue');
  assert.equal(toStationRequest({ ...base, votes: undefined }).votes, 1);
});
