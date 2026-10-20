import { Router } from 'express'; import { z } from 'zod'; import { query } from '../db.js'; import { requestQueue, evaluationJobOptions } from '../queue.js'; import { AppError } from '../errors.js';
import { rateLimit } from 'express-rate-limit'; import { redis } from '../redis.js'; import { FINAL_STAGES, publishRequestEvent, readRequestStatus, statusChannel } from '../request-status.js';
const router=Router(); const payload=z.object({guestName:z.string().trim().min(2).max(60),title:z.string().trim().min(1).max(140),artist:z.string().trim().min(1).max(140),genre:z.string().trim().min(1).max(60),bpm:z.number().positive().max(300).optional(),musicalKey:z.string().trim().max(15).optional()});
router.get('/venues/:code',async(req,res,next)=>{try{const r=await query('SELECT id,name,kind,ambience,public_code FROM establishments WHERE public_code=$1',[req.params.code]);if(!r.rowCount)throw new AppError(404,'Código de establecimiento inválido');res.json(r.rows[0]);}catch(e){next(e);}});
router.post('/venues/:code/requests',async(req,res,next)=>{try{const d=payload.parse(req.body);const v=await query('SELECT id FROM establishments WHERE public_code=$1',[req.params.code]);if(!v.rowCount)throw new AppError(404,'Código de establecimiento inválido');const r=await query('INSERT INTO song_requests(establishment_id,guest_name,title,artist,genre,bpm,musical_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[v.rows[0].id,d.guestName,d.title,d.artist,d.genre,d.bpm||null,d.musicalKey||null]);await publishRequestEvent(r.rows[0].id,{stage:'queued',message:'Tu petición está en la cola.',partialScore:0});await requestQueue.add('evaluate',{requestId:r.rows[0].id},evaluationJobOptions);res.status(202).json({id:r.rows[0].id,status:'queued',message:'Tu petición será evaluada por Smart DJ.'});}catch(e){next(e);}});

// ---------- Estado en vivo de una petición (polling y SSE) ----------
// El id es un UUID que solo conoce quien hizo la petición; no se expone el nombre del invitado.
const requestId = z.string().uuid('El id de la petición no es válido.');
const statusLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Demasiadas consultas. Espera un momento.' } });
const streamLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Demasiadas conexiones. Espera un momento.' } });
const SSE_MAX_MS = 2 * 60 * 1000;
const SSE_HEARTBEAT_MS = 15 * 1000;

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
    return { requestId: row.id, stage: 'result', message: row.ai_reason, partialScore: 0,
      result: { accepted: row.status === 'accepted', score: null, reason: row.ai_reason, bridgeSequence: row.bridge_sequence } };
  }
  return { requestId: row.id, stage: 'queued', message: 'Tu petición está en la cola.', partialScore: 0 };
};

router.get('/requests/:id', statusLimiter, async (req, res, next) => {
  try {
    const row = await loadRequest(requestId.parse(req.params.id));
    res.json({ id: row.id, title: row.title, artist: row.artist, status: row.status, live: await currentStatus(row) });
  } catch (e) { next(e); }
});

router.get('/requests/:id/events', streamLimiter, async (req, res, next) => {
  let row;
  try { row = await loadRequest(requestId.parse(req.params.id)); } catch (e) { return next(e); }
  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const subscriber = redis.duplicate();
  let closed = false;
  const send = (event) => res.write(`event: status\ndata: ${JSON.stringify(event)}\n\n`);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat); clearTimeout(maxLifetime);
    subscriber.quit().catch(() => subscriber.disconnect());
    res.end();
  };
  const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
  const maxLifetime = setTimeout(close, SSE_MAX_MS);
  req.on('close', close);
  subscriber.on('message', (_channel, message) => {
    const event = JSON.parse(message);
    send(event);
    if (FINAL_STAGES.has(event.stage)) close();
  });
  subscriber.on('error', (err) => { console.error('Error de Redis en SSE:', err.message); close(); });
  try {
    // Primero la suscripción y después la foto actual, para no perder eventos entre ambas.
    await subscriber.subscribe(statusChannel(row.id));
    const snapshot = await currentStatus(row);
    if (closed) return;
    send(snapshot);
    if (FINAL_STAGES.has(snapshot.stage)) close();
  } catch (err) {
    console.error('No se pudo iniciar el SSE:', err.message);
    close();
  }
});
export default router;
