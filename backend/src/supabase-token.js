import { createPublicKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

// Error de validación del token de Supabase: expired, invalid o unavailable (el JWKS no respondió).
export class SupabaseTokenError extends Error {
  constructor(reason) {
    super(`Token de Supabase ${reason}`);
    this.name = 'SupabaseTokenError';
    this.reason = reason;
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const audience = 'authenticated';

// Supabase firma sus tokens con iss = <url del proyecto>/auth/v1.
export const supabaseIssuer = () => `${config.supabaseUrl.replace(/\/+$/, '')}/auth/v1`;

// Claves públicas del JWKS en caché; se recargan si aparece un kid desconocido (rotación de claves).
const jwksTtlMs = 10 * 60 * 1000;
const minRefreshMs = 30 * 1000;
const jwksTimeoutMs = 5000;
let jwks = null;

export const resetJwksCache = () => {
  jwks = null;
};

const loadJwks = async () => {
  try {
    const response = await fetch(config.supabaseJwksUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(jwksTimeoutMs),
    });
    if (!response.ok) throw new SupabaseTokenError('unavailable');
    const body = await response.json();
    const keys = new Map();
    for (const key of body.keys ?? []) {
      if (!key.kid) continue;
      try {
        keys.set(key.kid, createPublicKey({ key, format: 'jwk' }));
      } catch {
        // Se salta una clave que esta versión de Node no puede leer.
      }
    }
    jwks = { keys, fetchedAt: Date.now() };
  } catch (err) {
    if (err instanceof SupabaseTokenError) throw err;
    throw new SupabaseTokenError('unavailable');
  }
};

const publicKeyFor = async (kid) => {
  if (!jwks || Date.now() - jwks.fetchedAt > jwksTtlMs) await loadJwks();
  let key = jwks.keys.get(kid);
  if (!key && Date.now() - jwks.fetchedAt > minRefreshMs) {
    await loadJwks();
    key = jwks.keys.get(kid);
  }
  if (!key) throw new SupabaseTokenError('invalid');
  return key;
};

// Verifica firma, emisor, audiencia y vencimiento. HS256 solo con SUPABASE_JWT_SECRET y RS256/ES256 solo con
// el JWKS, para que un tipo de clave nunca sirva para falsificar el otro.
export const verifySupabaseToken = async (token) => {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded.payload === 'string') throw new SupabaseTokenError('invalid');
  const { alg, kid } = decoded.header;
  let key;
  if (alg === 'HS256' && config.supabaseJwtSecret) key = config.supabaseJwtSecret;
  else if ((alg === 'RS256' || alg === 'ES256') && config.supabaseJwksUrl && kid) key = await publicKeyFor(kid);
  else throw new SupabaseTokenError('invalid');

  let payload;
  try {
    payload = jwt.verify(token, key, { algorithms: [alg], issuer: supabaseIssuer(), audience });
  } catch (err) {
    throw new SupabaseTokenError(err instanceof jwt.TokenExpiredError ? 'expired' : 'invalid');
  }
  if (
    payload.role !== 'authenticated' ||
    payload.is_anonymous === true ||
    typeof payload.sub !== 'string' ||
    !uuidPattern.test(payload.sub)
  )
    throw new SupabaseTokenError('invalid');
  const metadata = typeof payload.user_metadata === 'object' && payload.user_metadata !== null ? payload.user_metadata : {};
  return {
    sub: payload.sub.toLowerCase(),
    email: typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '',
    // Supabase marca user_metadata.email_verified cuando se confirma la dirección.
    emailVerified: metadata.email_verified === true,
    metadata,
  };
};
