import { query } from './db.js';

// Tablas y columnas que usa el código. Si en producción falta algo, el log lo dice al arrancar
// (en lugar de fallar con un 500 en la primera petición).
export const REQUIRED_SCHEMA = {
  users: ['id', 'email', 'name', 'role', 'auth_id', 'email_verified'],
  establishments: ['id', 'owner_id', 'name', 'kind', 'ambience', 'public_code', 'created_at'],
  song_requests: ['id', 'establishment_id', 'guest_name', 'title', 'artist', 'genre', 'bpm', 'musical_key', 'status', 'ai_reason', 'bridge_sequence', 'created_at', 'evaluated_at'],
};
export const REQUIRED_TYPES = ['venue_kind', 'request_status'];

// Compara lo requerido con las filas de information_schema.columns ({table_name, column_name}).
export const findMissing = (columnRows, typeNames, required = REQUIRED_SCHEMA, requiredTypes = REQUIRED_TYPES) => {
  const present = new Set(columnRows.map((r) => `${r.table_name}.${r.column_name}`));
  const tables = new Set(columnRows.map((r) => r.table_name));
  const missing = [];
  for (const [table, columns] of Object.entries(required)) {
    if (!tables.has(table)) { missing.push(`tabla ${table}`); continue; }
    for (const column of columns) if (!present.has(`${table}.${column}`)) missing.push(`columna ${table}.${column}`);
  }
  for (const type of requiredTypes) if (!typeNames.includes(type)) missing.push(`tipo ${type}`);
  return missing;
};

export const checkSchema = async () => {
  try {
    const columns = await query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1)`,
      [Object.keys(REQUIRED_SCHEMA)]);
    const types = await query(`SELECT typname FROM pg_type WHERE typname = ANY($1)`, [REQUIRED_TYPES]);
    const missing = findMissing(columns.rows, types.rows.map((r) => r.typname));
    if (missing.length) {
      console.error(`Esquema incompleto en la base de datos: falta ${missing.join(', ')}. Ejecuta en orden los archivos de database/migrations/ (ver README).`);
    } else {
      console.log('Esquema de la base de datos verificado.');
    }
    return missing;
  } catch (err) {
    console.error('No se pudo verificar el esquema de la base de datos:', err.message);
    return null;
  }
};
