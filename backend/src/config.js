import 'dotenv/config';
const required = ['DATABASE_URL','REDIS_URL','AI_SERVICE_URL'];
for (const name of required) if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
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
  port: Number(process.env.PORT || 3000), dbUrl: process.env.DATABASE_URL, redisUrl: process.env.REDIS_URL,
  // Fallbacks estables solo para desarrollo. En producción exigimos secretos
  // definidos por el operador para no firmar tokens con valores públicos.
  accessSecret: process.env.JWT_ACCESS_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'smartdj-local-access-secret-change-before-deploy'),
  refreshSecret: process.env.JWT_REFRESH_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'smartdj-local-refresh-secret-change-before-deploy'),
  aiUrl: process.env.AI_SERVICE_URL, origins: [...new Set([...origins, ...knownOrigins])],
  production: process.env.NODE_ENV === 'production', cookieSecure: process.env.COOKIE_SECURE === 'true',
  publicAppUrl: process.env.PUBLIC_APP_URL || 'https://smart-dj-platform-frontend.vercel.app',
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
  !origin || config.origins.includes(origin) || /\.vercel\.app$/.test(origin);
