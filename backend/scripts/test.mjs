// npm test: pruebas unitarias y, después, las de integración contra Postgres y Redis efímeros en Docker.
// - Si TEST_DATABASE_URL y TEST_REDIS_URL ya están definidas, se usan esas (sin tocar Docker).
// - SKIP_INTEGRATION=1 corre solo las unitarias (por ejemplo, en una máquina sin Docker).
// Nunca usa .env, la base de producción ni el Supabase real.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const compose = fileURLToPath(new URL('../test/integration/docker-compose.yml', import.meta.url));
const run = (cmd, args, env = process.env) => spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env, shell: false }).status ?? 1;

const unit = run(process.execPath, ['--test', 'test/*.test.js']);
if (unit !== 0) process.exit(unit);
if (process.env.SKIP_INTEGRATION === '1') {
  console.log('\nPruebas de integración omitidas (SKIP_INTEGRATION=1).');
  process.exit(0);
}

const integration = (env) =>
  run(process.execPath, ['--test', '--test-concurrency=1', '--test-force-exit', 'test/integration/*.int.js'], { ...process.env, ...env });

if (process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL) process.exit(integration({}));

if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
  console.error(
    '\nDocker no está disponible: las pruebas de integración lo necesitan. Usa SKIP_INTEGRATION=1 para correr solo las unitarias.',
  );
  process.exit(1);
}
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
process.exit(status);
