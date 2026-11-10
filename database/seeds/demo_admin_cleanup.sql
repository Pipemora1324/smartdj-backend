-- =====================================================================================
-- LIMPIEZA DEL SEED DE DEMOSTRACIÓN · SOLO DESPUÉS DE PRESENTAR
-- =====================================================================================
-- Borra lo que creó database/seeds/demo_admin.sql y la fila de admin123@example.com en users.
-- No toca auth.users: el usuario de Supabase Auth se borra a mano (Authentication → Users).
--
-- Al borrar los locales se borran también, en cascada, sus peticiones, historial, estado del reproductor,
-- cola y canciones bloqueadas (incluido lo que se haya pedido durante la presentación).
-- Al borrar la fila de users se borra también cualquier otro local que se haya creado con esa cuenta.
--
-- Idempotente: si ya no queda nada, solo avisa (NOTICE). Va en una transacción.
-- =====================================================================================

BEGIN;

DO $$
DECLARE
  demo_owner UUID;
  venue_count INT;
BEGIN
  SELECT id INTO demo_owner FROM users WHERE lower(email) = 'admin123@example.com';
  IF demo_owner IS NULL THEN
    RAISE NOTICE 'No existe el usuario admin123@example.com en users: no hay datos de demostración que borrar.';
    RETURN;
  END IF;

  DELETE FROM establishments
  WHERE owner_id = demo_owner
    AND public_code IN (SELECT substr(md5('smartdj-demo:' || s), 1, 12) FROM unnest(ARRAY['restaurante', 'cafe', 'salsa', 'discoteca']) AS s);
  GET DIAGNOSTICS venue_count = ROW_COUNT;

  DELETE FROM users WHERE id = demo_owner;
  RAISE NOTICE 'Datos de demostración borrados: % locales y la fila de admin123@example.com en users.', venue_count;
END $$;

COMMIT;
