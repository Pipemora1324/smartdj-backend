# SmartDJ Backend

API de SmartDJ: gateway Nginx, API Express, motor FastAPI/librosa, PostgreSQL y Redis/BullMQ.

## Ejecutar en local

Requiere Docker con Docker Compose.

1. Copia `.env.example` como `.env` y cambia todos los valores `CAMBIAR_ESTO` (contraseña de la base de datos y claves JWT de al menos 32 caracteres).
2. Ejecuta:

   ```bash
   docker compose up --build
   ```

3. Comprueba que responde: `http://localhost:3000/api/health`.

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
