import { Queue, Worker } from 'bullmq';
import axios from 'axios';
import { redis } from './redis.js';
import { query } from './db.js';
import { config } from './config.js';
export const requestQueue = new Queue('music-requests', { connection: redis });
new Worker('music-requests', async job => {
  const r = await query('SELECT r.*, e.kind AS venue_kind FROM song_requests r JOIN establishments e ON e.id=r.establishment_id WHERE r.id=$1',[job.data.requestId]);
  if (!r.rowCount) return;
  const item=r.rows[0];
  const ai=await axios.post(`${config.aiUrl}/compatibility`, { venue_type:item.venue_kind, current_genre:job.data.currentGenre||'Pop', requested_genre:item.genre, current_bpm:job.data.currentBpm||120, requested_bpm:item.bpm||120, current_key:job.data.currentKey||'C', requested_key:item.musical_key||'C' });
  await query('UPDATE song_requests SET status=$1, ai_reason=$2, bridge_sequence=$3, evaluated_at=NOW() WHERE id=$4',[ai.data.accepted?'accepted':'bridging',ai.data.reason,JSON.stringify(ai.data.bridge_sequence),item.id]);
  await redis.publish(`venue:${item.establishment_id}`, JSON.stringify({type:'request_evaluated', requestId:item.id, result:ai.data}));
}, { connection: redis });
