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
- **Host de respaldo** (observado en las pruebas del 2026-10-21: `mp3l` dejó de responder durante un rato mientras `prod-1` seguía funcionando):
  - La API también entrega `audioFallbackUrl`, que apunta a `prod-1`.
  - La consola prueba en este orden: `mp3l` con Web Audio, un reintento y después `prod-1` sin Web Audio (sin EQ). Si nada funciona, salta la pista.
  - La siguiente pista se verifica mientras se precarga, no cuando ya le toca sonar.

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
- **Cuándo se ejecuta:** solo con eventos (avanzar, saltar, quitar, cambiar a AutoDJ, petición aceptada y primera carga de la consola). **No hay temporizadores**, para cuidar las cuotas de Jamendo y Upstash. La primera carga no funcionaba (el estado del reproductor aún no existía); se corrigió en el cierre y lo cubre una prueba de integración.
- **Candado en Redis** (`SET NX EX 30`): evita dos rellenos a la vez.
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
- Desde el cierre, la página pública solo recibe los cambios de la emisora, agrupados (como mucho uno por local cada 2 s), y `/now` se calcula una vez por local cada 1,5 s. La consola del DJ pide `?view=console` y recibe también las peticiones nuevas. Ver [CARGA.md](CARGA.md).
- **No reproduce audio:** se quitan los previews de iTunes de la página pública.

## Peticiones dentro de la emisora (segunda iteración, 2026-10-22)

**Problema:**
- Los clientes pedían desde iTunes y la emisora sonaba con Jamendo: lo pedido no sonaba.
- Además, el dueño podía marcar una petición como "Sonada" a mano sin que hubiera sonado.

### Verificación previa (solo lectura)

