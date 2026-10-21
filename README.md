# SmartDJ Backend

API de SmartDJ: gateway Nginx, API Express, motor FastAPI/librosa, PostgreSQL y Redis/BullMQ.

## Ejecutar en local

Requiere Docker con Docker Compose.

1. Copia `.env.example` como `.env` y cambia todos los valores `CAMBIAR_ESTO` (ver [Variables](#variables)). El servidor no arranca si falta `SUPABASE_URL` o `SUPABASE_JWKS_URL`.
2. Ejecuta:

   ```bash
   docker compose up --build
   ```

3. Comprueba que responde: `http://localhost:3000/api/health`.

## Variables

| Variable | Uso |
| --- | --- |
| `SUPABASE_URL` | URL del proyecto, `https://<ref>.supabase.co`. Obligatoria: con ella se valida el emisor de los tokens. |
| `SUPABASE_JWKS_URL` | `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`. Claves públicas para validar los tokens (RS256/ES256). No es un secreto. |
| `SUPABASE_JWT_SECRET` | **Solo** si el proyecto sigue con el secreto HS256 heredado. Es un secreto: va únicamente en Render. No está en `.env.example` a propósito, para que nadie copie un valor de ejemplo como secreto real. |

Hace falta `SUPABASE_JWKS_URL` o `SUPABASE_JWT_SECRET`; lo recomendado es usar claves asimétricas y solo el JWKS.

Las variables `SMTP_*` y `MAIL_FROM` ya no se usan: los correos los envía Supabase.

## Migraciones

Los cambios de esquema están en `database/migrations/` y se pueden ejecutar más de una vez sin romper datos.

- **Docker local:** se aplican solos al crear el volumen de Postgres por primera vez. Si ya tenías el volumen, ejecútalos a mano:

  ```bash
  docker compose exec -T postgres psql -U smartdj -d smartdj < database/migrations/001_verificacion_por_codigo.sql
  docker compose exec -T postgres psql -U smartdj -d smartdj < database/migrations/002_supabase_auth.sql
  ```

- **Supabase:** copia el contenido de cada archivo, en orden, en el SQL Editor y ejecútalo.

## Autenticación

El registro, la verificación del correo, el inicio de sesión y la recuperación de contraseña los hace **Supabase Auth** desde el frontend. Supabase envía los códigos de 6 dígitos con el SMTP de Gmail configurado en su panel. La configuración completa está en [SUPABASE_AUTH.md](SUPABASE_AUTH.md).

- La API recibe el access token de Supabase como `Authorization: Bearer <token>` y lo valida con el JWKS: firma, emisor, audiencia `authenticated` y vencimiento.
- `GET /api/auth/me`: devuelve el perfil. La primera vez crea la fila en `users`, vinculada por `auth_id`, si el correo está confirmado.
- Las rutas de la auth propia anterior (`/register`, `/login`, `/verify-email`, `/forgot-password`, etc.) responden **410**.

## Puertos

| Puerto | Servicio |
| --- | --- |
| 3000 | API directa (la que usa el frontend en local) |
| 8080 | Gateway Nginx (`/api/`, con límite de 5 intentos de login por minuto por IP) |
| 50051 | Servidor gRPC del motor de IA (publicado en local para el script de prueba) |

## Servicios

| Servicio | Responsabilidad |
| --- | --- |
| gateway | Reverse proxy de `/api/` y límite de intentos de login |
| backend | REST, validación de tokens de Supabase, cola BullMQ, cliente gRPC del motor y estado en vivo (SSE) |
| ai | Compatibilidad musical por heurísticas (gRPC y HTTP) y análisis de BPM/tonalidad con librosa |
| postgres / redis | Datos relacionales, caché, pub/sub y BullMQ |

## gRPC entre el backend y el motor de IA

El backend llama al motor por **gRPC** (HTTP/2, Protocol Buffers). El navegador sigue usando **REST** y recibe el progreso de su petición por **SSE**, o por polling si SSE falla.

```
 Navegador                Backend (Node)                         Motor de IA (Python)
 ─────────                ──────────────                         ────────────────────
 POST /api/public/...  ─▶ guarda la petición
                          y la encola (BullMQ)
                          Worker ── StreamEvaluation (gRPC) ───▶ QUEUED
                                 ◀─ evento por etapa ─────────── ANALYZING_GENRE
                          publica cada etapa en Redis            ANALYZING_BPM
 GET .../events (SSE)  ◀─ reenvía cada etapa                     ANALYZING_KEY
 (o GET .../:id polling)  guarda el resultado en Postgres ◀───── RESULT
```

- **Contrato:** `ai/proto/compatibility.proto`, con una copia idéntica en `backend/proto/` (lo verifica `npm test`). Tiene dos RPC:
  - `CheckCompatibility` (unario): lo usa `POST /api/venues/:id/analyze`.
  - `StreamEvaluation` (server streaming): lo usa la cola de peticiones.
- **Estado en vivo para el navegador:**
  - `GET /api/public/requests/:id` (polling).
  - `GET /api/public/requests/:id/events` (SSE, eventos `status`).
- **Activación:**
  - En el motor, `AI_GRPC_PORT` enciende el servidor gRPC.
  - En el backend, `AI_GRPC_URL` (`host:puerto`) activa el cliente. Si está vacía, se usa HTTP con `AI_SERVICE_URL`.
  - `docker-compose.yml` ya define las dos.
- **Errores:** cada llamada tiene deadline (`AI_GRPC_TIMEOUT_MS`), espera la conexión como máximo `AI_GRPC_CONNECT_TIMEOUT_MS` y la cola reintenta 3 veces. Si todo falla, el navegador recibe el estado `failed`.
- **Despliegue:** Render gratis no permite gRPC entre dos servicios, así que se usa un **contenedor único** (ver abajo). Todas las opciones están en [DECISIONES_GRPC.md](DECISIONES_GRPC.md).

### Contenedor único (Render gratis)

`Dockerfile.combined` (en la raíz) mete el motor y el backend en una sola imagen. `start-combined.sh`:
1. Arranca el motor: gRPC en `127.0.0.1:50051` y HTTP en `127.0.0.1:8000`, ambos solo internos.
2. Espera a que gRPC responda y arranca el backend en `$PORT`.
3. Si cualquiera de los dos muere, el contenedor sale con error y Render lo reinicia.

```
[ contenedor ]  node (backend, $PORT público) ──gRPC 127.0.0.1:50051──▶ python (motor)
```

- **Memoria medida con un límite de 512 MB:** unos 97 MiB en reposo y unos 103 MiB con 20 peticiones simultáneas por SSE.
- `/analyze` (librosa, unos +400 MB) está apagado en esta imagen con `AI_ENABLE_ANALYZE=false`.

```bash
docker build -f Dockerfile.combined -t smartdj-combined .
docker run --rm -p 10000:10000 -e PORT=10000 -e DATABASE_URL=... -e REDIS_URL=... \
  -e SUPABASE_URL=... -e SUPABASE_JWKS_URL=... smartdj-combined
```

**Para activarlo en Render:**
- **Root Directory:** vacío.
- **Dockerfile Path:** `./Dockerfile.combined`.
- Agrega `AI_GRPC_URL=127.0.0.1:50051` y `AI_GRPC_TLS=false`.

**Para volver atrás:** Root Directory `backend` y borrar `AI_GRPC_URL`. Los pasos detallados están en [DECISIONES_GRPC.md](DECISIONES_GRPC.md#cómo-activarlo-en-render-servicio-smart-dj-platform).

### Probar gRPC en local

```bash
docker compose up --build                     # levanta todo, con gRPC activado
cd backend && node scripts/grpc-smoke.mjs     # llama a CheckCompatibility y StreamEvaluation en localhost:50051
npm test                                      # pruebas del cliente gRPC y de la sincronía del proto
cd ../ai && python -m unittest discover -s tests   # pruebas del servidor gRPC
```

## Diagnóstico de errores (bloque A)

Al arrancar, el backend deja en el log:
- **`Esquema de la base de datos verificado.`**, o qué tabla, columna o tipo falta. En ese caso, ejecuta en orden los archivos de `database/migrations/`.
- **`Motor de IA conectado por gRPC…`**, o un aviso si `AI_GRPC_URL` apunta a un motor que no responde.

Cada error 5xx se registra con método, ruta, mensaje y stack. De Postgres solo se registran `code`, `table`, `column` y `constraint`, nunca el `detail`, que puede traer datos. Los 4xx van en una sola línea.

| Síntoma | Causa | Qué hacer |
| --- | --- | --- |
| `403 Origen no permitido por CORS` y en el log `CORS rechazó el origen …` | La URL del frontend no está en la lista permitida | Agrégala a `CORS_ORIGIN`, separada por comas |
| `503 … no pudimos ponerla en la cola` y `No se pudo encolar la petición` | Redis no responde o se agotó la cuota de Upstash | Revisa `REDIS_URL` y el uso en el panel de Upstash |
| `500` con `code=42P01` / `42703` en el log | Falta una tabla o columna | Corre las migraciones pendientes en Supabase |

Antes, con Redis caído la petición se quedaba colgada y un origen rechazado respondía 500. Ahora la app usa una conexión a Redis que falla en segundos y el worker de BullMQ tiene la suya propia. Con la cola vacía, el worker consulta Redis cada 60 s en lugar de cada 5 s, para no agotar la cuota gratis de Upstash.

## CORS

Solo se aceptan los orígenes de `knownOrigins` en `backend/src/config.js` y los que se agreguen en `CORS_ORIGIN` (separados por coma). Para un nuevo dominio del frontend, agrégalo a `CORS_ORIGIN`.

## Frontend

El frontend está en el repositorio `smartdj-frontend`.
