"""Build an analysis DEM by fetching RGB-encoded terrain tiles over a viewport.

Default source is Mapterhorn ( https://mapterhorn.com ). The tiles are XYZ,
RGB-encoded elevation. The exact encoding for Mapterhorn should be verified
against their docs -- this module supports both common encodings and defaults
to "terrarium", which is the de-facto standard for open terrain tiles.

  terrarium : elev = (R * 256 + G + B / 256) - 32768
  mapbox    : elev = -10000 + (R * 65536 + G * 256 + B) * 0.1

Pipeline:  XYZ tiles -> decode -> mosaic (EPSG:3857) -> reproject to local UTM.
RiverREM's IDW interpolation and centerline sampling are in DEM units, so the
DEM is delivered in metres (UTM), not web-mercator, to keep distances honest.
"""
from __future__ import annotations

import math
import os
import time
import logging
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import numpy as np
import requests
from osgeo import gdal, osr
from PIL import Image
from io import BytesIO

gdal.UseExceptions()

_log = logging.getLogger("riverrem.terrain")

# {z}/{x}/{y} template. Override with TERRAIN_TILE_URL env var.
TERRAIN_TILE_URL = os.environ.get(
    "TERRAIN_TILE_URL",
    "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp",
)
TERRAIN_ENCODING = os.environ.get("TERRAIN_ENCODING", "terrarium")  # or "mapbox"
# Absolute ceiling for the per-viewport probe; Mapterhorn reaches ~18-20 in places.
TERRAIN_MAX_ZOOM = int(os.environ.get("TERRAIN_MAX_ZOOM", "20"))
TILE_SIZE = 256
_UA = {"User-Agent": "riverrem-app/0.1"}


def _decode(arr: np.ndarray) -> np.ndarray:
    r, g, b = arr[..., 0].astype("f8"), arr[..., 1].astype("f8"), arr[..., 2].astype("f8")
    if TERRAIN_ENCODING == "mapbox":
        return -10000.0 + (r * 65536.0 + g * 256.0 + b) * 0.1
    return (r * 256.0 + g + b / 256.0) - 32768.0  # terrarium


def _lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def _tile_to_mercator_bounds(x: int, y: int, z: int) -> tuple[float, float, float, float]:
    """Return (minx, miny, maxx, maxy) of a tile in EPSG:3857 metres."""
    R = 6378137.0
    origin = math.pi * R
    size = 2 * origin / (2 ** z)
    minx = -origin + x * size
    maxx = minx + size
    maxy = origin - y * size
    miny = maxy - size
    return minx, miny, maxx, maxy


def _fetch_tile(z: int, x: int, y: int, retries: int = 2) -> np.ndarray | None:
    url = TERRAIN_TILE_URL.format(z=z, x=x, y=y)
    for attempt in range(retries + 1):
        try:
            resp = requests.get(url, timeout=20, headers=_UA)
            resp.raise_for_status()
            img = Image.open(BytesIO(resp.content)).convert("RGB")
            return np.asarray(img)
        except Exception:
            if attempt == retries:
                return None
            time.sleep(0.25)
    return None


@lru_cache(maxsize=512)
def _max_zoom_cached(lon_r: float, lat_r: float, ceiling: int) -> int:
    """Deepest zoom whose center tile actually exists, probed top-down with a
    1-byte range request (cheap, works whether or not HEAD is supported)."""
    for z in range(ceiling, 8, -1):
        x, y = _lonlat_to_tile(lon_r, lat_r, z)
        url = TERRAIN_TILE_URL.format(z=z, x=x, y=y)
        try:
            r = requests.get(url, timeout=8, headers={**_UA, "Range": "bytes=0-0"})
            if r.status_code < 400:
                return z
        except Exception:
            continue
    return 12


def max_available_zoom(lon: float, lat: float, ceiling: int | None = None) -> int:
    return _max_zoom_cached(round(lon, 3), round(lat, 3), ceiling or TERRAIN_MAX_ZOOM)


