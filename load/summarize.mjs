// Resume una corrida de load/run.sh: RPS, latencias, errores, 429, SSE, recursos y llamadas a las APIs simuladas.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const read = (name) => {
  try {
    return JSON.parse(readFileSync(join(dir, name), 'utf8'));
  } catch {
    return null;
  }
};
const k6 = read('summary.json');
const sse = read('sse.json');
const calls = read('fake-calls.json');
const m = k6?.metrics ?? {};
const ms = (v) => (v === undefined ? '-' : `${Math.round(v)} ms`);
const dur = m['http_req_duration{escenario:publico}'] ?? m.http_req_duration ?? {};
const rows = readFileSync(join(dir, 'recursos.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(';'));
const mib = (text) => {
  const [value, unit] = (text || '').split('/')[0].trim().match(/([\d.]+)\s*(\w+)/)?.slice(1) ?? [];
  return value ? Number(value) * (unit.startsWith('G') ? 1024 : unit.startsWith('K') ? 1 / 1024 : 1) : 0;
};
const max = (values) => Math.max(0, ...values.filter(Number.isFinite));
const summary = {
  peticiones: m.http_reqs?.count,
  rps: Math.round((m.http_reqs?.rate ?? 0) * 10) / 10,
  p50: ms(dur.med),
  p95: ms(dur['p(95)']),
  p99: ms(dur['p(99)']),
  max: ms(dur.max),
  fallidas: `${Math.round((m.http_req_failed?.value ?? 0) * 1000) / 10} %`,
  respuestas_429: m.respuestas_429?.count ?? 0,
  respuestas_5xx: m.respuestas_5xx?.count ?? 0,
  checks_ok: `${Math.round((m.checks?.value ?? 0) * 1000) / 10} %`,
  memoria_max: `${Math.round(max(rows.map((r) => mib(r[1]))))} MiB`,
  cpu_max: `${max(rows.map((r) => parseFloat(r[2])))} %`,
  redis_clientes_max: max(rows.map((r) => Number(r[3]))),
  pg_conexiones_max: max(rows.map((r) => Number(r[4]))),
  por_endpoint: Object.fromEntries(
    Object.entries(m)
      .filter(([k]) => k.startsWith('http_req_duration{name:'))
      .map(([k, v]) => [k.slice('http_req_duration{name:'.length, -1), `p50 ${ms(v.med)} · p95 ${ms(v['p(95)'])} · max ${ms(v.max)}`]),
  ),
  checks_publico: m['checks{scenario:publico}'] ? `${Math.round(m['checks{scenario:publico}'].value * 1000) / 10} %` : '-',
  checks_dj: m['checks{scenario:dj}'] ? `${Math.round(m['checks{scenario:dj}'].value * 1000) / 10} %` : '-',
  sse,
  llamadas_externas: calls,
  redis_comandos: (() => {
    try {
      return Number(readFileSync(join(dir, 'redis-commands.txt'), 'utf8').trim());
    } catch {
      return null;
    }
  })(),
};
writeFileSync(join(dir, 'resumen.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
