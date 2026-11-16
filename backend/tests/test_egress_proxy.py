import http.server
import os
import socket
import threading
import unittest

from osgeo import gdal

from app import egress_proxy, security


def _raw(proxy: str, request: bytes) -> bytes:
    host, port = proxy.split(":")
    with socket.create_connection((host, int(port)), timeout=10) as s:
        s.sendall(request)
        return s.recv(4096)


class _Ok(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    do_HEAD = do_GET

    def log_message(self, *args):
        pass


class EgressProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        gdal.UseExceptions()
        cls.proxy = egress_proxy.install()
        # A "private" service the proxy must never reach.
        cls.private = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Ok)
        threading.Thread(target=cls.private.serve_forever, daemon=True).start()
        cls.private_port = cls.private.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.private.shutdown()

    def test_gdal_is_pointed_at_the_proxy(self):
        self.assertEqual(gdal.GetConfigOption("GDAL_HTTP_PROXY"), self.proxy)

    def test_connect_to_loopback_and_metadata_refused(self):
        for target in (f"127.0.0.1:{self.private_port}", "169.254.169.254:80", "localhost:443", "[::1]:443"):
            reply = _raw(self.proxy, f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
            self.assertTrue(reply.startswith(b"HTTP/1.1 403"), (target, reply))

    def test_plain_http_to_private_refused(self):
        url = f"http://127.0.0.1:{self.private_port}/"
        reply = _raw(self.proxy, f"GET {url} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".encode())
        self.assertTrue(reply.startswith(b"HTTP/1.1 403"), reply)

    def test_non_http_absolute_form_refused(self):
        reply = _raw(self.proxy, b"GET /relative HTTP/1.1\r\nHost: x\r\n\r\n")
        self.assertTrue(reply.startswith(b"HTTP/1.1 403"), reply)

    def test_gdal_cannot_read_private_service_directly(self):
        gdal.VSICurlClearCache()
        with self.assertRaises(RuntimeError):
            gdal.Open(f"/vsicurl/http://127.0.0.1:{self.private_port}/dem.tif")

    def test_allow_private_lets_it_through(self):
        previous = security.ALLOW_PRIVATE_URLS
        security.ALLOW_PRIVATE_URLS = True
        try:
            url = f"http://127.0.0.1:{self.private_port}/"
            reply = _raw(self.proxy, f"GET {url} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".encode())
            self.assertTrue(reply.startswith(b"HTTP/1.0 200") or reply.startswith(b"HTTP/1.1 200"), reply)
        finally:
            security.ALLOW_PRIVATE_URLS = previous

    def test_redirect_to_private_is_blocked(self):
        # Treat 127.0.0.2 as "public" and 127.0.0.1 as private. A public server
        # 302s to the private one: without the proxy GDAL follows the redirect
        # and reaches it (control); through the proxy the second hop is refused.
        hits = []

        class Private(_Ok):
            def do_GET(self):
                hits.append(self.path)
                super().do_GET()
            do_HEAD = do_GET

        private = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Private)
        target = f"http://127.0.0.1:{private.server_address[1]}/secret.tif"

        class Redirect(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", target)
                self.send_header("Content-Length", "0")
                self.end_headers()
            do_HEAD = do_GET

            def log_message(self, *args):
                pass

        public = http.server.ThreadingHTTPServer(("127.0.0.2", 0), Redirect)
        for server in (private, public):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"/vsicurl/http://127.0.0.2:{public.server_address[1]}/dem.tif"
        original = security._public_ip
        security._public_ip = lambda ip: str(ip) != "127.0.0.1"
        try:
            def attempt():
                hits.clear()
                gdal.VSICurlClearCache()
                try:
                    gdal.Open(url)
                except RuntimeError:
                    pass
                return list(hits)

            gdal.SetConfigOption("GDAL_HTTP_PROXY", None)
            gdal.SetConfigOption("GDAL_HTTPS_PROXY", None)
            self.assertTrue(attempt(), "control: GDAL should follow the redirect without the proxy")
            egress_proxy.install()
            self.assertEqual(attempt(), [], "the proxy let the redirect reach the private service")
        finally:
            security._public_ip = original
            egress_proxy.install()
            private.shutdown()
            public.shutdown()

    @unittest.skipUnless(os.environ.get("NETWORK_TESTS"), "needs internet (NETWORK_TESTS=1)")
    def test_public_cog_still_opens(self):
        gdal.VSICurlClearCache()
        ds = gdal.Open("/vsicurl/https://download.osgeo.org/gdal/data/gtiff/small_world.tif")
        self.assertIsNotNone(ds)
        self.assertGreater(ds.RasterXSize, 0)


if __name__ == "__main__":
    unittest.main()
