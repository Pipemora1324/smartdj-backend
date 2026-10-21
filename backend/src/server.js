import './zod-es.js'; import express from 'express'; import helmet from 'helmet'; import cors from 'cors'; import cookieParser from 'cookie-parser';
import { config, isAllowedOrigin } from './config.js'; import { pool } from './db.js'; import { redis } from './redis.js'; import { AppError, errorHandler, notFound } from './errors.js';
import authRoutes from './routes/auth.js'; import venueRoutes from './routes/venues.js'; import publicRoutes from './routes/public.js'; import './queue.js'; import { checkSchema } from './schema-check.js'; import { checkAiConnection } from './ai-client.js';
const app=express(); app.set('trust proxy',1); app.use(helmet({crossOriginResourcePolicy:false}));
// CORS: permitimos el frontend de Vercel (y local) con credenciales.
const corsOptions={origin:(origin,cb)=>{if(isAllowedOrigin(origin))return cb(null,true);console.warn(`CORS rechazó el origen ${origin}. Si es el frontend, agrégalo a CORS_ORIGIN.`);cb(new AppError(403,'Origen no permitido por CORS'));},credentials:true};
app.use(cors(corsOptions));
app.options('*',cors(corsOptions));
app.use(express.json({limit:'200kb'})); app.use(cookieParser());
app.get('/api/health',(_q,s)=>s.json({status:'ok'})); app.use('/api/auth',authRoutes); app.use('/api/venues',venueRoutes); app.use('/api/public',publicRoutes); app.use(notFound); app.use(errorHandler);
const server=app.listen(config.port,()=>{console.log(`API listening on ${config.port}`);checkSchema();checkAiConnection();});
const close=async()=>{server.close(); await pool.end(); redis.disconnect();}; process.on('SIGTERM',close); process.on('SIGINT',close);
// Errores fuera de una petición (worker, Redis, promesas sin catch): que siempre queden en el log.
process.on('unhandledRejection',(reason)=>console.error('Promesa rechazada sin manejar:',reason instanceof Error?`${reason.message}\n${reason.stack}`:reason));
