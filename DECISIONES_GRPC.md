# Decisiones de la fase gRPC

Registro de las decisiones tomadas al pasar la comunicación backend ↔ motor de IA de HTTP/JSON a gRPC con streaming. Fecha: 2026-10-20.

> **Estado al cierre (2026-10-23):**
> - El contenedor único está en producción.
> - El backend usa `StreamEvaluation`, para las peticiones, y `SuggestNext`, para el AutoDJ. `CheckCompatibility` sigue en el contrato y en el motor, pero el backend ya no lo llama: la ruta `/analyze` se eliminó.
> - También se quitaron librosa y ffmpeg, y la imagen combinada bajó de 1,19 GB a ~510 MB.
> - Los SSE comparten una sola suscripción de Redis por proceso.
> - Los números de carga actuales están en [CARGA.md](CARGA.md).
> - Lo que sigue es el registro de la decisión, corregido donde dejó de ser cierto.

## Resumen

- El backend (Node) habla con el motor (Python) por **gRPC**: `StreamEvaluation` (server streaming) y `SuggestNext` (unario, AutoDJ). `CheckCompatibility` (unario) sigue en el contrato, sin uso en el backend.
- El navegador **sigue usando REST**: recibe el estado en vivo de su petición por **SSE** (`EventSource`) o, si falla, por **polling**.
- Todo está implementado y probado **en local con Docker Compose**.
- En el plan gratis, Render no puede llevar gRPC entre **dos** servicios (ver [Render](#render-se-puede-usar-grpc-en-el-plan-gratis)).
- **La solución gratis vigente es un [contenedor único](#contenedor-único-en-render-gratis-decisión-vigente):** motor y backend en el mismo servicio, comunicados por gRPC en `127.0.0.1:50051`.
- Sin `AI_GRPC_URL`, el backend sigue usando el HTTP de siempre.

## Contenedor único en Render gratis (decisión vigente)

**Por qué:** Render gratis no deja que un servicio reciba tráfico privado, pero dentro de un mismo contenedor los procesos sí se pueden hablar por `localhost`. Así hay gRPC real (HTTP/2 y server streaming) sin pagar y sin exponer el motor a internet.

### Arquitectura

```
┌──────────────────── Servicio web smart-dj-platform (Render, Free, 512 MB) ────────────────────┐
│  start-combined.sh (PID 1)                                                                    │
│   ├─ python -m app.serve   motor de IA:  gRPC 127.0.0.1:50051  +  HTTP 127.0.0.1:8000         │
│   │                          ▲ StreamEvaluation / SuggestNext (gRPC, sin TLS)                 │
│   └─ node src/server.js    backend:      $PORT (público, lo usa el navegador por REST y SSE)  │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
          │ Postgres (Supabase) · Redis (Upstash): igual que hoy, por las variables del servicio
```

- **Archivos:** `Dockerfile.combined` y `start-combined.sh` en la raíz del repo, más un `.dockerignore` que deja fuera `.env` y `node_modules`. `backend/Dockerfile` y `ai/Dockerfile` **no cambian**: el despliegue actual con Root Directory `backend/` sigue funcionando igual.
- **Imagen:** dos etapas. Se usa `python:3.12-slim-bookworm` con el binario de Node 22 copiado desde `node:22-bookworm-slim`; los dos parten de Debian bookworm, así que cualquier módulo nativo de npm sería compatible (hoy no hay ninguno: argon2 se quitó con la auth propia). Las dependencias de npm se instalan en una etapa aparte.
- **Variables que trae la imagen:**

  | Variable | Valor |
  | --- | --- |
  | `AI_GRPC_PORT` | 50051 |
  | `AI_HTTP_PORT` | 8000 |
  | `AI_BIND_HOST` | 127.0.0.1 |
  | `AI_GRPC_URL` | 127.0.0.1:50051 |
  | `AI_GRPC_TLS` | false |
  | `AI_SERVICE_URL` | http://127.0.0.1:8000 |

  Las de Render tienen prioridad.
- **Arranque (`start-combined.sh`):**
  1. Lanza el motor y espera hasta 90 s (`AI_GRPC_WAIT_SECONDS`) a que el puerto gRPC acepte conexiones. Si el motor muere antes, el contenedor sale con error.
  2. Lanza el backend.
  3. Si **cualquiera** de los dos termina, detiene al otro y el contenedor sale con error, para que Render lo reinicie.
  4. Con SIGTERM (cuando Render apaga el servicio), detiene los dos. Espera 10 s y luego fuerza el cierre, porque Node no sale solo mientras BullMQ mantiene Redis abierto.
- **Puertos:** el motor escucha **solo en 127.0.0.1** (`AI_BIND_HOST`), así que desde fuera del contenedor solo se ve `$PORT`. Probado: desde otro contenedor, 8000 y 50051 no son visibles. Así Render no puede confundir el puerto público.

### Medición de memoria (local, `docker stats`, con `mem_limit: 512m` y `PORT=10000`)

| Situación | Memoria |
| --- | --- |
| En reposo (motor + backend) | **96–97 MiB** (≈19 %) |
| 20 peticiones simultáneas con su SSE abierto (pico de 40 muestras) | **102,7 MiB** (≈20 %) |
| Después de la carga | 102–104 MiB |
| Reinicios por falta de memoria (OOM) | ninguno |
| Por proceso (RSS, incluye páginas compartidas) | Python ≈ 88 MB, Node ≈ 97 MB, bash ≈ 3 MB |
| `/analyze` (librosa), medido aparte en su momento | +400 MB. **Ya no existe**: se eliminó en el cierre |

- **Recortes aplicados:**
  - `/analyze`, librosa y ffmpeg se eliminaron en el cierre: nadie los usaba y no cabían en 512 MB.
  - Imágenes slim y solo el binario de Node, sin npm en la imagen final.
- Tamaño de la imagen: ~510 MB (antes 1,19 GB por librosa/scipy). La prueba de carga con 150 personas llegó a 113 MiB ([CARGA.md](CARGA.md)).

### Pruebas del contenedor combinado (todas en local)
- `GET /api/health` → `{"status":"ok"}` en el puerto 10000.
- `/health` del motor (interno) → `grpc: true`.
- `grpc-smoke.mjs` dentro del contenedor contra `127.0.0.1:50051`: unario, streaming e `INVALID_ARGUMENT`.
- SSE de punta a punta: llegaron las 5 etapas. Con carga, 20 de 20 peticiones con SSE recibieron `result` y todas quedaron evaluadas en Postgres. La conexión 21 en el mismo minuto recibe 429 (rate limit).
- Fallos:
  - Matar Python → contenedor `exited 137`.
  - Matar Node → `exited 137`.
  - SIGTERM → `exited 0` en 12 s.

### Cómo activarlo en Render (servicio `smart-dj-platform`)
1. **Settings → Build & Deploy:**
   - **Root Directory:** vacío (la raíz del repo; hoy es `backend`).
   - **Dockerfile Path:** `./Dockerfile.combined`.
   - **Docker Build Context Directory:** `.` (la raíz).
2. **Environment:** agrega `AI_GRPC_URL=127.0.0.1:50051` y `AI_GRPC_TLS=false`. La imagen ya los trae por defecto, pero así quedan explícitos en el panel.
   - Las variables actuales (`DATABASE_URL`, `REDIS_URL`, `SUPABASE_URL`, `SUPABASE_JWKS_URL`, `CORS_ORIGIN`, etc.) se quedan igual.
   - Si `AI_SERVICE_URL` apunta al `smart-dj-ai` separado, puedes dejarla: con `AI_GRPC_URL` definido no se usa.
3. **Save Changes** y **Manual Deploy → Deploy latest commit**.
4. En los logs deben aparecer, en orden:
   - `[combined] gRPC listo en 127.0.0.1:50051`
   - `[combined] Iniciando el backend`
   - `{"level":"info",...,"msg":"API escuchando","port":10000}` (los registros ahora son JSON)
5. Comprueba que `GET https://smart-dj-platform.onrender.com/api/health` responde `{"status":"ok"}`. Después envía una petición desde el link público de un local: el estado debe avanzar por etapas.
6. El servicio `smart-dj-ai` separado queda sin uso por el backend y se puede pausar después. No es necesario tocarlo.

### Cómo volver atrás
1. **Settings → Build & Deploy:**
   - **Root Directory:** `backend`.
   - **Dockerfile Path:** `./Dockerfile` (o vacío).
   - **Build Context:** `.` (relativo a `backend`).
2. **Environment:** borra `AI_GRPC_URL` (o déjala vacía) y `AI_GRPC_TLS`. Verifica que `AI_SERVICE_URL` apunte de nuevo al servicio `smart-dj-ai`.
3. **Manual Deploy.** El backend vuelve a llamar al motor por HTTP, exactamente como antes. No hace falta revertir ningún commit.

```
Navegador ──REST──▶ Backend (Express) ──BullMQ──▶ Worker
    ▲                     │                        │
    │  SSE / polling      │                        │ gRPC StreamEvaluation (HTTP/2)
    └──────── Redis (estado + pub/sub) ◀───────────┤
                                                   ▼
                                     Motor de IA (Python, grpcio)
```

## Decisiones

### 1. Un solo `.proto`, copiado en los dos lados
- Fuente: `ai/proto/compatibility.proto`. Copia idéntica: `backend/proto/compatibility.proto`.
- `npm test` (`backend/test/proto-sync.test.js`) falla si las dos copias difieren.
- Paquete versionado `smartdj.compatibility.v1`, para poder publicar una `v2` sin romper clientes.
- **Por qué copiar y no compartir:** cada carpeta se construye como imagen Docker por separado (`./ai` y `./backend`) y en Render cada servicio usa su propio directorio raíz, así que ninguno ve los archivos del otro.

### 2. Contrato cargado en tiempo de ejecución, sin código generado
- Python: `grpc.protos_and_services('compatibility.proto')` (requiere `grpcio-tools`).
- Node: `@grpc/proto-loader`.
- **Por qué:** no hay archivos `*_pb2.py` ni stubs que regenerar y mantener sincronizados. Si cambia el `.proto`, basta con reiniciar.

### 3. Etapas del stream
`QUEUED → ANALYZING_GENRE → ANALYZING_BPM → ANALYZING_KEY → RESULT`. Cada evento lleva un `message` en español y el `partial_score` de la etapa; solo `RESULT` trae el `CompatibilityResult` completo.
- El motor espera `AI_STREAM_STEP_DELAY_MS` (250 ms por defecto) entre etapas, para que el estado en vivo se pueda seguir en la interfaz. Con `0` responde de inmediato.
- Si el cliente cancela el stream (`context.is_active()`), el servidor deja de calcular.

### 4. Misma lógica para HTTP y gRPC
- La heurística se movió de `main.py` a `ai/app/engine.py` **sin cambiar el resultado**. Se verificó comparando el `main.py` original con `engine.evaluate` en 1.016.064 combinaciones: todas idénticas.
- `POST /compatibility` (HTTP) se mantiene como respaldo y `GET /health` sigue igual (ahora indica si gRPC está activo).
- Los bugs conocidos del motor (familias de género, mayor/menor) **no** se tocaron: son de la Fase 5.

### 5. gRPC solo se activa con variables de entorno
| Variable | Dónde | Efecto |
| --- | --- | --- |
| `AI_GRPC_PORT` | motor | Si existe, `app/serve.py` inicia el servidor gRPC en ese puerto, además de la API HTTP (8000). Si no existe, solo HTTP, **igual que antes**. |
| `AI_GRPC_URL` | backend | `host:puerto` del motor. Si está vacío, el backend usa HTTP (`AI_SERVICE_URL`). |
| `AI_GRPC_TLS` | backend | `true` para un motor público con TLS (por ejemplo, Cloud Run en el puerto 443). |
| `AI_GRPC_TIMEOUT_MS` | backend | Deadline de cada llamada (10 s por defecto). |
| `AI_GRPC_CONNECT_TIMEOUT_MS` | backend | Máximo para conectar antes de responder `UNAVAILABLE` (3 s por defecto). |

**Por qué:** si el contenedor del motor abriera un segundo puerto en Render, Render podría elegir el puerto equivocado para el tráfico público. Además, nada de esto se puede usar hoy en Render gratis. Con variables, el mismo código sirve en local (gRPC) y en el Render actual (HTTP).

### 6. Timeouts y errores
- Toda llamada lleva **deadline** (`AI_GRPC_TIMEOUT_MS`).
- Antes de cada llamada, el cliente espera la conexión como máximo `AI_GRPC_CONNECT_TIMEOUT_MS`. Sin esto, con el motor caído cada intento esperaba el deadline completo: unos 50 s hasta avisar al usuario. Ahora son unos 15 s.
- Errores gRPC traducidos a `AppError` con mensaje en español:

  | Código gRPC | HTTP |
  | --- | --- |
  | `DEADLINE_EXCEEDED` | 504 |
  | `UNAVAILABLE` | 503 |
  | `INVALID_ARGUMENT` | 400 |
  | `CANCELLED` | 499 |
  | Otros | 502 |

  Además, un stream que termina sin `RESULT` también responde 502.
- La cola BullMQ reintenta **3 veces** con espera exponencial (2 s, 4 s). Si se agotan, el navegador recibe el estado final `failed` y no se queda esperando.

### 7. Estado en vivo: Redis + SSE con respaldo de polling
- El worker publica cada etapa en Redis:
  - `request-status:<id>` guarda el último evento, con vencimiento de 1 h.
  - `request-events:<id>` es el canal pub/sub.
- `GET /api/public/requests/:id` sirve para el polling. Si el evento en vivo ya venció, el estado se deduce de la base de datos.
- `GET /api/public/requests/:id/events` es el SSE:
  - Primero se suscribe y después envía la foto actual, para no perder eventos entre ambas.
  - Se cierra solo al llegar `result` o `failed`.
  - Envía un latido cada 15 s y dura como máximo 2 min.
  - Lleva `X-Accel-Buffering: no` para que nginx no lo retenga.
- **Por qué SSE y no WebSockets:** el flujo es unidireccional (servidor → navegador), SSE es HTTP normal (pasa por CORS, nginx, Render y Vercel sin configuración extra) y `EventSource` reconecta solo.
- **Seguridad:** el id es un UUID que solo conoce quien hizo la petición. No se expone el nombre del invitado. Límites de 120 consultas/min de polling y 20 conexiones SSE/min **por cliente**, con un tope por IP (ver [CARGA.md](CARGA.md)).
- **Costo:** al principio cada SSE abría su propia conexión a Redis (`redis.duplicate()`). En el cierre se cambió a un único suscriptor compartido por proceso (`live-hub.js`, `PSUBSCRIBE request-events:*`), con una prueba de integración que lo verifica.

### 8. Otros cambios
- `POST /api/venues/:id/analyze` usó `CheckCompatibility` (y corrigió un bug de camelCase). La ruta se eliminó en el cierre porque el frontend ya no la usaba.
- `backend/Dockerfile` y `ai/Dockerfile` copian `proto/`. La imagen del motor arranca con `python -m app.serve`.

## Render: ¿se puede usar gRPC en el plan gratis?

**No.** Lo que dice la documentación oficial de Render:

1. **Tráfico público:** el balanceador termina TLS y reenvía la petición *"to your web service over HTTP"*, a un solo puerto HTTP por servicio. No se menciona gRPC ni HTTP/2 hacia el contenedor. En la guía de Temporal, Render dice textualmente: *"Render doesn't yet have native support for gRPC and mTLS over external connections."*
2. **Red privada:** entre servicios se puede usar *"any protocol"* en casi cualquier puerto, así que gRPC funcionaría. Pero *"Free web services can't receive private network traffic"*: un motor en plan gratis no puede recibir las llamadas del backend. Además, los Private Services no tienen instancia gratis.
3. El plan gratis tiene otras limitaciones: se apaga tras 15 min sin tráfico y tiene 750 h al mes por workspace.

Fuentes: [Private Network](https://render.com/docs/private-network) · [Web Services](https://render.com/docs/web-services) · [Deploy for Free](https://render.com/docs/free) · [Deploy Temporal](https://render.com/docs/deploy-temporal)

Por eso, en ese momento no se cambió el despliegue. Después se eligió el [contenedor único](#contenedor-único-en-render-gratis-decisión-vigente), que es lo que corre hoy.

## Cómo desplegar gRPC en la nube (recomendado)

La opción gratis vigente es el [contenedor único](#contenedor-único-en-render-gratis-decisión-vigente). Las siguientes son alternativas si se quieren servicios separados.

### Opción A: motor de IA como Private Service de pago en Render
Es gRPC real con streaming, por la red privada de Render, sin exponer el motor a internet ni agregar autenticación. El backend puede seguir en plan gratis, porque los servicios gratis sí pueden *enviar* tráfico privado.

1. En Render, crea un **Private Service** nuevo:
   - Mismo repositorio, directorio raíz `ai`, entorno Docker.
   - **Misma región** que el backend.
   - Plan de pago más pequeño (Starter).
2. Variables del private service: `AI_GRPC_PORT=50051`. Opcional: `AI_STREAM_STEP_DELAY_MS=250`.
3. Anota su **hostname interno**: aparece en el panel del servicio, en la sección Connect → Internal.
4. Variables del backend en Render:
   - `AI_GRPC_URL=<hostname-interno>:50051`
   - `AI_GRPC_TLS=false` (la red privada ya está aislada).
   - `AI_SERVICE_URL=http://<hostname-interno>:8000`, solo como respaldo.
5. Despliega el backend. En los logs del motor debe aparecer "Servidor gRPC escuchando en el puerto 50051".
6. Prueba: envía una petición de canción desde el link público; el estado debe avanzar por etapas.
7. Cuando funcione, borra el servicio web viejo del motor.

### Opción B (gratis): motor en Google Cloud Run con HTTP/2 de punta a punta
Cloud Run sí soporta gRPC con streaming del servidor si se activa HTTP/2 de punta a punta (h2c hacia el contenedor). Fuentes: [Using gRPC (Cloud Run)](https://docs.cloud.google.com/run/docs/triggering/grpc) · [Cloud Run now supports HTTP/gRPC server streaming](https://cloud.google.com/blog/products/serverless/cloud-run-now-supports-http-grpc-server-streaming)

1. Construye la imagen de `ai/` y despliégala en Cloud Run con:
   - `--use-http2`
   - `--port 8080`
   - `--set-env-vars AI_GRPC_PORT=8080`

   Con esto, el puerto público (443, con TLS de Google) llega al servidor gRPC.
2. En el backend de Render:
   - `AI_GRPC_URL=<servicio>-<hash>.<región>.run.app:443`
   - `AI_GRPC_TLS=true`
3. **Pendiente de seguridad:** así el motor queda público. Antes de usarlo en serio, hay que agregar autenticación: IAM de Cloud Run con un token de identidad, o una clave compartida en los metadatos gRPC validada por el servidor. Eso implica cambios en `ai-client.js` y en `grpc_server.py`.
4. En esta opción, la API HTTP del motor (`/compatibility`) no queda expuesta, porque Cloud Run publica un solo puerto.

### Opción C: mantener HTTP en producción
Fue el estado inicial, antes del contenedor único. Ya no aplica.

## Pruebas realizadas (todas en local, sin producción ni el Supabase real)
- **Python:** pruebas del servidor gRPC en `ai/tests` (unario igual a `engine`, orden de las etapas del stream, `INVALID_ARGUMENT`, `SuggestNext`). Hoy corren dentro de `npm test` del backend, en la imagen del motor.
- **Node:** pruebas del cliente (`backend/test/ai-client.test.js`): stream, stream sin `RESULT`, deadline, `INVALID_ARGUMENT`, `UNAVAILABLE`, `SuggestNext` y sincronía del proto. Las pruebas de integración usan un motor gRPC simulado.
- **Script manual:** `node backend/scripts/grpc-smoke.mjs localhost:50051`, que prueba el unario, el streaming y un error esperado.
- **Docker Compose de punta a punta:** `POST` de una petición pública → BullMQ → stream gRPC → Redis → SSE. Llegaron las 5 etapas en vivo, y el polling y la base de datos coinciden.
- **Motor apagado:** 3 reintentos y estado `failed` en el SSE a los ~15 s. Al volver el motor, el cliente se reconecta solo.
- **Respaldo HTTP:** con `AI_GRPC_URL` vacío, el motor recibe `POST /compatibility` y el navegador igual recibe el resultado.
- **Navegador (frontend):** las etapas avanzan en vivo con SSE. Con el SSE bloqueado a propósito, pasa a polling y llega al resultado.
