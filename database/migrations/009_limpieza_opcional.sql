-- =====================================================================================
-- 009 · LIMPIEZA OPCIONAL — EJECUTAR A MANO SOLO TRAS CONFIRMAR
-- =====================================================================================
-- Borra tablas y columnas que ningún código usa desde la migración a Supabase Auth.
-- Detalle y evidencia en LIMPIEZA.md.
--
-- NO se monta en docker-compose.yml ni se aplica sola. Antes de ejecutarla:
--   1. Haz un respaldo (Supabase: Database → Backups, o pg_dump).
--   2. Confirma que el backend desplegado es el de la limpieza (sin /api/auth/login ni mailer).
--   3. Ejecútala en el SQL Editor. Es idempotente: se puede repetir sin error.
--
-- Lo que borra NO se puede recuperar sin el respaldo:
--   - auth_codes:       códigos de 6 dígitos de la auth propia (Fase 1).
--   - password_resets:  tokens de recuperación de la auth propia.
--   - refresh_tokens:   nunca se creó en este proyecto; se incluye por si existiera.
--   - songs:            catálogo inicial sin uso (las pistas viven en track_cache).
--   - users.password_hash: las contraseñas las guarda Supabase Auth.
--   - mix_history.song_id: el historial usa track_id desde la 006.
-- =====================================================================================

BEGIN;

DROP TABLE IF EXISTS auth_codes;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS refresh_tokens;

-- mix_history.song_id apunta a songs: primero la columna, después la tabla.
ALTER TABLE IF EXISTS mix_history DROP COLUMN IF EXISTS song_id;
DROP TABLE IF EXISTS songs;

ALTER TABLE IF EXISTS users DROP COLUMN IF EXISTS password_hash;

COMMIT;
