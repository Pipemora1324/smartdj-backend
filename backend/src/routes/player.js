import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { requireSupabaseAuth } from '../supabase-auth.js';
import { requirePlayerSchema } from '../schema-check.js';
import { AppError } from '../errors.js';
import { findCachedTrack } from '../music-catalog.js';
import { advanceSchema, claimSchema, pauseSchema, playSchema, playerSettingsSchema, queueAddSchema, queueOrderSchema, skipSchema, uuidParam } from '../owner-validation.js';
import { advance, claimConsole, enqueue, pause, play, playerSnapshot, removeFromQueue, reorderQueue, updateSettings } from '../player.js';
import { ownedVenue } from './venues.js';

// Reproductor de la emisora de un local (/api/venues/:id/player). Solo el dueño del local.
const router = Router({ mergeParams: true });
const playerLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: (req) => req.user.sub, message: { error: 'Demasiadas acciones seguidas. Espera un momento.' } });
router.use(requireSupabaseAuth, playerLimiter, async (req, _res, next) => {
  try {
    req.venue = await ownedVenue(req.params.id, req.user.sub);
    await requirePlayerSchema();
    next();
  } catch (e) { next(e); }
});

// Después de cada cambio se responde con la foto completa, para que la consola no tenga que pedirla otra vez.
const reply = async (req, res, extra = {}) => res.json({ ...(await playerSnapshot(req.venue.id)), ...extra });
const handle = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

router.get('/', handle((req, res) => reply(req, res)));
router.post('/claim', handle(async (req, res) => { await claimConsole(req.venue.id, claimSchema.parse(req.body).consoleId); await reply(req, res); }));
router.post('/play', handle(async (req, res) => { await play(req.venue.id, playSchema.parse(req.body ?? {})); await reply(req, res); }));
router.post('/pause', handle(async (req, res) => { await pause(req.venue.id, pauseSchema.parse(req.body ?? {})); await reply(req, res); }));
router.post('/skip', handle(async (req, res) => {
  const d = skipSchema.parse(req.body ?? {});
  const advanced = await advance(req.venue.id, { consoleId: d.consoleId, fromTrackId: d.fromTrackId, reason: d.reason });
  await reply(req, res, { advanced });
}));
router.post('/advance', handle(async (req, res) => {
  const d = advanceSchema.parse(req.body ?? {});
  const advanced = await advance(req.venue.id, { consoleId: d.consoleId, fromTrackId: d.fromTrackId, reason: 'ended' });
  await reply(req, res, { advanced });
}));
router.patch('/', handle(async (req, res) => { await updateSettings(req.venue.id, playerSettingsSchema.parse(req.body ?? {})); await reply(req, res); }));
router.post('/queue', handle(async (req, res) => {
  const d = queueAddSchema.parse(req.body ?? {});
  const track = await findCachedTrack(d.provider, d.externalId);
  if (!track) throw new AppError(404, 'No encontramos esa pista. Búscala de nuevo en el catálogo.');
  if (track.non_commercial && req.venue.exclude_non_commercial) throw new AppError(409, 'Este local solo programa pistas con licencia comercial.');
  await enqueue(req.venue.id, track, { source: 'manual' });
  await reply(req, res);
}));
router.patch('/queue', handle(async (req, res) => { await reorderQueue(req.venue.id, queueOrderSchema.parse(req.body ?? {}).order); await reply(req, res); }));
router.delete('/queue/:itemId', handle(async (req, res) => { await removeFromQueue(req.venue.id, uuidParam.parse(req.params.itemId)); await reply(req, res); }));

export default router;
