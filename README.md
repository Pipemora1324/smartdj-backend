# SmartDJ Backend

API de SmartDJ: gateway Nginx, API Express, motor FastAPI/librosa, PostgreSQL y Redis/BullMQ.

## Ejecutar en local

Requiere Docker con Docker Compose.

1. Copia `.env.example` como `.env` y cambia todos los valores `CAMBIAR_ESTO` (ver [Variables](#variables)). El servidor no arranca si falta alguna clave o si tiene menos de 32 caracteres.
2. Ejecuta:

   ```bash
   docker compose up --build
   ```

3. Comprueba que responde: `http://localhost:3000/api/health`.

## Variables

| Variable | Uso |
| --- | --- |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Firman los tokens. Obligatorias, 32 caracteres o más y distintas entre sí. |
| `AUTH_CODE_SECRET` | Clave del HMAC con que se guardan los códigos de 6 dígitos. Obligatoria, 32 caracteres o más. |
| `RESEND_API_KEY` | Envío de correos con [Resend](https://resend.com). Déjala vacía si no la usas. |
| `MAIL_FROM` | Remitente. Con Resend debe ser de un dominio verificado. |
| `SMTP_*` | Alternativa a Resend. |

Genera claves aleatorias con `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

Si no hay `RESEND_API_KEY` ni SMTP, los códigos de verificación y recuperación se imprimen **solo en el log del servidor**, nunca en la respuesta de la API.

## Migraciones

Los cambios de esquema están en `database/migrations/` y se pueden ejecutar más de una vez sin romper datos.

- **Docker local:** se aplican solos al crear el volumen de Postgres por primera vez. Si ya tenías el volumen, ejecútalos a mano:

  ```bash
  docker compose exec -T postgres psql -U smartdj -d smartdj < database/migrations/001_verificacion_por_codigo.sql
  ```

- **Supabase:** copia el contenido del archivo en el SQL Editor y ejecútalo.

## Autenticación

- `POST /api/auth/register`: crea la cuenta sin verificar y envía un código de 6 dígitos.
- `POST /api/auth/verify-email` `{email, code}`: verifica la cuenta e inicia sesión.
- `POST /api/auth/resend-code` `{email}`: reenvía el código (60 s de espera entre envíos).
- `POST /api/auth/forgot-password` `{email}` y `POST /api/auth/reset-password` `{email, code, password}`: recuperación con código.
- Los códigos vencen en 10 minutos, son de un solo uso y se invalidan tras 5 intentos fallidos.
- `POST /api/auth/logout` revoca los tokens en Redis. Cambiar la contraseña cierra todas las sesiones.

## Puertos

| Puerto | Servicio |
| --- | --- |
| 3000 | API directa (la que usa el frontend en local) |
| 8080 | Gateway Nginx (`/api/`, con límite de 5 intentos de login por minuto por IP) |

## Servicios

| Servicio | Responsabilidad |
| --- | --- |
| gateway | Reverse proxy de `/api/` y límite de intentos de login |
| backend | REST, tokens JWT y cookies HttpOnly, cola y persistencia |
| ai | BPM/tonalidad con librosa y compatibilidad/transición por heurísticas |
| postgres / redis | Datos relacionales, caché, pub/sub y BullMQ |

## CORS

Solo se aceptan los orígenes de `knownOrigins` en `backend/src/config.js` y los que se agreguen en `CORS_ORIGIN` (separados por coma). Para un nuevo dominio del frontend, agrégalo a `CORS_ORIGIN`.

## Frontend

El frontend está en el repositorio `smartdj-frontend`.
