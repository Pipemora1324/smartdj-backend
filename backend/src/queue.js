import { Queue, Worker } from 'bullmq';
import axios from 'axios';
import { redis, createWorkerConnection } from './redis.js';
import { query } from './db.js';
import { config } from './config.js';
import { hasColumn } from './schema-check.js';
import { grpcEnabled, streamEvaluation } from './ai-client.js';
import { publishRequestEvent, toLiveEvent } from './request-status.js';
import { afterRequestEvaluated } from './autodj.js';
export const requestQueue = new Queue('music-requests', { connection: redis });
export const evaluationJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 100,
  removeOnFail: 100,
};

// Datos de la evaluación con los nombres del proto. bpm llega de Postgres (NUMERIC) como texto.
// current: la canción que suena en el local (o null). 0 y '' significan "dato desconocido" para el motor.
export const toEvaluationRequest = (item, current) => ({
  venue_type: item.venue_kind,
  current_genre: current?.genre || '',
  requested_genre: item.genre,
  current_bpm: Number(current?.bpm) || 0,
  requested_bpm: Number(item.bpm) || 0,
  current_key: current?.musical_key || '',
  requested_key: item.musical_key || '',
});

// La canción que suena ahora en el local: la última marcada como sonada.
const currentSong = async (venueId) => {
  // Con emisora (006), lo que suena es la pista actual del reproductor, no la última petición sonada.
  if (hasColumn('player_state.establishment_id')) {
    // Si la emisora está detenida, no suena nada: se evalúa contra el ambiente del local.
    const station = await query(
      `SELECT s.status, t.genre, t.bpm, t.musical_key FROM player_state s LEFT JOIN track_cache t ON t.id = s.current_track_id
      WHERE s.establishment_id=$1`,
      [venueId],
    );
    if (station.rowCount) return station.rows[0].status !== 'stopped' && station.rows[0].genre !== null ? station.rows[0] : null;
  }
  const order = hasColumn('song_requests.played_at') ? 'played_at DESC NULLS LAST, evaluated_at DESC' : 'evaluated_at DESC NULLS LAST';
  const r = await query(
    `SELECT genre, bpm, musical_key FROM song_requests WHERE establishment_id=$1 AND status='played' ORDER BY ${order} LIMIT 1`,
    [venueId],
  );
  return r.rows[0] || null;
};

// Respaldo sin gRPC (AI_GRPC_URL vacío): una sola llamada HTTP, sin etapas intermedias.
const evaluateOverHttp = async (requestId, request) => {
  await publishRequestEvent(requestId, { stage: 'queued', message: 'Evaluando tu petición.', partialScore: 0 });
  const { data } = await axios.post(`${config.aiUrl}/compatibility`, request, { timeout: config.aiGrpcTimeoutMs });
  await publishRequestEvent(requestId, toLiveEvent({ stage: 'RESULT', message: data.reason, result: data }));
  return data;
};

const worker = new Worker(
  'music-requests',
  async (job) => {
    const r = await query(
      'SELECT r.*, e.kind AS venue_kind FROM song_requests r JOIN establishments e ON e.id=r.establishment_id WHERE r.id=$1',
      [job.data.requestId],
    );
    if (!r.rowCount) return;
    const item = r.rows[0];
    const request = toEvaluationRequest(item, await currentSong(item.establishment_id));
    const ai = grpcEnabled()
      ? await streamEvaluation(item.id, request, (event) => publishRequestEvent(item.id, toLiveEvent(event)))
      : await evaluateOverHttp(item.id, request);
    await query('UPDATE song_requests SET status=$1, ai_reason=$2, bridge_sequence=$3, evaluated_at=NOW() WHERE id=$4', [
      ai.accepted ? 'accepted' : 'bridging',
      ai.reason,
      JSON.stringify(ai.bridge_sequence),
      item.id,
    ]);
    await redis.publish(`venue:${item.establishment_id}`, JSON.stringify({ type: 'request_evaluated', requestId: item.id, result: ai }));
    // Emisora: en AutoDJ, una petición que encaja se intercala sola en la cola.
    void afterRequestEvaluated(item.establishment_id).catch((err) =>
      console.error('No se pudo intercalar la petición evaluada:', err.message),
    );
  },
  {
    connection: createWorkerConnection(),
    // Con la cola vacía, BullMQ consulta Redis en bucle. drainDelay (segundos) y stalledInterval (ms) más largos
    // bajan de ~20.000 a ~1.700 comandos al día, para no agotar la cuota del plan gratis de Upstash.
    drainDelay: 60,
    stalledInterval: 300000,
  },
);

// Si se agotan los reintentos, el navegador recibe un estado final de error en lugar de quedarse esperando.
worker.on('failed', (job, err) => {
  console.error(`Evaluación fallida (intento ${job?.attemptsMade}) de la petición ${job?.data?.requestId}:`, err.message);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    publishRequestEvent(job.data.requestId, {
      stage: 'failed',
      message: 'No pudimos evaluar tu petición en este momento. El DJ la revisará manualmente.',
      partialScore: 0,
    }).catch((e) => console.error('No se pudo publicar el estado de error:', e.message));
  }
});
