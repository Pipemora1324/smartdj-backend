// npm test: todas las pruebas del repositorio, en orden:
// 1) unitarias del backend (Node, sin red ni servicios);
// 2) del motor de IA (Python) dentro de su imagen de Docker, la misma que se despliega;
// 3) de integración contra Postgres y Redis efímeros en Docker, con dobles locales de Supabase, Jamendo, iTunes y el motor.
// - Si TEST_DATABASE_URL y TEST_REDIS_URL ya están definidas, la integración usa esas (sin levantar contenedores).
// - SKIP_ENGINE=1 o SKIP_INTEGRATION=1 omiten esos pasos (por ejemplo, en una máquina sin Docker).
// Nunca usa .env, la base de producción ni el Supabase real.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const aiDir = fileURLToPath(new URL('../../ai', import.meta.url));
const compose = fileURLToPath(new URL('../test/integration/docker-compose.yml', import.meta.url));
const run = (cmd, args, env = process.env) => spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env, shell: false }).status ?? 1;
const step = (title) => console.log(`\n== ${title}`);
const finish = (status) => process.exit(status);

step('Pruebas unitarias del backend');
const unit = run(process.execPath, ['--test', 'test/*.test.js']);
if (unit !== 0) finish(unit);

const needsDocker = process.env.SKIP_ENGINE !== '1' || (process.env.SKIP_INTEGRATION !== '1' && !process.env.TEST_DATABASE_URL);
if (needsDocker && spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
  console.error('\nDocker no está disponible. Lo necesitan las pruebas del motor y las de integración.');
  console.error('Usa SKIP_ENGINE=1 SKIP_INTEGRATION=1 para correr solo las unitarias.');
  finish(1);
}

if (process.env.SKIP_ENGINE === '1') console.log('\nPruebas del motor omitidas (SKIP_ENGINE=1).');
else {
  step('Pruebas del motor de IA (Python, en Docker)');
  const image = 'smartdj-ai-test';
  let status = run('docker', ['build', '-q', '-t', image, aiDir]);
  if (status === 0)
    status = run('docker', [
      'run',
      '--rm',
      '-v',
      `${aiDir}/tests:/app/tests:ro`,
      image,
      'python',
      '-m',
      'unittest',
      'discover',
      '-s',
      'tests',
    ]);
  if (status !== 0) finish(status);
}

if (process.env.SKIP_INTEGRATION === '1') {
  console.log('\nPruebas de integración omitidas (SKIP_INTEGRATION=1).');
  finish(0);
}
step('Pruebas de integración (Postgres y Redis en Docker)');
const integration = (env) =>
  run(process.execPath, ['--test', '--test-concurrency=1', '--test-force-exit', 'test/integration/*.int.js'], {
    LOG_LEVEL: 'silent',
    ...process.env,
    ...env,
  });
if (process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL) finish(integration({}));

const dockerCompose = (...args) => run('docker', ['compose', '--progress', 'quiet', '-f', compose, ...args]);
let status = 1;
try {
  status = dockerCompose('up', '-d', '--wait', '--quiet-pull');
  if (status === 0)
    status = integration({
      TEST_DATABASE_URL: 'postgresql://smartdj:test_only_password@127.0.0.1:55432/smartdj',
      TEST_REDIS_URL: 'redis://127.0.0.1:56379',
    });
} finally {
  dockerCompose('down', '-v', '--remove-orphans');
}
finish(status);
