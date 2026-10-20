import 'dotenv/config';
const required = ['DATABASE_URL','REDIS_URL','AI_SERVICE_URL','JWT_ACCESS_SECRET','JWT_REFRESH_SECRET'];
for (const name of required) if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
for (const name of ['JWT_ACCESS_SECRET','JWT_REFRESH_SECRET']) if (process.env[name].length < 32) throw new Error(`${name} must be at least 32 characters long`);
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
  // Fallbacks estables solo para desarrollo. En producción exigimos secretos
  // definidos por el operador para no firmar tokens con valores públicos.
  accessSecret: process.env.JWT_ACCESS_SECRET,
  refreshSecret: process.env.JWT_REFRESH_SECRET,
  aiUrl: process.env.AI_SERVICE_URL, origins: [...new Set([...origins, ...knownOrigins])],
  production: process.env.NODE_ENV === 'production', cookieSecure: process.env.COOKIE_SECURE === 'true',
  publicAppUrl: process.env.PUBLIC_APP_URL || 'https://smart-dj-platform-frontend.vercel.app',
  resendApiKey: process.env.RESEND_API_KEY,
  smtp: {
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM || 'SmartDJ <no-reply@smartdj.app>',
  },
};

if (config.production && (!config.accessSecret || !config.refreshSecret)) {
  throw new Error('JWT_ACCESS_SECRET y JWT_REFRESH_SECRET son obligatorios en producción');
}

// Verdadero si el origen de la peticion esta permitido.
export const isAllowedOrigin = (origin) =>
  !origin || config.origins.includes(origin);
