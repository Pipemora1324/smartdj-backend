import { rateLimit } from 'express-rate-limit';

// Límites de uso de la API en un solo lugar. Las rutas del dueño se cuentan por cuenta. Las públicas, por cliente:
// en un local, decenas de celulares salen a internet con la misma IP (el Wi-Fi), así que contar solo por IP
// bloquearía a todos. Por eso cada ruta pública tiene dos límites: uno por cliente (IP + identificador del
// navegador) y un tope por IP más alto, que frena a quien invente identificadores. Ver CARGA.md.
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
// Tope por IP de cada límite público: alcanza para ~300 personas en el mismo Wi-Fi.
export const IP_CEILING_FACTOR = 30;

// Clave por dueño: cada cuenta tiene su propio límite, aunque varias compartan IP.
export const byOwner = (req) => req.user.sub;

// Identificador anónimo del navegador (X-Client-Id o ?client= en EventSource, que no manda cabeceras).
// No es secreto ni da permisos: solo separa los contadores de quienes comparten IP.
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;
export const clientIdOf = (req) => {
  const value = req.get('x-client-id') ?? req.query?.client;
  return typeof value === 'string' && CLIENT_ID.test(value) ? value : null;
};
export const byClient = (req) => {
  const client = clientIdOf(req);
  return client ? `${req.ip}|${client}` : req.ip;
};

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

// Límite de una ruta pública: tope por IP y, dentro de él, el límite de cada cliente.
export const createPublicLimiter = (config) => [
  createLimiter({ ...config, limit: config.limit * IP_CEILING_FACTOR }),
  createLimiter({ ...config, keyGenerator: byClient }),
];
