import './zod-es.js';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { isAllowedOrigin } from './config.js';
import { AppError, errorHandler, notFound, sanitizeForLog } from './errors.js';
import authRoutes from './routes/auth.js';
import venueRoutes from './routes/venues.js';
import playerRoutes from './routes/player.js';
import publicRoutes from './routes/public.js';
import publicLiveRoutes from './routes/public-live.js';
import { logger } from './logger.js';

// La app de Express sin escuchar en un puerto: server.js la arranca y las pruebas de integración la montan en un puerto libre.
export const createApp = () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: false }));
  // CORS solo para los orígenes conocidos; la sesión viaja en el header Authorization, sin cookies.
  const corsOptions = {
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      logger.warn('CORS rechazó un origen; si es el frontend, agrégalo a CORS_ORIGIN', { origin: sanitizeForLog(origin) });
      cb(new AppError(403, 'Origen no permitido por CORS'));
    },
    maxAge: 600,
  };
  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));
  // Los cuerpos más grandes de la API (reordenar la cola) caben de sobra en 32 kB.
  app.use(express.json({ limit: '32kb' }));
  app.get('/api/health', (_q, s) => s.json({ status: 'ok' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/venues/:id/player', playerRoutes);
  app.use('/api/venues', venueRoutes);
  app.use('/api/public', publicRoutes);
  app.use('/api/public', publicLiveRoutes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
};
