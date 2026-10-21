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
