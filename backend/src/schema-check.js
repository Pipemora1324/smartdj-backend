import { query } from './db.js';
import { AppError } from './errors.js';

// Tablas y columnas que usa el código. Si en producción falta algo, el log lo dice al arrancar
// (en lugar de fallar con un 500 en la primera petición).
export const REQUIRED_SCHEMA = {
  users: ['id', 'email', 'name', 'role', 'auth_id', 'email_verified'],
  establishments: ['id', 'owner_id', 'name', 'kind', 'ambience', 'public_code', 'created_at'],
  song_requests: [
    'id',
    'establishment_id',
    'guest_name',
    'title',
    'artist',
    'genre',
    'bpm',
    'musical_key',
    'status',
    'ai_reason',
    'bridge_sequence',
    'created_at',
    'evaluated_at',
  ],
};
export const REQUIRED_TYPES = ['venue_kind', 'request_status'];
// Columnas de funciones nuevas: si faltan, el código sigue funcionando sin ellas (y avisa qué migración correr).
export const OPTIONAL_COLUMNS = {
  'song_requests.external_id': '004_canciones_buscador.sql',
  'song_requests.artwork_url': '004_canciones_buscador.sql',
  'song_requests.preview_url': '004_canciones_buscador.sql',
  'song_requests.played_at': '005_panel_dueno.sql',
  'song_requests.status_updated_at': '005_panel_dueno.sql',
  'track_cache.id': '006_emisora.sql',
  'track_search_cache.query_key': '006_emisora.sql',
  'player_state.establishment_id': '006_emisora.sql',
  'play_queue.id': '006_emisora.sql',
  'mix_history.track_id': '006_emisora.sql',
  'establishments.exclude_non_commercial': '006_emisora.sql',
  'song_requests.provider': '008_peticiones_emisora.sql',
  'song_requests.track_id': '008_peticiones_emisora.sql',
  'song_requests.store_url': '008_peticiones_emisora.sql',
  'mix_history.request_id': '008_peticiones_emisora.sql',
};
// Tablas a revisar: las obligatorias y las de columnas opcionales (algunas tablas son nuevas, de la 006).
export const schemaTables = () => [
  ...new Set([...Object.keys(REQUIRED_SCHEMA), ...Object.keys(OPTIONAL_COLUMNS).map((key) => key.split('.')[0])]),
];
const presentColumns = new Set();
let lastCheckAt = 0;
// true si la columna existe (según la última verificación al arrancar).
export const hasColumn = (key) => presentColumns.has(key);

// Compara lo requerido con las filas de information_schema.columns ({table_name, column_name}).
export const findMissing = (columnRows, typeNames, required = REQUIRED_SCHEMA, requiredTypes = REQUIRED_TYPES) => {
  const present = new Set(columnRows.map((r) => `${r.table_name}.${r.column_name}`));
  const tables = new Set(columnRows.map((r) => r.table_name));
  const missing = [];
  for (const [table, columns] of Object.entries(required)) {
    if (!tables.has(table)) {
      missing.push(`tabla ${table}`);
      continue;
    }
    for (const column of columns) if (!present.has(`${table}.${column}`)) missing.push(`columna ${table}.${column}`);
  }
  for (const type of requiredTypes) if (!typeNames.includes(type)) missing.push(`tipo ${type}`);
  return missing;
};

export const checkSchema = async () => {
  try {
    const columns = await query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1)`,
      [schemaTables()],
    );
    const types = await query(`SELECT typname FROM pg_type WHERE typname = ANY($1)`, [REQUIRED_TYPES]);
    lastCheckAt = Date.now();
    presentColumns.clear();
    for (const r of columns.rows) presentColumns.add(`${r.table_name}.${r.column_name}`);
    const pendingFiles = [
      ...new Set(
        Object.entries(OPTIONAL_COLUMNS)
          .filter(([key]) => !presentColumns.has(key))
          .map(([, file]) => file),
      ),
    ];
    if (pendingFiles.length) console.warn(`Migraciones pendientes (la app funciona, con menos datos): ${pendingFiles.join(', ')}.`);
    const missing = findMissing(
      columns.rows,
      types.rows.map((r) => r.typname),
    );
    if (missing.length) {
      console.error(
        `Esquema incompleto en la base de datos: falta ${missing.join(', ')}. Ejecuta en orden los archivos de database/migrations/ (ver README).`,
      );
    } else {
      console.log('Esquema de la base de datos verificado.');
    }
    return missing;
  } catch (err) {
    console.error('No se pudo verificar el esquema de la base de datos:', err.message);
    return null;
  }
};

// Emisora (migración 006): si faltan sus tablas responde 503 con un mensaje claro en lugar de un 500.
// Vuelve a revisar el esquema como mucho una vez por minuto, para no exigir reiniciar después de correr el SQL.
const PLAYER_KEYS = [
  'track_cache.id',
  'track_search_cache.query_key',
  'player_state.establishment_id',
  'play_queue.id',
  'mix_history.track_id',
  'establishments.exclude_non_commercial',
];
const RECHECK_MS = 60 * 1000;
export const requirePlayerSchema = async () => {
  if (PLAYER_KEYS.every(hasColumn)) return;
  if (Date.now() - lastCheckAt > RECHECK_MS) await checkSchema();
  if (!PLAYER_KEYS.every(hasColumn))
    throw new AppError(503, 'La emisora todavía no está lista: falta ejecutar la migración 006_emisora.sql en la base de datos.');
};
