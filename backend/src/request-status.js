import { redis } from './redis.js';

// Estado en vivo de cada petición de canción, alimentado por el stream gRPC del motor.
// - request-status:<id>  último evento (lo lee el polling), vence en 1 hora.
// - request-events:<id>  canal pub/sub (lo escuchan las conexiones SSE).
const TTL_SECONDS = 3600;
export const FINAL_STAGES = new Set(['result', 'failed']);
export const statusKey = (requestId) => `request-status:${requestId}`;
export const statusChannel = (requestId) => `request-events:${requestId}`;

// Evento del proto (stage QUEUED, partial_score, result con bridge_sequence) → evento para el navegador.
export const toLiveEvent = ({ stage, message, partial_score: partialScore, result }) => ({
  stage: String(stage).toLowerCase(),
  message,
  partialScore: partialScore ?? 0,
  ...(result && String(stage) === 'RESULT'
    ? { result: { accepted: result.accepted, score: result.score, reason: result.reason, bridgeSequence: result.bridge_sequence } }
    : {}),
});

export const publishRequestEvent = async (requestId, event) => {
  const payload = JSON.stringify({ requestId, ...event, updatedAt: new Date().toISOString() });
  await redis.multi().set(statusKey(requestId), payload, 'EX', TTL_SECONDS).publish(statusChannel(requestId), payload).exec();
};

export const readRequestStatus = async (requestId) => {
  const value = await redis.get(statusKey(requestId));
  return value ? JSON.parse(value) : null;
};
