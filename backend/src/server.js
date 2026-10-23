import { config } from './config.js';
import { createApp } from './app.js';
import { pool } from './db.js';
import { redis } from './redis.js';
import { closeQueue } from './queue.js';
import { checkSchema } from './schema-check.js';
import { checkAiConnection } from './ai-client.js';
import { logger } from './logger.js';
const server = createApp().listen(config.port, () => {
  logger.info('API escuchando', { port: config.port });
  checkSchema().catch((err) => logger.error('Falló la verificación del esquema', { err: err }));
  checkAiConnection().catch((err) => logger.error('Falló el diagnóstico del motor', { err: err }));
});
// Apagado ordenado (Render manda SIGTERM al desplegar). Las suscripciones de los SSE mantendrían vivo el proceso,
// así que al terminar se sale explícitamente; si algo se cuelga, se sale igual a los SHUTDOWN_MS.
const SHUTDOWN_MS = 10000;
const close = async () => {
  setTimeout(() => process.exit(0), SHUTDOWN_MS).unref();
  server.close();
  server.closeAllConnections();
  await closeQueue().catch(() => {});
  await pool.end().catch(() => {});
  redis.disconnect();
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
// Errores fuera de una petición (worker, Redis, promesas sin catch): que siempre queden en el log.
process.on('unhandledRejection', (reason) =>
  logger.error(
    'Promesa rechazada sin manejar',
    reason instanceof Error ? { err: reason, stack: reason.stack } : { reason: String(reason) },
  ),
);
