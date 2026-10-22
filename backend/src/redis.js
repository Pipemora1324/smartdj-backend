import IORedis from 'ioredis';
import { config } from './config.js';
// Conexión de la app (cola, estado en vivo, SSE, cuota de Jamendo, candado del AutoDJ): si Redis no responde, los comandos fallan
// en segundos en lugar de esperar para siempre y dejar la petición HTTP colgada.
export const redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: 2, connectTimeout: 5000, commandTimeout: 5000 });
redis.on('error', (err) => console.error('Error de Redis:', err.message));
// El worker de BullMQ exige maxRetriesPerRequest: null (espera bloqueante de trabajos), con su propia conexión.
export const createWorkerConnection = () => new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
