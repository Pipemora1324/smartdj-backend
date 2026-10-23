// NUNCA EJECUTAR CONTRA PRODUCCIÓN. Abre SSE_CLIENTS conexiones al SSE público del local durante SSE_SECONDS,
// como 100 celulares con la página abierta, y cuenta conexiones, avisos recibidos y errores.
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://api:3000';
if (!/^http:\/\/(api|localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('Solo se permite un backend local.');
const CLIENTS = Number(process.env.SSE_CLIENTS || 100);
const SECONDS = Number(process.env.SSE_SECONDS || 120);
const CLIENT_IDS = process.env.CLIENT_ID === '1';

// k6 escribe el código del local en /out/venue.json al preparar la prueba.
const waitVenue = async () => {
  for (let i = 0; i < 120; i += 1) {
    try {
      return JSON.parse(readFileSync('/out/venue.json', 'utf8'));
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('No apareció /out/venue.json');
};

const { code } = await waitVenue();
const stats = { opened: 0, refused: {}, errors: 0, updates: 0, reconnects: 0, refreshes: {} };
const end = Date.now() + SECONDS * 1000;

const client = async (i) => {
  const clientId = `${(i + 1).toString(16).padStart(8, '0')}-carga`;
  const query = CLIENT_IDS ? `?client=${clientId}` : '';
  // Igual que la página pública: cada aviso programa un GET /now como mucho cada 2 s.
  let pending = null;
  const refreshSoon = () => {
    pending ??= setTimeout(async () => {
      pending = null;
      const res = await fetch(`${BASE}/api/public/venues/${code}/now`, { headers: CLIENT_IDS ? { 'x-client-id': clientId } : {} }).catch(() => null);
      const key = res ? res.status : 'error';
      stats.refreshes[key] = (stats.refreshes[key] || 0) + 1;
    }, 2000);
  };
  while (Date.now() < end) {
    try {
      const res = await fetch(`${BASE}/api/public/venues/${code}/events${query}`, { signal: AbortSignal.timeout(Math.max(1, end - Date.now())) });
      if (!res.headers.get('content-type')?.startsWith('text/event-stream')) {
        stats.refused[res.status] = (stats.refused[res.status] || 0) + 1;
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      stats.opened += 1;
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        const text = decoder.decode(chunk);
        const updates = (text.match(/event: update/g) || []).length;
        stats.updates += updates;
        if (updates || text.includes('event: ready')) refreshSoon();
      }
      stats.reconnects += 1;
    } catch (err) {
      if (Date.now() < end && err.name !== 'TimeoutError') stats.errors += 1;
    }
  }
};

await Promise.all(Array.from({ length: CLIENTS }, (_, i) => client(i)));
writeFileSync('/out/sse.json', JSON.stringify(stats));
console.log(JSON.stringify(stats));
