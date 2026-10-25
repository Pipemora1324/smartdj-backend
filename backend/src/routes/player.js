import { Router } from 'express';
import { LIMITS, byOwner, createLimiter } from '../rate-limits.js';
import { requireSupabaseAuth } from '../supabase-auth.js';
import { requirePlayerSchema } from '../schema-check.js';
import { AppError } from '../errors.js';
import { findCachedTrack } from '../music-catalog.js';
import {
  advanceSchema,
  claimSchema,
  pauseSchema,
  playSchema,
  playerSettingsSchema,
  queueAddSchema,
  queueOrderSchema,
  requestPrioritySchema,
  requestQueueSchema,
  skipSchema,
  uuidParam,
} from '../owner-validation.js';
import {
  advance,
  claimConsole,
  enqueue,
  ensurePlayerState,
  pause,
  play,
  playerSnapshot,
  requestPositions,
  removeFromQueue,
  reorderQueue,
  updateSettings,
} from '../player.js';
import { ownedVenue } from './venues.js';
import { ensureQueue } from '../autodj.js';
import {
  adjustPriority,
  autoAcceptsRequests,
  blockRequest,
  dismissRequest,
  pendingRequests,
  queueRequestById,
} from '../station-requests.js';
import { autoRequestsReady, hasColumn } from '../schema-check.js';
import { toStationRequest } from '../player-logic.js';

// Reproductor de la emisora de un local (/api/venues/:id/player). Solo el dueño del local.
const router = Router({ mergeParams: true });
const playerLimiter = createLimiter({ ...LIMITS.ownerPlayer, keyGenerator: byOwner });
router.use(requireSupabaseAuth, playerLimiter, async (req, _res, next) => {
  try {
    req.venue = await ownedVenue(req.params.id, req.user.sub);
    await requirePlayerSchema();
    next();
  } catch (e) {
    next(e);
  }
});

// Después de cada cambio se responde con la foto completa, para que la consola no tenga que pedirla otra vez.
const reply = async (req, res, extra = {}) => res.json({ ...(await playerSnapshot(req.venue.id)), ...extra });
// Acciones que pueden dejar la cola corta: el AutoDJ la rellena antes de responder (no hace nada en modo manual).
const refillAndReply = async (req, res, extra) => {
  await ensureQueue(req.venue);
  await reply(req, res, extra);
};
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (e) {
    next(e);
  }
};

router.get(
  '/',
  handle(async (req, res) => {
    // Sin el estado creado, el AutoDJ no sabría el modo y la primera carga quedaría con la cola vacía.
    await ensurePlayerState(req.venue.id);
    await refillAndReply(req, res);
  }),
);
router.post(
  '/claim',
  handle(async (req, res) => {
    await claimConsole(req.venue.id, claimSchema.parse(req.body).consoleId);
    await reply(req, res);
  }),
);
router.post(
  '/play',
  handle(async (req, res) => {
    await play(req.venue.id, playSchema.parse(req.body ?? {}));
    await reply(req, res);
  }),
);
router.post(
  '/pause',
  handle(async (req, res) => {
    await pause(req.venue.id, pauseSchema.parse(req.body ?? {}));
    await reply(req, res);
  }),
);
router.post(
  '/skip',
  handle(async (req, res) => {
    const d = skipSchema.parse(req.body ?? {});
    const advanced = await advance(req.venue.id, { consoleId: d.consoleId, fromTrackId: d.fromTrackId, reason: d.reason });
    await refillAndReply(req, res, { advanced });
  }),
);
router.post(
  '/advance',
  handle(async (req, res) => {
    const d = advanceSchema.parse(req.body ?? {});
    const advanced = await advance(req.venue.id, { consoleId: d.consoleId, fromTrackId: d.fromTrackId, reason: 'ended' });
    await refillAndReply(req, res, { advanced });
  }),
);
router.patch(
  '/',
  handle(async (req, res) => {
    await updateSettings(req.venue.id, playerSettingsSchema.parse(req.body ?? {}));
    await refillAndReply(req, res);
  }),
);
router.post(
  '/queue',
  handle(async (req, res) => {
    const d = queueAddSchema.parse(req.body ?? {});
    const track = await findCachedTrack(d.provider, d.externalId);
    if (!track) throw new AppError(404, 'No encontramos esa pista. Búscala de nuevo en el catálogo.');
    if (track.non_commercial && req.venue.exclude_non_commercial)
      throw new AppError(409, 'Este local solo programa pistas con licencia comercial.');
    await enqueue(req.venue.id, track, { source: 'manual' });
    await reply(req, res);
  }),
);
router.patch(
  '/queue',
  handle(async (req, res) => {
    await reorderQueue(req.venue.id, queueOrderSchema.parse(req.body ?? {}).order);
    await reply(req, res);
  }),
);
router.delete(
  '/queue/:itemId',
  handle(async (req, res) => {
    await removeFromQueue(req.venue.id, uuidParam.parse(req.params.itemId));
    await refillAndReply(req, res);
  }),
);

