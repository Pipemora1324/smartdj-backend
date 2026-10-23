# Prueba de carga de la demo

> **NUNCA EJECUTAR CONTRA PRODUCCIÓN.** Todo corre en Docker local: la API, Postgres, Redis y dobles de Supabase,
> Jamendo e iTunes. Los scripts solo aceptan un backend local (`http://api`, `localhost` o `127.0.0.1`).

## Objetivo

En la demo, unas 100 personas por minuto piden canciones desde la página pública del local. Esta prueba responde:
- ¿Aguanta el contenedor de Render (512 MB) sin errores?
- ¿Dónde están los cuellos de botella?
- ¿Cabe dentro de los planes gratis de Render, Supabase y Upstash?

## Cómo se ejecuta

```bash
bash load/run.sh antes                               # 1 CPU, la página sin identificador de cliente
CLIENT_ID=1 bash load/run.sh despues                 # 1 CPU, como el frontend actual
LOAD_CPUS=0.1 CLIENT_ID=1 bash load/run.sh render    # la CPU real de Render gratis
```

`load/run.sh` hace todo:
1. Levanta `load/docker-compose.yml`.
2. Corre k6 y 100 clientes SSE.
3. Muestrea memoria, CPU, conexiones a Redis y a Postgres cada 3 s.
4. Deja el resumen en `load/results/<etiqueta>/resumen.json`. `load/results/` está en `.gitignore`.

### Réplica del despliegue

| Pieza | En la prueba | En producción |
| --- | --- | --- |
| API + motor | El mismo `Dockerfile.combined`, `mem_limit: 512m`, `cpus: 1` o `0.1` | Render gratis: 512 MB, **0,1 CPU** |
| Base de datos | Postgres 16 con `max_connections=60` y las migraciones 001–008 | Supabase gratis (Nano): 60 conexiones directas, 200 clientes en el pooler |
| Redis | Redis 7 local | Upstash gratis: 500K comandos al mes, 10K por segundo |
| Jamendo e iTunes | Dobles con 300 ms de latencia que cuentan sus llamadas | APIs reales |
| Supabase Auth | JWKS local con clave EC generada en la prueba | Supabase real |

### Escenario (`load/k6/demo.js` y `load/sse-clients.mjs`)

- **Público, 150 usuarios virtuales:**
  - Llegan en 60 s, se quedan 60 s y se van en 10 s.
  - Todos salen por **la misma IP**, como en el Wi-Fi de un local.
  - Cada uno:
    1. Abre la página (local y `/now`).
    2. Busca dos veces, como al escribir.
    3. Pide una canción: mitad de Jamendo y mitad de iTunes.
    4. Sigue su petición por SSE y consulta sus peticiones.
    5. Consulta `/now` cada 10 s durante un minuto, como el respaldo de la página sin SSE.
- **100 celulares con el SSE del local abierto**, que piden `/now` tras cada aviso, igual que la página.
- **La consola del DJ** con la emisora sonando en AutoDJ: refresca su estado y las peticiones, y avanza de pista cada ~30 s.

## Resultados

| | Antes (1 CPU) | Después (1 CPU) | Después (0,1 CPU, Render gratis) |
| --- | --- | --- | --- |
| Peticiones HTTP / RPS | 3.325 / 21,9 | 3.965 / 26,2 | 2.019 / 13,1 |
| **Fallidas** | **83,2 %** | **0 %** | 0,2 % |
| Respuestas 429 | 2.766 | 0 | 0 |
| Respuestas 5xx | 0 | 0 | 0 |
| Checks del público | 19 % | 100 % | 99,6 % |
| p50 / p95 / p99 | 2 / 10 / 628 ms (los 429 son rápidos) | 3 / 760 / 765 ms | 1,6 / 16,9 / 21,3 s |
| SSE del local abiertos / rechazados | 90 / 2.240 (429) | 100 / 0 | 100 / 0 |
| Avisos recibidos por los 100 SSE | 3.480 | 800 | 300 |
| Memoria máxima del contenedor | 108 MiB | 104 MiB | 113 MiB |
| Clientes de Redis (máximo) | 9 | 6 | 6 |
| Conexiones a Postgres (máximo) | 11 | 11 | 11 |
| Llamadas a Jamendo / iTunes | 21 / 20 | 16 / **8** | 16 / 8 |
| Comandos de Redis de toda la corrida | — | 33.873 | — |

### Latencia por endpoint (después)

| Endpoint | 1 CPU: p50 / p95 | 0,1 CPU: p50 / p95 |
| --- | --- | --- |
| Local (`/venues/:code`) | 2 / 5 ms | 9,1 / 22,7 s |
| `/now` | 2 / 5 ms | 6,0 / 13,8 s |
| Buscar | 5 / 8 ms | 1,1 / 2,3 s |
| Pedir | 7 / 12 ms | 1,4 / 2,9 s |
| Resultado por SSE de la petición | 760 / 769 ms | 8,3 / 19,4 s |
| Mis peticiones | 4 / 7 ms | 0,6 / 1,5 s |
| Consola: estado | 18 / 52 ms | 8,7 / 20,7 s |
| Consola: avanzar | 33 / 69 ms | 1,7 / 3,1 s |

Los ~760 ms del resultado por SSE son intencionales: el motor hace pausas de 250 ms entre las etapas para que se vean en la página.

## Qué se encontró y qué se corrigió

