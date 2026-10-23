import 'dotenv/config';
import { z } from 'zod';

// Validación de la configuración al arrancar: si falta algo o tiene un formato inválido, el servidor no arranca
// y el error lista TODOS los problemas en español. Los valores por defecto son solo los seguros (puertos, tiempos).
// Una variable definida pero vacía en el panel del hosting cuenta como no definida (usa su valor por defecto).
const blankToUndefined = (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
// Solo se revisa el esquema: pg e ioredis aceptan contraseñas con caracteres que new URL() rechazaría.
const urlWith = (schemes, label) =>
  z
    .string({ required_error: 'falta (es obligatoria)' })
    .trim()
    .min(1, 'falta (es obligatoria)')
    .regex(new RegExp(`^(${schemes.join('|')})://\\S+$`, 'i'), `debe ser una URL ${label}`);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', 'host.docker.internal']);
// https en producción; http solo para servicios locales (pruebas con dobles de Jamendo o del motor).
const serviceUrl = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
    } catch {
      return false;
    }
  }, 'debe ser una URL https (http solo para localhost)');
const positiveInt = (fallback) =>
  z.preprocess(
    blankToUndefined,
    z.coerce
      .number({ invalid_type_error: 'debe ser un número' })
      .int('debe ser un entero')
      .positive('debe ser mayor que 0')
      .default(fallback),
  );
const optionalText = z.string().trim().optional().default('');

const envSchema = z.object({
  PORT: positiveInt(3000).refine((n) => n <= 65535, 'debe ser un puerto válido'),
  DATABASE_URL: urlWith(['postgres', 'postgresql'], 'de Postgres (postgres:// o postgresql://)'),
  DATABASE_POOL_MAX: positiveInt(10).refine((n) => n <= 50, 'debe ser como mucho 50'),
  REDIS_URL: urlWith(['redis', 'rediss'], 'de Redis (redis:// o rediss://)'),
  AI_SERVICE_URL: urlWith(['http', 'https'], 'http(s) del motor'),
  SUPABASE_URL: urlWith(['http', 'https'], 'http(s) del proyecto de Supabase'),
  SUPABASE_JWKS_URL: optionalText,
  SUPABASE_JWT_SECRET: optionalText.refine((v) => !v || v.length >= 32, 'debe tener al menos 32 caracteres'),
  CORS_ORIGIN: optionalText,
  AI_GRPC_URL: optionalText.refine((v) => !v || /^[\w.-]+:\d{1,5}$/.test(v), 'debe tener el formato host:puerto'),
  AI_GRPC_TLS: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    z
      .enum(['true', 'false', ''], { errorMap: () => ({ message: 'debe ser true o false' }) })
      .optional()
      .default('false'),
  ),
  AI_GRPC_TIMEOUT_MS: positiveInt(10000),
  AI_GRPC_CONNECT_TIMEOUT_MS: positiveInt(3000),
  JAMENDO_CLIENT_ID: optionalText,
  JAMENDO_API_URL: z.preprocess(blankToUndefined, serviceUrl.optional().default('https://api.jamendo.com/v3.0')),
  JAMENDO_MONTHLY_BUDGET: positiveInt(30000),
  ITUNES_API_URL: z.preprocess(blankToUndefined, serviceUrl.optional()),
  AUDIUS_API_KEY: optionalText,
});

