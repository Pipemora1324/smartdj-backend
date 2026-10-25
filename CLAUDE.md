# SmartDJ Backend

Plataforma para locales (cafeterías, restaurantes, bares). El dueño crea cuenta, registra locales y cada local tiene un link público y un QR; los clientes no inician sesión, piden canciones desde ese link.

- `backend/`: API Node.js + Express (auth, locales, peticiones, cola BullMQ).
- `ai/`: motor de compatibilidad musical (Python): servidor gRPC y HTTP con FastAPI.
- `database/`: `init.sql` y migraciones en `database/migrations/` (idempotentes). La 009 es una limpieza opcional que se ejecuta a mano.
- Despliegue: backend y ai en un solo contenedor en Render (`Dockerfile.combined`), PostgreSQL en Supabase, Redis en Upstash. El frontend vive en el repo `smartdj-frontend` (Vercel).
- **Autenticación: Supabase Auth.** Registro, códigos de 6 dígitos (SMTP de Gmail en el panel de Supabase), login y recuperación se hacen desde el frontend. La API solo valida el token con JWKS (`supabase-token.js`) y usa `requireSupabaseAuth` (`supabase-auth.js`), que vincula la cuenta con `users.auth_id`; `req.user.sub` es el `users.id` local. La auth propia de la Fase 1 se eliminó (código, dependencias y rutas); `routes/auth.js` solo tiene `GET /me`. Guía en `SUPABASE_AUTH.md`.

## Convenciones técnicas (bloques A–F)

- **Migraciones:** archivos idempotentes en `database/migrations/`, numerados (001…009). Una columna nueva que use el código va en `OPTIONAL_COLUMNS` de `schema-check.js` y se consulta con `hasColumn()`, para que producción no se rompa antes de correr el SQL.
- **Errores:** usa `AppError` con un mensaje en español; toda respuesta de error lleva `code` estable (`ERROR_CODES` en `errors.js`). Los 5xx se registran con stack. Todo dato del usuario que vaya al log pasa por `sanitizeForLog()`. Los mensajes de Zod salen en español (`zod-es.js`).
- **Logs:** usa `logger` (`logger.js`, JSON por línea, `LOG_LEVEL`), nunca `console.*`. No registres datos personales: las claves con correo, nombre, token, etc. se ocultan solas.
- **Configuración:** toda variable nueva va en el esquema Zod de `config.js`, que valida al arrancar y lista todos los problemas. Sin valores por defecto inseguros.
- **Redis:** la app usa `redis`, que falla rápido; el worker de BullMQ usa `createWorkerConnection()`. No vuelvas a compartir la conexión.
- **Endpoints públicos:** todos con validación Zod y límites de `rate-limits.js` (`createPublicLimiter`: por cliente con `X-Client-Id` y tope por IP, porque en un local todos comparten el Wi-Fi). Los ids, como UUID. Las rutas del dueño validan la propiedad con `ownedVenue()`.
- **Tiempo real:** los SSE usan `live-hub.js` (una sola suscripción de Redis por proceso). Nunca abras una conexión a Redis por visitante. Lo que muchos piden a la vez pasa por `createMemo()` (`memo.js`).
- **Dependencias:** `backend/package-lock.json` (`npm ci --ignore-scripts`) y `ai/requirements.lock` con hashes. Al cambiar `requirements.txt`, regenera el lock (ver README).
- **Docker:** las imágenes corren sin root. `Dockerfile.combined` es el despliegue gratis en Render (motor y backend con gRPC en localhost).
- **Pruebas:** `npm test` en `backend/` corre las unitarias, las del motor (Docker) y las de integración (`test/integration`, Postgres y Redis efímeros en Docker con dobles de Supabase, Jamendo, iTunes y el motor). Escribe pruebas para lo que agregues y córrelas antes de cada push.
- **Lint y formato:** `npm run lint` y `npm run format` (ESLint + Prettier). Deben quedar limpios antes de cada commit.
- **Carga:** `load/` es solo local (`CARGA.md`). Nunca apuntes un script de carga a producción.
- **Pendientes fuera del código:** `PENDIENTES.md`.

## Emisora automática (AutoDJ)

