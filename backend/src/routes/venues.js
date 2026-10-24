import { Router } from 'express';
import { query } from '../db.js';
import { requireSupabaseAuth } from '../supabase-auth.js';
import { AppError } from '../errors.js';
import { trackSearchSchema, uuidParam, venuePatchSchema, venueSchema } from '../owner-validation.js';
import { autoRequestsReady, requirePlayerSchema } from '../schema-check.js';
import { ensureQueue } from '../autodj.js';
import { LIMITS, byOwner, createLimiter } from '../rate-limits.js';
import { searchCatalog } from '../music-catalog.js';
import { tagsForVenueProfile, toPublicTrack } from '../catalog-logic.js';
const router = Router();
router.use(requireSupabaseAuth);
// Carga el local solo si pertenece al dueño de la sesión; si no, 404 (no se revela si existe).
export const ownedVenue = async (id, ownerId) => {
  const r = await query('SELECT * FROM establishments WHERE id=$1 AND owner_id=$2', [uuidParam.parse(id), ownerId]);
  if (!r.rowCount) throw new AppError(404, 'Establecimiento no encontrado');
  return r.rows[0];
};
router.get('/', async (req, res, next) => {
  try {
    const r = await query('SELECT * FROM establishments WHERE owner_id=$1 ORDER BY created_at DESC', [req.user.sub]);
    res.json(r.rows);
  } catch (e) {
    next(e);
  }
});
router.post('/', async (req, res, next) => {
  try {
    const d = venueSchema.parse(req.body);
    const r = await query(
      "INSERT INTO establishments(owner_id,name,kind,ambience,public_code) VALUES($1,$2,$3,$4,encode(gen_random_bytes(6),'hex')) RETURNING *",
      [req.user.sub, d.name, d.kind, d.ambience],
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    next(e);
  }
});
router.patch('/:id', async (req, res, next) => {
  try {
    await ownedVenue(req.params.id, req.user.sub);
    const d = venuePatchSchema.parse(req.body);
    if ('exclude_non_commercial' in d) await requirePlayerSchema();
    if (('auto_accept_requests' in d || 'block_explicit' in d) && !autoRequestsReady())
      throw new AppError(503, 'Las peticiones automáticas no están listas: falta ejecutar la migración 010_peticiones_automaticas.sql.');
    const keys = Object.keys(d);
    const r = await query(
      `UPDATE establishments SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(',')} WHERE id=$1 AND owner_id=$2 RETURNING *`,
      [req.params.id, req.user.sub, ...keys.map((k) => d[k])],
    );
    // Al activar "Aceptar peticiones automáticamente", las pendientes entran a la cola sin esperar otro evento.
    if (d.auto_accept_requests === true) await ensureQueue(r.rows[0]);
    res.json(r.rows[0]);
  } catch (e) {
    next(e);
  }
});
// Catálogo de la emisora (Jamendo y, si está configurado, Audius). Límite por dueño para cuidar la cuota del proveedor.
const trackSearchLimiter = createLimiter({ ...LIMITS.ownerSearch, keyGenerator: byOwner });
router.get('/:id/tracks/search', trackSearchLimiter, async (req, res, next) => {
  try {
    const venue = await ownedVenue(req.params.id, req.user.sub);
    await requirePlayerSchema();
    const d = trackSearchSchema.parse(req.query);
    const tags = d.genre ? [d.genre] : d.q ? [] : tagsForVenueProfile(venue);
    const { tracks, source } = await searchCatalog({
      provider: d.provider,
      q: d.q,
      tags,
      excludeNonCommercial: venue.exclude_non_commercial,
    });
    res.json({ tracks: tracks.map((row) => toPublicTrack(row)), source });
  } catch (e) {
    next(e);
  }
});
export default router;
