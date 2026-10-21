# Pendientes

Problemas encontrados durante el trabajo autónomo que necesitan una acción fuera del código.

## 1. Render no publica los despliegues nuevos del backend (detectado el 2026-10-21)

**Síntoma:** después de los pushes de los bloques A y B, `https://smart-dj-platform.onrender.com` sigue sirviendo una versión anterior. `/api/health` responde `{"status":"ok"}`, pero:
- Una ruta del bloque B (`GET /api/public/venues/<código>/search`) responde `Recurso no encontrado`.
- Un `Origin` desconocido sigue dando 500 en vez del 403 del bloque A.

La versión viva incluye las rutas de gRPC/SSE (`fead3c2` o posterior), pero no `9d33a53` (bloque A).

**Lo que se descartó:**
- El backend con el código actual arranca bien en local con `NODE_ENV=production` (Docker, `backend/Dockerfile`).
- `npm test` y las pruebas de Python pasan.

**Qué revisar en Render** (servicio `smart-dj-platform`):
1. **Events:** ¿hay despliegues en estado *Failed* o *Canceled*? Abre el último y revisa el log del **build** y del **deploy**.
2. Si el deploy falla al arrancar: Render conserva la versión anterior cuando la nueva no arranca. Revisa que existan `SUPABASE_URL` y `SUPABASE_JWKS_URL`: sin ellas el servidor se detiene con `Missing required environment variable`.
3. **Settings → Build & Deploy → Auto-Deploy:** debe estar en *On Commit*. Si está apagado, usa *Manual Deploy → Deploy latest commit*.
4. Si cambiaste a `Dockerfile.combined`: Root Directory vacío, Dockerfile Path `./Dockerfile.combined`. El primer build tarda más por librosa.

**Consecuencia:** mientras el backend nuevo no esté publicado, **no se sube el frontend nuevo**, porque depende de rutas que la versión vieja no tiene (`/search`, `PATCH /venues/...`). Los commits del frontend quedan listos en local.

**Estado al terminar los bloques A–F:** el backend se subió completo (último commit `ec4143e`) y `/api/health` responde `ok`. Pero dos comprobaciones de solo lectura muestran que sigue viva la versión anterior:
- `GET /api/public/venues/<código-inexistente>/search?q=ab` responde `Recurso no encontrado`; la versión nueva respondería `Código de establecimiento inválido`.
- Un `Origin` desconocido sigue dando 500 en vez de 403.

## 2. Frontend retenido en local

Con el frontend nuevo y el backend viejo, pedir canciones dejaría de funcionar:
- El buscador llama a `/search`, que no existe en la versión vieja.
- El POST con `trackId` lo rechaza la versión vieja.

Cuando Render publique el backend (las dos comprobaciones de arriba deben responder lo nuevo), sube el frontend con `git push origin main` en `smartdj-frontend`.

## 3. SQL para Supabase (SQL Editor, en este orden, una sola vez)

Todos los archivos son idempotentes: se pueden ejecutar de nuevo sin romper datos.

1. `database/migrations/003_esquema_base.sql`: asegura los tipos y tablas base (`song_requests`, `songs`, `mix_history`).
2. `database/migrations/004_canciones_buscador.sql`: portada, preview e id de iTunes en las peticiones.
3. `database/migrations/005_panel_dueno.sql`: `played_at` y `status_updated_at` para "sonando" y la cola.

Antes deben estar aplicadas `001` y `002`, de fases anteriores. Mientras falten 004 y 005 la app funciona igual, con menos datos, y el log lo avisa al arrancar ("Migraciones pendientes").

## 4. SonarCloud: hallazgos que quedan a propósito

- `backend/src/mailer.js:15` ("http inseguro"): falso positivo en `jsonTransport`, de la auth anterior que ya no se usa.
- `smartdj-frontend/scripts/dev-static-server.mjs` (http): servidor solo para desarrollo local.
- El análisis del frontend en SonarCloud seguirá en rojo hasta que se suba el frontend: el BLOCKER de XSS ya está corregido en local (bloque B).
