"""Input checks shared by the public endpoints.

The API is meant to sit on the open internet, so anything a client sends that
ends up in GDAL, PROJ or the filesystem is checked here first:

- remote DEM/COG URLs must be http(s) and resolve only to public addresses
  (no loopback, private, link-local or metadata addresses: the API container
  must not become a proxy into the host's network);
- a CRS typed by the user must be a plain authority code (EPSG:6344), never a
  PROJ string or a path PROJ would read;
- ids that become path segments must be the hex ids this server generates;
- a client-supplied relative path must stay under its root.
"""
from __future__ import annotations

import ipaddress
import os
import re
import socket
from urllib.parse import urlsplit


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    return default if value is None else value.strip().lower() in {"1", "true", "yes", "on"}


# Local development may point at a COG on localhost or the LAN; a public
# deployment never should. Off by default.
ALLOW_PRIVATE_URLS = _env_bool("ALLOW_PRIVATE_URLS", False)

_HEX_ID = re.compile(r"[0-9a-f]{32}")
_CRS_CODE = re.compile(r"(?i)(EPSG|ESRI|IGNF|OGC):[0-9A-Za-z_.]{1,32}")


def _public_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def validate_remote_url(url: str) -> str:
    """Return the URL unchanged if it is safe to hand to GDAL /vsicurl/.

    Raises ValueError otherwise. DNS is resolved here and every address must be
    public; GDAL resolves again when it connects, so a host that changes its
    answer in between (DNS rebinding) or a redirect to a private address is not
    covered. That residual risk is why the network policy of the container
    (no route to internal services) remains the real boundary.
    """
    if not isinstance(url, str) or len(url) > 2048:
        raise ValueError("The DEM URL is missing or too long")
    if any(ch.isspace() or ord(ch) < 32 for ch in url):
        raise ValueError("The DEM URL contains whitespace or control characters")
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"}:
        raise ValueError("DEM URLs must use http:// or https://")
    if parts.username or parts.password:
        raise ValueError("DEM URLs must not embed credentials")
    host = parts.hostname
    if not host:
        raise ValueError("The DEM URL has no host")
    if ALLOW_PRIVATE_URLS:
        return url
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError as exc:
        raise ValueError("The DEM URL has an invalid port") from exc
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError(f"The DEM URL host could not be resolved: {host}") from exc
    addresses = {info[4][0] for info in infos}
    if not addresses:
        raise ValueError(f"The DEM URL host could not be resolved: {host}")
    for address in addresses:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
        if not _public_ip(ip):
            raise ValueError("DEM URLs must point to a public internet host")
    return url


def validate_crs_code(value: str | None) -> str | None:
    """Accept an authority code such as EPSG:6344; reject anything else."""
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    if not _CRS_CODE.fullmatch(value):
        raise ValueError("Enter the CRS as an authority code, for example EPSG:6344")
    return value.upper() if value.upper().startswith("EPSG:") else value


def validate_hex_id(value: str, what: str = "id") -> str:
    if not isinstance(value, str) or not _HEX_ID.fullmatch(value):
        raise ValueError(f"Invalid {what}")
    return value


def resolve_under(root: str, relative: str) -> str | None:
    """Join `relative` to `root` and return the real path if it stays inside
    `root` (symlinks resolved), else None."""
    if not isinstance(relative, str) or not relative or "\x00" in relative:
        return None
    base = os.path.realpath(root)
    target = os.path.realpath(os.path.join(base, relative))
    try:
        if os.path.commonpath((base, target)) != base:
            return None
    except ValueError:
        return None
    return target
