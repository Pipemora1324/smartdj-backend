# Pruebas de POST /suggest-next (modo HTTP del AutoDJ). Necesitan fastapi y httpx (TestClient); si faltan, se omiten.
import importlib.util
import unittest

HAS_HTTPX = all(importlib.util.find_spec(name) is not None for name in ('httpx', 'fastapi'))


@unittest.skipUnless(HAS_HTTPX, 'faltan httpx o fastapi')
class HttpSuggestTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        from app.main import app
        cls.client = TestClient(app)

    def test_elige_la_siguiente(self):
        body = {'venue_type': 'nightclub', 'current': {'id': 'now', 'genre': 'house', 'energy': 5},
                'candidates': [{'id': 'jazz', 'genre': 'jazz', 'energy': 1}, {'id': 'techno', 'genre': 'techno', 'energy': 5, 'duration_seconds': 300}]}
        data = self.client.post('/suggest-next', json=body).json()
        self.assertEqual(data['track_id'], 'techno')
        self.assertEqual(data['transition_at_seconds'], 293.0)

    def test_sin_candidatas_y_datos_invalidos(self):
        self.assertEqual(self.client.post('/suggest-next', json={}).json()['track_id'], '')
        self.assertEqual(self.client.post('/suggest-next', json={'candidates': [{'id': 'a', 'energy': 7}]}).status_code, 422)


if __name__ == '__main__':
    unittest.main()
