// Dobles locales de los servicios externos para las pruebas de integración: Supabase (JWKS y tokens),
// Jamendo, iTunes y el motor de IA por gRPC. Todo en 127.0.0.1 con puertos libres; nunca hay red externa.
import http from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

export const SUPABASE_URL = 'https://test-ref.supabase.co';
export const JAMENDO_CLIENT_ID = 'test-client';

const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};
const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// Supabase: JWKS con una clave EC generada en la prueba y tokens firmados con ella (ES256, como Supabase).
export const startSupabase = async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'ES256', use: 'sig' };
  const server = http.createServer((_req, res) => sendJson(res, 200, { keys: [jwk] }));
  const base = await listen(server);
  const token = ({ sub = randomUUID(), email = `${sub.slice(0, 8)}@prueba.test`, verified = true, expiresIn = '1h', ...extra } = {}) =>
    jwt.sign(
      {
        sub,
        email,
        role: 'authenticated',
        aud: 'authenticated',
        user_metadata: { email_verified: verified, name: 'Dueña de prueba' },
        ...extra,
      },
      privateKey,
      { algorithm: 'ES256', keyid: 'test-kid', issuer: `${SUPABASE_URL}/auth/v1`, expiresIn },
    );
  return { jwksUrl: `${base}/jwks.json`, token, close: () => server.close() };
};

// Catálogo de Jamendo: pistas de varios géneros y licencias; cuenta las llamadas y puede simular una caída.
const GENRES = ['lounge', 'jazz', 'acoustic', 'chillout', 'latin', 'salsa', 'house', 'electronic'];
const SPEEDS = ['low', 'medium', 'high', 'veryhigh'];
export const JAMENDO_TRACKS = Array.from({ length: 48 }, (_, i) => ({
  id: String(2000000 + i),
  name: `Pista ${i + 1} ${GENRES[i % GENRES.length]}`,
  duration: 180 + i,
  artist_name: `Artista ${(i % 9) + 1}`,
  album_name: 'Demo',
  image: `https://usercontent.jamendo.com/?type=album&id=${i + 1}&width=300`,
  audio: `https://prod-1.storage.jamendo.com/?trackid=${2000000 + i}&format=mp31`,
  license_ccurl: i % 2 ? 'http://creativecommons.org/licenses/by-nc-sa/3.0/' : 'http://creativecommons.org/licenses/by-sa/3.0/',
  waveform: JSON.stringify({ peaks: Array.from({ length: 40 }, (_v, k) => (k * 7 + i) % 100) }),
  musicinfo: { speed: SPEEDS[i % SPEEDS.length], tags: { genres: [GENRES[i % GENRES.length]] } },
}));
// Una canción conocida para probar que una petición de iTunes encuentra su versión libre.
Object.assign(JAMENDO_TRACKS[0], { name: 'Vivir Mi Vida', artist_name: 'Marc Anthony' });

export const startJamendo = async () => {
  // failing: todo responde 500; searchDown: solo fallan las búsquedas (la radio y la consulta por id siguen).
  const state = { calls: 0, failing: false, searchDown: false };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.calls += 1;
    if (state.failing) return sendJson(res, 500, { error: 'caído' });
    if (url.searchParams.get('client_id') !== JAMENDO_CLIENT_ID)
      return sendJson(res, 200, { headers: { status: 'failed', code: 5, error_message: 'client_id inválido' }, results: [] });
    const ok = (results) => sendJson(res, 200, { headers: { status: 'success', code: 0 }, results });
    if (url.pathname.startsWith('/v3.0/radios/stream')) return ok([{ id: 1, playingnow: { track_id: JAMENDO_TRACKS[5].id } }]);
    if (!url.pathname.startsWith('/v3.0/tracks')) return sendJson(res, 404, {});
    const id = url.searchParams.get('id');
    if (state.searchDown && !id) return sendJson(res, 500, { error: 'búsqueda caída' });
    const words = (url.searchParams.get('search') || '').toLowerCase().split(/\s+/).filter(Boolean);
    const tags = (url.searchParams.get('fuzzytags') || '').split(/[ +]/).filter(Boolean);
    let list = JAMENDO_TRACKS;
    if (id) list = list.filter((t) => t.id === id);
    if (words.length) list = list.filter((t) => words.some((w) => `${t.name} ${t.artist_name}`.toLowerCase().includes(w)));
    if (tags.length) list = list.filter((t) => tags.includes(t.musicinfo.tags.genres[0]));
    return ok(list.slice(0, Number(url.searchParams.get('limit') || 10)));
  });
  const base = await listen(server);
  return { apiUrl: `${base}/v3.0`, state, close: () => server.close() };
};

