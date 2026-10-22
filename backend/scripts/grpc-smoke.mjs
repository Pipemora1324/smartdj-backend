// Prueba manual del servidor gRPC del motor: llama a CheckCompatibility (unario) y StreamEvaluation (streaming).
// Uso (desde backend/): node scripts/grpc-smoke.mjs [host:puerto]   (por defecto localhost:50051)
// Solo para entornos locales: usa credenciales sin TLS y no lee .env.
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';

const target = process.argv[2] || 'localhost:50051';
const PROTO_PATH = fileURLToPath(new URL('../proto/compatibility.proto', import.meta.url));
const { CompatibilityService } = grpc.loadPackageDefinition(
  protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: Number, enums: String, defaults: true }),
).smartdj.compatibility.v1;
const client = new CompatibilityService(target, grpc.credentials.createInsecure());
const deadline = () => new Date(Date.now() + 10000);

const cases = [
  {
    name: 'compatible',
    request: {
      venue_type: 'salsa_bar',
      current_genre: 'Salsa',
      requested_genre: 'Bachata',
      current_bpm: 96,
      requested_bpm: 100,
      current_key: 'Am',
      requested_key: 'C',
    },
  },
  {
    name: 'requiere puente',
    request: {
      venue_type: 'nightclub',
      current_genre: 'House',
      requested_genre: 'Jazz',
      current_bpm: 128,
      requested_bpm: 80,
      current_key: 'F#',
      requested_key: 'C',
    },
  },
];

const unary = (request) =>
  new Promise((resolve, reject) => client.CheckCompatibility(request, { deadline: deadline() }, (e, r) => (e ? reject(e) : resolve(r))));
const stream = (requestId, request) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const call = client.StreamEvaluation({ request_id: requestId, compatibility: request }, { deadline: deadline() });
    call.on('data', (event) =>
      console.log(`  +${String(Date.now() - started).padStart(4)} ms  ${event.stage.padEnd(16)} ${event.message}`),
    );
    call.on('error', reject);
    call.on('end', resolve);
  });

try {
  console.log(`Servidor gRPC: ${target}\n`);
  for (const { name, request } of cases) {
    const result = await unary(request);
    console.log(`[unario] ${name}: accepted=${result.accepted} score=${result.score} puente=${result.bridge_sequence.length} temas`);
    console.log(`[stream] ${name}:`);
    await stream(`smoke-${name.replace(/\s/g, '-')}`, request);
    console.log('');
  }
  try {
    await unary({ ...cases[0].request, requested_bpm: -5 });
    console.log('[error] se esperaba INVALID_ARGUMENT y no llegó');
    process.exitCode = 1;
  } catch (err) {
    console.log(`[error esperado] ${grpc.status[err.code]}: ${err.details}`);
  }
} catch (err) {
  console.error(`Falló la prueba: ${grpc.status[err.code] ?? ''} ${err.details ?? err.message}`);
  process.exitCode = 1;
} finally {
  client.close();
}
