// Pruebas del manejador de errores: estados, mensajes en español y registro sin datos sensibles.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AppError, errorHandler, sanitizeForLog } from '../src/errors.js';

// El logger escribe una línea JSON por evento en stderr (warn y error); se captura para revisarla.
let logs;
const originalWrite = process.stderr.write;
beforeEach(() => {
  logs = { error: [], warn: [] };
  process.stderr.write = (line) => {
    const entry = JSON.parse(line);
    logs[entry.level].push(entry);
    return true;
  };
});
afterEach(() => {
  process.stderr.write = originalWrite;
});

const run = (err) => {
  const res = {
    statusCode: 0,
    body: null,
    headersSent: false,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    end() {
      return this;
    },
  };
  errorHandler(err, { method: 'POST', baseUrl: '/api/public', path: '/venues/abc/requests' }, res, () => {});
  return res;
};

test('un error inesperado responde 500 genérico y se registra con stack', () => {
  const res = run(new Error('boom'));
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Error interno del servidor', code: 'internal' });
  assert.equal(logs.error[0].status, 500);
  assert.equal(logs.error[0].where, 'POST /api/public/venues/abc/requests');
  assert.equal(logs.error[0].err, 'boom');
  assert.match(logs.error[0].stack, /at /);
});

test('un error de Postgres registra code y tabla pero no el detail', () => {
  const pgError = Object.assign(new Error('relation "song_requests" does not exist'), {
    code: '42P01',
    table: 'song_requests',
    detail: 'Key (email)=(ana@correo.co) already exists.',
  });
  const res = run(pgError);
  assert.equal(res.statusCode, 500);
  assert.equal(logs.error[0].db, 'code=42P01 table=song_requests');
  assert.doesNotMatch(JSON.stringify(logs.error[0]), /ana@correo\.co/);
});

test('un ZodError responde 400 con su mensaje y no registra stack', () => {
  let err;
  try {
    z.object({ title: z.string().min(1, 'Escribe el título.') }).parse({ title: '' });
  } catch (e) {
    err = e;
  }
  const res = run(err);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Escribe el título.');
  assert.equal(logs.error.length, 0);
  assert.equal(logs.warn[0].status, 400);
  assert.equal(logs.warn[0].stack, undefined);
});

test('JSON inválido responde 400 en español', () => {
  const res = run(Object.assign(new SyntaxError('Unexpected end of JSON input'), { type: 'entity.parse.failed', status: 400 }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'El cuerpo de la petición no es un JSON válido.');
});

test('limpia saltos de línea y caracteres de control antes de registrar', () => {
  assert.equal(sanitizeForLog('/a\r\n[500] falso'), '/a??[500] falso');
  assert.equal(sanitizeForLog('x'.repeat(300)).length, 200);
  assert.equal(sanitizeForLog(undefined), '');
  const res = {
    status() {
      return this;
    },
    json() {
      return this;
    },
  };
  errorHandler(new AppError(404, 'No existe'), { method: 'GET', baseUrl: '', path: '/x\n[200] OK' }, res, () => {});
  assert.doesNotMatch(logs.warn[0].where, /\n/);
});

test('un AppError conserva estado, mensaje y extra', () => {
  const res = run(new AppError(503, 'No disponible', { retryAfter: 5 }));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'No disponible', code: 'unavailable', retryAfter: 5 });
});

test('cada error trae un código estable y el de extra tiene prioridad', () => {
  assert.equal(run(new AppError(404, 'No existe')).body.code, 'not_found');
  assert.equal(run(new AppError(429, 'Espera')).body.code, 'rate_limited');
  assert.equal(run(new AppError(409, 'Otra consola', { code: 'console_taken' })).body.code, 'console_taken');
  assert.equal(run(Object.assign(new SyntaxError('x'), { type: 'entity.too.large' })).body.code, 'payload_too_large');
  assert.equal(run(new AppError(418, 'Tetera')).body.code, 'error');
  assert.equal(run(new AppError(507, 'Sin espacio')).body.code, 'internal');
});
