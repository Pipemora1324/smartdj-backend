import { Router } from 'express'; import { z } from 'zod'; import { query } from '../db.js'; import { requestQueue, evaluationJobOptions } from '../queue.js'; import { AppError } from '../errors.js';
import { rateLimit } from 'express-rate-limit'; import { redis } from '../redis.js'; import { FINAL_STAGES, publishRequestEvent, readRequestStatus, statusChannel } from '../request-status.js';
import { lookupTrack, searchTracks } from '../music-search.js'; import { hasColumn } from '../schema-check.js';
// BPM y tonalidad son opcionales: "", null o espacios cuentan como "sin dato".
const emptyToUndefined=(v)=>(v===null||(typeof v==='string'&&v.trim()==='')?undefined:v);
const router=Router();
const optionalText=(max)=>z.preprocess(emptyToUndefined,z.string().trim().min(1).max(max).optional());
// Con trackId (buscador) los datos de la canción se vuelven a pedir a iTunes; title/artist queda para clientes viejos.
const payload=z.object({
  guestName:z.preprocess(emptyToUndefined,z.string().trim().min(2,'El nombre debe tener al menos 2 caracteres.').max(60,'El nombre puede tener hasta 60 caracteres.').optional()),
  trackId:z.preprocess(emptyToUndefined,z.string().trim().regex(/^\d{1,20}$/,'La canción elegida no es válida.').optional()),
  title:optionalText(140),artist:optionalText(140),genre:optionalText(60),
  bpm:z.preprocess(emptyToUndefined,z.coerce.number().positive().max(300).optional()),musicalKey:z.preprocess(emptyToUndefined,z.string().trim().max(15).optional()),
}).refine((d)=>d.trackId||(d.title&&d.artist),{message:'Elige una canción del buscador.'});
const searchQuery=z.string({required_error:'Escribe qué canción buscas.',invalid_type_error:'Escribe qué canción buscas.'}).trim().min(2,'Escribe al menos 2 caracteres.').max(100,'La búsqueda puede tener hasta 100 caracteres.');
const limiter=(limit,message)=>rateLimit({windowMs:60*1000,limit,standardHeaders:'draft-7',legacyHeaders:false,message:{error:message}});
const requestLimiter=limiter(10,'Enviaste muchas peticiones seguidas. Espera un minuto.');
const searchLimiter=limiter(30,'Hiciste muchas búsquedas seguidas. Espera un momento.');
const nowLimiter=limiter(120,'Demasiadas consultas. Espera un momento.');
const SEARCH_CACHE_SECONDS=600;

const findVenue=async(code)=>{
  const r=await query('SELECT id,name,kind,ambience,public_code FROM establishments WHERE public_code=$1',[code]);
  if(!r.rowCount)throw new AppError(404,'Código de establecimiento inválido');
  return r.rows[0];
};
// Caché corta en Redis para no repetir la misma búsqueda contra iTunes; si Redis falla, se busca directo.
const cachedSearch=async(term)=>{
  const key=`music-search:${term.toLowerCase()}`;
  const cached=await redis.get(key).catch(()=>null);
  if(cached)return JSON.parse(cached);
  const tracks=await searchTracks(term);
  await redis.set(key,JSON.stringify(tracks),'EX',SEARCH_CACHE_SECONDS).catch(()=>{});
  return tracks;
};
// Inserta la petición; las columnas de la canción solo si la migración 004 ya se aplicó.
const insertRequest=async(venueId,guestName,song,extra)=>{
  const columns=['establishment_id','guest_name','title','artist','genre','bpm','musical_key'];
  const values=[venueId,guestName,song.title,song.artist,song.genre,extra.bpm||null,extra.musicalKey||null];
  for(const [column,value] of [['external_id',song.trackId],['artwork_url',song.artworkUrl],['preview_url',song.previewUrl]]){
    if(hasColumn(`song_requests.${column}`)){columns.push(column);values.push(value??null);}
  }
  const r=await query(`INSERT INTO song_requests(${columns.join(',')}) VALUES(${values.map((_,i)=>`$${i+1}`).join(',')}) RETURNING id`,values);
  return r.rows[0];
};

router.get('/venues/:code',async(req,res,next)=>{try{res.json(await findVenue(req.params.code));}catch(e){next(e);}});
// Interfaz de DJ del link público: lo que suena (última marcada como sonada) y la cola de aceptadas.
// Sin nombres de invitados. Sin la migración 005 se ordena por evaluated_at.
const NOW_QUEUE_LIMIT=10;
const publicSong=(r)=>({id:r.id,title:r.title,artist:r.artist,genre:r.genre,artworkUrl:r.artwork_url??null,previewUrl:r.preview_url??null});
router.get('/venues/:code/now',nowLimiter,async(req,res,next)=>{try{
  const venue=await findVenue(req.params.code);
  const playedOrder=hasColumn('song_requests.played_at')?'played_at DESC NULLS LAST, evaluated_at DESC':'evaluated_at DESC NULLS LAST, created_at DESC';
  const queueOrder=hasColumn('song_requests.status_updated_at')?'COALESCE(status_updated_at, evaluated_at, created_at)':'COALESCE(evaluated_at, created_at)';
  const [playing,queue]=await Promise.all([
    query(`SELECT * FROM song_requests WHERE establishment_id=$1 AND status='played' ORDER BY ${playedOrder} LIMIT 1`,[venue.id]),
    query(`SELECT * FROM song_requests WHERE establishment_id=$1 AND status='accepted' ORDER BY ${queueOrder} ASC LIMIT $2`,[venue.id,NOW_QUEUE_LIMIT]),
  ]);
  res.json({nowPlaying:playing.rows[0]?{...publicSong(playing.rows[0]),playedAt:playing.rows[0].played_at??playing.rows[0].evaluated_at}:null,queue:queue.rows.map(publicSong)});
}catch(e){next(e);}});
router.get('/venues/:code/search',searchLimiter,async(req,res,next)=>{
  try{const term=searchQuery.parse(req.query.q);await findVenue(req.params.code);res.json(await cachedSearch(term));}catch(e){next(e);}
});
router.post('/venues/:code/requests',requestLimiter,async(req,res,next)=>{try{
  const d=payload.parse(req.body);
  const venue=await findVenue(req.params.code);
  const track=d.trackId?await lookupTrack(d.trackId):null;
  if(d.trackId&&!track)throw new AppError(404,'No encontramos esa canción. Busca otra.');
  const song=track??{title:d.title,artist:d.artist,genre:d.genre||'Sin género'};
  const row=await insertRequest(venue.id,d.guestName||'Invitado',song,d);
  await publishRequestEvent(row.id,{stage:'queued',message:'Tu petición está en la cola.',partialScore:0}).catch((err)=>console.error('No se pudo publicar el estado inicial de la petición:',err.message));try{await requestQueue.add('evaluate',{requestId:row.id},evaluationJobOptions);}catch(err){console.error('No se pudo encolar la petición:',err.message);throw new AppError(503,'Recibimos tu petición, pero no pudimos ponerla en la cola. Intenta de nuevo en un momento.');}res.status(202).json({id:row.id,status:'queued',message:'Tu petición será evaluada por Smart DJ.'});}catch(e){next(e);}});

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
