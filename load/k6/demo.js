// NUNCA EJECUTAR CONTRA PRODUCCIÓN. Escenario de la demo: 150 personas llegan en un minuto a la página pública
// del local (todas detrás de la misma IP, como en el Wi-Fi del local), buscan y piden una canción cada una,
// siguen su petición y la emisora; mientras, la consola del DJ está activa. El SSE de 100 celulares lo abre
// load/sse-clients.mjs. Solo acepta un backend local.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://api:3000'; // NOSONAR: solo red local de Docker (ver abajo)
if (!/^http:\/\/(api|localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('Solo se permite un backend local.');
// CLIENT_ID=1: la página manda su identificador de cliente (X-Client-Id), como el frontend corregido.
const CLIENT_IDS = __ENV.CLIENT_ID === '1';
const OWNER = JSON.parse(open('/out/tokens.json')).owner;
const TERMS = ['marc anthony', 'vivir mi vida', 'pista', 'lounge', 'salsa', 'jazz', 'valio la pena', 'artista 3'];
const ITUNES_IDS = ['1440818839', '1440818840', '1440818841'];

const limited = new Counter('respuestas_429');
const failed = new Counter('respuestas_5xx');

export const options = {
  scenarios: {
    publico: {
      executor: 'ramping-vus',
      exec: 'publico',
      startVUs: 0,
      stages: [
        { duration: '60s', target: 150 },
        { duration: '60s', target: 150 },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '20s',
    },
    dj: { executor: 'constant-vus', exec: 'dj', vus: 1, duration: '130s' },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  // Umbrales de la demo; también hacen que k6 exporte cada endpoint por separado en el resumen.
  thresholds: {
    'http_req_duration{escenario:publico}': ['p(95)<1500'],
    'http_req_duration{name:local}': ['p(95)<1000'],
    'http_req_duration{name:now}': ['p(95)<1000'],
    'http_req_duration{name:buscar}': ['p(95)<2000'],
    'http_req_duration{name:pedir}': ['p(95)<2000'],
    'http_req_duration{name:sse_peticion}': ['p(95)<10000'],
    'http_req_duration{name:mis_peticiones}': ['p(95)<1000'],
    'http_req_duration{name:dj_estado}': ['p(95)<2000'],
    'http_req_duration{name:dj_avanzar}': ['p(95)<3000'],
    'checks{scenario:publico}': ['rate>0.95'],
    'checks{scenario:dj}': ['rate>0.95'],
  },
};

const json = (body) => ({ headers: { 'content-type': 'application/json' }, ...body });
const owner = (extra = {}) => ({ headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' }, ...extra });
const count = (res) => {
  if (res.status === 429) limited.add(1);
  if (res.status >= 500) failed.add(1);
  return res;
};

export function setup() {
  const venue = http.post(`${BASE}/api/venues`, JSON.stringify({ name: 'Bar de la demo', kind: 'restaurant', ambience: 'lounge con jazz' }), owner()).json();
  const base = `${BASE}/api/venues/${venue.id}/player`;
  http.get(base, owner());
  http.post(`${base}/claim`, JSON.stringify({ consoleId: 'consola-demo-01' }), owner());
  http.post(`${base}/play`, JSON.stringify({ consoleId: 'consola-demo-01' }), owner());
  // Para que load/sse-clients.mjs abra el SSE del mismo local (k6 no escribe archivos: se publica por consola).
  console.log(`VENUE ${JSON.stringify({ code: venue.public_code, id: venue.id })}`);
  return { code: venue.public_code, id: venue.id };
}

// Una persona: abre la página, busca, pide, sigue su petición y mira la emisora durante un minuto.
export function publico({ code }) {
  const clientId = `${String(__VU).padStart(8, '0')}-k6`;
  const params = { headers: CLIENT_IDS ? { 'x-client-id': clientId } : {}, tags: { escenario: 'publico' } };
  const get = (path, name) => count(http.get(`${BASE}/api/public${path}`, { ...params, tags: { ...params.tags, name } }));
  check(get(`/venues/${code}`, 'local'), { 'local 200': (r) => r.status === 200 });
  check(get(`/venues/${code}/now`, 'now'), { 'now 200': (r) => r.status === 200 });
  sleep(2 + Math.random() * 3);
  const term = TERMS[Math.floor(Math.random() * TERMS.length)];
  get(`/venues/${code}/search?q=${encodeURIComponent(term.slice(0, 4))}`, 'buscar');
  sleep(0.5);
  const found = get(`/venues/${code}/search?q=${encodeURIComponent(term)}`, 'buscar');
  check(found, { 'buscar 200': (r) => r.status === 200 });
  sleep(2 + Math.random() * 3);

  const full = found.status === 200 ? (found.json() || []).find((t) => t.kind === 'full') : null;
  const song = full && Math.random() < 0.5 ? { provider: 'jamendo', externalId: full.externalId } : { trackId: ITUNES_IDS[__VU % 3] };
  const sent = count(
    http.post(`${BASE}/api/public/venues/${code}/requests`, JSON.stringify({ guestName: `Persona ${__VU}`, ...song }), {
      ...json(params),
      headers: { ...params.headers, 'content-type': 'application/json' },
      tags: { ...params.tags, name: 'pedir' },
    }),
  );
  check(sent, { 'pedir 202': (r) => r.status === 202 });
  if (sent.status === 202) {
    const id = sent.json('id');
    // El navegador abre el SSE de su petición; termina al llegar el resultado.
    const sse = http.get(`${BASE}/api/public/requests/${id}/events${CLIENT_IDS ? `?client=${clientId}` : ''}`, {
      timeout: '20s',
      tags: { ...params.tags, name: 'sse_peticion' },
    });
    count(sse);
    check(sse, { 'resultado por SSE': (r) => r.status === 200 && r.body.includes('"stage":"result"') });
    get(`/venues/${code}/requests?ids=${id}`, 'mis_peticiones');
  }
  // Sin SSE del local en este cliente: consulta /now cada 10 s durante el resto del minuto.
  for (let i = 0; i < 4; i += 1) {
    sleep(10);
    get(`/venues/${code}/now`, 'now');
  }
}

// La consola del DJ: refresca el estado y las peticiones, y avanza de pista cada ~30 s (pistas cortas para generar avisos).
export function dj({ id }) {
  const base = `${BASE}/api/venues/${id}/player`;
  const tags = { escenario: 'dj' };
  for (let i = 0; i < 4; i += 1) {
    const state = count(http.get(base, owner({ tags: { ...tags, name: 'dj_estado' } })));
    check(state, { 'dj estado 200': (r) => r.status === 200 });
    count(http.get(`${base}/requests`, owner({ tags: { ...tags, name: 'dj_peticiones' } })));
    sleep(7.5);
  }
  const current = http.get(base, owner({ tags })).json('current.track.id');
  const advanced = count(
    http.post(`${base}/advance`, JSON.stringify({ consoleId: 'consola-demo-01', fromTrackId: current ?? null }), owner({ tags: { ...tags, name: 'dj_avanzar' } })),
  );
  check(advanced, { 'dj avanzar 200': (r) => r.status === 200 });
}
