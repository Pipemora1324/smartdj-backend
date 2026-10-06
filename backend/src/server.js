import express from 'express'; import helmet from 'helmet'; import cors from 'cors'; import cookieParser from 'cookie-parser';
import { config, isAllowedOrigin } from './config.js'; import { pool } from './db.js'; import { redis } from './redis.js'; import { errorHandler, notFound } from './errors.js';
import authRoutes from './routes/auth.js'; import venueRoutes from './routes/venues.js'; import publicRoutes from './routes/public.js'; import './queue.js';
const app=express(); app.set('trust proxy',1); app.use(helmet({crossOriginResourcePolicy:false}));
// CORS: permitimos el frontend de Vercel (y local) con credenciales.
app.use(cors({origin:(origin,cb)=>isAllowedOrigin(origin)?cb(null,true):cb(new Error('Origen no permitido por CORS')),credentials:true}));
app.options('*',cors({origin:(origin,cb)=>isAllowedOrigin(origin)?cb(null,true):cb(new Error('Origen no permitido por CORS')),credentials:true}));
app.use(express.json({limit:'200kb'})); app.use(cookieParser());
app.get('/api/health',(_q,s)=>s.json({status:'ok'})); app.use('/api/auth',authRoutes); app.use('/api/venues',venueRoutes); app.use('/api/public',publicRoutes); app.use(notFound); app.use(errorHandler);
const server=app.listen(config.port,()=>console.log(`API listening on ${config.port}`));
const close=async()=>{server.close(); await pool.end(); redis.disconnect();}; process.on('SIGTERM',close); process.on('SIGINT',close);