def build_dem(bbox, zoom: int, resolution_multiplier: int, out_path: str) -> dict:
    """Fetch terrain tiles for `bbox`, decode, mosaic, reproject to UTM, write GeoTIFF.

    `bbox` has .west/.south/.east/.north in WGS84 degrees. The DEM is fetched at
    `zoom + log2(multiplier)`, clamped to the deepest zoom the source actually
    serves here — we never upsample beyond the source, so a multiplier past the
    source's ceiling is a no-op (the UI uses `source_max_zoom` to warn about that).

    Returns a dict: path + the zoom decision (source_max_zoom / dem_zoom / requested_zoom).
    """
    cx0 = (bbox.west + bbox.east) / 2.0
    cy0 = (bbox.south + bbox.north) / 2.0
    # want_z = the resolution requested (screen zoom + multiplier); source_max = the
    # deepest zoom Mapterhorn serves here; z = the clamp (no upsampling past source).
    want_z = zoom + int(math.log2(resolution_multiplier))
    source_max = max_available_zoom(cx0, cy0)
    z = min(want_z, source_max)
    x0, y0 = _lonlat_to_tile(bbox.west, bbox.north, z)
    x1, y1 = _lonlat_to_tile(bbox.east, bbox.south, z)
    xs = range(min(x0, x1), max(x0, x1) + 1)
    ys = range(min(y0, y1), max(y0, y1) + 1)

    ntiles = len(xs) * len(ys)
    if ntiles > 256:
        raise ValueError(
            f"Viewport needs {ntiles} tiles at z{z}; zoom in or lower the resolution multiplier."
        )

    jobs = [(z, x, y) for y in ys for x in xs]
    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(lambda t: (t, _fetch_tile(*t)), jobs))

    valid = [(t, a) for t, a in results if a is not None]
    if not valid:
        raise ValueError("No terrain tiles returned for this viewport. Check TERRAIN_TILE_URL.")

    # Tile pixel size is detected from the data (Mapterhorn serves 512, OSM/Mapbox 256).
    ts = valid[0][1].shape[0]
    cols, rows = len(xs) * ts, len(ys) * ts
    mosaic = np.full((rows, cols), np.nan, dtype="f4")
    xs_list, ys_list = list(xs), list(ys)
    for (zz, x, y), arr in valid:
        if arr.shape[0] != ts or arr.shape[1] != ts:
            continue
        ix, iy = xs_list.index(x), ys_list.index(y)
        mosaic[iy * ts:(iy + 1) * ts, ix * ts:(ix + 1) * ts] = _decode(arr)

    # If too many tiles are missing (e.g. the source has no data at this zoom),
    # fail clearly rather than letting RiverREM crash on an all-NoData river.
    coverage = float(np.isfinite(mosaic).mean())
    if coverage < 0.25:
        raise ValueError(
            f"Terrain coverage is only {coverage:.0%} here at z{z}. "
            "Try a lower resolution multiplier or a different area."
        )

    # Geotransform of the mosaic in EPSG:3857 (origin = upper-left tile corner).
    ul_minx, _, _, ul_maxy = _tile_to_mercator_bounds(min(xs), min(ys), z)
    px = (2 * math.pi * 6378137.0) / (2 ** z) / ts  # metres / pixel in mercator
    gt = (ul_minx, px, 0.0, ul_maxy, 0.0, -px)

    mem = gdal.GetDriverByName("MEM").Create("", cols, rows, 1, gdal.GDT_Float32)
    mem.SetGeoTransform(gt)
    srs3857 = osr.SpatialReference(); srs3857.ImportFromEPSG(3857)
    mem.SetProjection(srs3857.ExportToWkt())
    band = mem.GetRasterBand(1)
    band.WriteArray(np.where(np.isnan(mosaic), -9999.0, mosaic))
    band.SetNoDataValue(-9999.0)
    # Patch holes from individually-failed tiles so the river never lands on NoData.
    gdal.FillNodata(targetBand=band, maskBand=None, maxSearchDist=100, smoothingIterations=0)

    # Reproject to the UTM zone of the viewport centre, so REMMaker works in metres.
    cx = (bbox.west + bbox.east) / 2.0
    cy = (bbox.south + bbox.north) / 2.0
    utm_zone = int((cx + 180) / 6) + 1
    epsg_utm = (32600 if cy >= 0 else 32700) + utm_zone

    _log.info(
        "DEM build: screen z%d, requested z%d, source max z%d, fetched z%d (%dx)",
        zoom, want_z, source_max, z, resolution_multiplier,
    )

    gdal.Warp(
        out_path, mem,
        dstSRS=f"EPSG:{epsg_utm}",
        resampleAlg="bilinear",
        srcNodata=-9999.0, dstNodata=-9999.0,
        format="GTiff",
    )
    mem = None
    return {
        "path": out_path,
        "source_max_zoom": source_max,
        "dem_zoom": z,
        "requested_zoom": want_z,
        "screen_zoom": zoom,
    }
