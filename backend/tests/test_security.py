import os
import tempfile
import unittest

from app import security
from app.security import resolve_under, validate_crs_code, validate_hex_id, validate_remote_url


class RemoteUrlTests(unittest.TestCase):
    def test_rejects_non_http_schemes(self):
        for url in ("file:///etc/passwd", "/etc/passwd", "ftp://example.com/a.tif",
                    "/vsizip//data/x.zip", "gopher://example.com/"):
            with self.assertRaises(ValueError, msg=url):
                validate_remote_url(url)

    def test_rejects_private_and_metadata_hosts(self):
        for url in ("http://127.0.0.1/dem.tif", "http://localhost:8000/dem.tif",
                    "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/dem.tif",
                    "http://192.168.1.10/dem.tif", "http://[::1]/dem.tif",
                    "http://[::ffff:127.0.0.1]/dem.tif", "http://0.0.0.0/dem.tif"):
            with self.assertRaises(ValueError, msg=url):
                validate_remote_url(url)

    def test_rejects_credentials_and_whitespace(self):
        with self.assertRaises(ValueError):
            validate_remote_url("https://user:pass@example.com/dem.tif")
        with self.assertRaises(ValueError):
            validate_remote_url("https://example.com/dem.tif\nHost: evil")

    def test_accepts_public_ip_literal(self):
        self.assertEqual(validate_remote_url("https://8.8.8.8/dem.tif"), "https://8.8.8.8/dem.tif")

    def test_private_allowed_when_configured(self):
        previous = security.ALLOW_PRIVATE_URLS
        security.ALLOW_PRIVATE_URLS = True
        try:
            self.assertTrue(validate_remote_url("http://127.0.0.1/dem.tif"))
        finally:
            security.ALLOW_PRIVATE_URLS = previous


class CrsCodeTests(unittest.TestCase):
    def test_accepts_authority_codes(self):
        self.assertEqual(validate_crs_code("epsg:6344"), "EPSG:6344")
        self.assertEqual(validate_crs_code(" ESRI:102003 "), "ESRI:102003")
        self.assertIsNone(validate_crs_code("  "))

    def test_rejects_proj_strings_and_paths(self):
        for value in ("+proj=utm +zone=15", "+init=/etc/passwd", "/tmp/x.prj",
                      'PROJCS["x"]', "EPSG:6344; rm -rf /"):
            with self.assertRaises(ValueError, msg=value):
                validate_crs_code(value)


class PathTests(unittest.TestCase):
    def test_hex_id(self):
        self.assertEqual(validate_hex_id("a" * 32), "a" * 32)
        for value in ("../etc", "A" * 32, "a" * 31, "a" * 32 + "/x"):
            with self.assertRaises(ValueError):
                validate_hex_id(value)

    def test_resolve_under(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "job"))
            self.assertTrue(resolve_under(root, "job/rem.tif"))
            self.assertIsNone(resolve_under(root, "../outside"))
            self.assertIsNone(resolve_under(root, "/etc/passwd"))
            self.assertIsNone(resolve_under(root, ""))
            # A sibling sharing the prefix ("cogs" vs "cogs2") is outside.
            self.assertIsNone(resolve_under(root, "../" + os.path.basename(root) + "2/x"))


if __name__ == "__main__":
    unittest.main()
