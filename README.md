# SmartDJ Backend

API de SmartDJ: gateway Nginx, API Express, motor FastAPI/librosa, PostgreSQL y Redis/BullMQ.

## Ejecutar en local

Requiere Docker con Docker Compose.

1. Copia `.env.example` como `.env` y cambia todos los valores `CAMBIAR_ESTO` (ver [Variables](#variables)). El servidor no arranca si falta `SUPABASE_URL` o `SUPABASE_JWKS_URL`.
2. Ejecuta:

   ```bash
   docker compose up --build
   ```

3. Comprueba que responde: `http://localhost:3000/api/health`.

## Variables

| Variable | Uso |
| --- | --- |
| `SUPABASE_URL` | URL del proyecto, `https://<ref>.supabase.co`. Obligatoria: con ella se valida el emisor de los tokens. |
| `SUPABASE_JWKS_URL` | `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`. Claves públicas para validar los tokens (RS256/ES256). No es un secreto. |
| `SUPABASE_JWT_SECRET` | **Solo** si el proyecto sigue con el secreto HS256 heredado. Es un secreto: va únicamente en Render. No está en `.env.example` a propósito, para que nadie copie un valor de ejemplo como secreto real. |

Hace falta `SUPABASE_JWKS_URL` o `SUPABASE_JWT_SECRET`; lo recomendado es usar claves asimétricas y solo el JWKS.

Las variables `SMTP_*` y `MAIL_FROM` ya no se usan: los correos los envía Supabase.

## Migraciones

Los cambios de esquema están en `database/migrations/` y se pueden ejecutar más de una vez sin romper datos.

- **Docker local:** se aplican solos al crear el volumen de Postgres por primera vez. Si ya tenías el volumen, ejecútalos a mano:

  ```bash
  docker compose exec -T postgres psql -U smartdj -d smartdj < database/migrations/001_verificacion_por_codigo.sql
  docker compose exec -T postgres psql -U smartdj -d smartdj < database/migrations/002_supabase_auth.sql
  ```

- **Supabase:** copia el contenido de cada archivo, en orden, en el SQL Editor y ejecútalo.

## Autenticación

El registro, la verificación del correo, el inicio de sesión y la recuperación de contraseña los hace **Supabase Auth** desde el frontend. Supabase envía los códigos de 6 dígitos con el SMTP de Gmail configurado en su panel. La configuración completa está en [SUPABASE_AUTH.md](SUPABASE_AUTH.md).

- La API recibe el access token de Supabase como `Authorization: Bearer <token>` y lo valida con el JWKS: firma, emisor, audiencia `authenticated` y vencimiento.
- `GET /api/auth/me`: devuelve el perfil. La primera vez crea la fila en `users`, vinculada por `auth_id`, si el correo está confirmado.
- Las rutas de la auth propia anterior (`/register`, `/login`, `/verify-email`, `/forgot-password`, etc.) responden **410**.

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
