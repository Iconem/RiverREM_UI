"""RiverREM pipeline API.

Simple client-server design (the trigger.dev path would swap /compute for an
enqueue + status-poll, but the work is identical). Endpoints:

  POST /centerline/osm  -> preview the longest OSM river in a bbox (GeoJSON)
  POST /upload          -> upload a zipped shapefile, returns upload_id
  POST /compute         -> run the full pipeline, returns a COG url + metadata
  GET  /cogs/<file>     -> static COG, HTTP range requests (for the cog protocol)
"""
from __future__ import annotations

import logging
import math
import os
import re
import shutil
import threading
import uuid
import zipfile

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from osgeo import gdal, osr

from .centerline import (
    geojson_to_shapefile,
    normalize_uploaded_shapefile,
    osm_centerline_geojson,
)
from .rem import make_rem_cog, _percentiles
from .schemas import (
    CenterlineResponse,
    CogIngestRequest,
    CogIngestResponse,
    ComputeRequest,
    ComputeResponse,
)
from .terrain import build_dem

gdal.UseExceptions()

DATA_DIR = os.environ.get("DATA_DIR", "./data")
COG_DIR = os.path.join(DATA_DIR, "cogs")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
PUBLIC_BASE = os.environ.get("PUBLIC_BASE", "http://localhost:8000")
for d in (COG_DIR, UPLOAD_DIR):
    os.makedirs(d, exist_ok=True)

app = FastAPI(title="RiverREM Pipeline")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
)
# StaticFiles serves byte-range requests, which is all the cog protocol needs.
app.mount("/cogs", StaticFiles(directory=COG_DIR), name="cogs")


# ---------------------------------------------------------------------------
# Job registry + progress. RiverREM logs its KD-tree interpolation progress as
# "<pct>%" lines (the slowest step); we attach a logging handler that attributes
# those lines to the running job's thread and exposes them via GET /compute/{id}.
# ---------------------------------------------------------------------------
JOBS: dict[str, dict] = {}
_THREAD_JOB: dict[int, str] = {}

_PHASE_KEYWORDS = [
    ("river centerline", "Finding centerline"),
    ("river elevation", "Sampling river elevation"),
    ("Interpolating", "Interpolating water surface"),
    ("Detrending", "Detrending DEM"),
]


class _ProgressHandler(logging.Handler):
    def emit(self, record):
        jid = _THREAD_JOB.get(threading.get_ident())
        if not jid or jid not in JOBS:
            return
        msg = record.getMessage()
        m = re.search(r"(\d+(?:\.\d+)?)\s*%", msg)
        if m:
            JOBS[jid]["pct"] = float(m.group(1))
        for kw, phase in _PHASE_KEYWORDS:
            if kw in msg:
                JOBS[jid]["phase"] = phase
                break


logging.getLogger().addHandler(_ProgressHandler())


def _set(job_id: str, **kw):
    if job_id in JOBS:
        JOBS[job_id].update(kw)


def _run_compute(job_id: str, req: ComputeRequest):
    _THREAD_JOB[threading.get_ident()] = job_id
    job_dir = os.path.join(COG_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)
    try:
        _set(job_id, phase="Fetching terrain tiles", pct=0)
        dem_path = os.path.join(job_dir, "dem.tif")
        build_dem(req.bbox, req.zoom, req.resolution_multiplier, dem_path)

        _set(job_id, phase="Resolving centerline")
        centerline_shp = None
        if req.centerline_mode == "geojson":
            if not req.centerline_geojson:
                raise ValueError("centerline_geojson required for geojson mode")
            centerline_shp = geojson_to_shapefile(req.centerline_geojson, os.path.join(job_dir, "centerline.shp"))
        elif req.centerline_mode == "shapefile":
            if not req.upload_id:
                raise ValueError("upload_id required for shapefile mode")
            centerline_shp = normalize_uploaded_shapefile(os.path.join(UPLOAD_DIR, req.upload_id))

        _set(job_id, phase="Running RiverREM")
        rem_cog = os.path.join(job_dir, "rem_REM.tif")
        meta = make_rem_cog(
            dem_path, rem_cog, out_dir=job_dir,
            centerline_shp=centerline_shp,
            interp_pts=req.interp_pts, k=req.k, eps=req.eps,
        )

        rel = os.path.relpath(rem_cog, COG_DIR)
        dem_url = None
        if meta.get("dem_cog") and os.path.exists(meta["dem_cog"]):
            dem_url = f"{PUBLIC_BASE}/cogs/{os.path.relpath(meta['dem_cog'], COG_DIR)}"
        resp = ComputeResponse(
            job_id=job_id,
            cog_url=f"{PUBLIC_BASE}/cogs/{rel}",
            dem_url=dem_url,
            bounds=[req.bbox.west, req.bbox.south, req.bbox.east, req.bbox.north],
            rem_min=meta["rem_min"], rem_max=meta["rem_max"],
            river_name=meta.get("river_name"), river_length_m=meta.get("river_length_m"),
        )
        _set(job_id, status="done", phase="Done", pct=100, result=resp.model_dump())
    except Exception as e:
        _set(job_id, status="error", error=str(e))
    finally:
        _THREAD_JOB.pop(threading.get_ident(), None)


