"""A forward proxy inside the API process that only lets GDAL reach public hosts.

`security.validate_remote_url` checks a URL when the request arrives, but GDAL
(libcurl) resolves the host again when it connects and follows redirects, so a
host that changes its DNS answer, or a public URL that redirects to
http://169.254.169.254/ or a service on the host's network, would get past it.

Every GDAL HTTP request is therefore sent through this proxy
(`GDAL_HTTP_PROXY`, set by `install()`). For each connection it:

- resolves the host itself and refuses unless every address is public;
- connects to the exact address it checked (no second lookup to race);
- handles redirects by construction: curl sends each hop through the proxy
  again, so each one is checked;
- tunnels HTTPS with CONNECT (TLS stays end to end; the proxy sees only the
  host and port), and for plain HTTP forces `Connection: close` so a reused
  proxy connection can never carry a request to a second host.

It listens on 127.0.0.1 only. Mapterhorn tiles are fetched with `requests`,
not GDAL, and do not go through it. `ALLOW_PRIVATE_URLS=true` turns the
address check off (local testing), the proxy still runs.
"""
from __future__ import annotations

import ipaddress
import logging
import select
import socket
import socketserver
import threading
from urllib.parse import urlsplit

from osgeo import gdal

from . import security

_log = logging.getLogger("riverrem.egress")
_MAX_HEADER = 64 * 1024
_IDLE_TIMEOUT = 120


class Refused(Exception):
    pass


def _checked_address(host: str, port: int) -> tuple:
    """Resolve once; return a sockaddr to connect to, or raise Refused."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise Refused(f"cannot resolve {host}") from exc
    if not infos:
        raise Refused(f"cannot resolve {host}")
    if not security.ALLOW_PRIVATE_URLS:
        for info in infos:
            ip = ipaddress.ip_address(info[4][0].split("%", 1)[0])
            if not security._public_ip(ip):
                raise Refused(f"{host} resolves to a non-public address")
    family, _, _, _, sockaddr = infos[0]
    return family, sockaddr


def _read_head(conn: socket.socket) -> tuple[bytes, bytes]:
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = conn.recv(8192)
        if not chunk:
            break
        buf += chunk
        if len(buf) > _MAX_HEADER:
            raise Refused("request header too large")
    head, sep, rest = buf.partition(b"\r\n\r\n")
    if not sep:
        raise Refused("incomplete request")
    return head, rest


def _pipe(a: socket.socket, b: socket.socket) -> None:
    socks = [a, b]
    while True:
        readable, _, errored = select.select(socks, [], socks, _IDLE_TIMEOUT)
        if errored or not readable:
            return
        for s in readable:
            data = s.recv(65536)
            if not data:
                return
            (b if s is a else a).sendall(data)


class _Handler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        client: socket.socket = self.request
        client.settimeout(_IDLE_TIMEOUT)
        upstream = None
        try:
            head, rest = _read_head(client)
            lines = head.split(b"\r\n")
            method, target, version = lines[0].decode("latin-1").split(" ", 2)
            if method.upper() == "CONNECT":
                host, _, port_s = target.rpartition(":")
                host = host.strip("[]")
                port = int(port_s)
                family, addr = _checked_address(host, port)
                upstream = socket.create_connection(addr[:2], timeout=30)
                client.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
                if rest:
                    upstream.sendall(rest)
            else:
                parts = urlsplit(target)
                if parts.scheme != "http" or not parts.hostname:
                    raise Refused("only absolute http:// URLs or CONNECT")
                port = parts.port or 80
                family, addr = _checked_address(parts.hostname, port)
                upstream = socket.create_connection(addr[:2], timeout=30)
                path = parts.path or "/"
                if parts.query:
                    path += "?" + parts.query
                headers = [
                    line for line in lines[1:]
                    if not line.lower().startswith((b"proxy-connection:", b"connection:", b"proxy-authorization:"))
                ]
                out = [f"{method} {path} {version}".encode("latin-1"), *headers, b"Connection: close"]
                upstream.sendall(b"\r\n".join(out) + b"\r\n\r\n" + rest)
            upstream.settimeout(None)
            client.settimeout(None)
            _pipe(client, upstream)
        except Refused as exc:
            _log.warning("Egress refused: %s", exc)
            try:
                client.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
        except (OSError, ValueError) as exc:
            try:
                client.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            _log.info("Egress error: %s", exc)
        finally:
            if upstream is not None:
                upstream.close()


class _Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


_server: _Server | None = None
_lock = threading.Lock()


def install() -> str:
    """Start the proxy (once) and point every GDAL HTTP request at it."""
    global _server
    with _lock:
        if _server is None:
            _server = _Server(("127.0.0.1", 0), _Handler)
            threading.Thread(target=_server.serve_forever, name="egress-proxy", daemon=True).start()
        address = f"127.0.0.1:{_server.server_address[1]}"
        gdal.SetConfigOption("GDAL_HTTP_PROXY", address)
        gdal.SetConfigOption("GDAL_HTTPS_PROXY", address)
        # Our own proxy: never bypass it for any host.
        gdal.SetConfigOption("NO_PROXY", "")
        gdal.SetConfigOption("no_proxy", "")
        return address
