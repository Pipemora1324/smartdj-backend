# Descarga de audio para /analyze protegida contra SSRF: solo https, hosts permitidos, IPs públicas,
# sin redirecciones y con límites de tamaño y de tiempo.
import ipaddress
import os
import socket
import time
from urllib.parse import urlsplit

import requests

DEFAULT_ALLOWED_HOSTS = 'audio-ssl.itunes.apple.com,*.mzstatic.com,*.dzcdn.net'
CHUNK_BYTES = 64 * 1024


class UnsafeUrlError(ValueError):
    """La URL no cumple las reglas de seguridad o la descarga superó un límite (mensaje en español)."""


def allowed_hosts():
    raw = os.environ.get('AI_ANALYZE_ALLOWED_HOSTS', DEFAULT_ALLOWED_HOSTS)
    return [h.strip().lower() for h in raw.split(',') if h.strip()]


def max_bytes():
    return int(os.environ.get('AI_ANALYZE_MAX_BYTES', str(10 * 1024 * 1024)))


def host_allowed(host, patterns):
    host = host.lower().rstrip('.')
    for pattern in patterns:
        if pattern.startswith('*.'):
            if host.endswith(pattern[1:]) and host != pattern[2:]:
                return True
        elif host == pattern:
            return True
    return False


def validate_url(url, resolver=socket.getaddrinfo):
    """Lanza UnsafeUrlError si la URL no se puede descargar de forma segura."""
    parts = urlsplit(url)
    if parts.scheme != 'https':
        raise UnsafeUrlError('Solo se aceptan URLs https.')
    if parts.username or parts.password:
        raise UnsafeUrlError('La URL no puede incluir usuario ni contraseña.')
    if not parts.hostname:
        raise UnsafeUrlError('La URL no tiene un host válido.')
    if parts.port not in (None, 443):
        raise UnsafeUrlError('Solo se permite el puerto 443.')
    if not host_allowed(parts.hostname, allowed_hosts()):
        raise UnsafeUrlError(f'El host {parts.hostname} no está en la lista permitida.')
    try:
        infos = resolver(parts.hostname, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise UnsafeUrlError('No se pudo resolver el host.') from exc
    addresses = {info[4][0] for info in infos}
    if not addresses or any(not ipaddress.ip_address(a.split('%')[0]).is_global for a in addresses):
        raise UnsafeUrlError('El host resuelve a una dirección no pública.')
    return parts.hostname


def download(url, connect_timeout=5, read_timeout=10, total_timeout=20, get=requests.get, resolver=socket.getaddrinfo):
    """Descarga como máximo max_bytes() en total_timeout segundos. Devuelve los bytes."""
    validate_url(url, resolver)
    limit = max_bytes()
    started = time.monotonic()
    with get(url, stream=True, timeout=(connect_timeout, read_timeout), allow_redirects=False) as response:
        if 300 <= response.status_code < 400:
            raise UnsafeUrlError('No se permiten redirecciones.')
        response.raise_for_status()
        declared = response.headers.get('Content-Length')
        if declared and declared.isdigit() and int(declared) > limit:
            raise UnsafeUrlError(f'El audio supera el máximo de {limit // (1024 * 1024)} MB.')
        chunks, size = [], 0
        for chunk in response.iter_content(CHUNK_BYTES):
            size += len(chunk)
            if size > limit:
                raise UnsafeUrlError(f'El audio supera el máximo de {limit // (1024 * 1024)} MB.')
            if time.monotonic() - started > total_timeout:
                raise UnsafeUrlError('La descarga del audio tardó demasiado.')
            chunks.append(chunk)
    return b''.join(chunks)
