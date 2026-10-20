import pg from 'pg';
import { config } from './config.js';
export const pool = new pg.Pool({ connectionString: config.dbUrl });
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
