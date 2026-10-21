# Servidor gRPC del motor de compatibilidad. Carga el contrato desde ai/proto en tiempo de ejecución
# (grpc.protos_and_services), así no hay código generado que mantener sincronizado.
import logging
import os
import sys
import time
from concurrent import futures

import grpc

from app.engine import build_result, evaluate, normalize, stage_scores

PROTO_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'proto')
if PROTO_DIR not in sys.path:
    sys.path.insert(0, PROTO_DIR)
pb2, pb2_grpc = grpc.protos_and_services('compatibility.proto')

Event = pb2.EvaluationEvent
log = logging.getLogger('smartdj.grpc')


def step_delay_seconds():
    # Pausa entre etapas del stream para que el estado en vivo se pueda seguir en la interfaz.
    return max(0.0, float(os.environ.get('AI_STREAM_STEP_DELAY_MS', '250')) / 1000)


def validate(request, context):
    for name in ('current_bpm', 'requested_bpm'):
        value = getattr(request, name)
        if not 0 <= value <= 300:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, f'{name} debe estar entre 0 (desconocido) y 300.')


def to_result(data):
    return pb2.CompatibilityResult(
        accepted=data['accepted'],
        score=data['score'],
        reason=data['reason'],
        bridge_sequence=[pb2.BridgeStep(**step) for step in data['bridge_sequence']],
        profile=data['profile'],
    )


class CompatibilityService(pb2_grpc.CompatibilityServiceServicer):
    def CheckCompatibility(self, request, context):
        validate(request, context)
        return to_result(evaluate(request.venue_type, request.current_genre, request.requested_genre,
                                  request.current_bpm, request.requested_bpm, request.current_key, request.requested_key))

    def StreamEvaluation(self, request, context):
        c = request.compatibility
        validate(c, context)

        def event(stage, message, partial=0.0, result=None):
            return Event(request_id=request.request_id, stage=stage, message=message, partial_score=partial, result=result)

        yield event(Event.QUEUED, 'Petición recibida por el motor de compatibilidad.')
        stage_values = stage_scores(c.venue_type, c.current_genre, c.requested_genre, c.current_bpm, c.requested_bpm, c.current_key, c.requested_key)
        against = f'a {c.current_genre}' if normalize(c.current_genre) else 'al ambiente del local'
        bpm_text = lambda v: f'{round(v)} BPM' if v else 'BPM desconocido'
        steps = [
            (Event.ANALYZING_GENRE, 'genre', lambda: stage_values['genre'],
             lambda s: f'Analizando el género: {c.requested_genre or "sin género"} frente {against} ({round(s * 100)}%).'),
            (Event.ANALYZING_BPM, 'bpm', lambda: stage_values['bpm'],
             lambda s: f'Analizando el tempo: {bpm_text(c.requested_bpm)} frente a {bpm_text(c.current_bpm)} ({round(s * 100)}%).'),
            (Event.ANALYZING_KEY, 'key', lambda: stage_values['key'],
             lambda s: (f'Analizando la tonalidad: {c.requested_key} sobre {c.current_key} ({round(s * 100)}%).' if c.requested_key and c.current_key else f'Analizando la tonalidad: tonalidad desconocida ({round(s * 100)}%).')),
        ]
        scores = {}
        for stage, name, compute, describe in steps:
            time.sleep(step_delay_seconds())
            if not context.is_active():
                log.info('Stream cancelado por el cliente (request_id=%s)', request.request_id)
                return
            scores[name] = compute()
            yield event(stage, describe(scores[name]), scores[name])
        scores['venue'] = stage_values['venue']
        result = build_result(c.venue_type, c.current_genre, c.requested_genre, c.current_bpm, c.requested_bpm, scores)
        yield event(Event.RESULT, result['reason'], result=to_result(result))


def create_server(port, max_workers=10, host=None):
    """Crea el servidor sin iniciarlo. Devuelve (server, puerto_real); con port=0 elige uno libre.
    host: AI_BIND_HOST o todas las interfaces; en el contenedor combinado es 127.0.0.1."""
    host = host or os.environ.get('AI_BIND_HOST', '[::]')
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=max_workers))
    pb2_grpc.add_CompatibilityServiceServicer_to_server(CompatibilityService(), server)
    bound = server.add_insecure_port(f'{host}:{port}')
    return server, bound


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    grpc_server, grpc_port = create_server(int(os.environ.get('AI_GRPC_PORT', '50051')))
    grpc_server.start()
    log.info('Servidor gRPC escuchando en el puerto %s', grpc_port)
    grpc_server.wait_for_termination()
