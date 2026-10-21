# Pruebas del motor de compatibilidad (familias de género, tonalidades, BPM y canción sonando).
# Ejecutar desde ai/: python -m unittest discover -s tests
import unittest

from app.engine import (NEUTRAL, bpm_score, evaluate, family, family_affinity, genre_score, key_score,
                        parse_key, stage_scores)


class FamilyTest(unittest.TestCase):
    def test_reconoce_generos_de_itunes_en_espanol_e_ingles(self):
        cases = {
            'Reggaeton': 'urban', 'Urbano latino': 'urban', 'Hip-Hop/Rap': 'urban', 'Trap': 'urban',
            'Salsa y tropical': 'salsa', 'Cumbia': 'salsa', 'Bachata': 'salsa', 'Música tropical': 'salsa',
            'Electrónica': 'dance', 'House': 'dance', 'Pop en español': 'pop', 'Pop': 'pop', 'K-Pop': 'pop',
            'Jazz': 'chill', 'Soul': 'chill', 'Rock y alternativo': 'rock', 'Metal': 'rock',
        }
        for genre, expected in cases.items():
            with self.subTest(genre=genre):
                self.assertEqual(family(genre), expected)

    def test_reconoce_generos_de_jamendo(self):
        cases = {'lounge': 'chill', 'chillout': 'chill', 'hiphop': 'urban', 'latin': 'salsa', 'electronic': 'dance',
                 'Urbano latino': 'urban', 'Latin pop': 'pop', 'classical': 'other'}
        for genre, expected in cases.items():
            with self.subTest(genre=genre):
                self.assertEqual(family(genre), expected)

    def test_gana_la_ultima_palabra_clave(self):
        self.assertEqual(family('Indie rock'), 'rock')
        self.assertEqual(family('Latin pop'), 'pop')

    def test_no_confunde_subtextos(self):
        # "rap" no debe encontrarse dentro de "grapefruit" ni "pop" dentro de "populares".
        self.assertEqual(family('Grapefruit sessions'), 'other')
        self.assertEqual(family('Canciones populares'), 'other')

    def test_genero_vacio_o_desconocido_es_other(self):
        self.assertEqual(family(''), 'other')
        self.assertEqual(family(None), 'other')
        self.assertEqual(family('Regional mexicano'), 'other')

    def test_afinidad_entre_familias(self):
        self.assertEqual(family_affinity('salsa', 'salsa'), 1.0)
        self.assertEqual(family_affinity('salsa', 'urban'), family_affinity('urban', 'salsa'))
        self.assertGreater(genre_score('Salsa', 'Reggaeton'), genre_score('Salsa', 'Metal'))
        self.assertEqual(genre_score('Rock', 'Indie rock'), 1.0)
        self.assertEqual(family_affinity('other', 'rock'), 0.5)


class KeyTest(unittest.TestCase):
    def test_interpreta_notaciones(self):
        self.assertEqual(parse_key('C'), (8, 'B'))
        self.assertEqual(parse_key('Am'), (8, 'A'))
        self.assertEqual(parse_key('A minor'), (8, 'A'))
        self.assertEqual(parse_key('La menor'.replace('La', 'A')), (8, 'A'))
        self.assertEqual(parse_key('Bb'), parse_key('A#'))
        self.assertEqual(parse_key('B♭m'), parse_key('Bbm'))
        self.assertEqual(parse_key('F#m'), (11, 'A'))
        self.assertEqual(parse_key('8A'), (8, 'A'))
        self.assertIsNone(parse_key('H'))
        self.assertIsNone(parse_key(''))

    def test_puntaje_en_la_rueda_camelot(self):
        self.assertEqual(key_score('C', 'C'), 1.0)
        self.assertEqual(key_score('Am', 'C'), 0.9)          # relativa
        self.assertEqual(key_score('C', 'G'), 0.85)          # vecina
        self.assertLess(key_score('C', 'F#'), key_score('C', 'D'))
        self.assertLess(key_score('Am', 'A'), 0.9)           # antes daba 1.0: perdía el modo menor
        self.assertEqual(key_score('C', ''), NEUTRAL)


class BpmTest(unittest.TestCase):
    def test_medio_y_doble_tempo(self):
        self.assertEqual(bpm_score(120, 120), 1)
        self.assertEqual(bpm_score(140, 70), 1)
        self.assertEqual(bpm_score(70, 140), 1)
        self.assertEqual(bpm_score(120, 175), 0)          # ni directo, ni medio, ni doble tempo

    def test_bpm_desconocido_es_neutral(self):
        self.assertEqual(bpm_score(0, 120), NEUTRAL)
        self.assertEqual(bpm_score(120, None), NEUTRAL)


class EvaluateTest(unittest.TestCase):
    def test_sin_cancion_sonando_compara_con_el_local(self):
        scores = stage_scores('salsa_bar', '', 'Salsa y tropical', 0, 0, '', '')
        self.assertEqual(scores['genre'], 1.0)
        result = evaluate('salsa_bar', '', 'Salsa y tropical', 0, 0, '', '')
        self.assertTrue(result['accepted'])
        self.assertEqual(result['bridge_sequence'], [])
        self.assertIn('No hay canción sonando', result['reason'])

    def test_cancion_que_no_encaja_genera_puente(self):
        result = evaluate('nightclub', 'House', 'Jazz', 128, 80, 'F#', 'C')
        self.assertFalse(result['accepted'])
        self.assertEqual(len(result['bridge_sequence']), 2)

    def test_misma_familia_tempo_y_tonalidad_compatible_se_acepta(self):
        self.assertTrue(evaluate('salsa_bar', 'Salsa', 'Salsa y tropical', 96, 100, 'Am', 'C')['accepted'])


if __name__ == '__main__':
    unittest.main()
