# SmartDJ Backend

Plataforma para locales (cafeterías, restaurantes, bares). El dueño crea cuenta, registra locales y cada local tiene un link público y un QR; los clientes no inician sesión, piden canciones desde ese link.

- `backend/`: API Node.js + Express (auth, locales, peticiones, cola BullMQ).
- `ai/`: motor FastAPI de compatibilidad musical.
- `database/`: `init.sql` y migraciones en `database/migrations/` (idempotentes).
- Despliegue: backend y ai en Render, PostgreSQL en Supabase, Redis en Upstash. El frontend vive en el repo `smartdj-frontend` (Vercel).
- **Autenticación: Supabase Auth.** Registro, códigos de 6 dígitos (SMTP de Gmail en el panel de Supabase), login y recuperación se hacen desde el frontend. La API solo valida el token con JWKS (`supabase-token.js`) y usa `requireSupabaseAuth` (`supabase-auth.js`), que vincula la cuenta con `users.auth_id`; `req.user.sub` es el `users.id` local. La auth propia de la Fase 1 (`codes.js`, `auth.js`, rutas de `routes/auth.js`) queda sin uso y responde 410: no volver a usarla. Guía en `SUPABASE_AUTH.md`.

## Reglas fijas

- **Idioma del código:** todo en inglés: variables, funciones, archivos, rutas, tablas y columnas nuevas.
- **Idioma de los textos:** comentarios nuevos y textos para el usuario (errores de la API, correos, pantallas, logs de la app) en español.
- **Comentarios existentes:** no modificarlos ni eliminarlos, aunque el código de al lado cambie.
- **Commits:** pequeños (un cambio lógico por commit), mensajes cortos en español sin punto final, sin `Co-Authored-By` ni menciones de IA. Usar el git config del usuario sin cambiarlo.
- **Secretos:** no leer ni tocar `.env`. En `.env.example` solo placeholders `CAMBIAR_ESTO`.
- **Git remoto:** no hacer push sin confirmación del usuario. Nunca usar `--force` ni reescribir el historial.
- **Trabajo por fases:** una fase a la vez. Al terminar cada una, detenerse y decir qué hay que configurar en Render, Vercel o Supabase.
- **Comunicación backend ↔ ai:** en una fase próxima pasará a gRPC (con streaming). Todavía no existe el `.proto`; no asumir su forma.
