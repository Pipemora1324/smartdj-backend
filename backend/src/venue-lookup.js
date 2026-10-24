import { z } from 'zod';
import { query } from './db.js';
import { AppError } from './errors.js';
import { hasColumn } from './schema-check.js';

// Código público del local: hasta 12 caracteres alfanuméricos (los nuevos son 12 hex). Lo demás ni llega a la base.
const venueCode = z.string().regex(/^[A-Za-z0-9_-]{1,12}$/);

// Columnas de migraciones opcionales: licencias (006) y reglas de peticiones (010).
const optionalColumns = () =>
  ['exclude_non_commercial', 'auto_accept_requests', 'block_explicit']
    .filter((column) => hasColumn(`establishments.${column}`))
    .map((column) => `,${column}`)
    .join('');

// Local por su código público (el del enlace o QR), con lo justo para la página pública.
export const findVenue = async (code) => {
  if (!venueCode.safeParse(code).success) throw new AppError(404, 'Código de establecimiento inválido');
  const r = await query(`SELECT id,name,kind,ambience,public_code${optionalColumns()} FROM establishments WHERE public_code=$1`, [code]);
  if (!r.rowCount) throw new AppError(404, 'Código de establecimiento inválido');
  return r.rows[0];
};
