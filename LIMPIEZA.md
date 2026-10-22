# Limpieza de código muerto (cierre del proyecto)

Primero se hizo el inventario y después se borró. Cómo se buscó cada elemento:
- **Imports:** `grep` de cada módulo de `backend/src`.
- **Rutas:** las que llama el frontend contra las que define el backend.
- **Configuración:** las claves de `config.js` y `.env.example` y quién las lee.
- **Dependencias:** cada paquete de `package.json` y de `requirements.txt` contra los imports.
- **Base de datos:** las tablas y columnas de las migraciones contra las consultas del código.

**Criterio:** se borra solo lo que nadie llama ni importa. Lo que sigue en uso, aunque sea de respaldo, se mantiene.

## Backend (Node)

| Elemento | Evidencia | Decisión |
| --- | --- | --- |
| Rutas de la auth propia (`/api/auth/register`, `verify-email`, `resend-code`, `login`, `refresh`, `logout`, `forgot-password`, `reset-password`) | Responden 410 desde la migración a Supabase Auth. El frontend usa Supabase y solo llama `GET /api/auth/me`. | **Borrar.** Queda `/api/auth/me` con su rate limit. |
| `src/auth.js` (JWT propios, cookie de refresh, revocación en Redis con `revoked:<jti>` y `revoked_before:<user>`) | Solo lo importaban esas rutas. | **Borrar.** |
| `src/codes.js` (códigos de 6 dígitos propios) | Solo lo importaban esas rutas. | **Borrar.** |
| `src/mailer.js` (envío por Resend y SMTP) | Solo lo importaba `codes.js`. Supabase envía los correos. | **Borrar.** |
| Dependencias `argon2`, `nodemailer` y `cookie-parser` | Solo las usaban la auth propia y su cookie. | **Borrar.** `jsonwebtoken` se queda: lo usa `supabase-token.js`. |
| Rutas del dueño `GET /:id/dashboard`, `GET /:id/search` (iTunes), `POST /:id/analyze` y `PATCH /:id/requests/:requestId` | El panel y la consola ya no las llaman: las peticiones se manejan con `/player/requests`. | **Borrar**, junto con `listLimit`, `requestStatusSchema` y `OWNER_STATUSES` de `owner-validation.js`, que solo usaban ellas. |
| `config.js`: `accessSecret`, `refreshSecret`, `cookieSecure`, `resendApiKey`, `authCodeSecret`, `smtp`, `publicAppUrl` y `production` | Solo los leían la auth propia y el mailer. | **Borrar.** |
| `.env.example`: `COOKIE_SECURE`, `PUBLIC_APP_URL`, `SMTP_*` y `MAIL_FROM` | Ningún código los lee. | **Borrar.** |
| `gateway/nginx.conf`: zona `login_limit` y `location = /api/auth/login` | La ruta ya no existe. | **Borrar.** |
| CORS con `credentials: true` | Ya no hay cookies: la API usa `Authorization: Bearer`. | **Quitar** (bloque B, CORS estricto). |
| `POST /compatibility` (HTTP) y `evaluateOverHttp` en `queue.js` | Es el respaldo cuando `AI_GRPC_URL` está vacío. | **Mantener.** |
| `scripts/grpc-smoke.mjs` | Prueba manual del servidor gRPC, documentada en el README. | **Mantener.** |

## Motor (Python)

| Elemento | Evidencia | Decisión |
| --- | --- | --- |
| `POST /analyze` (librosa) y `app/safe_fetch.py`, con sus pruebas | No lo llama ningún cliente. El backend calcula la compatibilidad con gRPC. En producción ya estaba apagado (`AI_ENABLE_ANALYZE=false`) porque usa unos 400 MB. | **Borrar.** |
| `librosa`, `numpy` y `requests` en `requirements.txt`; `ffmpeg` en `ai/Dockerfile`; `AI_ENABLE_ANALYZE` en `Dockerfile.combined` | Solo los usaba `/analyze`. | **Borrar.** Además, la imagen queda mucho más liviana. |
| `engine.harmonic_distance` | Alias de compatibilidad sin referencias. | **Borrar.** |
| `grpcio-tools` | Lo necesita `grpc.protos_and_services` en tiempo de ejecución. | **Mantener.** |

## Base de datos

**No se borra nada automáticamente.** La migración `database/migrations/009_limpieza_opcional.sql` hace lo siguiente y **se ejecuta a mano, solo después de confirmar** que no se necesita:
- Elimina las tablas `auth_codes`, `password_resets` y `refresh_tokens`. Esta última nunca se creó; se incluye por si existiera.
- Elimina la tabla `songs`, que no usa ninguna consulta.
- Elimina las columnas `users.password_hash` y `mix_history.song_id`.

**Se mantienen:**
- `users.email_verified`: la escribe `supabase-auth.js`.
- Todas las demás tablas y columnas, que el código usa.

La 009 no se monta en `docker-compose.yml`.

## Frontend

La limpieza del frontend está en `LIMPIEZA.md` de `smartdj-frontend`.
