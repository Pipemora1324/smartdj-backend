-- Autenticacion con Supabase Auth: el correo, la contrasena y los codigos viven en Supabase.
-- Idempotente: se puede ejecutar varias veces sin romper datos existentes.

-- Vinculo con auth.users.id de Supabase. Sin clave foranea para que el Postgres local (sin esquema auth) funcione.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_id UUID UNIQUE;

-- Las cuentas creadas desde Supabase no tienen contrasena local.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
