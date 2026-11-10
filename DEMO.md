# Guía de demostración

Cómo presentar SmartDJ con la cuenta de demostración `admin123@example.com` y sus 4 locales de ejemplo.
La contraseña no está escrita en ningún archivo: la entrega quien presenta.

## 1. Preparar la cuenta (una sola vez)

1. **Supabase → Authentication → Users → Add user:** correo `admin123@example.com`, una contraseña de al menos 8 caracteres y **Auto Confirm User** activado. La cuenta no puede recibir correos, así que debe quedar confirmada desde el panel.
2. **Entra una vez a la app** con esa cuenta. El backend crea su fila en `users` en la primera sesión (la vincula por `auth_id`). El panel aparecerá vacío.
3. **Supabase → SQL Editor:** pega y ejecuta `database/seeds/demo_admin.sql`.
   - Debe responder `Datos de demostración listos: 4 locales y 12 peticiones de ejemplo.`
   - Si dice `No existe el usuario admin123@example.com en users`, falta el paso 2.
   - Se puede repetir sin duplicar nada. Los códigos públicos no cambian, así que los links y los QR impresos siguen sirviendo.
4. Recarga el panel: aparecen los 4 locales.

| Local | Tipo | Código público |
| --- | --- | --- |
| Club Nébula | Discoteca | `6e4c4a987fa0` |
| La Esquina del Son | Bar de salsa | `da2e4d6d9043` |
| Café Grano Alto | Café | `9fec367bf8fb` |
| La Mesa de Inés | Restaurante | `b07c53e3d816` |

El link público de cada local es `<dominio del frontend>/?venue=<código>`.

Cada local trae dos peticiones que ya sonaron (con su historial) y una que el motor rechazó. Ninguna queda pendiente, así que el AutoDJ no intenta ponerlas en la cola. Mientras la emisora está apagada, la página pública muestra como "sonando" la última petición de ejemplo; al iniciar la emisora pasa a mostrar la pista real.

## 2. Antes de presentar (5 minutos antes)

1. **Despierta el backend.** Render gratis se duerme tras 15 minutos sin tráfico y tarda alrededor de un minuto en arrancar. Abre `https://smart-dj-platform.onrender.com/api/health` hasta que responda `{"status":"ok"}`.
2. **Abre el frontend** e inicia sesión con la cuenta demo.
3. **Abre la consola de DJ** del local que vas a mostrar (por ejemplo, La Esquina del Son) y pulsa **▶ Iniciar emisora**. El audio suena en la consola del dueño, así que deja el volumen del computador listo.
4. **Ten a mano un celular** con datos o con el Wi-Fi del salón para escanear el QR.
5. Opcional: deja abiertos los **logs de Render** del servicio `smart-dj-platform` en otra pestaña.

## 3. Orden recomendado

1. **Landing:** qué problema resuelve (la música del local la decide el público, con una IA que cuida el ambiente).
2. **Login:** entra con `admin123@example.com`. La autenticación es de Supabase; la API solo valida el token.
3. **Panel con los 4 locales:** cuatro tipos distintos, cada uno con su descripción de ambiente. El AutoDJ usa ese texto y el tipo para escoger géneros.
4. **QR:** abre el QR de un local y escanéalo con el celular. El cliente no inicia sesión.
5. **Consola de DJ:** la emisora sonando, la cola, el modo AutoDJ y el interruptor "Aceptar peticiones automáticamente".
6. **Pedir una canción desde el celular:** búscala en la página pública y envíala. En la consola aparece la petición, entra a la cola en el orden que decide la IA y suena cuando le llega el turno.
7. **Flujo de gRPC con las etapas:** al enviar la petición, la página pública muestra en vivo las etapas `QUEUED → ANALYZING_GENRE → ANALYZING_BPM → ANALYZING_KEY → RESULT`, cada una con su mensaje y su puntaje parcial. Detalle en [DECISIONES_GRPC.md](DECISIONES_GRPC.md).

Si una petición se pide con una canción que no encaja (por ejemplo, rock en el bar de salsa), el motor la rechaza y explica por qué: sirve para mostrar el criterio de la IA.

## 4. Qué mostrar de gRPC

- **Contrato:** [`ai/proto/compatibility.proto`](ai/proto/compatibility.proto). Tres RPC: `CheckCompatibility` (unario), `StreamEvaluation` (streaming del servidor, las etapas) y `SuggestNext` (el AutoDJ). Hay una copia idéntica en `backend/proto/` y `npm test` verifica que coincidan.
- **Logs de Render:** al arrancar aparecen, en orden, `[combined] gRPC listo en 127.0.0.1:50051`, `[combined] Iniciando el backend` y `API escuchando`. El motor y el backend viven en el mismo contenedor y hablan por gRPC en localhost, porque Render gratis no permite gRPC entre servicios.
- **Prueba en vivo en local:** con `docker compose up` corriendo, desde `backend/`:

  ```bash
  node scripts/grpc-smoke.mjs localhost:50051
  ```

  Llama a `CheckCompatibility` y a `StreamEvaluation` y muestra las etapas una por una. Es solo para local (sin TLS); no lo apuntes a producción.

## 5. Después de presentar

1. **Supabase → SQL Editor:** ejecuta `database/seeds/demo_admin_cleanup.sql`. Borra los 4 locales (con sus peticiones, historial, cola y estado del reproductor) y la fila de `admin123@example.com` en `users`. También borra cualquier otro local que se haya creado con esa cuenta durante la presentación.
2. **Supabase → Authentication → Users:** borra el usuario `admin123@example.com`. El cleanup no toca `auth.users`.
3. Si vas a presentar otra vez, repite la sección 1 completa.
