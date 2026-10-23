// Pruebas del registro estructurado (niveles, formato JSON y datos personales ocultos).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, toLogContext } from '../src/logger.js';

const capture = (level) => {
  const lines = [];
  const logger = createLogger({
    level,
    write: (line, lvl) => lines.push({ entry: JSON.parse(line), lvl }),
    now: () => '2026-10-22T00:00:00.000Z',
  });
  return { logger, lines };
};

test('escribe una línea JSON con nivel, hora, mensaje y contexto', () => {
  const { logger, lines } = capture('info');
  logger.info('Petición evaluada', { requestId: 'r1', ms: 12 });
  assert.deepEqual(lines[0].entry, { level: 'info', time: '2026-10-22T00:00:00.000Z', msg: 'Petición evaluada', requestId: 'r1', ms: 12 });
});

test('respeta el nivel mínimo', () => {
  const { logger, lines } = capture('warn');
  logger.debug('detalle');
  logger.info('normal');
  logger.warn('aviso');
  logger.error('falla');
  assert.deepEqual(
    lines.map((l) => l.entry.level),
    ['warn', 'error'],
  );
});

test('silent no escribe ni los errores', () => {
  const { logger, lines } = capture('silent');
  logger.error('falla');
  assert.equal(lines.length, 0);
});

test('un nivel desconocido usa info', () => {
  const { logger, lines } = capture('ruidoso');
  logger.debug('no');
  logger.info('sí');
  assert.equal(lines.length, 1);
});

test('oculta datos personales y secretos del contexto', () => {
  const ctx = toLogContext({ email: 'ana@x.co', guestName: 'Ana', token: 'abc', authorization: 'Bearer x', venueId: 'v1', status: 500 });
  assert.deepEqual(ctx, {
    email: '[oculto]',
    guestName: '[oculto]',
    token: '[oculto]',
    authorization: '[oculto]',
    venueId: 'v1',
    status: 500,
  });
});

test('los errores se registran como mensaje y código', () => {
  const err = Object.assign(new Error('se cayó Redis'), { code: 'ECONNREFUSED' });
  assert.deepEqual(toLogContext({ err }), { err: 'se cayó Redis', errCode: 'ECONNREFUSED' });
  assert.deepEqual(toLogContext(), {});
});
