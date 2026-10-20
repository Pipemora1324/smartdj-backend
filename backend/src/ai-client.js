import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { AppError } from './errors.js';

// Cliente gRPC del motor de compatibilidad. El contrato se carga en tiempo de ejecución desde
// backend/proto/compatibility.proto (copia idéntica de ai/proto, lo verifica npm test).
const PROTO_PATH = fileURLToPath(new URL('../proto/compatibility.proto', import.meta.url));
const definition = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: Number, enums: String, defaults: true });
const { CompatibilityService } = grpc.loadPackageDefinition(definition).smartdj.compatibility.v1;

let client = null;
export const grpcEnabled = () => Boolean(config.aiGrpcUrl);
const getClient = () => {
  client ??= new CompatibilityService(
    config.aiGrpcUrl,
    // TLS para un motor público (por ejemplo en el puerto 443); sin TLS dentro de una red privada o en local.
    config.aiGrpcTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
    { 'grpc.keepalive_time_ms': 30000 },
  );
  return client;
};
export const closeAiClient = () => { client?.close(); client = null; };

const deadlineIn = (ms) => new Date(Date.now() + ms);

// Espera la conexión con el motor como máximo connectTimeoutMs. Sin esto, con el motor caído cada
// llamada esperaría el deadline completo antes de fallar.
const ensureConnected = (connectTimeoutMs = config.aiGrpcConnectTimeoutMs) =>
  new Promise((resolve, reject) => {
    getClient().waitForReady(deadlineIn(connectTimeoutMs), (err) => (err
      ? reject(new AppError(503, 'El motor de compatibilidad no está disponible en este momento.', { grpcCode: 'UNAVAILABLE' }))
      : resolve()));
  });

// Convierte un error gRPC en un AppError con mensaje en español; conserva el código gRPC en extra.
export const toAppError = (err) => {
  const byCode = {
    [grpc.status.DEADLINE_EXCEEDED]: [504, 'El motor de compatibilidad tardó demasiado en responder.'],
    [grpc.status.UNAVAILABLE]: [503, 'El motor de compatibilidad no está disponible en este momento.'],
    [grpc.status.INVALID_ARGUMENT]: [400, `Datos inválidos para el motor de compatibilidad: ${err.details}`],
    [grpc.status.CANCELLED]: [499, 'La evaluación se canceló.'],
  };
  const [status, message] = byCode[err.code] ?? [502, 'El motor de compatibilidad respondió con un error.'];
  return new AppError(status, message, { grpcCode: grpc.status[err.code] ?? String(err.code) });
};

// Evaluación unaria. request usa los nombres del proto (venue_type, current_bpm, ...).
export const checkCompatibility = async (request, { timeoutMs = config.aiGrpcTimeoutMs } = {}) => {
  await ensureConnected();
  return new Promise((resolve, reject) => {
    getClient().CheckCompatibility(request, { deadline: deadlineIn(timeoutMs) }, (err, result) => (err ? reject(toAppError(err)) : resolve(result)));
  });
};

// Evaluación con server streaming: llama a onEvent(evento) por cada etapa y resuelve con el resultado final.
// Espera a que terminen los onEvent asíncronos (por ejemplo, publicar en Redis) antes de resolver.
export const streamEvaluation = async (requestId, request, onEvent, { timeoutMs = config.aiGrpcTimeoutMs } = {}) => {
  await ensureConnected();
  return new Promise((resolve, reject) => {
    const call = getClient().StreamEvaluation({ request_id: requestId, compatibility: request }, { deadline: deadlineIn(timeoutMs) });
    const pending = [];
    let result = null;
    let failed = false;
    call.on('data', (event) => {
      if (event.stage === 'RESULT') result = event.result;
      if (onEvent) pending.push(Promise.resolve().then(() => onEvent(event)).catch((err) => console.error('Error procesando un evento del stream gRPC:', err.message)));
    });
    call.on('error', (err) => { failed = true; Promise.allSettled(pending).then(() => reject(toAppError(err))); });
    call.on('end', () => {
      if (failed) return;
      Promise.allSettled(pending).then(() => (result
        ? resolve(result)
        : reject(new AppError(502, 'El motor terminó la evaluación sin enviar un resultado.'))));
    });
  });
};
