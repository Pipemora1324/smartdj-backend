// Pruebas del algoritmo de prioridad de las peticiones en AutoDJ (lógica pura).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aiTracksNeeded,
  layoutQueue,
  planRequestOrder,
  queueEta,
  remainingOfCurrent,
  songKeyOf,
  transitionFit,
} from '../src/request-priority.js';

const at = (minute) => new Date(Date.UTC(2026, 9, 24, 20, minute)).toISOString();
const req = (id, minute, extra = {}) => ({
  id,
  createdAt: at(minute),
  votes: 1,
  passed: 0,
  ownerPriority: 0,
  genre: '',
  energy: 0,
  ...extra,
});
const ids = (list) => list.map((r) => r.id);

test('sin otros datos respeta el orden de llegada', () => {
  const order = planRequestOrder([req('c', 3), req('a', 1), req('b', 2)]);
  assert.deepEqual(ids(order), ['a', 'b', 'c']);
});

test('ajuste suave: evita un choque de género y energía adelantando una sola posición', () => {
  const prev = { genre: 'Salsa', energy: 4 };
  const order = planRequestOrder([req('metal', 1, { genre: 'Metal', energy: 1 }), req('salsa', 2, { genre: 'Salsa', energy: 4 })], {
    prev,
  });
  assert.deepEqual(ids(order), ['salsa', 'metal']);
  // Pero no salta muchos puestos: una petición que encaja y llegó cuarta no pasa a las tres primeras si ellas no chocan.
  const neutral = [req('a', 1), req('b', 2), req('c', 3), req('d', 4, { genre: 'Salsa', energy: 4 })];
  assert.deepEqual(ids(planRequestOrder(neutral, { prev })).slice(0, 2), ['a', 'b']);
});

test('los votos suben una petición, sin pasar el límite de aplazamiento', () => {
  const order = planRequestOrder([req('a', 1), req('b', 2), req('c', 3, { votes: 8 })], { maxDeferral: 3 });
  assert.equal(order[0].id, 'c');
  const capped = planRequestOrder([req('a', 1, { passed: 3 }), req('b', 2, { votes: 50 })], { maxDeferral: 3 });
  assert.deepEqual(ids(capped), ['a', 'b'], 'la que ya fue aplazada 3 veces suena primero');
});

test('la prioridad del dueño sube o baja una petición', () => {
  assert.deepEqual(ids(planRequestOrder([req('a', 1), req('b', 2, { ownerPriority: 2 })])), ['b', 'a']);
  assert.deepEqual(ids(planRequestOrder([req('a', 1, { ownerPriority: -2 }), req('b', 2)])), ['b', 'a']);
});

test('ninguna petición se aplaza más de N turnos aunque siempre choque', () => {
  // Simula la emisora: suena la primera del plan; las que llegaron antes y siguen esperando cuentan un aplazamiento.
  const maxDeferral = 2;
  let pending = [req('choque', 0, { genre: 'Metal', energy: 1 })];
  for (let i = 1; i <= 8; i += 1) pending.push(req(`salsa${i}`, i, { genre: 'Salsa', energy: 4, votes: 4 }));
  const played = [];
  while (pending.length) {
    const [next] = planRequestOrder(pending, { prev: { genre: 'Salsa', energy: 4 }, maxDeferral });
    played.push(next.id);
    pending = pending.filter((r) => r.id !== next.id).map((r) => (r.createdAt < next.createdAt ? { ...r, passed: r.passed + 1 } : r));
    for (const r of pending) assert.ok(r.passed <= maxDeferral, `${r.id} aplazada ${r.passed} veces`);
  }
  assert.equal(played.indexOf('choque'), maxDeferral, 'suena justo al llegar al límite');
  assert.equal(new Set(played).size, 9, 'todas suenan, sin pérdidas ni duplicados');
});

test('casos límite: vacío, una sola y llegadas iguales', () => {
  assert.deepEqual(planRequestOrder([]), []);
  assert.deepEqual(ids(planRequestOrder([req('x', 1)])), ['x']);
  assert.deepEqual(ids(planRequestOrder([req('b', 1), req('a', 1)])), ['a', 'b'], 'empate de hora: orden estable por id');
});

test('equilibrio: una pista de la IA cada N peticiones solo cuando hay muchas', () => {
  const requests = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'];
  assert.deepEqual(layoutQueue(requests, ['ia1', 'ia2', 'ia3'], { balanceEvery: 4 }), [
    'r1',
    'r2',
    'r3',
    'r4',
    'ia1',
    'r5',
    'r6',
    'r7',
    'r8',
    'ia2',
    'r9',
    'ia3',
  ]);
  assert.deepEqual(layoutQueue(['r1', 'r2', 'r3'], ['ia1'], { balanceEvery: 4 }), ['r1', 'r2', 'r3', 'ia1'], 'pocas: seguidas');
  assert.deepEqual(layoutQueue([], ['ia1', 'ia2']), ['ia1', 'ia2'], 'sin peticiones el AutoDJ sigue igual');
  assert.deepEqual(layoutQueue(['r1', 'r2', 'r3', 'r4', 'r5'], [], { balanceEvery: 4 }), ['r1', 'r2', 'r3', 'r4', 'r5']);
});

test('pistas de la IA necesarias: mínimo de la cola, equilibrio y siempre una al final', () => {
  assert.equal(aiTracksNeeded(0, { minQueue: 5 }), 5);
  assert.equal(aiTracksNeeded(3, { minQueue: 5 }), 2);
  assert.equal(aiTracksNeeded(5, { minQueue: 5, balanceEvery: 4 }), 2, 'una de equilibrio y una al final');
  assert.equal(aiTracksNeeded(12, { minQueue: 5, balanceEvery: 4 }), 3);
});

test('puesto y espera estimada de cada pista', () => {
  const eta = queueEta([{ transition_at_seconds: 170 }, { duration_seconds: 30 }, {}], { remainingSeconds: 60.4 });
  assert.deepEqual(eta, [
    { position: 1, etaSeconds: 60 },
    { position: 2, etaSeconds: 230 },
    { position: 3, etaSeconds: 260 },
  ]);
  assert.equal(remainingOfCurrent({ track: { duration_seconds: 200 }, current_meta: { transitionAtSeconds: 190 } }, 40), 150);
  assert.equal(remainingOfCurrent({ track: null }, 0), 0);
  assert.equal(remainingOfCurrent({ track: { duration_seconds: 100 } }, 150), 0);
});

test('transición: mismo género y energía cercana es suave; sin datos es neutra', () => {
  assert.equal(transitionFit({ genre: 'Salsa y Tropical', energy: 4 }, { genre: 'latin', energy: 4 }), 1);
  assert.equal(transitionFit({ genre: 'House', energy: 5 }, { genre: 'Jazz', energy: 1 }), 0);
  assert.equal(transitionFit(null, { genre: 'Jazz' }), 0.5);
  assert.equal(transitionFit({ genre: '' }, { genre: '' }), 0.5);
});

test('identidad de la canción para duplicados y bloqueos', () => {
  assert.equal(songKeyOf('itunes', '1440818839'), 'itunes:1440818839');
  assert.equal(songKeyOf('jamendo', null), null);
});
