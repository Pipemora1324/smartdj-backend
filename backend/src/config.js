import 'dotenv/config';
const required = ['DATABASE_URL','REDIS_URL','AI_SERVICE_URL','SUPABASE_URL'];
for (const name of required) if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
if (!process.env.SUPABASE_JWKS_URL && !process.env.SUPABASE_JWT_SECRET) throw new Error('Missing required environment variable: SUPABASE_JWKS_URL (or SUPABASE_JWT_SECRET)');
const redisUrl = (() => {
  const value = process.env.REDIS_URL;
  const parsed = new URL(value);
  // Upstash habilita TLS. Corrige URLs copiadas como redis:// para que ioredis
  // conecte de forma segura sin tener que exponer credenciales en el código.
  if (parsed.hostname.endsWith('.upstash.io') && parsed.protocol === 'redis:') {
    return value.replace(/^redis:\/\//i, 'rediss://');
  }
  return value;
})();
// Lista de origenes permitidos (separados por coma en CORS_ORIGIN).
const origins = (process.env.CORS_ORIGIN || 'http://localhost:8080')
  .split(',').map(s => s.trim()).filter(Boolean);

// Origenes de los despliegues conocidos, siempre permitidos.
const knownOrigins = [
  'https://smart-dj-platform-frontend.vercel.app',
  'http://localhost:8080',
  'http://localhost:3000',
  'http://localhost:5173',
];

export const config = {
  port: Number(process.env.PORT || 3000), dbUrl: process.env.DATABASE_URL, redisUrl,
  aiUrl: process.env.AI_SERVICE_URL, origins: [...new Set([...origins, ...knownOrigins])],
  supabaseUrl: process.env.SUPABASE_URL || '', supabaseJwksUrl: process.env.SUPABASE_JWKS_URL || '', supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET || '',
  // gRPC con el motor de IA: si AI_GRPC_URL (host:puerto) está vacío se usa HTTP con AI_SERVICE_URL.
  aiGrpcUrl: process.env.AI_GRPC_URL || '', aiGrpcTls: process.env.AI_GRPC_TLS === 'true',
  aiGrpcTimeoutMs: Number(process.env.AI_GRPC_TIMEOUT_MS || 10000), aiGrpcConnectTimeoutMs: Number(process.env.AI_GRPC_CONNECT_TIMEOUT_MS || 3000),
  // Catálogo de la emisora (ver DECISIONES_DJ.md). Sin JAMENDO_CLIENT_ID el buscador de pistas avisa que no está configurado.
  jamendoClientId: process.env.JAMENDO_CLIENT_ID || '', jamendoApiUrl: process.env.JAMENDO_API_URL || 'https://api.jamendo.com/v3.0',
  jamendoMonthlyBudget: Number(process.env.JAMENDO_MONTHLY_BUDGET || 30000),
  // Audius es opcional y la clave solo vive en el servidor.
  audiusApiKey: process.env.AUDIUS_API_KEY || '',
};

// Verdadero si el origen de la peticion esta permitido.
export const isAllowedOrigin = (origin) =>
  !origin || config.origins.includes(origin);
