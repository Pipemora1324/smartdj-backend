import { rateLimit } from 'express-rate-limit';

// Límites de uso de la API en un solo lugar. Las rutas públicas se cuentan por IP (detrás del proxy de Render,
// con trust proxy) y las del dueño por cuenta. Los valores y su justificación están en CARGA.md.
export const MINUTE_MS = 60 * 1000;
export const LIMITS = {
  publicRequest: { limit: 10, message: 'Enviaste muchas peticiones seguidas. Espera un minuto.' },
  publicSearch: { limit: 30, message: 'Hiciste muchas búsquedas seguidas. Espera un momento.' },
  publicRead: { limit: 120, message: 'Demasiadas consultas. Espera un momento.' },
  requestStream: { limit: 20, message: 'Demasiadas conexiones. Espera un momento.' },
  venueStream: { limit: 30, message: 'Demasiadas conexiones. Espera un momento.' },
  ownerSearch: { limit: 30, message: 'Hiciste muchas búsquedas seguidas. Espera un momento.' },
  ownerPlayer: { limit: 120, message: 'Demasiadas acciones seguidas. Espera un momento.' },
  authProfile: { limit: 30, windowMs: 15 * MINUTE_MS, message: 'Demasiadas solicitudes. Espera unos minutos e intenta de nuevo.' },
};

// Clave por dueño: cada cuenta tiene su propio límite, aunque varias compartan IP.
export const byOwner = (req) => req.user.sub;

// Respuesta 429 con el mismo formato que el resto de errores de la API.
export const createLimiter = ({ limit, windowMs = MINUTE_MS, message, keyGenerator }) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (_req, res, _next, options) => res.status(options.statusCode).json({ error: message, code: 'rate_limited' }),
  });
