import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from './config.js';
import { redis } from './redis.js';
import { AppError } from './errors.js';
export const accessToken = user => jwt.sign({ sub:user.id, email:user.email, role:user.role }, config.accessSecret, { expiresIn:'15m' });
export const refreshToken = user => jwt.sign({ sub:user.id, jti:crypto.randomUUID() }, config.refreshSecret, { expiresIn:'7d' });
// Cross-site (Vercel -> Render) exige SameSite=None + Secure. En local usamos lax.
export const setRefreshCookie = (res, token) => res.cookie('smartdj_refresh', token, { httpOnly:true, secure:config.cookieSecure || config.production, sameSite:config.production ? 'none' : 'lax', partitioned:config.production, path:'/api/auth', maxAge:604800000 });
export const clearRefreshCookie = (res) => res.clearCookie('smartdj_refresh', { httpOnly:true, secure:config.cookieSecure || config.production, sameSite:config.production ? 'none' : 'lax', partitioned:config.production, path:'/api/auth' });
// Acepta el token del header 'Authorization: Bearer <token>' o, si no viene,
// de la cookie HttpOnly. El header tiene prioridad.
export const requireAuth = async (req,_res,next) => {
  const header=(req.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();
  const token=header || req.cookies?.smartdj_access || req.cookies?.smartdj_refresh || '';
  if(!token) return next(new AppError(401,'No autorizado: falta el token'));
  let payload;
  try {
    payload=jwt.verify(token, header ? config.accessSecret : config.refreshSecret);
  } catch (err) {
    console.error('JWT verification failed in requireAuth:',err.name);
    return next(new AppError(401,'No autorizado: token inválido o expirado'));
  }

  let timeoutId;
  try {
    const timeout=new Promise((_,reject)=>{
      timeoutId=setTimeout(()=>reject(new Error('Redis revocation check timed out')),500);
      timeoutId.unref?.();
    });
    const revoked=await Promise.race([
      redis.get(`revoked:${payload.jti || token}`),
      timeout,
    ]);
    if(revoked) return next(new AppError(401,'Sesión inválida'));
  } catch (err) {
    console.error('Redis error in requireAuth:',err);
  } finally {
    clearTimeout(timeoutId);
  }

  req.user=payload;
  next();
};
