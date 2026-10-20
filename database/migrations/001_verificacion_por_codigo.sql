-- Verificacion de correo y recuperacion de contrasena con codigo de 6 digitos.
-- Idempotente: se puede ejecutar varias veces sin romper datos existentes.

-- Las cuentas que ya existen quedan verificadas; las nuevas nacen sin verificar.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT FALSE;

-- Codigos de un solo uso. Solo se guarda el HMAC del codigo, nunca el codigo.
CREATE TABLE IF NOT EXISTS auth_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose VARCHAR(20) NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS auth_codes_user_purpose_idx ON auth_codes(user_id, purpose, created_at DESC);
