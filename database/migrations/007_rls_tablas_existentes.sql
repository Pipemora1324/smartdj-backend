-- Seguridad en Supabase: activa RLS en las tablas que ya existían.
-- Sin RLS, cualquiera con la clave anon (que es pública, va en config.js del frontend) puede leer o escribir
-- estas tablas por la API REST de Supabase (/rest/v1/...). El backend se conecta como dueño de las tablas,
-- así que RLS sin políticas no lo afecta. Idempotente: solo actúa sobre las tablas que existen.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','establishments','songs','song_requests','mix_history','refresh_tokens','password_resets','auth_codes']
  LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;
