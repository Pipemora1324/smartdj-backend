import { Queue, Worker } from 'bullmq';
import axios from 'axios';
import { redis } from './redis.js';
import { query } from './db.js';
import { config } from './config.js';
import { grpcEnabled, streamEvaluation } from './ai-client.js';
import { publishRequestEvent, toLiveEvent } from './request-status.js';
export const requestQueue = new Queue('music-requests', { connection: redis });
export const evaluationJobOptions = { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 100, removeOnFail: 100 };

// Datos de la evaluación con los nombres del proto. bpm llega de Postgres (NUMERIC) como texto.
const toEvaluationRequest = (item, data) => ({
  venue_type: item.venue_kind, current_genre: data.currentGenre || 'Pop', requested_genre: item.genre,
  current_bpm: Number(data.currentBpm) || 120, requested_bpm: Number(item.bpm) || 120,
  current_key: data.currentKey || 'C', requested_key: item.musical_key || 'C',
});

// Respaldo sin gRPC (AI_GRPC_URL vacío): una sola llamada HTTP, sin etapas intermedias.
const evaluateOverHttp = async (requestId, request) => {
  await publishRequestEvent(requestId, { stage: 'queued', message: 'Evaluando tu petición.', partialScore: 0 });
  const { data } = await axios.post(`${config.aiUrl}/compatibility`, request, { timeout: config.aiGrpcTimeoutMs });
  await publishRequestEvent(requestId, toLiveEvent({ stage: 'RESULT', message: data.reason, result: data }));
  return data;
};

const worker = new Worker('music-requests', async job => {
  const r = await query('SELECT r.*, e.kind AS venue_kind FROM song_requests r JOIN establishments e ON e.id=r.establishment_id WHERE r.id=$1',[job.data.requestId]);
  if (!r.rowCount) return;
  const item=r.rows[0];
  const request = toEvaluationRequest(item, job.data);
  const ai = grpcEnabled()
    ? await streamEvaluation(item.id, request, (event) => publishRequestEvent(item.id, toLiveEvent(event)))
    : await evaluateOverHttp(item.id, request);
  await query('UPDATE song_requests SET status=$1, ai_reason=$2, bridge_sequence=$3, evaluated_at=NOW() WHERE id=$4',[ai.accepted?'accepted':'bridging',ai.reason,JSON.stringify(ai.bridge_sequence),item.id]);
  await redis.publish(`venue:${item.establishment_id}`, JSON.stringify({type:'request_evaluated', requestId:item.id, result:ai}));
}, { connection: redis });

// Si se agotan los reintentos, el navegador recibe un estado final de error en lugar de quedarse esperando.
worker.on('failed', (job, err) => {
  console.error(`Evaluación fallida (intento ${job?.attemptsMade}) de la petición ${job?.data?.requestId}:`, err.message);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    publishRequestEvent(job.data.requestId, { stage: 'failed', message: 'No pudimos evaluar tu petición en este momento. El DJ la revisará manualmente.', partialScore: 0 })
      .catch((e) => console.error('No se pudo publicar el estado de error:', e.message));
  }
});
