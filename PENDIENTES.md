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

## 5. Emisora automática (bloques 0–F, 2026-10-21)

- **Render ya publica el backend nuevo:** la comprobación de `/search` responde "Código de establecimiento inválido". Los puntos 1 y 2 de arriba quedan resueltos, y el frontend ya se subió.
- **SQL (SQL Editor de Supabase, en orden):**
  1. `database/migrations/006_emisora.sql`
  2. `database/migrations/007_rls_tablas_existentes.sql`

  Sin la 006, la consola muestra "falta ejecutar la migración 006" (503) y el resto de la app sigue igual.
- **Render:**
  - Agregar `JAMENDO_CLIENT_ID`.
  - Opcionales: `JAMENDO_MONTHLY_BUDGET` y `AUDIUS_API_KEY`.
- **Cuenta:** crear una aplicación en <https://devportal.jamendo.com> para obtener el Client ID. Audius es opcional: <https://audius.co/api>.
- **mp3l.jamendo.com dejó de responder durante las pruebas:**
  - `prod-1` seguía funcionando. La consola cae sola a `prod-1` sin EQ y la emisora sigue sonando.
  - Si pasa seguido, considerar un proxy de audio en un servicio de pago.
- **Pistas que no cargan:** se saltan, pero pueden volver a programarse cuando salen de las últimas 30 del historial. Mejora posible: marcarlas como rotas en `track_cache`.
- **Sin pruebas reales:** no se probó con un Client ID real de Jamendo (no hay cuenta) ni contra tu Supabase. El formato de la respuesta se tomó de la documentación oficial y del Jamendo simulado.

## 6. Peticiones dentro de la emisora (2026-10-22)

- **SQL:** `database/migrations/008_peticiones_emisora.sql`, después de la 006 y la 007. Además de las columnas nuevas, devuelve a "aceptada" las peticiones marcadas como sonadas que nunca sonaron. Sin la 008, la pestaña Peticiones de la consola muestra que falta la migración y el resto sigue funcionando.
- **Previews de iTunes en la emisora:** van contra los términos de Apple (solo promoción, no entretenimiento). Se dejaron por pedido del proyecto académico; para un uso real hay que quitar el "corte de petición".
- **Cuota de iTunes:** unas 20 consultas por minuto. El buscador público usa iTunes solo si Jamendo devuelve menos de 5 resultados, con caché de 10 minutos en Redis.
- **Historial de antes de la 008:** las peticiones que sí sonaron antes de esa migración no tienen `mix_history.request_id`, así que la corrección también las devuelve a "aceptada". Afecta solo a datos de prueba.