// Peticiones del público en la consola (migración 008): pendientes y acciones del dueño.
const requireRequests = () => {
  if (!hasColumn('song_requests.track_id'))
    throw new AppError(503, 'Las peticiones en la emisora no están listas: falta ejecutar la migración 008_peticiones_emisora.sql.');
};
// Peticiones pendientes con su puesto en la cola y si el local las acepta solas (interruptor de la 010).
const replyRequests = async (req, res) => {
  const [rows, live] = await Promise.all([pendingRequests(req.venue.id), requestPositions(req.venue.id, { fresh: true })]);
  const autoAccept = autoAcceptsRequests(req.venue, live.mode);
  res.json({
    requests: rows.map((row) => toStationRequest(row, { positions: live.positions, autoAccept })),
    autoAccept,
    autoAcceptEnabled: autoRequestsReady() ? req.venue.auto_accept_requests !== false : null,
    blockExplicit: autoRequestsReady() ? Boolean(req.venue.block_explicit) : null,
  });
};
const requireAutoRequests = () => {
  if (!autoRequestsReady())
    throw new AppError(503, 'Las peticiones automáticas no están listas: falta ejecutar la migración 010_peticiones_automaticas.sql.');
};
router.get(
  '/requests',
  handle(async (req, res) => {
    requireRequests();
    await replyRequests(req, res);
  }),
);
router.post(
  '/requests/:requestId/queue',
  handle(async (req, res) => {
    requireRequests();
    const { next } = requestQueueSchema.parse(req.body ?? {});
    await queueRequestById(req.venue, uuidParam.parse(req.params.requestId), {
      next,
      reason: next ? 'El DJ la puso ahora.' : 'El DJ la agregó a la cola.',
    });
    await reply(req, res);
  }),
);
router.post(
  '/requests/:requestId/dismiss',
  handle(async (req, res) => {
    requireRequests();
    await dismissRequest(req.venue, uuidParam.parse(req.params.requestId));
    await replyRequests(req, res);
  }),
);
// Subir o bajar una petición en el orden (dentro del límite de aplazamiento); el AutoDJ reordena enseguida.
router.post(
  '/requests/:requestId/priority',
  handle(async (req, res) => {
    requireRequests();
    requireAutoRequests();
    await adjustPriority(req.venue, uuidParam.parse(req.params.requestId), requestPrioritySchema.parse(req.body ?? {}).delta);
    await ensureQueue(req.venue);
    await replyRequests(req, res);
  }),
);
// Bloquear: descarta la petición (también si ya estaba en la cola) y la canción no se acepta más en el local.
router.post(
  '/requests/:requestId/block',
  handle(async (req, res) => {
    requireRequests();
    requireAutoRequests();
    await blockRequest(req.venue, uuidParam.parse(req.params.requestId));
    await ensureQueue(req.venue);
    await replyRequests(req, res);
  }),
);

export default router;
