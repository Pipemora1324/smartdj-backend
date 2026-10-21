# Decisiones de la emisora automática (AutoDJ)

SmartDJ pasa de evaluar peticiones a mantener una **emisora por local**:
- **El audio suena en el navegador del dueño**, en la consola de DJ.
- **El servidor** guarda el estado y la cola.
- **El motor de IA** (gRPC) elige la siguiente pista.

Aquí queda la evidencia de cada decisión.

## Bloque 0: verificación previa (2026-10-21, solo lectura)

### a) Jamendo `/v3.0/tracks`

Fuente: <https://developer.jamendo.com/v3.0/tracks>.

**Campos de cada pista:**
- **Identificación:** `id`, `name`, `duration` (segundos), `artist_name`, `album_name`.
- **Medios:** `image`/`album_image`, `audio` (stream), `audiodownload`, `audiodownload_allowed`.
- **Licencia y enlaces:** `license_ccurl`, `shareurl`, `shorturl`.
- **Forma de onda:** `waveform`, con picos ya calculados.

**Lo que trae `include=musicinfo`:**
- `vocalinstrumental`, `lang`, `gender`, `acousticelectric`.
- **`speed`**, de `verylow` a `veryhigh`.
- `tags.genres`, `tags.instruments` y `tags.vartags`.

**No trae BPM ni tonalidad.**

**Filtros útiles:**
- `fuzzytags` (OR) y `tags` (AND).
- `speed`.
- `ccnc` / `ccsa` / `ccnd`.
- `boost=popularity_total`.
- `limit` hasta 200.

**`audioformat`:** `mp31` (96 kbps), `mp32` (VBR), `ogg` o `flac`.

**Decisión:**
- **Género:** `tags.genres[0]`.
- **Energía (1–5):** sale de `speed`.
- **BPM:** 0 ("desconocido", como ya entiende el motor).
- **Forma de onda:** se reduce el `waveform` a 120 picos para dibujarla en la consola.

### b) CORS del audio (¿EQ con Web Audio?)

Petición HEAD y GET con `Range: bytes=0-1023`, con `Origin` de Vercel y de `localhost:5173`:

| URL | `Access-Control-Allow-Origin` |
|---|---|
| `https://mp3l.jamendo.com/?trackid=<id>&format=mp31` | `*` siempre, con `Accept-Ranges: bytes` y `audio/mpeg` |
| `https://prod-1.storage.jamendo.com/?trackid=<id>&format=mp31` | Un origen **ajeno** (`http://localhost:5173`, `https://example.com`) aunque se pida desde otro: el caché ignora `Vary: Origin` |
| `https://api.audius.co/v1/tracks/<id>/stream` → creatornode → R2 | `*` en los tres saltos |

`prod-1` es el host que suele venir en el campo `audio`.

**Decisión: el EQ de 3 bandas con Web Audio es viable sin proxy.**
- El backend reescribe el audio de Jamendo a `mp3l.jamendo.com/?trackid=<id>&format=mp31`, que tampoco expone el `client_id`.
- La consola carga el `<audio>` con `crossOrigin="anonymous"`.
- **Respaldo por deck:** si una pista no carga con CORS, se reintenta sin `crossOrigin`. Ese deck no pasa por Web Audio: el crossfade se hace con `audio.volume` y el EQ se desactiva, con un aviso.
- **Sin proxy de audio:** en Render gratis, todo el audio pasaría por el servidor.

### c) Términos de uso