1. **Límite por IP con 100 personas en el mismo Wi-Fi** (`rate-limits.js`). Era el problema más grave: el 83 % de las peticiones recibía 429.
   - Los límites públicos (10 peticiones por minuto, 30 búsquedas, 120 lecturas, 20–30 conexiones SSE) se contaban **por IP**, y en un local todos comparten la IP pública.
   - Ahora cada ruta pública tiene **dos límites**:
     - **Por cliente:** IP + un identificador anónimo del navegador (`X-Client-Id`, o `?client=` en EventSource).
     - **Por IP:** un tope 30 veces mayor, que alcanza para ~300 personas en el mismo Wi-Fi y frena a quien invente identificadores.
   - El identificador no da permisos: solo separa contadores.
   - Sin identificador, se cuenta por IP como antes.
   - `trust proxy` sigue en 1, el proxy de Render.
2. **Avalancha de `/now` tras cada aviso** (`venue-events.js`, `live-hub.js`).
   - Cada petición nueva de cualquier persona llegaba como aviso a **todos** los celulares, y cada uno pedía `/now`.
   - Ahora la página pública solo recibe los cambios que muestra (`player_updated` y `request_updated`), agrupados: como mucho un aviso por local cada 2 s.
   - La consola del DJ (`?view=console`) sigue recibiendo todo.
   - En el frontend, el refresco tras un aviso tiene un desfase aleatorio de 0 a 2 s.
   - Resultado: de 3.480 a 800 avisos.
3. **`/now` calculado una vez por local** (`memo.js`): microcaché de 1,5 s con deduplicación. 100 consultas simultáneas hacen una sola consulta a la base de datos.
4. **Una conexión a Redis por cada SSE de petición.**
   - Cada SSE abría su propia conexión (`redis.duplicate()`), y en Upstash eso suma conexiones, latencia TLS y comandos.
   - Ahora hay una sola suscripción compartida por proceso (`PSUBSCRIBE request-events:*`), con una prueba que lo verifica.
   - Los clientes de Redis quedan fijos en 6: app, worker, cola, avisos de locales, estado de peticiones y la herramienta de medición.
5. **Búsquedas repetidas a Jamendo e iTunes.**
   - Las búsquedas iguales simultáneas comparten una sola consulta (single-flight).
   - La canción de iTunes de cada petición (`/lookup`) se recuerda 10 minutos.
   - iTunes pasó de 158 llamadas (en la primera corrida corregida) a 8.
6. **Cola de evaluación** (`queue.js`).
   - El worker evaluaba de a una petición, y cada una dura ~0,75 s por las pausas de las etapas. El tope eran ~80 por minuto y la demo genera ~150, así que la cola crecía y los SSE llegaban a 20 s.
   - Ahora evalúa 6 a la vez. El servidor gRPC del motor tiene 10 hilos.
7. **Pool de Postgres** (`db.js`): `DATABASE_POOL_MAX`, 10 por defecto y máximo 50.
   - Espera de 5 s antes de fallar, en lugar de colgar la petición.
   - Cierre de conexiones inactivas a los 30 s.
   - Manejador de `error`, porque sin él un corte del pooler tumbaba el proceso.
   - Con 10 conexiones queda margen dentro de las 60 directas de Supabase gratis.
8. **Apagado**: con SSE abiertos el proceso no salía al recibir SIGTERM. Ahora sale en ~2 s.

Además se encontró y corrigió un bug con las pruebas de integración: en la **primera** carga de la consola, el AutoDJ no llenaba la cola porque el estado del reproductor aún no existía.

## Límites de los planes gratis y conclusiones

- **Render gratis: 0,1 CPU y 512 MB.**
  - La memoria sobra: el máximo fue 113 MiB, frente a 512.
  - La CPU no alcanza para responder rápido al escenario completo:
    - No hay errores ni rechazos (0,2 % de fallidas).
    - Pero la mediana sube a 1,6 s y el p95 a 17 s.
  - El perfil de CPU no muestra nada anómalo: ~4,6 ms de CPU por petición, repartidos entre sockets, Postgres, Express y el recolector de basura.
  - **Recomendación para la demo:**
    - Subir el servicio a un plan con más CPU durante la demo (por ejemplo Starter, 0,5 CPU).
    - O aceptar la latencia.
    - En cualquier caso, abrir la página 2–3 minutos antes: Render gratis duerme el servicio tras 15 minutos sin tráfico y despertarlo tarda cerca de un minuto.
- **Supabase gratis:** 60 conexiones directas y 200 clientes en el pooler. La API usa como mucho 10 (`DATABASE_POOL_MAX`), con la medición incluida: 11.
- **Upstash gratis: 500K comandos al mes.**
  - Una demo de 2 minutos con 150 peticiones consume **~34K comandos**, un 7 % del cupo.
  - ~70 % son de BullMQ (encolar, mover y cerrar cada trabajo) y ~6K del estado en vivo de cada petición.
  - Alcanza para unas 14 demos completas al mes, además del consumo en reposo, ya reducido con `drainDelay`.
  - Si hiciera falta más margen, el siguiente paso sería evaluar las peticiones sin BullMQ.
- **Conexiones a Upstash:** la página de precios no publica un tope para el plan gratis. Con los cambios, la API mantiene 5 conexiones fijas sin importar cuántas personas estén conectadas.
- **IP real detrás de Render:** la prueba local no puede confirmar qué IP ve Express en Render (`trust proxy` 1).
  - Si fuera la del proxy y no la del cliente, el límite por cliente seguiría separando a las personas.
  - Solo el tope por IP (×30) sería compartido.

Fuentes de los límites: [Render, instancias](https://render.com/docs/free), [Supabase, cómputo y conexiones](https://supabase.com/docs/guides/platform/compute-and-disk), [Upstash, precios](https://upstash.com/docs/redis/overall/pricing).
