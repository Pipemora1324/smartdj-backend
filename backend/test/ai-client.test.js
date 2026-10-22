// Pruebas del cliente gRPC contra un servidor gRPC falso en localhost (sin red externa ni el motor real).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';

const PROTO_PATH = fileURLToPath(new URL('../proto/compatibility.proto', import.meta.url));
const { CompatibilityService } = grpc.loadPackageDefinition(
  protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: Number, enums: String, defaults: true }),
).smartdj.compatibility.v1;

const RESULT = {
  accepted: false,
  score: 58,
  reason: 'Transición directa no recomendada (58/100).',
  bridge_sequence: [{ position: 1, genre: 'dance', target_bpm: 115, purpose: 'Ajustar' }],
  profile: 'dance',
};
const REQUEST = {
  venue_type: 'nightclub',
  current_genre: 'House',
  requested_genre: 'Salsa',
  current_bpm: 124,
  requested_bpm: 96,
  current_key: 'Am',
  requested_key: 'C',
};
let server;
let mode = 'ok';
let client;

before(async () => {
  server = new grpc.Server();
  server.addService(CompatibilityService.service, {
    CheckCompatibility(call, callback) {
      if (mode === 'slow') return setTimeout(() => callback(null, RESULT), 500);
      if (call.request.requested_bpm <= 0)
        return callback({ code: grpc.status.INVALID_ARGUMENT, details: 'requested_bpm debe ser mayor que 0' });
      callback(null, RESULT);
    },
    StreamEvaluation(call) {
      const stages = ['QUEUED', 'ANALYZING_GENRE', 'ANALYZING_BPM', 'ANALYZING_KEY'];
      for (const stage of stages) call.write({ request_id: call.request.request_id, stage, message: stage });
      if (mode === 'no-result') return call.end();
      call.write({ request_id: call.request.request_id, stage: 'RESULT', message: RESULT.reason, result: RESULT });
      call.end();
    },
    SuggestNext(call, callback) {
      if (mode === 'slow') return setTimeout(() => callback(null, {}), 500);
      if (!call.request.candidates.length) return callback({ code: grpc.status.INVALID_ARGUMENT, details: 'Faltan candidatas.' });
      const [first] = call.request.candidates;
      callback(null, {
        track_id: first?.id ?? '',
        score: 80,
        reason: `Siguiente después de ${call.request.current?.id || 'nada'}.`,
        transition_at_seconds: 190,
        crossfade_seconds: 8,
      });
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))),
  );
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://x:y@localhost/z',
    REDIS_URL: 'redis://localhost:6379',
    AI_SERVICE_URL: 'http://localhost:1',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_JWKS_URL: 'http://localhost:1/jwks',
    AI_GRPC_URL: `127.0.0.1:${port}`,
  });
  client = await import('../src/ai-client.js');
});

after(() => {
  client?.closeAiClient();
  server?.forceShutdown();
});

test('el cliente usa gRPC cuando AI_GRPC_URL está definido', () => {
  assert.equal(client.grpcEnabled(), true);
});

test('StreamEvaluation entrega las etapas en orden y resuelve con el resultado', async () => {
  mode = 'ok';
  const stages = [];
  const result = await client.streamEvaluation('req-1', REQUEST, async (event) => {
    await new Promise((r) => setTimeout(r, 5));
    stages.push(event.stage);
  });
  assert.deepEqual(stages, ['QUEUED', 'ANALYZING_GENRE', 'ANALYZING_BPM', 'ANALYZING_KEY', 'RESULT']);
  assert.deepEqual(result, RESULT);
});

test('un stream sin RESULT termina con error 502', async () => {
  mode = 'no-result';
  await assert.rejects(client.streamEvaluation('req-2', REQUEST), (err) => err.status === 502);
});

test('el timeout se convierte en error 504', async () => {
  mode = 'slow';
  await assert.rejects(
    client.suggestNext({ venue_type: 'cafe', candidates: [{ id: 'a' }] }, { timeoutMs: 100 }),
    (err) => err.status === 504 && err.extra.grpcCode === 'DEADLINE_EXCEEDED',
  );
});

test('INVALID_ARGUMENT se convierte en error 400', async () => {
  mode = 'ok';
  await assert.rejects(
    client.suggestNext({ venue_type: 'cafe', candidates: [] }),
    (err) => err.status === 400 && /Faltan candidatas/.test(err.message),
  );
});

test('sin servidor responde 503 (UNAVAILABLE)', async () => {
  const { toAppError } = client;
  const err = toAppError({ code: grpc.status.UNAVAILABLE, details: 'connect ECONNREFUSED' });
  assert.equal(err.status, 503);
});

test('SuggestNext devuelve la pista elegida por el motor', async () => {
  const result = await client.suggestNext({
    venue_type: 'cafe',
    current: { id: 'now', energy: 2 },
    candidates: [{ id: 'a', energy: 3 }],
    recent_ids: [],
    recent_artists: [],
  });
  assert.deepEqual(result, {
    track_id: 'a',
    score: 80,
    reason: 'Siguiente después de now.',
    transition_at_seconds: 190,
    crossfade_seconds: 8,
  });
});