**Jamendo** (<https://devportal.jamendo.com/api_terms_of_use>):
- "The API may be used freely for **non-commercial** uses". Para cualquier otro uso hay que contactar al equipo comercial (3.3).
- **Atribución:** dar crédito al artista y a Jamendo como proveedor, y **enlazar cada pista a su página en Jamendo** (4.1).
- **Caché:** la app no debe diseñarse para cachear contenido ni dar acceso offline. Solo se permite el caché "razonablemente necesario" (3.3).
- **Límites:** Jamendo puede limitar el número y la frecuencia de peticiones (3.3).
- **Cuota de 35.000 peticiones al mes:** **no aparece en los términos oficiales**. La citan fuentes de terceros como la cuota del plan no comercial. Se usa como tope **configurable y conservador** (`JAMENDO_MONTHLY_BUDGET`, 30.000 por defecto).
- **Radios** (<https://developer.jamendo.com/v3.0/radios/stream>): "the stream link returned is not more working". De una radio solo sirve `playingnow.track_id`, para armar la URL de audio de esa pista.
- **Uso comercial:** las radios `pro` son para comercios y requieren licencia comercial.

**Audius** (<https://docs.audius.co>):
- API gratis con API key y bearer token. El bearer es **solo para el servidor**.
- Plan Free: 10 req/s y 500.000 al mes.
- Pide **dar crédito siempre al artista**.
- `license` suele venir `null`.
- **Trae `bpm` y `musical_key`.**

**Decisión:**
- **Caché:** solo de **metadatos**, nunca de audio, y se renueva cada 24 h.
- **Crédito:** cada pista muestra artista, título, enlace a su página y licencia.
- **Pistas NC:** se marcan las que tienen licencia no comercial (`by-nc` en `license_ccurl`). Las de Audius cuentan como no comerciales porque su licencia es desconocida.
- **Opción por local:** `exclude_non_commercial` las filtra.
- **Audius es opcional:** solo se activa con `AUDIUS_API_KEY` en el servidor.
- **iTunes** se usa solo para el buscador de peticiones del público.

## Arquitectura

### Quién reproduce
El audio suena en la consola del dueño. Render gratis no puede transmitir audio continuo, y así la emisora usa el equipo de sonido del local.
- **El servidor guarda:**
  - El estado (`player_state`).
  - La cola (`play_queue`).
  - El historial (`mix_history`).
- **Posición viva:** se calcula como `position_seconds` más el tiempo desde `started_at`. Así la consola no envía el progreso cada pocos segundos.
- **Una sola consola por local:** `POST /player/claim` guarda un `console_id`. Si otra pestaña toma el control, la anterior se pausa.

### AutoDJ
- **`ensureQueue()`** mantiene al menos 5 pistas en la cola.
- **Cuándo se ejecuta:** solo con eventos (avanzar, saltar, quitar, cambiar a AutoDJ, petición aceptada y primera carga de la consola). **No hay temporizadores**, para cuidar las cuotas de Jamendo y Upstash.
- **Candado en Redis** (`SET NX EX 20`): evita dos rellenos a la vez.
- **Candidatas:** primero del caché de pistas. Si hay menos de 20, se hace **una** búsqueda por género en Jamendo, que queda cacheada 24 h.
- **`SuggestNext`** (gRPC, o `POST /suggest-next` en modo HTTP) recibe:
  - La pista actual, que es la última de la cola.
  - Las candidatas.
  - El tipo de local.
  - Los ids y artistas recientes.

  Devuelve la siguiente pista con su puntaje, la razón, el punto de transición y la duración del crossfade.

**Respaldos:**
1. **Si el motor falla:** elección simple por familia de género y energía, sin repetir (`player-logic.js`).
2. **Si Jamendo falla o se acaba la cuota:** caché, aunque esté vencido.
3. **Si no hay caché:** la pista que suena en la radio de Jamendo del género.

### Peticiones del público
El público pide desde iTunes (catálogo comercial), y la emisora solo puede sonar pistas con licencia libre. Cuando el dueño acepta una petición:
1. Se busca en Jamendo por título y artista, con coincidencia normalizada.
2. Si aparece, se intercala después de la siguiente pista y nunca hay dos peticiones seguidas.
3. Si no aparece (lo normal con música comercial), el panel avisa "No está en el catálogo libre", la petición queda aceptada y el AutoDJ favorece ese género.

### Página pública
- Muestra la pista actual con su crédito y las próximas 5 pistas.
- Se actualiza por SSE. Hay **un solo** suscriptor de Redis por proceso (`psubscribe venue:*`) que reparte los avisos, y polling cada 10 s como respaldo.
- **No reproduce audio:** se quitan los previews de iTunes de la página pública.
