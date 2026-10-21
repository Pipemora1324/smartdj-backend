# Pruebas del servidor gRPC sin red externa: levanta el servidor en un puerto libre de localhost.
# Ejecutar desde ai/: python -m unittest discover -s tests
import os
import unittest

os.environ['AI_STREAM_STEP_DELAY_MS'] = '0'

import grpc  # noqa: E402

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


if __name__ == '__main__':
    unittest.main()
