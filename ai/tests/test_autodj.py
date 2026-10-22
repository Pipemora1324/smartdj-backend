# Pruebas del AutoDJ (elección de la siguiente pista de la emisora).
# Ejecutar desde ai/: python -m unittest discover -s tests
import unittest

from app.autodj import crossfade_for, energy_flow_score, energy_target_score, suggest_next, transition_point


def track(id, genre='lounge', energy=3, bpm=0, key='', duration=200, artist='A'):
    return dict(id=id, genre=genre, energy=energy, bpm=bpm, key=key, duration_seconds=duration, artist=artist)


class AutoDjTest(unittest.TestCase):
    def test_no_repite_pistas_recientes(self):
        result = suggest_next('cafe', track('now'), [track('a'), track('b')], recent_ids=['a'])
        self.assertEqual(result['track_id'], 'b')

    def test_nunca_elige_la_pista_actual(self):
        result = suggest_next('cafe', track('now'), [track('now'), track('x', genre='metal', energy=5)])
        self.assertEqual(result['track_id'], 'x')

    def test_si_todo_es_reciente_repite_antes_que_el_silencio(self):
        result = suggest_next('cafe', track('now'), [track('a')], recent_ids=['a'])
        self.assertEqual(result['track_id'], 'a')
        self.assertIsNone(suggest_next('cafe', track('now'), []))

    def test_mantiene_la_energia_del_local(self):
        candidates = [track('fiesta', genre='house', energy=5), track('suave', genre='jazz', energy=2)]
        self.assertEqual(suggest_next('cafe', track('now', genre='jazz', energy=2), candidates)['track_id'], 'suave')
        self.assertEqual(suggest_next('nightclub', track('now', genre='house', energy=5), candidates)['track_id'], 'fiesta')

    def test_evita_repetir_artista(self):
        candidates = [track('a', artist='Ana'), track('b', artist='Beto')]
        self.assertEqual(suggest_next('cafe', track('now'), candidates, recent_artists=['ANA'])['track_id'], 'b')

    def test_usa_bpm_y_tonalidad_cuando_existen(self):
        current = track('now', genre='house', energy=4, bpm=124, key='8A')
        candidates = [track('lejos', genre='house', energy=4, bpm=90, key='2B'), track('cerca', genre='house', energy=4, bpm=125, key='9A')]
        result = suggest_next('nightclub', current, candidates)
        self.assertEqual(result['track_id'], 'cerca')
        self.assertIn('tempo parecido', result['reason'])

    def test_sin_pista_actual_elige_por_el_local(self):
        result = suggest_next('salsa_bar', None, [track('rock', genre='rock', energy=3), track('salsa', genre='salsa', energy=4)])
        self.assertEqual(result['track_id'], 'salsa')
        self.assertTrue(result['reason'].endswith('.'))

    def test_puntaje_entre_0_y_100(self):
        result = suggest_next('other', track('now'), [track('a', genre='', energy=0)])
        self.assertTrue(0 <= result['score'] <= 100)


class TransitionTest(unittest.TestCase):
    def test_crossfade_segun_energia_y_tempo(self):
        self.assertEqual(crossfade_for(1, 0, 300), 12.0)
        self.assertEqual(crossfade_for(5, 0, 300), 6.0)
        self.assertEqual(crossfade_for(3, 128, 300), 7.5)
        self.assertEqual(crossfade_for(0, 0, 300), 8.0)
        self.assertEqual(crossfade_for(1, 0, 15), 5.0)

    def test_punto_de_transicion_antes_del_final(self):
        self.assertEqual(transition_point(200, 8), 191)
        self.assertEqual(transition_point(34, 6), 27)
        self.assertEqual(transition_point(0, 8), 0)

    def test_energia(self):
        self.assertEqual(energy_target_score('nightclub', 4), 1.0)
        self.assertEqual(energy_target_score('nightclub', 2), 0.0)
        self.assertEqual(energy_flow_score(3, 4), 0.85)
        self.assertEqual(energy_flow_score(1, 5), 0.1)


class RequestHintsTest(unittest.TestCase):
    def test_lo_pedido_por_el_publico_cambia_la_eleccion(self):
        candidates = [track('lounge', genre='lounge', energy=3, artist='Ana'), track('salsa', genre='salsa', energy=3, artist='Beto')]
        sin_pedidos = suggest_next('other', None, candidates)
        con_pedidos = suggest_next('other', None, candidates, request_genres=['Salsa y Tropical'])
        self.assertEqual(sin_pedidos['track_id'], 'lounge')
        self.assertEqual(con_pedidos['track_id'], 'salsa')
        self.assertIn('pidió el público', con_pedidos['reason'])

    def test_el_artista_pedido_pesa_mas_que_el_genero(self):
        candidates = [track('a', genre='salsa', artist='Otro'), track('b', genre='lounge', artist='Marc Anthony')]
        result = suggest_next('other', None, candidates, request_genres=['salsa'], request_artists=['marc anthony'])
        self.assertEqual(result['track_id'], 'b')
        self.assertIn('Marc Anthony', result['reason'])
        self.assertLessEqual(result['score'], 100)


if __name__ == '__main__':
    unittest.main()
