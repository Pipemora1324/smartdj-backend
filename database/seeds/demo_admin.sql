-- =====================================================================================
-- SEED DE DEMOSTRACIÓN · SOLO PARA PRESENTAR EL PROYECTO
-- =====================================================================================
-- Crea 4 locales de ejemplo con algunas peticiones e historial para la cuenta admin123@example.com.
-- No es una migración: NO se monta en docker-compose.yml ni se aplica sola. Se ejecuta a mano.
--
-- Antes de ejecutarlo:
--   1. Crea el usuario en Supabase Auth (Authentication → Users → Add user, con "Auto Confirm User").
--   2. Entra una vez a la app con esa cuenta: así el backend crea su fila en users (vinculada por auth_id).
--   3. Ejecuta este archivo en el SQL Editor. Requiere las migraciones hasta la 010.
--
-- Idempotente: se puede ejecutar varias veces sin duplicar. Los ids y los códigos públicos salen de md5 de un
-- texto fijo, así que los links y los QR no cambian al repetirlo. Si el usuario no existe, solo avisa (NOTICE).
--
-- Cómo se reconocen los datos de demostración:
--   - Locales: dueño admin123@example.com y public_code = primeros 12 caracteres de md5('smartdj-demo:<local>').
--   - Peticiones: client_key = 'demo-seed', ip_key = 'demo-seed' y song_key que empieza por 'demo:'.
--   - Historial: filas de mix_history ligadas (request_id) a esas peticiones.
-- Para borrarlos: database/seeds/demo_admin_cleanup.sql.
--
-- Las peticiones quedan "sonadas" (con su historial) o "rechazadas": ninguna queda pendiente, así que el AutoDJ
-- no intenta ponerlas en la cola. El historial no tiene track_id, así que no cuenta como pista reciente.
-- =====================================================================================

DO $$
DECLARE
  demo_owner UUID;
  venue_count INT;
  request_count INT;
