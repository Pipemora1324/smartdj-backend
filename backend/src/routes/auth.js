import { Router } from 'express'; import { rateLimit } from 'express-rate-limit';
import { query } from '../db.js'; import { AppError } from '../errors.js'; import { requireSupabaseAuth } from '../supabase-auth.js';
const router=Router();
// El registro, el login y la recuperación los hace Supabase Auth desde el frontend; aquí solo queda el perfil.
const limitMessage={error:'Demasiadas solicitudes. Espera unos minutos e intenta de nuevo.'};
router.use(rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:'draft-7',legacyHeaders:false,message:limitMessage}));
router.get('/me',requireSupabaseAuth,async(req,res,next)=>{try{const r=await query('SELECT id,email,name,role FROM users WHERE id=$1',[req.user.sub]); if(!r.rowCount) throw new AppError(404,'Usuario no encontrado'); res.json(r.rows[0]);}catch(e){next(e);}});
export default router;