@app.post("/centerline/osm", response_model=CenterlineResponse)
def centerline_osm(req: ComputeRequest):
    try:
        geojson, name, length = osm_centerline_geojson(req.bbox)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return CenterlineResponse(geojson=geojson, river_name=name, river_length_m=round(length, 1))


@app.post("/upload")
async def upload_shapefile(file: UploadFile = File(...)):
    upload_id = uuid.uuid4().hex
    dest = os.path.join(UPLOAD_DIR, upload_id)
    os.makedirs(dest, exist_ok=True)
    raw = os.path.join(dest, file.filename)
    with open(raw, "wb") as f:
        shutil.copyfileobj(file.file, f)
    if raw.lower().endswith(".zip"):
        with zipfile.ZipFile(raw) as z:
            z.extractall(dest)
    return {"upload_id": upload_id}


@app.post("/compute")
def compute(req: ComputeRequest):
    """Start a compute job; returns a job_id. Poll GET /compute/{job_id} for
    progress (RiverREM's interpolation % is surfaced) and the final result."""
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "running", "phase": "Queued", "pct": 0}
    threading.Thread(target=_run_compute, args=(job_id, req), daemon=True).start()
    return {"job_id": job_id}


@app.get("/compute/{job_id}")
def compute_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown job")
    return job


@app.get("/sample")
def sample(path: str, lng: float, lat: float):
    """Read the value of a served COG (by its /cogs relative path) at a lng/lat.
    Used by the click/hover altitude picker. COGs are EPSG:3857."""
    fp = os.path.normpath(os.path.join(COG_DIR, path))
    if not fp.startswith(os.path.abspath(COG_DIR)) or not os.path.exists(fp):
        raise HTTPException(status_code=404, detail="Unknown COG")
    ds = gdal.Open(fp)
    if ds is None:
        return {"value": None}
    R = 6378137.0
    x = R * math.radians(lng)
    y = R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    gt = ds.GetGeoTransform()
    px = int((x - gt[0]) / gt[1])
    py = int((y - gt[3]) / gt[5])
    if px < 0 or py < 0 or px >= ds.RasterXSize or py >= ds.RasterYSize:
        return {"value": None}
    band = ds.GetRasterBand(1)
    arr = band.ReadAsArray(px, py, 1, 1)
    if arr is None:
        return {"value": None}
    v = float(arr[0, 0])
    nd = band.GetNoDataValue()
    if nd is not None and v == nd:
        return {"value": None}
    return {"value": round(v, 3)}


@app.get("/health")
def health():
    return {"ok": True}


def _to_wgs84_bounds(ds) -> list[float]:
    """Full extent of a dataset in WGS84 [w, s, e, n], axis-order safe."""
    gt = ds.GetGeoTransform()
    W, H = ds.RasterXSize, ds.RasterYSize
    src = osr.SpatialReference(wkt=ds.GetProjection())
    src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    dst = osr.SpatialReference(); dst.ImportFromEPSG(4326)
    dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    ct = osr.CoordinateTransformation(src, dst)
    corners = [
        (gt[0], gt[3]),
        (gt[0] + gt[1] * W, gt[3]),
        (gt[0], gt[3] + gt[5] * H),
        (gt[0] + gt[1] * W, gt[3] + gt[5] * H),
    ]
    lons, lats = [], []
    for x, y in corners:
        lon, lat, *_ = ct.TransformPoint(x, y)
        lons.append(lon); lats.append(lat)
    return [min(lons), min(lats), max(lons), max(lats)]


@app.post("/cog/ingest", response_model=CogIngestResponse)
def cog_ingest(req: CogIngestRequest):
    """Reproject an arbitrary remote single-band float COG to a web-mercator COG.

    Reads the source over HTTP via GDAL /vsicurl (range requests + overviews), so
    only the needed blocks are fetched. Output is downsampled to ~3k px on the long
    side for a fast overview the client can style; recompute/zoom for full detail.
    """
    try:
        src = gdal.Open("/vsicurl/" + req.url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open COG: {e}")
    if src is None:
        raise HTTPException(status_code=400, detail="Could not open COG (is the URL a valid COG?).")

    bounds = _to_wgs84_bounds(src)

    job_id = uuid.uuid4().hex
    job_dir = os.path.join(COG_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)

    R = 6378137.0
    def to3857(lon, lat):
        return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    minx, miny = to3857(bounds[0], max(-85.05, bounds[1]))
    maxx, maxy = to3857(bounds[2], min(85.05, bounds[3]))
    res = max(maxx - minx, maxy - miny) / 3072.0

    warped = os.path.join(job_dir, "ingest.3857.tif")
    out_cog = os.path.join(job_dir, "ingest_REM.tif")
    try:
        gdal.Warp(
            warped, src, dstSRS="EPSG:3857",
            xRes=res, yRes=res, resampleAlg="bilinear", format="GTiff",
        )
        gdal.Translate(
            out_cog, warped, format="COG",
            creationOptions=["COMPRESS=DEFLATE", "BLOCKSIZE=256", "PREDICTOR=2"],
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Reprojection failed: {e}")

    lo, hi = _percentiles(out_cog, nodata=src.GetRasterBand(1).GetNoDataValue())
    rel = os.path.relpath(out_cog, COG_DIR)
    return CogIngestResponse(
        cog_url=f"{PUBLIC_BASE}/cogs/{rel}",
        bounds=bounds,
        rem_min=round(lo, 3),
        rem_max=round(hi, 3),
    )
