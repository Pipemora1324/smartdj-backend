# Punto de entrada del contenedor: API HTTP (FastAPI, incluye /health) y, si AI_GRPC_PORT está
# definido, el servidor gRPC en ese puerto dentro del mismo proceso.
# Sin AI_GRPC_PORT solo se abre el puerto HTTP, igual que antes (el despliegue actual no cambia).
import logging
import os

import uvicorn

log = logging.getLogger('smartdj.serve')


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
    grpc_server = None
    grpc_port = os.environ.get('AI_GRPC_PORT')
    if grpc_port:
        from app.grpc_server import create_server
        grpc_server, bound = create_server(int(grpc_port))
        grpc_server.start()
        log.info('Servidor gRPC escuchando en el puerto %s', bound)
    else:
        log.info('AI_GRPC_PORT no está definido: solo se inicia la API HTTP')
    try:
        uvicorn.run('app.main:app', host='0.0.0.0', port=int(os.environ.get('AI_HTTP_PORT', '8000')))
    finally:
        if grpc_server:
            grpc_server.stop(grace=5)


if __name__ == '__main__':
    main()
