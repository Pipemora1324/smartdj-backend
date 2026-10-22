import { Router } from 'express';
import { LIMITS, createLimiter } from '../rate-limits.js';
import { query } from '../db.js';
import { AppError } from '../errors.js';
import { requireSupabaseAuth } from '../supabase-auth.js';
const router = Router();
// El registro, el login y la recuperación los hace Supabase Auth desde el frontend; aquí solo queda el perfil.
router.use(createLimiter(LIMITS.authProfile));
router.get('/me', requireSupabaseAuth, async (req, res, next) => {
  try {
    const r = await query('SELECT id,email,name,role FROM users WHERE id=$1', [req.user.sub]);
    if (!r.rowCount) throw new AppError(404, 'Usuario no encontrado');
    res.json(r.rows[0]);
  } catch (e) {
    next(e);
  }
});
export default router;
