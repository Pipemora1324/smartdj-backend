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

| `JAMENDO_CLIENT_ID` | Client ID de [Jamendo](https://devportal.jamendo.com) para el catálogo de la emisora. Sin él, el buscador de pistas responde "El catálogo de música no está configurado". |
| `JAMENDO_MONTHLY_BUDGET` | Opcional, 30000 por defecto. Tope de consultas a Jamendo por mes (contador en Redis); al llegar se usa solo el caché. |
| `AUDIUS_API_KEY` | Opcional. Bearer token de la API de Audius (segundo proveedor). Solo en el servidor; vacío = Audius desactivado. |
| `JAMENDO_API_URL` | Solo para pruebas locales con un Jamendo simulado. En producción no se define. |

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
- **Emisora:** `006_emisora.sql` crea el caché de pistas, el estado del reproductor y la cola. Sin ella, las rutas del reproductor responden 503 con "falta ejecutar la migración 006".
- **Peticiones en la emisora:** `008_peticiones_emisora.sql` guarda el origen de cada petición (Jamendo o iTunes) y su pista, y enlaza el historial con la petición que sonó. También corrige las peticiones marcadas como "Sonada" que nunca sonaron. Requiere la 006.
- **Seguridad en Supabase:** `007_rls_tablas_existentes.sql` activa RLS en las tablas que ya existían, para que la clave anon (pública) no pueda leerlas por la API REST de Supabase. El backend se conecta como dueño de las tablas y no lo afecta.

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

## Buscador de canciones (bloque B)

- **`GET /api/public/venues/:code/search?q=`**: busca en iTunes Search **desde el servidor** (`backend/src/music-search.js`).
  - `q` de 2 a 100 caracteres, timeout de 5 s, máximo 10 resultados.
  - Rate limit de 30 por minuto por IP y caché de 10 min en Redis.
  - Cada resultado trae `trackId`, `title`, `artist`, `genre`, `artworkUrl` (300×300) y `previewUrl` (30 s).
  - Las URLs de portada y preview solo se aceptan si son `https` de dominios de Apple.
- **`POST /api/public/venues/:code/requests`** con `{ trackId, guestName? }`:
  - El backend vuelve a consultar la canción por id, así que no confía en los datos del navegador.
  - Rate limit de 10 por minuto por IP.
  - El formato anterior (`title`, `artist`, `genre`…) sigue aceptándose.
- La migración `004_canciones_buscador.sql` agrega `external_id`, `artwork_url` y `preview_url` a `song_requests`. Mientras no se aplique, las peticiones se guardan sin esas columnas y el log avisa "Migraciones pendientes".

## Panel del dueño (bloque C)

Todas las rutas requieren el token de Supabase. Cada `:id` se valida como UUID y se comprueba que el local sea del dueño de la sesión; si no lo es, se responde 404 sin revelar si existe.

| Ruta | Uso |
| --- | --- |
| `GET /api/venues` | Locales del dueño (puede tener varios) |
| `POST /api/venues` | Crear local (`name`, `kind`, `ambience`) |
| `PATCH /api/venues/:id` | Editar uno o más campos |
| `GET /api/venues/:id/dashboard?limit=50` | Local y peticiones recientes (de 1 a 100) |
| `PATCH /api/venues/:id/requests/:requestId` | `{ status: "accepted" \| "rejected" \| "played" }`. `played` registra `played_at` |

- Cada cambio de estado se publica en Redis (`venue:<id>`).
- El panel del frontend se actualiza por polling cada 5 s. No usa SSE porque `EventSource` no puede enviar el token `Bearer`.
- La migración `005_panel_dueno.sql` agrega `played_at` y `status_updated_at`. Mientras no se aplique, los cambios de estado funcionan igual, solo que sin esas fechas.

## Interfaz de DJ del link público (bloque D)

- **`GET /api/public/venues/:code/now`**: devuelve `{ nowPlaying, queue }`.
  - `nowPlaying` es la última petición marcada como `played` (por `played_at`).
  - `queue` son hasta 10 `accepted`, en el orden en que se aceptaron.
  - Cada canción trae `title`, `artist`, `genre`, `artworkUrl` y `previewUrl`, **sin nombres de invitados**.
  - Rate limit de 120 por minuto por IP.
- Sin la migración 005, se ordena por `evaluated_at`.

## Motor y seguridad (bloque E)

- **Familias de género** (`ai/app/engine.py`):
  - Cada género se clasifica por palabra completa, sin acentos. Si hay varias, gana la última ("indie rock" es rock).
  - Una tabla explícita define la afinidad entre familias (salsa↔urbano, dance↔pop…).
  - Antes se buscaban subtextos y la "afinidad" comparaba nombres de familia contra listas de géneros. Por eso "Reggaeton" salía como salsa y casi nada era "relacionado".
- **Tonalidades:** se interpretan `C`, `C#`, `Db`, `Am`, `Bbm`, `F# menor`, `A minor`, `8A`… y se puntúan con la **rueda Camelot**: misma 1,0; relativa (Am/C) 0,9; vecina 0,85. Antes "Am" y "A" daban 1,0 porque se perdía el modo menor.
- **BPM:** tolera medio y doble tempo (70 ≈ 140). 0 o vacío significa desconocido y da un puntaje neutral (0,55); lo mismo pasa con la tonalidad.
- **Evaluación contra lo que suena:** el worker compara cada petición con la **última canción marcada como sonada en ese local**. Si no suena ninguna, la compara con el ambiente del local. Antes usaba valores fijos (Pop, 120 BPM, Do).
- **`/analyze` contra SSRF** (`ai/app/safe_fetch.py`):
  - Solo `https`, puerto 443 y hosts permitidos (`AI_ANALYZE_ALLOWED_HOSTS`, por defecto los de audio de Apple y Deezer).
  - Todas las IPs resueltas deben ser públicas.
  - Sin redirecciones; máximo `AI_ANALYZE_MAX_BYTES` (10 MB) y 20 s.
  - La imagen del motor incluye ffmpeg para decodificar los previews `.m4a`.
- **UTF-8:** se revisaron todos los archivos de los dos repos y no hay texto mal codificado. Se declaró `charset=utf-8` en el gateway nginx y en el servidor estático de desarrollo.
- **Validación:** los mensajes de Zod salen en español (`backend/src/zod-es.js`).
- **Rate limit en todos los endpoints públicos** (por IP, por minuto):

  | Endpoint | Límite |
  | --- | --- |
  | Consultar el local y `/now` | 120 |
  | Búsqueda | 30 |
  | Peticiones | 10 |
  | Estado de una petición | 120 |
  | SSE | 20 |

## Calidad: SonarCloud (bloque F)

El Quality Gate fallaba por **fiabilidad** (C) y **seguridad** (C). Duplicación y mantenibilidad estaban bien. Lo que se corrigió:

| Hallazgo | Corrección |
| --- | --- |
| Promesas sin `await` ni `.catch` (S9383) | `.catch` en los diagnósticos de arranque y en el stream gRPC |
| Inyección en logs (S5145) | `sanitizeForLog()` limpia ruta y `Origin` antes de registrarlos |
| Dependencias sin versión fija (S8543/S8544/S8564) | `backend/package-lock.json` + `npm ci`; `ai/requirements.lock` con hashes (pip-compile) + `--require-hashes` |
| Scripts de instalación (S6505/S8541) | `npm ci --ignore-scripts` y `pip install --only-binary :all:` |
| Contenedores como root (S6471) | `USER node` / usuario `app` (uid 10001); gateway con `nginx-unprivileged` en el puerto 8080 |

Se dejaron sin cambiar, documentados como falsos positivos:
- `mailer.js:15`: es `jsonTransport`, de la auth anterior, que ya no se usa.

Para regenerar el lock de Python dentro de Linux:

```bash
docker run --rm -v "$PWD/ai:/work" -w /work python:3.12-slim sh -c "pip install pip-tools==7.4.1 && pip-compile --generate-hashes --allow-unsafe --strip-extras -o requirements.lock requirements.txt"
```

## Emisora automática (AutoDJ)

Cada local tiene una emisora que no se detiene. Las decisiones y la evidencia (formato de Jamendo, CORS del audio y términos de uso) están en [DECISIONES_DJ.md](DECISIONES_DJ.md).

```
Consola del dueño (navegador)           Backend                                Motor (gRPC)
───────────────────────────────          ───────                                ────────────
reproduce el audio (mp3l.jamendo.com)    player_state + play_queue (006)
POST /player/advance ───────────────────▶ avanza la cola ─▶ ensureQueue() ──▶ SuggestNext
                                          (≥ 5 pistas)        candidatas de     (género, energía,
                                                              track_cache o     BPM, tonalidad,
                                                              Jamendo (24 h)    sin repetir)
Página pública ◀── SSE /venues/:code/events ◀── Redis venue:<id>
```

- **Catálogo:** `GET /api/venues/:id/tracks/search?q=&genre=&provider=`.
  - Busca en Jamendo (y en Audius, si está configurado) desde el servidor.
  - Respuesta: título, artista, género, duración, portada, `audioUrl`, `audioFallbackUrl`, forma de onda y crédito (artista, título, enlace y licencia).
  - Cada búsqueda queda en caché 24 h en la base de datos (`track_search_cache`), y se guardan solo metadatos, nunca audio.
  - Rate limit de 30 por minuto por dueño. El tope mensual de Jamendo se cuenta en Redis.
- **Reproductor:** `/api/venues/:id/player`, solo para el dueño del local.

  | Ruta | Qué hace |
  | --- | --- |
  | `GET /` | Estado, pista actual y cola |
  | `POST /claim` | Una sola consola por local |
  | `POST /play`, `POST /pause` | Reproduce o pausa |
  | `POST /skip` | Saltar |
  | `POST /advance` | Fin de la pista; es idempotente con `fromTrackId` |
  | `PATCH /` | `volume`, `mode` (`autodj`/`manual`) y `crossfadeSeconds` |
  | `POST /queue` | Agregar a la cola |
  | `PATCH /queue` | Reordenar con `{order:[ids]}` |
  | `DELETE /queue/:itemId` | Quitar de la cola |

- **AutoDJ** (`autodj.js`):
  - Mantiene al menos 5 pistas en la cola. Solo se ejecuta con eventos (avanzar, saltar, quitar, cambiar de modo, petición aceptada o abrir la consola), nunca con temporizadores.
  - El motor elige con `SuggestNext` (gRPC) o con `POST /suggest-next` (HTTP) y devuelve la pista, el puntaje, la razón, el punto de transición y la duración del crossfade.
  - Respaldos:
    - Si el motor falla, se elige por género y energía del local, y no se le vuelve a preguntar durante un minuto.
    - Si Jamendo falla, se usa el caché.
    - Si no hay caché, se usa la pista que suena en la radio de Jamendo del tipo de local.
- **Peticiones del público:** al aceptar una petición se busca la misma canción en el catálogo libre.
  - Si está, se intercala después de la siguiente pista, sin dos peticiones seguidas.
  - Si no está, la respuesta trae `station.queued=false` y el AutoDJ favorece ese género durante 30 minutos.
- **Página pública:**
  - `GET /api/public/venues/:code/now` devuelve la pista de la emisora con su crédito y las próximas 5, sin audio ni datos de clientes.
  - `GET /api/public/venues/:code/events` es un SSE con un solo suscriptor de Redis por proceso. Solo reenvía el tipo de aviso.

## Peticiones del público en la emisora

**Flujo del cliente** (link o QR del local, sin cuenta):
1. Busca una canción. Primero aparecen las pistas **Completa** (Jamendo); si hay menos de 5, se completan con **Preview 30 s** (iTunes).
2. La pide (`POST /api/public/venues/:code/requests` con `{provider:'jamendo', externalId}` o `{trackId}` de iTunes). El motor la evalúa en vivo contra lo que suena en la emisora o, si está detenida, contra el ambiente del local.
3. En "Tus peticiones" ve su estado: En evaluación, Esperando turno, El DJ la revisará, En la cola, Sonando ahora, Sonada o Descartada. Viene de `GET /api/public/venues/:code/requests?ids=` y se actualiza por SSE.

**Flujo del dueño** (pestaña Peticiones de la consola):
- `GET /player/requests` lista las pendientes de las últimas 24 h, con portada, origen, quién la pidió, estado y si encaja.
- Acciones:

  | Acción | Ruta |
  | --- | --- |
  | Reproducir ahora | `POST /player/requests/:id/queue {next:true}` |
  | Añadir a la cola | `POST /player/requests/:id/queue` |
  | Descartar | `POST /player/requests/:id/dismiss` |

- **En AutoDJ**, las peticiones que el motor aceptó se intercalan solas: como mucho dos en la cola, nunca seguidas y sin repetir pistas recientes. Las que no encajan esperan la decisión del dueño. **En Manual** decide siempre el dueño.
- **Qué suena:**
  - Una petición de Jamendo suena completa.
  - Una de iTunes busca primero su versión completa en Jamendo. Si no existe, suena como **corte de 30 s** con fundido de salida de 4 s, y después sigue el AutoDJ.
- **"Sonada"** solo se marca cuando la petición sale de la emisora después de sonar (terminó o se saltó), y queda en `mix_history.request_id`. El dueño ya no puede marcarla a mano.
- **Lo pedido orienta al AutoDJ:** los géneros y artistas de las peticiones pendientes viajan a `SuggestNext` (`request_genres`, `request_artists`) y suben el puntaje de las candidatas parecidas. La razón queda en la cola, por ejemplo "se parece a lo que pidió el público".

## Licencias de la música

- **La API de Jamendo es gratuita solo para uso no comercial.**
  - Los términos piden dar crédito al artista y a Jamendo y enlazar cada pista a su página. SmartDJ lo muestra en la consola y en la página pública.
  - Los términos prohíben diseñar la app para cachear el contenido. Por eso solo se guardan metadatos durante 24 h.
- **Licencias de las pistas:** cada pista tiene su licencia Creative Commons. Las `NC` (no comerciales) quedan marcadas, y cada local puede excluirlas con "Solo licencias comerciales" (`exclude_non_commercial`). Las de Audius se tratan como no comerciales porque su licencia viene vacía.
- **Previews de iTunes:** los términos de la iTunes Search API permiten los previews solo para promocionar la tienda, "not for entertainment purposes", en streaming, sin guardarlos y con atribución y enlace a Apple.
  - Ponerlos en la emisora como "corte de petición" va contra eso. Se hizo por pedido del proyecto académico, con atribución ("Preview cortesía de iTunes") y enlace a la canción.
  - **Para un uso real hay que quitarlo.**
- **Este proyecto es académico, no comercial.**
- **Qué cambia en un uso comercial real:** poner música en un bar, café o restaurante abierto al público es un uso comercial y una comunicación pública. Hace falta:
  - Una licencia comercial de la API: hablar con Jamendo.
  - Música con licencia para comercios: Jamendo Licensing ofrece radios "In-Store" y radios `pro` con certificado legal. También sirven pistas cuya licencia permita el uso comercial.
  - Revisar la gestión colectiva del país; en Colombia, SAYCO-ACINPRO.

  Esto no es asesoría legal: hay que confirmarlo con Jamendo y con un abogado antes de usar SmartDJ en un local real.

## Pruebas

```bash
cd backend && npm test                           # 67 pruebas (Node)
cd ai && python -m unittest discover -s tests    # 43 pruebas (Python; las 2 de /suggest-next por HTTP necesitan fastapi y httpx)
```

Las pruebas de punta a punta de la emisora se hicieron con Postgres y Redis en Docker, el motor por gRPC, un Jamendo simulado (`JAMENDO_API_URL`) y la consola en un navegador headless. El audio era real, desde los servidores de Jamendo. Nunca se probó contra producción ni contra el Supabase real.

## CORS

Solo se aceptan los orígenes de `knownOrigins` en `backend/src/config.js` y los que se agreguen en `CORS_ORIGIN` (separados por coma). Para un nuevo dominio del frontend, agrégalo a `CORS_ORIGIN`.

## Frontend

El frontend está en el repositorio `smartdj-frontend`.
