#!/usr/bin/env bash
# Arranque del contenedor combinado: primero el motor de IA (Python), luego el backend (Node).
# Si cualquiera de los dos procesos termina, se detiene el otro y el contenedor sale con error,
# para que Render lo reinicie en lugar de quedar a medias.
set -uo pipefail

GRPC_PORT="${AI_GRPC_PORT:-50051}"
GRPC_WAIT_SECONDS="${AI_GRPC_WAIT_SECONDS:-90}"
AI_PID=""
NODE_PID=""

stop_all() {
  [ -n "$NODE_PID" ] && kill -TERM "$NODE_PID" 2>/dev/null
  [ -n "$AI_PID" ] && kill -TERM "$AI_PID" 2>/dev/null
  # Espera hasta 10 s a que terminen solos; después los fuerza (Node no sale con SIGTERM mientras BullMQ mantiene Redis abierto).
  for ((j = 0; j < 10; j++)); do
    kill -0 "$NODE_PID" 2>/dev/null || kill -0 "$AI_PID" 2>/dev/null || break
    sleep 1
  done
  [ -n "$NODE_PID" ] && kill -KILL "$NODE_PID" 2>/dev/null
  [ -n "$AI_PID" ] && kill -KILL "$AI_PID" 2>/dev/null
  wait 2>/dev/null
}
# Render envía SIGTERM al apagar: se reenvía a ambos procesos.
trap 'echo "[combined] Señal recibida, deteniendo servicios"; stop_all; exit 0' TERM INT

echo "[combined] Iniciando el motor de IA (gRPC ${GRPC_PORT}, HTTP ${AI_HTTP_PORT:-8000})"
(cd /app/ai && exec python -m app.serve) &
AI_PID=$!

# Espera a que el puerto gRPC acepte conexiones (o a que el motor muera).
for ((i = 0; i < GRPC_WAIT_SECONDS; i++)); do
  if ! kill -0 "$AI_PID" 2>/dev/null; then
    echo "[combined] El motor de IA terminó antes de estar listo" >&2
    exit 1
  fi
  if (exec 3<>"/dev/tcp/127.0.0.1/${GRPC_PORT}") 2>/dev/null; then
    echo "[combined] gRPC listo en 127.0.0.1:${GRPC_PORT} tras ${i}s"
    break
  fi
  sleep 1
done
if ! (exec 3<>"/dev/tcp/127.0.0.1/${GRPC_PORT}") 2>/dev/null; then
  echo "[combined] gRPC no respondió en ${GRPC_WAIT_SECONDS}s" >&2
  stop_all
  exit 1
fi

echo "[combined] Iniciando el backend (puerto ${PORT:-3000})"
(cd /app/backend && exec node src/server.js) &
NODE_PID=$!

# El primero que termine (por error o no) detiene todo y el contenedor sale con error.
wait -n "$AI_PID" "$NODE_PID"
STATUS=$?
if ! kill -0 "$AI_PID" 2>/dev/null; then WHO="motor de IA"; else WHO="backend"; fi
echo "[combined] El ${WHO} terminó (código ${STATUS}); deteniendo el contenedor" >&2
stop_all
exit $(( STATUS == 0 ? 1 : STATUS ))
