import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { AppError } from '../errors.js';
import { LIMITS, MINUTE_MS, createLimiter } from '../rate-limits.js';
import { redis } from '../redis.js';
import { FINAL_STAGES, readRequestStatus, statusChannel } from '../request-status.js';
import { listenVenue } from '../venue-events.js';
import { findVenue } from '../venue-lookup.js';
import { openEventStream, startHeartbeat, writeEvent } from '../sse.js';
import { logger } from '../logger.js';

// Estado en vivo para la página pública: el de cada petición (polling y SSE) y los avisos del local.
const router = Router();

// ---------- Estado en vivo de una petición (polling y SSE) ----------
// El id es un UUID que solo conoce quien hizo la petición; no se expone el nombre del invitado.
const requestId = z.string().uuid('El id de la petición no es válido.');
const statusLimiter = createLimiter(LIMITS.publicRead);
const streamLimiter = createLimiter(LIMITS.requestStream);
const SSE_MAX_MS = 2 * MINUTE_MS;
const venueStreamLimiter = createLimiter(LIMITS.venueStream);
const VENUE_SSE_MAX_MS = 5 * MINUTE_MS;

const loadRequest = async (id) => {
  const r = await query('SELECT id,title,artist,status,ai_reason,bridge_sequence,evaluated_at FROM song_requests WHERE id=$1', [id]);
  if (!r.rowCount) throw new AppError(404, 'Petición no encontrada');
  return r.rows[0];
};

// Estado actual: el último evento en vivo o, si ya venció en Redis, el que se deduce de la base de datos.
const currentStatus = async (row) => {
  const live = await readRequestStatus(row.id);
  if (live) return live;
  if (row.evaluated_at) {
    return {
      requestId: row.id,
      stage: 'result',
      message: row.ai_reason,
      partialScore: 0,
      result: { accepted: row.status === 'accepted', score: null, reason: row.ai_reason, bridgeSequence: row.bridge_sequence },
    };
  }
  return { requestId: row.id, stage: 'queued', message: 'Tu petición está en la cola.', partialScore: 0 };
};

router.get('/requests/:id', statusLimiter, async (req, res, next) => {
  try {
    const row = await loadRequest(requestId.parse(req.params.id));
    res.json({ id: row.id, title: row.title, artist: row.artist, status: row.status, live: await currentStatus(row) });
  } catch (e) {
    next(e);
  }
});

router.get('/requests/:id/events', streamLimiter, async (req, res, next) => {
  let row;
  try {
    row = await loadRequest(requestId.parse(req.params.id));
  } catch (e) {
    return next(e);
  }
  openEventStream(res);
  const subscriber = redis.duplicate();
  let closed = false;
  const send = (event) => writeEvent(res, 'status', event);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(maxLifetime);
    subscriber.quit().catch(() => subscriber.disconnect());
    res.end();
  };
  const heartbeat = startHeartbeat(res);
  const maxLifetime = setTimeout(close, SSE_MAX_MS);
  req.on('close', close);
  subscriber.on('message', (_channel, message) => {
    const event = JSON.parse(message);
    send(event);
    if (FINAL_STAGES.has(event.stage)) close();
  });
  subscriber.on('error', (err) => {
    logger.error('Error de Redis en SSE', { err: err });
    close();
  });
  try {
    // Primero la suscripción y después la foto actual, para no perder eventos entre ambas.
    await subscriber.subscribe(statusChannel(row.id));
    const snapshot = await currentStatus(row);
    if (closed) return;
    send(snapshot);
    if (FINAL_STAGES.has(snapshot.stage)) close();
  } catch (err) {
    logger.error('No se pudo iniciar el SSE', { err: err });
    close();
  }
});

// Avisos en vivo del local para la página pública: solo el tipo de cambio ("player_updated", ...); la página
// vuelve a pedir /now. Se cierra a los 5 minutos y EventSource se reconecta solo.
router.get('/venues/:code/events', venueStreamLimiter, async (req, res, next) => {
  let venue;
  try {
    venue = await findVenue(req.params.code);
  } catch (e) {
    return next(e);
  }
  let stop = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(maxLifetime);
    stop?.();
    res.end();
  };
  const heartbeat = startHeartbeat(res);
  const maxLifetime = setTimeout(close, VENUE_SSE_MAX_MS);
  req.on('close', close);
  try {
    // Un aviso que llegue antes de enviar las cabeceras se descarta: el cliente pide /now al recibir "ready".
    stop = await listenVenue(venue.id, (event) => {
      if (res.headersSent && !closed) writeEvent(res, 'update', event);
    });
  } catch (err) {
    logger.error('No se pudo iniciar el SSE del local', { err: err });
  }
  if (!stop) {
    clearInterval(heartbeat);
    clearTimeout(maxLifetime);
    if (closed) return;
    closed = true;
    return res.status(503).json({ error: 'Demasiadas conexiones en vivo. La página se actualizará cada pocos segundos.' });
  }
  if (closed) return stop();
  openEventStream(res);
  writeEvent(res, 'ready', {});
});

export default router;
