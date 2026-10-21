# SmartDJ Backend

Plataforma para locales (cafeterías, restaurantes, bares). El dueño crea cuenta, registra locales y cada local tiene un link público y un QR; los clientes no inician sesión, piden canciones desde ese link.

- `backend/`: API Node.js + Express (auth, locales, peticiones, cola BullMQ).
- `ai/`: motor FastAPI de compatibilidad musical.
- `database/`: `init.sql` y migraciones en `database/migrations/` (idempotentes).
- Despliegue: backend y ai en Render, PostgreSQL en Supabase, Redis en Upstash. El frontend vive en el repo `smartdj-frontend` (Vercel).
- **Autenticación: Supabase Auth.** Registro, códigos de 6 dígitos (SMTP de Gmail en el panel de Supabase), login y recuperación se hacen desde el frontend. La API solo valida el token con JWKS (`supabase-token.js`) y usa `requireSupabaseAuth` (`supabase-auth.js`), que vincula la cuenta con `users.auth_id`; `req.user.sub` es el `users.id` local. La auth propia de la Fase 1 (`codes.js`, `auth.js`, rutas de `routes/auth.js`) queda sin uso y responde 410: no volver a usarla. Guía en `SUPABASE_AUTH.md`.

## Convenciones técnicas (bloques A–F)

- **Migraciones:** archivos idempotentes en `database/migrations/`, numerados (001…005). Una columna nueva que use el código va en `OPTIONAL_COLUMNS` de `schema-check.js` y se consulta con `hasColumn()`, para que producción no se rompa antes de correr el SQL.
- **Errores:** usa `AppError` con un mensaje en español; los 5xx se registran con stack. Todo dato del usuario que vaya al log pasa por `sanitizeForLog()`. Los mensajes de Zod salen en español (`zod-es.js`).
- **Redis:** la app usa `redis`, que falla rápido; el worker de BullMQ usa `createWorkerConnection()`. No vuelvas a compartir la conexión.
- **Endpoints públicos:** todos con rate limit y validación Zod. Los ids, como UUID. Las rutas del dueño validan la propiedad con `ownedVenue()`.
- **Dependencias:** `backend/package-lock.json` (`npm ci --ignore-scripts`) y `ai/requirements.lock` con hashes. Al cambiar `requirements.txt`, regenera el lock (ver README).
- **Docker:** las imágenes corren sin root. `Dockerfile.combined` es el despliegue gratis en Render (motor y backend con gRPC en localhost).
- **Pruebas:** `npm test` en `backend/` y `python -m unittest discover -s tests` en `ai/`. Escribe pruebas para lo que agregues y córrelas antes de cada push.
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

## Reglas fijas

- **Idioma del código:** todo en inglés: variables, funciones, archivos, rutas, tablas y columnas nuevas.
- **Idioma de los textos:** comentarios nuevos y textos para el usuario (errores de la API, correos, pantallas, logs de la app) en español.
- **Comentarios existentes:** no modificarlos ni eliminarlos, aunque el código de al lado cambie.
- **Commits:** pequeños (un cambio lógico por commit), mensajes cortos en español sin punto final, sin `Co-Authored-By` ni menciones de IA. Usar el git config del usuario sin cambiarlo.
- **Secretos:** no leer ni tocar `.env`. En `.env.example` solo placeholders `CAMBIAR_ESTO`.
- **Git remoto:** no hacer push sin confirmación del usuario. Nunca usar `--force` ni reescribir el historial.
- **Trabajo por fases:** una fase a la vez. Al terminar cada una, detenerse y decir qué hay que configurar en Render, Vercel o Supabase.
- **Comunicación backend ↔ ai: gRPC.** Contrato en `ai/proto/compatibility.proto`, con una copia idéntica en `backend/proto/` (`npm test` lo verifica; cambia siempre los dos). Cliente: `backend/src/ai-client.js`. Servidor: `ai/app/grpc_server.py`, sobre `ai/app/engine.py`. Sin `AI_GRPC_URL`, el backend usa HTTP (`AI_SERVICE_URL`). Render gratis no soporta gRPC entre servicios: ver `DECISIONES_GRPC.md`.
