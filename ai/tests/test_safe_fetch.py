# Pruebas de la protección SSRF de /analyze (sin red: DNS y HTTP simulados).
import os
import socket
import unittest

from app.safe_fetch import UnsafeUrlError, download, host_allowed, validate_url


def resolver_for(*ips):
    return lambda host, port, proto=0: [(socket.AF_INET, socket.SOCK_STREAM, proto, '', (ip, port)) for ip in ips]


PUBLIC = resolver_for('17.253.144.10')


class FakeResponse:
    def __init__(self, status=200, chunks=(b'abc',), headers=None):
        self.status_code, self._chunks, self.headers = status, chunks, headers or {}
    def __enter__(self): return self
    def __exit__(self, *exc): return False
    def raise_for_status(self):
        if self.status_code >= 400: raise RuntimeError(self.status_code)
    def iter_content(self, _size): yield from self._chunks


class ValidateUrlTest(unittest.TestCase):
    def setUp(self):
        os.environ.pop('AI_ANALYZE_ALLOWED_HOSTS', None)

    def test_acepta_hosts_permitidos(self):
        self.assertEqual(validate_url('https://audio-ssl.itunes.apple.com/a.m4a', PUBLIC), 'audio-ssl.itunes.apple.com')
        self.assertEqual(validate_url('https://is1-ssl.mzstatic.com/a.m4a', PUBLIC), 'is1-ssl.mzstatic.com')

    def test_rechaza_esquemas_hosts_y_puertos(self):
        for url in ['http://audio-ssl.itunes.apple.com/a', 'file:///etc/passwd', 'https://evil.example.com/a',
                    'https://mzstatic.com.evil.example/a', 'https://user:pw@audio-ssl.itunes.apple.com/a',
                    'https://audio-ssl.itunes.apple.com:8443/a', 'https://localhost/a']:
            with self.subTest(url=url), self.assertRaises(UnsafeUrlError):
                validate_url(url, PUBLIC)

    def test_rechaza_ips_no_publicas(self):
        for ip in ['127.0.0.1', '10.0.0.5', '192.168.1.10', '169.254.169.254', '::1']:
            with self.subTest(ip=ip), self.assertRaises(UnsafeUrlError):
                validate_url('https://audio-ssl.itunes.apple.com/a', resolver_for(ip))

    def test_rechaza_si_alguna_ip_es_privada(self):
        with self.assertRaises(UnsafeUrlError):
            validate_url('https://audio-ssl.itunes.apple.com/a', resolver_for('17.253.144.10', '10.0.0.1'))

    def test_comodin_no_incluye_el_dominio_raiz(self):
        self.assertTrue(host_allowed('a.mzstatic.com', ['*.mzstatic.com']))
        self.assertFalse(host_allowed('mzstatic.com', ['*.mzstatic.com']))
        self.assertFalse(host_allowed('evilmzstatic.com', ['*.mzstatic.com']))


class DownloadTest(unittest.TestCase):
    URL = 'https://audio-ssl.itunes.apple.com/a.m4a'

    def test_descarga_dentro_del_limite(self):
        get = lambda *a, **k: FakeResponse(chunks=(b'ab', b'cd'))
        self.assertEqual(download(self.URL, get=get, resolver=PUBLIC), b'abcd')

    def test_rechaza_redirecciones(self):
        get = lambda *a, **k: FakeResponse(status=302)
        with self.assertRaises(UnsafeUrlError):
            download(self.URL, get=get, resolver=PUBLIC)

    def test_corta_si_supera_el_tamano(self):
        os.environ['AI_ANALYZE_MAX_BYTES'] = '5'
        try:
            get = lambda *a, **k: FakeResponse(chunks=(b'abc', b'def'))
            with self.assertRaises(UnsafeUrlError):
                download(self.URL, get=get, resolver=PUBLIC)
            with self.assertRaises(UnsafeUrlError):
                download(self.URL, get=lambda *a, **k: FakeResponse(headers={'Content-Length': '999'}), resolver=PUBLIC)
        finally:
            os.environ.pop('AI_ANALYZE_MAX_BYTES', None)

    def test_pide_sin_redirecciones_y_con_timeout(self):
        seen = {}
        def get(url, **kwargs):
            seen.update(kwargs)
            return FakeResponse()
        download(self.URL, get=get, resolver=PUBLIC)
        self.assertFalse(seen['allow_redirects'])
        self.assertEqual(seen['timeout'], (5, 10))
        self.assertTrue(seen['stream'])


if __name__ == '__main__':
    unittest.main()
