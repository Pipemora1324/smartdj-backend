#!/usr/bin/env bash
# NUNCA EJECUTAR CONTRA PRODUCCIÓN: todo corre en Docker local (ver load/docker-compose.yml y CARGA.md).
# Uso: load/run.sh <etiqueta>        Variables: LOAD_CPUS (1 por defecto; 0.1 = Render gratis), CLIENT_ID=1
# Deja en load/results/<etiqueta>/: resumen de k6, SSE, llamadas a las APIs simuladas y muestras de recursos.
set -u
cd "$(dirname "$0")" || exit 1
LABEL=${1:-prueba}
RES="results/$LABEL"
mkdir -p out "$RES"
rm -f out/*.json
# En Git Bash (Windows), que no convierta las rutas de los contenedores en rutas de Windows.
export MSYS_NO_PATHCONV=1
export LOAD_CPUS=${LOAD_CPUS:-1} CLIENT_ID=${CLIENT_ID:-0}
compose() { docker compose --progress quiet "$@"; }

compose down -v --remove-orphans >/dev/null 2>&1
compose up -d --build --wait postgres redis || exit 1
compose up -d --build fakes api || exit 1
for _ in $(seq 1 60); do curl -sf localhost:3500/api/health >/dev/null && [ -f out/tokens.json ] && break; sleep 1; done
curl -sf localhost:3500/api/health >/dev/null || { echo "La API no arrancó"; compose logs api | tail -20; exit 1; }
echo "API lista (CPU=$LOAD_CPUS, CLIENT_ID=$CLIENT_ID)"

compose run --rm -T k6 run --quiet --summary-export /out/summary.json /scripts/demo.js > "$RES/k6.log" 2>&1 &
K6=$!
for _ in $(seq 1 60); do grep -q 'VENUE {' "$RES/k6.log" 2>/dev/null && break; sleep 1; done
grep -o 'VENUE {[^}]*}' "$RES/k6.log" | head -1 | sed 's/^VENUE //; s/\\"/"/g' > out/venue.json
compose run --rm -T sse > "$RES/sse.log" 2>&1 &
SSE=$!

echo "t;mem;cpu;redis_clients;pg_connections" > "$RES/recursos.csv"
START=$(date +%s)
while kill -0 $K6 2>/dev/null; do
  STATS=$(docker stats --no-stream --format '{{.MemUsage}};{{.CPUPerc}}' smartdj-load-api-1 2>/dev/null)
  REDIS=$(docker exec smartdj-load-redis-1 redis-cli info clients 2>/dev/null | grep connected_clients | cut -d: -f2 | tr -d '\r')
  PG=$(docker exec smartdj-load-postgres-1 psql -U smartdj -d smartdj -tAc "select count(*) from pg_stat_activity where datname='smartdj'" 2>/dev/null)
  echo "$(( $(date +%s) - START ));$STATS;$REDIS;$PG" >> "$RES/recursos.csv"
  sleep 3
done
wait $SSE
# Comandos de Redis de toda la corrida (Upstash gratis: 500K al mes).
docker exec smartdj-load-redis-1 redis-cli info stats | grep total_commands_processed | cut -d: -f2 | tr -dc '0-9' > out/redis-commands.txt
docker exec smartdj-load-redis-1 redis-cli info commandstats > out/redis-commandstats.txt
cp out/summary.json out/sse.json out/fake-calls.json out/redis-commands.txt out/redis-commandstats.txt "$RES/" 2>/dev/null
compose logs api > "$RES/api.log" 2>&1
[ "${KEEP:-0}" = 1 ] || compose down -v --remove-orphans >/dev/null 2>&1
node summarize.mjs "$LABEL" && cat "$RES/resumen.json"