// iTunes Search API: /search y /lookup con canciones de ejemplo; cuenta las llamadas.
export const ITUNES_SONGS = [
  { trackId: 1440818839, trackName: 'Vivir Mi Vida', artistName: 'Marc Anthony', primaryGenreName: 'Salsa y Tropical' },
  { trackId: 1440818840, trackName: 'Valió la Pena', artistName: 'Marc Anthony', primaryGenreName: 'Salsa y Tropical' },
  { trackId: 1440818841, trackName: 'Thunderstruck', artistName: 'AC/DC', primaryGenreName: 'Metal' },
].map((s) => ({
  ...s,
  kind: 'song',
  artworkUrl100: `https://is1-ssl.mzstatic.com/image/${s.trackId}/100x100bb.jpg`,
  previewUrl: `https://audio-ssl.itunes.apple.com/preview/${s.trackId}.m4a`,
  trackViewUrl: `https://music.apple.com/co/song/${s.trackId}`,
  trackTimeMillis: 240000,
}));

export const startItunes = async () => {
  const state = { calls: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.calls += 1;
    if (url.pathname === '/lookup')
      return sendJson(res, 200, { results: ITUNES_SONGS.filter((s) => String(s.trackId) === url.searchParams.get('id')) });
    const term = (url.searchParams.get('term') || '').toLowerCase();
    return sendJson(res, 200, { results: ITUNES_SONGS.filter((s) => `${s.trackName} ${s.artistName}`.toLowerCase().includes(term)) });
  });
  const base = await listen(server);
  return { url: base, state, close: () => server.close() };
};

// Motor de IA por gRPC: acepta toda petición salvo Metal y sugiere la primera candidata. state.down simula una caída.
export const startEngine = async () => {
  const protoPath = fileURLToPath(new URL('../../proto/compatibility.proto', import.meta.url));
  const { CompatibilityService } = grpc.loadPackageDefinition(
    protoLoader.loadSync(protoPath, { keepCase: true, longs: Number, enums: String, defaults: true }),
  ).smartdj.compatibility.v1;
  const state = { down: false, suggestCalls: 0 };
  const unavailable = { code: grpc.status.UNAVAILABLE, details: 'motor caído (simulado)' };
  const resultFor = (req) => {
    const accepted = req.requested_genre !== 'Metal';
    return {
      accepted,
      score: accepted ? 85 : 30,
      reason: accepted ? 'Encaja con el ambiente.' : 'No encaja con el ambiente.',
      bridge_sequence: accepted ? [] : [{ position: 1, genre: 'rock', target_bpm: 110, purpose: 'Puente' }],
      profile: 'test',
    };
  };
  const server = new grpc.Server();
  server.addService(CompatibilityService.service, {
    CheckCompatibility: (call, cb) => (state.down ? cb(unavailable) : cb(null, resultFor(call.request))),
    StreamEvaluation(call) {
      if (state.down) return call.destroy(unavailable);
      const result = resultFor(call.request.compatibility);
      call.write({ request_id: call.request.request_id, stage: 'ANALYZING_GENRE', message: 'Analizando género' });
      call.write({ request_id: call.request.request_id, stage: 'RESULT', message: result.reason, result });
      call.end();
    },
    SuggestNext(call, cb) {
      state.suggestCalls += 1;
      if (state.down) return cb(unavailable);
      const [first] = call.request.candidates;
      cb(null, {
        track_id: first.id,
        score: 90,
        reason: 'Sugerida por el motor de prueba.',
        transition_at_seconds: 170,
        crossfade_seconds: 8,
      });
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))),
  );
  return { url: `127.0.0.1:${port}`, state, close: () => server.forceShutdown() };
};
