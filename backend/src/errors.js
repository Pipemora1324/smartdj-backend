export class AppError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const notFound = (_req, res) => res.status(404).json({ error: 'Recurso no encontrado' });

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

export const errorHandler = (err, req, res, _next) => {
  const [status, message] = describe(err);
  const where = sanitizeForLog(`${req.method} ${req.baseUrl}${req.path}`);
  // Todo 5xx se registra con mensaje y stack; nunca el cuerpo de la petición ni el detail de Postgres.
  if (status >= 500) console.error(`[${status}] ${where} → ${err?.name || 'Error'}: ${err?.message} ${dbFields(err)}\n${err?.stack || ''}`);
  else console.warn(`[${status}] ${where} → ${sanitizeForLog(message)}`);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: message, ...(err instanceof AppError && err.extra ? err.extra : {}) });
};
