import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';
// Si todas las conexiones están ocupadas, una consulta espera como mucho POOL_WAIT_MS y falla (en lugar de colgar
// la petición HTTP). Las conexiones sin uso se cierran a los 30 s para no ocupar cupo del pooler de Supabase.
const POOL_WAIT_MS = 5000;
const IDLE_MS = 30000;
export const pool = new pg.Pool({
  connectionString: config.dbUrl,
  max: config.dbPoolMax,
  connectionTimeoutMillis: POOL_WAIT_MS,
  idleTimeoutMillis: IDLE_MS,
});
// Un cliente inactivo que se corta (reinicio del pooler, red) emite 'error': sin este manejador el proceso se cae.
pool.on('error', (err) => logger.error('Se cortó una conexión inactiva de Postgres', { err: err }));
export const query = (text, params) => pool.query(text, params);
// Ejecuta fn(client) dentro de BEGIN/COMMIT; ante cualquier error hace ROLLBACK.
export const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};