**CORS de los previews de iTunes:** HEAD y GET con `Range` a `audio-ssl.itunes.apple.com/itunes-assets/...m4a`, desde el origen de Vercel y desde `localhost:5173`. Responden:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Headers: range`
- `Accept-Ranges: bytes`

**Decisión:** el preview pasa por Web Audio como cualquier pista, con EQ y fundido. Si en algún navegador falla, aplica el mismo respaldo por deck: sin Web Audio, con volumen y fundido.

**Términos de iTunes Search** (<https://performance-partners.apple.com/search-api>):
- El contenido promocional (previews) se permite "only to promote store content and not for entertainment purposes".
- Debe estar junto a un enlace a la tienda.
- Debe llevar la atribución "provided courtesy of iTunes".
- Debe hacerse "streamed only, and not downloaded, saved, cached".
- Límite de unas 20 llamadas por minuto, con caché recomendado.

**Choque con los términos:** reproducir previews en la emisora de un local es entretenimiento, no promoción. Se implementa porque se pidió para el proyecto académico, con estas condiciones:
- Solo se reproduce en streaming desde Apple: nunca se guarda el audio, solo la URL en `track_cache`.
- Se muestra "Preview 30 s · cortesía de iTunes" con enlace a la página de la canción en Apple.
- Las búsquedas a iTunes quedan en caché de Redis 10 minutos.

**Para un uso real, quitar el corte de previews** y dejar solo música con licencia (ver "Licencias de la música" en el README).

**Jamendo `/tracks`** (<https://developer.jamendo.com/v3.0/tracks>):
- `order=popularity_*` usa orden descendente siempre.
- `boost=popularity_*` es lo indicado al combinar texto (`search`) con popularidad.
- `tags` filtra con AND y `fuzzytags` con OR.
- `durationbetween=desde_hasta` filtra por duración en segundos.

**Decisión:**
- **Buscador:** `search` + `boost=popularity_total`.
- **Candidatas del AutoDJ:** `fuzzytags` con los géneros del tipo de local y los que aparecen en la descripción del ambiente, `order=popularity_month` y `durationbetween=90_480`. Así se evitan fragmentos muy cortos y mezclas de una hora.

### Diseño

**Buscador público:**
- Primero Jamendo, que da pistas completas: "Completa".
- Si hay menos de 5 resultados, completa con iTunes: "Preview 30 s".
- Los duplicados (mismo título y artista) se quedan con la versión completa.

**Petición:**
- Guarda el `provider` y la pista (`track_id` para Jamendo; `external_id`, `preview_url` y `store_url` para iTunes). Lo agrega la migración `008`.
- Al programarla, una petición de iTunes busca primero su versión completa en Jamendo. Si no existe, entra a la cola como "corte de petición": el preview de 30 s con fundido de salida de 4 s, y después sigue el AutoDJ.

**"Sonada":**
- Solo cuando la pista sale de la emisora después de sonar: terminó o el dueño la saltó.
- Si no cargó (error), sigue pendiente.
- El dueño ya no puede marcarla a mano.
- `mix_history.request_id` deja constancia.
- La migración 008 devuelve a "aceptada" las peticiones marcadas como sonadas que no tienen ese registro.

**AutoDJ:**
- En modo AutoDJ intercala las peticiones que el motor aceptó (género y energía compatibles), como mucho dos a la vez en la cola y nunca seguidas.
- Las que el motor no aceptó ("con transición") esperan la decisión del dueño en la consola.
- Los géneros y artistas de las peticiones recientes viajan a `SuggestNext` (`request_genres`, `request_artists`) y suben el puntaje de las candidatas parecidas.

## Cierre: carga de la demo (2026-10-23)

La prueba de carga local ([CARGA.md](CARGA.md)) simuló 150 personas en el mismo Wi-Fi pidiendo canciones mientras la emisora sonaba. Cambios que afectan a la emisora:
- **Límites por cliente:** el público se cuenta por IP + identificador anónimo del navegador, con un tope por IP. Antes, el 83 % de las peticiones recibía 429 porque todos compartían la IP del local.
- **Evaluación en paralelo:** el worker evalúa 6 peticiones a la vez. De a una, las pausas de las etapas del motor (~0,75 s) limitaban a ~80 por minuto.
- **Avisos agrupados y `/now` compartido:** se evita que cada aviso dispare una consulta de cada celular conectado.
- **Una sola suscripción de Redis** para los SSE de las peticiones; antes había una conexión por cliente.
- **Búsquedas deduplicadas:** las búsquedas iguales simultáneas consultan a Jamendo o iTunes una vez, y la canción de iTunes de cada petición se recuerda 10 minutos.

## Peticiones automáticas en AutoDJ (2026-10-24)

**Problema:** en AutoDJ solo entraban solas las peticiones que "encajaban", con un máximo de dos en la cola. Muchas se quedaban en la pestaña Peticiones esperando al dueño y nunca sonaban.

**Decisión:** en AutoDJ, con el interruptor **"Aceptar peticiones automáticamente"** activo (por defecto), toda petición válida entra sola a la cola. La IA decide el **orden** y el **momento**, no si entra. La compatibilidad con la pista actual solo cuenta para el orden y la transición.

### Algoritmo de prioridad (`backend/src/request-priority.js`)
1. **Orden de llegada:** primero en pedir, primero en sonar.
2. **Ajuste suave:** se mira una ventana con las N+1 peticiones más antiguas (N = `REQUEST_MAX_DEFERRAL`, 3 por defecto) y se elige la de mejor puntaje:
   - −1 por cada puesto de llegada.
   - +1 por cada duplicación de votos (log₂).
   - +3 por cada clic del dueño en "subir" (−3 en "bajar").
   - Hasta +1,5 según qué tan suave es la transición con la pista anterior: familia de género y energía.

   Así se evita un choque brusco de género o energía adelantando o atrasando una petición unas posiciones, nunca más allá de la ventana.
3. **Límite de aplazamiento:**
   - `passed_count` guarda cuántas peticiones que llegaron después ya sonaron antes que esta.
   - El plan también cuenta los saltos que él mismo propone.
   - Una petición que llegó a N suena antes que cualquier otra, así que **ninguna se aplaza más de N turnos** y todas suenan.
4. **Equilibrio:** si hay más de K peticiones (K = `REQUEST_BALANCE_EVERY`, 4 por defecto), después de cada K seguidas va una pista elegida por la IA. Con pocas suenan seguidas. Sin peticiones, el AutoDJ sigue como siempre.
5. **La siguiente no se mueve:** mientras algo suena, la primera de la cola queda fija, porque la consola ya puede haberla precargado.
6. **Pistas de la IA necesarias:** las del equilibrio, las que faltan para el mínimo de 5 y siempre una al final, para que la cola nunca quede vacía. Como máximo 8 llamadas al motor por pasada.

Todo se recalcula solo por eventos (petición evaluada, avanzar, saltar, quitar, subir o bajar, activar el interruptor), nunca con temporizadores.

### Reglas de entrada
- **Duplicados → votos:**
  - Si alguien pide una canción que ya está pendiente (misma `song_key` = proveedor:id), la nueva fila apunta a la original (`duplicate_of`) y suma un voto. Un candado por local y canción (`pg_advisory_xact_lock`) evita originales repetidas cuando llegan a la vez.
  - Si dos peticiones distintas resuelven la misma pista (una de iTunes con su versión completa de Jamendo, por ejemplo), también quedan como voto.
  - Si la IA ya había puesto esa pista en la cola, ese lugar pasa a ser de la petición.
- **Justicia por cliente:**
  - Como máximo `REQUEST_MAX_PENDING_PER_CLIENT` (3) pendientes por navegador, contadas con una huella anónima (sha256) del identificador de cliente + IP.
  - Tope por IP 30 veces mayor (el Wi-Fi del local).
  - Si se supera: 429 `too_many_pending` con un mensaje en español.
- **Pista reciente:** si sonó en los últimos `REQUEST_REPLAY_WAIT_MINUTES` (30), la petición queda aceptada con `not_before`. El cliente ve "En la cola" con la espera, y entra a la cola al cumplirse. Los intentos fallidos no cuentan como "sonó".
- **iTunes:** entra igual que las demás y suena como corte de 30 s con fundido, con la etiqueta "Preview 30 s".
- **Motor caído:** tras 3 intentos, la petición entra igual a la cola sin evaluación.
- **Interruptor apagado o modo Manual:** las peticiones quedan en la pestaña Peticiones para que decida el dueño. Sin la migración 010 se mantiene el comportamiento anterior.

### Estados y anti-abuso
- **Estados:** En evaluación → En la cola (con puesto y espera estimada) → Sonando ahora → Sonada. También Descartada, No se pudo reproducir y Esperando al DJ (interruptor apagado o Manual).
- **Espera estimada:** lo que falta de la pista actual (hasta su punto de transición) más la duración de cada pista anterior. Si no hay dato, cuenta 180 s.
- **"Sonada"** solo cuando la petición salió de la emisora después de sonar. Sus votos quedan sonados con ella.
- **Fallo al reproducir:** el primero se reintenta (vuelve a la cola); con el segundo queda "No se pudo reproducir" y la emisora sigue.
- **Dueño:** puede quitar de la cola (queda descartada y no vuelve a entrar), subir o bajar prioridad, y bloquear. Al bloquear, la canción va a `blocked_songs` y nuevas peticiones de ella se rechazan.
- **Explícitas:** filtro opcional por local (`block_explicit`), con la marca `trackExplicitness` de iTunes. Jamendo no la informa.

### Migración 010
`010_peticiones_automaticas.sql`, idempotente:
- Agrega las columnas y `blocked_songs` con RLS.
- Completa `song_key` en las peticiones existentes.
- Pasa a "aceptada" las que quedaron sin evaluar. Con el interruptor activo, entran a la cola por orden de llegada en el siguiente evento de la emisora.
- Las pendientes de más de 24 h se consideran vencidas y no entran: es la misma ventana que ya usaba la consola.
