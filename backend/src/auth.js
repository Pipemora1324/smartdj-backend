import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from './config.js';
import { redis } from './redis.js';
import { AppError } from './errors.js';
export const accessToken = user => jwt.sign({ sub:user.id, email:user.email, role:user.role }, config.accessSecret, { expiresIn:'15m' });
export const refreshToken = user => jwt.sign({ sub:user.id, jti:crypto.randomUUID() }, config.refreshSecret, { expiresIn:'7d' });
// Cross-site (Vercel -> Render) exige SameSite=None + Secure. En local usamos lax.
export const setRefreshCookie = (res, token) => res.cookie('smartdj_refresh', token, { httpOnly:true, secure:config.cookieSecure || config.production, sameSite:config.production ? 'none' : 'lax', path:'/api/auth', maxAge:604800000 });
export const clearRefreshCookie = (res) => res.clearCookie('smartdj_refresh', { httpOnly:true, secure:config.cookieSecure || config.production, sameSite:config.production ? 'none' : 'lax', path:'/api/auth' });
export const requireAuth = async (req,_res,next) => { try { const token=(req.get('authorization')||'').replace(/^Bearer\s+/i,''); if(!token) throw new AppError(401,'No autorizado'); const payload=jwt.verify(token,config.accessSecret); if(await redis.get(`revoked:${payload.jti || token}`)) throw new AppError(401,'Sesión inválida'); req.user=payload; next(); } catch { next(new AppError(401,'No autorizado')); } };