const listFrom = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
// Una barra final copiada desde el navegador no impide arrancar: "https://x.app/" equivale a "https://x.app".
const corsOrigins = (value) => listFrom(value).map((origin) => origin.replace(/\/+$/, ''));
const isOrigin = (value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
};
// Reglas que combinan variables: se revisan aparte para listarlas junto a los demás problemas
// (Zod no ejecuta los refinamientos del objeto si algún campo ya falló).
const crossIssues = (env) => {
  const issues = [];
  const jwks = String(env.SUPABASE_JWKS_URL || '').trim();
  if (!jwks && !String(env.SUPABASE_JWT_SECRET || '').trim()) issues.push('SUPABASE_JWKS_URL: falta (o define SUPABASE_JWT_SECRET)');
  if (jwks && !/^https?:\/\//.test(jwks)) issues.push('SUPABASE_JWKS_URL: debe ser una URL http(s)');
  for (const origin of corsOrigins(env.CORS_ORIGIN)) {
    if (!isOrigin(origin)) issues.push(`CORS_ORIGIN: "${origin}" no es un origen válido (http(s)://host[:puerto], sin ruta)`);
  }
  return issues;
};

// Origenes de los despliegues conocidos, siempre permitidos.
const knownOrigins = [
  'https://smart-dj-platform-frontend.vercel.app',
  'http://localhost:8080',
  'http://localhost:3000',
  'http://localhost:5173',
];

export class ConfigError extends Error {}

// Convierte las variables de entorno en la configuración de la app o lanza ConfigError con todos los problemas.
export const parseConfig = (env) => {
  const result = envSchema.safeParse(env);
  const problems = [
    ...(result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)),
    ...crossIssues(env),
  ];
  if (problems.length) {
    throw new ConfigError(`Configuración inválida; revisa las variables de entorno:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  const e = result.data;
  const redisUrl = (() => {
    // Host: lo que sigue a la última @ (la contraseña puede tenerla) o, sin credenciales, a ://.
    const host = /^[a-z]+:\/\/(?:.*@)?([^:/?#@]+)/i.exec(e.REDIS_URL)?.[1] ?? '';
    // Upstash habilita TLS. Corrige URLs copiadas como redis:// para que ioredis
    // conecte de forma segura sin tener que exponer credenciales en el código.
    if (host.endsWith('.upstash.io') && /^redis:/i.test(e.REDIS_URL)) {
      return e.REDIS_URL.replace(/^redis:\/\//i, 'rediss://');
    }
    return e.REDIS_URL;
  })();
  // Lista de origenes permitidos (separados por coma en CORS_ORIGIN).
  const origins = corsOrigins(e.CORS_ORIGIN);
  return {
    port: e.PORT,
    dbUrl: e.DATABASE_URL,
    // Conexiones del pool de Postgres. Supabase gratis admite 60 directas y 200 por el pooler: 10 deja margen. Ver CARGA.md.
    dbPoolMax: e.DATABASE_POOL_MAX,
    redisUrl,
    aiUrl: e.AI_SERVICE_URL,
    origins: [...new Set([...origins, ...knownOrigins])],
    supabaseUrl: e.SUPABASE_URL,
    supabaseJwksUrl: e.SUPABASE_JWKS_URL,
    supabaseJwtSecret: e.SUPABASE_JWT_SECRET,
    // gRPC con el motor de IA: si AI_GRPC_URL (host:puerto) está vacío se usa HTTP con AI_SERVICE_URL.
    aiGrpcUrl: e.AI_GRPC_URL,
    aiGrpcTls: e.AI_GRPC_TLS === 'true',
    aiGrpcTimeoutMs: e.AI_GRPC_TIMEOUT_MS,
    aiGrpcConnectTimeoutMs: e.AI_GRPC_CONNECT_TIMEOUT_MS,
    // Catálogo de la emisora (ver DECISIONES_DJ.md). Sin JAMENDO_CLIENT_ID el buscador de pistas avisa que no está configurado.
    jamendoClientId: e.JAMENDO_CLIENT_ID,
    jamendoApiUrl: e.JAMENDO_API_URL,
    jamendoMonthlyBudget: e.JAMENDO_MONTHLY_BUDGET,
    // Audius es opcional y la clave solo vive en el servidor.
    audiusApiKey: e.AUDIUS_API_KEY,
  };
};

export const config = parseConfig(process.env);

// Verdadero si el origen de la peticion esta permitido.
export const isAllowedOrigin = (origin) => !origin || config.origins.includes(origin);
