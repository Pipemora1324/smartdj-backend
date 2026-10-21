# Pruebas del servidor gRPC sin red externa: levanta el servidor en un puerto libre de localhost.
# Ejecutar desde ai/: python -m unittest discover -s tests
import os
import unittest

os.environ['AI_STREAM_STEP_DELAY_MS'] = '0'

import grpc  # noqa: E402

from app.autodj import suggest_next  # noqa: E402
from app.engine import evaluate  # noqa: E402
from app.grpc_server import create_server, pb2, pb2_grpc  # noqa: E402

SAMPLE = dict(venue_type='nightclub', current_genre='House', requested_genre='Salsa',
              current_bpm=124, requested_bpm=96, current_key='Am', requested_key='C')


class GrpcServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server, port = create_server(0)
        cls.server.start()
        cls.channel = grpc.insecure_channel(f'localhost:{port}')
        cls.stub = pb2_grpc.CompatibilityServiceStub(cls.channel)

    @classmethod
    def tearDownClass(cls):
        cls.channel.close()
        cls.server.stop(None)

    def test_unary_matches_engine(self):
        result = self.stub.CheckCompatibility(pb2.CompatibilityRequest(**SAMPLE), timeout=5)
        expected = evaluate(**SAMPLE)
        self.assertEqual(result.accepted, expected['accepted'])
        self.assertEqual(result.score, expected['score'])
        self.assertEqual(result.reason, expected['reason'])
        self.assertEqual(result.profile, expected['profile'])
        self.assertEqual([(s.position, s.genre, s.target_bpm) for s in result.bridge_sequence],
                         [(s['position'], s['genre'], s['target_bpm']) for s in expected['bridge_sequence']])

    def test_stream_emits_all_stages_in_order(self):
        request = pb2.EvaluationRequest(request_id='req-1', compatibility=pb2.CompatibilityRequest(**SAMPLE))
        events = list(self.stub.StreamEvaluation(request, timeout=5))
        stages = [pb2.EvaluationEvent.Stage.Name(e.stage) for e in events]
        self.assertEqual(stages, ['QUEUED', 'ANALYZING_GENRE', 'ANALYZING_BPM', 'ANALYZING_KEY', 'RESULT'])
        self.assertTrue(all(e.request_id == 'req-1' for e in events))
        self.assertEqual(events[-1].result.score, evaluate(**SAMPLE)['score'])

    def test_invalid_bpm_is_rejected(self):
        with self.assertRaises(grpc.RpcError) as ctx:
            self.stub.CheckCompatibility(pb2.CompatibilityRequest(**{**SAMPLE, 'requested_bpm': -5}), timeout=5)
        self.assertEqual(ctx.exception.code(), grpc.StatusCode.INVALID_ARGUMENT)
        with self.assertRaises(grpc.RpcError) as ctx:
            list(self.stub.StreamEvaluation(pb2.EvaluationRequest(compatibility=pb2.CompatibilityRequest(**{**SAMPLE, 'current_bpm': 999})), timeout=5))
        self.assertEqual(ctx.exception.code(), grpc.StatusCode.INVALID_ARGUMENT)

    def test_suggest_next_matches_autodj(self):
        current = pb2.TrackFeatures(id='now', genre='jazz', energy=2, duration_seconds=180, artist='Ana')
        candidates = [pb2.TrackFeatures(id='fiesta', genre='house', energy=5, duration_seconds=200, artist='Beto'),
                      pb2.TrackFeatures(id='suave', genre='lounge', energy=2, duration_seconds=240, artist='Caro')]
        result = self.stub.SuggestNext(pb2.SuggestNextRequest(venue_type='cafe', current=current, candidates=candidates, recent_ids=['x']), timeout=5)
        expected = suggest_next('cafe', {'id': 'now', 'genre': 'jazz', 'energy': 2, 'bpm': 0, 'key': '', 'duration_seconds': 180, 'artist': 'Ana'},
                                [{'id': c.id, 'genre': c.genre, 'energy': c.energy, 'bpm': 0, 'key': '', 'duration_seconds': c.duration_seconds, 'artist': c.artist} for c in candidates], ['x'])
        self.assertEqual(result.track_id, 'suave')
        self.assertEqual((result.score, result.reason, result.crossfade_seconds), (expected['score'], expected['reason'], expected['crossfade_seconds']))
        self.assertAlmostEqual(result.transition_at_seconds, expected['transition_at_seconds'])

    def test_suggest_next_without_candidates_and_invalid_data(self):
        empty = self.stub.SuggestNext(pb2.SuggestNextRequest(venue_type='cafe'), timeout=5)
        self.assertEqual(empty.track_id, '')
        with self.assertRaises(grpc.RpcError) as ctx:
            self.stub.SuggestNext(pb2.SuggestNextRequest(candidates=[pb2.TrackFeatures(id='a', energy=9)]), timeout=5)
        self.assertEqual(ctx.exception.code(), grpc.StatusCode.INVALID_ARGUMENT)
        with self.assertRaises(grpc.RpcError) as ctx:
            self.stub.SuggestNext(pb2.SuggestNextRequest(candidates=[pb2.TrackFeatures(id=str(i)) for i in range(201)]), timeout=5)
        self.assertEqual(ctx.exception.code(), grpc.StatusCode.INVALID_ARGUMENT)


if __name__ == '__main__':
    unittest.main()