- **Decisiones y evidencia:** `DECISIONES_DJ.md`. Incluye el formato de Jamendo, el CORS del audio, los términos y por qué el audio suena en la consola del dueño.
- **Catálogo:**
  - `music-providers/` (Jamendo y Audius) tiene funciones puras y clientes que reciben su configuración.
  - `music-catalog.js` maneja el caché en la base de datos (24 h) y el tope mensual en Redis.
  - Nunca consultes al proveedor en bucle ni con temporizadores. Guarda solo metadatos, nunca audio.
- **Lógica pura** (sin base de datos ni Redis, probada con `node --test`): `catalog-logic.js` y `player-logic.js`. Lo que se pueda probar aislado va ahí.
- **Reproductor:**
  - `player.js` hace cada escritura en una transacción con `player_state` bloqueado.
  - Las rutas están en `routes/player.js`.
  - `advance` y `skip` son idempotentes con `fromTrackId`.
- **AutoDJ:**
  - `autodj.js` (`ensureQueue`) se dispara solo por eventos y nunca lanza.
  - El contrato es `SuggestNext` en `compatibility.proto`, con la lógica en `ai/app/autodj.py`; `POST /suggest-next` es el modo HTTP.
- **Página pública:** nunca expone audio, ids de petición, nombres de clientes ni el `consoleId`. Los avisos van por `venue-events.js`, con un solo suscriptor de Redis.
- **Supabase:** toda tabla nueva va con `ENABLE ROW LEVEL SECURITY` (la clave anon es pública).
- **Peticiones en la emisora (008):**
  - `station-requests.js` decide qué pista suena por cada petición: Jamendo completa o preview de iTunes de 30 s con fundido.
  - "Sonada" la marca solo `player.js` cuando la petición sale de la emisora después de sonar. **Nunca la marques a mano.**
  - El AutoDJ intercala las que el motor aceptó (máximo dos en cola) y pasa los géneros y artistas pedidos a `SuggestNext`.
  - Los previews de iTunes nunca son candidatas del AutoDJ.
- **Peticiones automáticas (010):**
  - En AutoDJ, con `auto_accept_requests`, toda petición válida entra sola a la cola. La IA decide solo el orden (`request-priority.js`, lógica pura y probada), nunca si entra.
  - Respeta siempre el límite de aplazamiento (`REQUEST_MAX_DEFERRAL`) y no muevas la primera de la cola mientras algo suena.
  - Las repetidas son votos (`duplicate_of`). Cualquier cambio de estado de una petición debe aplicarse también a sus votos.
  - El AutoDJ se dispara solo por eventos. Con el candado tomado deja el aviso `autodj:again:<local>`: no lo quites.
  - Sin la 010 (`autoRequestsReady()`), todo se comporta como antes.

## Reglas fijas

- **Idioma del código:** todo en inglés: variables, funciones, archivos, rutas, tablas y columnas nuevas.
- **Idioma de los textos:** comentarios nuevos y textos para el usuario (errores de la API, correos, pantallas, logs de la app) en español.
- **Comentarios existentes:** no modificarlos ni eliminarlos, aunque el código de al lado cambie.
- **Commits:** pequeños (un cambio lógico por commit), mensajes cortos en español sin punto final, sin `Co-Authored-By` ni menciones de IA. Usar el git config del usuario sin cambiarlo.
- **Secretos:** no leer ni tocar `.env`. En `.env.example` solo placeholders `CAMBIAR_ESTO`.
- **Git remoto:** no hacer push sin confirmación del usuario. Nunca usar `--force` ni reescribir el historial.
- **Trabajo por fases:** una fase a la vez. Al terminar cada una, detenerse y decir qué hay que configurar en Render, Vercel o Supabase.
- **Comunicación backend ↔ ai: gRPC.** Contrato en `ai/proto/compatibility.proto`, con una copia idéntica en `backend/proto/` (`npm test` lo verifica; cambia siempre los dos). Cliente: `backend/src/ai-client.js`. Servidor: `ai/app/grpc_server.py`, sobre `ai/app/engine.py`. Sin `AI_GRPC_URL`, el backend usa HTTP (`AI_SERVICE_URL`). Render gratis no soporta gRPC entre servicios: ver `DECISIONES_GRPC.md`.
