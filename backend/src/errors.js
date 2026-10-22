import { logger } from './logger.js';
export class AppError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const notFound = (_req, res) => res.status(404).json({ error: 'Recurso no encontrado', code: 'not_found' });

// Texto que viene del usuario (ruta, Origin) antes de ir al log: sin saltos de línea ni caracteres de
// control (evita falsificar líneas del log) y con largo máximo.
export const sanitizeForLog = (value, max = 200) =>
  String(value ?? '')
    // eslint-disable-next-line no-control-regex -- quitar los caracteres de control es justo el objetivo
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?')
    .slice(0, max);

// Campos de un error de Postgres que se pueden registrar sin exponer datos (detail puede traer valores).
const dbFields = (err) =>
  ['code', 'table', 'column', 'constraint', 'routine']
    .filter((key) => err?.[key])
    .map((key) => `${key}=${err[key]}`)
    .join(' ');

// Mensaje y estado para cada tipo de error. Solo los AppError y los de validación muestran su mensaje al usuario.
const describe = (err) => {
  if (err?.name === 'ZodError') return [400, err.issues?.[0]?.message || 'Datos de entrada inválidos'];
  if (err?.type === 'entity.parse.failed') return [400, 'El cuerpo de la petición no es un JSON válido.'];
  if (err?.type === 'entity.too.large') return [413, 'El cuerpo de la petición es demasiado grande.'];
  if (err instanceof AppError) return [err.status, err.message];
  return [500, 'Error interno del servidor'];
};

// Código estable para la máquina según el estado HTTP; el mensaje en español es para las personas.
// Un AppError puede traer su propio código en extra.code (por ejemplo, console_taken).
export const ERROR_CODES = {
  400: 'invalid_input',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  410: 'gone',
  413: 'payload_too_large',
  429: 'rate_limited',
  499: 'cancelled',
  502: 'upstream_error',
  503: 'unavailable',
  504: 'upstream_timeout',
};
export const errorCode = (status) => ERROR_CODES[status] ?? (status >= 500 ? 'internal' : 'error');

export const errorHandler = (err, req, res, _next) => {
  const [status, message] = describe(err);
  const where = sanitizeForLog(`${req.method} ${req.baseUrl}${req.path}`);
  // Todo 5xx se registra con mensaje y stack; nunca el cuerpo de la petición ni el detail de Postgres.
  if (status >= 500)
    logger.error('Error del servidor', { status, where, name: err?.name || 'Error', err, db: dbFields(err), stack: err?.stack });
  else logger.warn('Petición rechazada', { status, where, reason: sanitizeForLog(message) });
  if (res.headersSent) return res.end();
  res.status(status).json({ error: message, code: errorCode(status), ...(err instanceof AppError && err.extra ? err.extra : {}) });
};
