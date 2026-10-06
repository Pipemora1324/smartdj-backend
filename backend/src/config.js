import 'dotenv/config';
const required = ['DATABASE_URL','REDIS_URL','JWT_ACCESS_SECRET','JWT_REFRESH_SECRET','AI_SERVICE_URL'];
for (const name of required) if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
export const config = {
  port: Number(process.env.PORT || 3000), dbUrl: process.env.DATABASE_URL, redisUrl: process.env.REDIS_URL,
  accessSecret: process.env.JWT_ACCESS_SECRET, refreshSecret: process.env.JWT_REFRESH_SECRET,
  aiUrl: process.env.AI_SERVICE_URL, origin: process.env.CORS_ORIGIN || 'http://localhost:8080',
  production: process.env.NODE_ENV === 'production', cookieSecure: process.env.COOKIE_SECURE === 'true'
};