BEGIN
  IF to_regclass('public.song_requests') IS NULL OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'song_requests' AND column_name = 'client_key'
  ) THEN
    RAISE EXCEPTION 'Faltan migraciones: ejecuta primero hasta la 010_peticiones_automaticas.sql.';
  END IF;

  SELECT id INTO demo_owner FROM users WHERE lower(email) = 'admin123@example.com';
  IF demo_owner IS NULL THEN
    RAISE NOTICE 'No existe el usuario admin123@example.com en users. Créalo en Supabase Auth, entra una vez a la app y vuelve a ejecutar este archivo. No se hizo nada.';
    RETURN;
  END IF;

  -- Locales: el más antiguo queda al final del panel (se ordena por created_at DESC).
  INSERT INTO establishments (owner_id, name, kind, ambience, public_code, created_at)
  SELECT demo_owner, v.name, v.kind::venue_kind, v.ambience, substr(md5('smartdj-demo:' || v.slug), 1, 12),
         NOW() - v.age
  FROM (VALUES
    ('restaurante', 'La Mesa de Inés', 'restaurant',
     'Restaurante de cocina colombiana de autor, luz cálida y mesas para conversar. Música suave de fondo y a volumen bajo: jazz, bossa nova y acústico.',
     INTERVAL '4 minutes'),
    ('cafe', 'Café Grano Alto', 'cafe',
     'Café de especialidad con mesas largas para trabajar y estudiar. De día, ambiente relajado con lo-fi, indie acústico y jazz suave.',
     INTERVAL '3 minutes'),
    ('salsa', 'La Esquina del Son', 'salsa_bar',
     'Bar de salsa caleña con pista de baile. De jueves a sábado: salsa brava, son cubano y algo de timba para un público que viene a bailar.',
     INTERVAL '2 minutes'),
    ('discoteca', 'Club Nébula', 'nightclub',
     'Discoteca con DJ residente, luces y mucha energía. Noches de house, tech house y latino urbano con reguetón hasta tarde.',
     INTERVAL '1 minute')
  ) AS v(slug, name, kind, ambience, age)
  ON CONFLICT (public_code) DO NOTHING;

  -- Peticiones de ejemplo: dos sonadas y una rechazada por local. ago = hace cuánto se pidió.
  INSERT INTO song_requests (
    id, establishment_id, guest_name, title, artist, genre, bpm, musical_key, status, ai_reason,
    created_at, evaluated_at, status_updated_at, played_at, provider, song_key, client_key, ip_key
  )
  SELECT md5('smartdj-demo:request:' || r.slug || ':' || r.n)::uuid, e.id, r.guest, r.title, r.artist, r.genre, r.bpm, r.music_key,
         r.status::request_status, r.reason,
         NOW() - r.ago, NOW() - r.ago + INTERVAL '3 seconds', NOW() - r.ago + r.wait,
         CASE WHEN r.status = 'played' THEN NOW() - r.ago + r.wait END,
         'itunes', 'demo:' || r.slug || ':' || r.n, 'demo-seed', 'demo-seed'
  FROM (VALUES
    ('restaurante', 1, 'Laura', 'The Girl from Ipanema', 'Stan Getz & João Gilberto', 'Bossa Nova', 130.00, 'F', 'played',
     'Bossa nova suave: encaja con el ambiente tranquilo del restaurante.', INTERVAL '3 hours', INTERVAL '6 minutes'),
    ('restaurante', 2, 'Andrés', 'Fly Me to the Moon', 'Frank Sinatra', 'Jazz', 120.00, 'C', 'played',
     'Jazz clásico a tempo medio, compatible con la pista anterior.', INTERVAL '2 hours 40 minutes', INTERVAL '9 minutes'),
    ('restaurante', 3, 'Camila', 'Gasolina', 'Daddy Yankee', 'Reggaeton', 96.00, 'Am', 'rejected',
     'Demasiada energía para una cena tranquila: no encaja con el perfil del local.', INTERVAL '2 hours', INTERVAL '3 seconds'),
    ('cafe', 1, 'Julián', 'Banana Pancakes', 'Jack Johnson', 'Acoustic', 104.00, 'G', 'played',
     'Acústico relajado, ideal para trabajar y estudiar.', INTERVAL '2 hours 30 minutes', INTERVAL '5 minutes'),
    ('cafe', 2, 'Valentina', 'Coffee', 'beabadoobee', 'Indie', 94.00, 'D', 'played',
     'Indie suave con un tempo cercano al de la pista anterior.', INTERVAL '2 hours 10 minutes', INTERVAL '8 minutes'),
    ('cafe', 3, 'Santiago', 'Thunderstruck', 'AC/DC', 'Rock', 134.00, 'B', 'rejected',
     'Rock muy enérgico: rompe el ambiente de concentración del café.', INTERVAL '1 hour 40 minutes', INTERVAL '3 seconds'),
    ('salsa', 1, 'Mariana', 'Vivir Mi Vida', 'Marc Anthony', 'Salsa', 104.00, 'Am', 'played',
     'Salsa con el tempo justo para la pista de baile.', INTERVAL '2 hours', INTERVAL '4 minutes'),
    ('salsa', 2, 'Felipe', 'Idilio', 'Willie Colón', 'Salsa', 92.00, 'Dm', 'played',
     'Salsa clásica en una tonalidad vecina de la anterior: transición natural.', INTERVAL '1 hour 45 minutes', INTERVAL '7 minutes'),
    ('salsa', 3, 'Daniela', 'Smells Like Teen Spirit', 'Nirvana', 'Rock', 117.00, 'Fm', 'rejected',
     'Rock alternativo: no encaja con un bar de salsa.', INTERVAL '1 hour 20 minutes', INTERVAL '3 seconds'),
    ('discoteca', 1, 'Sebastián', 'One More Time', 'Daft Punk', 'House', 123.00, 'F#m', 'played',
     'House con mucha energía, perfecto para la pista.', INTERVAL '1 hour 30 minutes', INTERVAL '5 minutes'),
    ('discoteca', 2, 'Paula', 'Tusa', 'KAROL G & Nicki Minaj', 'Reggaeton', 101.00, 'Fm', 'played',
     'Latino urbano: sube el ánimo y respeta el perfil del local.', INTERVAL '1 hour 10 minutes', INTERVAL '8 minutes'),
    ('discoteca', 3, 'Mateo', 'Clair de Lune', 'Claude Debussy', 'Classical', 66.00, 'Db', 'rejected',
     'Pieza clásica muy lenta: corta la energía de la discoteca.', INTERVAL '50 minutes', INTERVAL '3 seconds')
  ) AS r(slug, n, guest, title, artist, genre, bpm, music_key, status, reason, ago, wait)
  JOIN establishments e ON e.public_code = substr(md5('smartdj-demo:' || r.slug), 1, 12) AND e.owner_id = demo_owner
  ON CONFLICT (id) DO NOTHING;

  -- Historial: cada petición sonada queda en mix_history (así la cuenta como "sonada" el resto del sistema).
  INSERT INTO mix_history (id, establishment_id, bpm, musical_key, played_at, source, skipped, ended_reason, request_id)
  SELECT md5('smartdj-demo:history:' || r.id::text)::uuid, r.establishment_id, r.bpm, r.musical_key, r.played_at,
         'request', FALSE, 'ended', r.id
  FROM song_requests r
  JOIN establishments e ON e.id = r.establishment_id AND e.owner_id = demo_owner
  WHERE r.client_key = 'demo-seed' AND r.status = 'played'
  ON CONFLICT (id) DO NOTHING;

  SELECT COUNT(*) INTO venue_count FROM establishments
  WHERE owner_id = demo_owner
    AND public_code IN (SELECT substr(md5('smartdj-demo:' || s), 1, 12) FROM unnest(ARRAY['restaurante', 'cafe', 'salsa', 'discoteca']) AS s);
  SELECT COUNT(*) INTO request_count FROM song_requests r JOIN establishments e ON e.id = r.establishment_id
  WHERE e.owner_id = demo_owner AND r.client_key = 'demo-seed';
  RAISE NOTICE 'Datos de demostración listos: % locales y % peticiones de ejemplo.', venue_count, request_count;
END $$;
