"""RiverREM pipeline API.

Simple client-server design (the trigger.dev path would swap /compute for an
enqueue + status-poll, but the work is identical). Endpoints:

  POST /centerline/osm  -> preview the longest OSM river in a bbox (GeoJSON)
  POST /upload          -> upload a zipped shapefile, returns upload_id
  POST /compute         -> run the full pipeline, returns a COG url + metadata
  GET  /cogs/<file>     -> static COG, HTTP range requests (for the cog protocol)
"""
from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager
import glob
import hashlib
import json
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
import threading
import uuid
import zipfile
from pathlib import PurePosixPath

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from osgeo import gdal, ogr, osr

from .centerline import (
    CenterlineCrsRequired,
    geojson_to_shapefile,
    import_centerline_dataset,
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
    DemUploadInitRequest,
    PruneRequest,
    PruneResponse,
    ThumbRequest,
    ThumbResponse,
)
from .terrain import build_dem

gdal.UseExceptions()

DATA_DIR = os.environ.get("DATA_DIR", "./data")
COG_DIR = os.path.join(DATA_DIR, "cogs")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
PUBLIC_BASE = os.environ.get("PUBLIC_BASE", "http://localhost:8000")
# Cap the number of stored COG job dirs; oldest are evicted past this. The client
# prunes runs whose COG vanished (see /runs/prune), so the UI stays consistent.
MAX_COGS = int(os.environ.get("MAX_COGS", "200"))
CENTERLINE_UPLOAD_MAX_BYTES = max(
    1, int(os.environ.get("CENTERLINE_UPLOAD_MAX_BYTES", str(64 * 1024**2)))
)


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    return default if value is None else value.strip().lower() in {"1", "true", "yes", "on"}


DEM_UPLOAD_ENABLED = _env_bool("DEM_UPLOAD_ENABLED", False)
DEM_UPLOAD_MAX_BYTES = max(1, int(os.environ.get("DEM_UPLOAD_MAX_BYTES", str(20 * 1024**3))))
DEM_UPLOAD_TTL_HOURS = max(1, int(os.environ.get("DEM_UPLOAD_TTL_HOURS", "24")))
DEM_UPLOAD_CLEANUP_INTERVAL_MINUTES = max(
    1, int(os.environ.get("DEM_UPLOAD_CLEANUP_INTERVAL_MINUTES", "15"))
)
DEM_UPLOAD_DIR = os.path.realpath(os.environ.get("DEM_UPLOAD_DIR", os.path.join(DATA_DIR, "dem_uploads")))
DEM_LIBRARY_DIR_RAW = os.environ.get("DEM_LIBRARY_DIR", "").strip()
DEM_LIBRARY_DIR = os.path.realpath(DEM_LIBRARY_DIR_RAW) if DEM_LIBRARY_DIR_RAW else None
DEM_LIBRARY_LABEL = os.environ.get("DEM_LIBRARY_LABEL", "Server library").strip() or "Server library"
for d in (COG_DIR, UPLOAD_DIR, DEM_UPLOAD_DIR):
    os.makedirs(d, exist_ok=True)


def _evict_old_cogs():
    """Keep at most MAX_COGS job dirs under COG_DIR (newest by mtime), so disk use
    stays bounded. `thumbs/` and any non-job entries are left untouched."""
    try:
        entries = []
        for name in os.listdir(COG_DIR):
            if name == "thumbs":
                continue
            p = os.path.join(COG_DIR, name)
            if os.path.isdir(p):
                entries.append((os.path.getmtime(p), p, name))
        if len(entries) <= MAX_COGS:
            return
        entries.sort(reverse=True)  # newest first
        for _, p, name in entries[MAX_COGS:]:
            shutil.rmtree(p, ignore_errors=True)
            # drop the matching thumbnail too (best-effort)
            tp = os.path.join(COG_DIR, "thumbs", f"{name}.jpg")
            if os.path.exists(tp):
                try:
                    os.remove(tp)
                except OSError:
                    pass
    except Exception:
        pass

async def _dem_upload_cleanup_loop():
    """Remove expired uploads periodically without requiring an API request."""
    while True:
        await asyncio.sleep(DEM_UPLOAD_CLEANUP_INTERVAL_MINUTES * 60)
        try:
            await asyncio.to_thread(_prune_dem_uploads)
        except Exception:
            logging.getLogger("riverrem.dem").exception("Automatic DEM upload cleanup failed")


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    cleanup_task = None
    if DEM_UPLOAD_ENABLED:
        # Clean on every server start, then continue on a fixed interval.
        await asyncio.to_thread(_prune_dem_uploads)
        cleanup_task = asyncio.create_task(_dem_upload_cleanup_loop())
    try:
        yield
    finally:
        if cleanup_task:
            cleanup_task.cancel()
            try:
                await cleanup_task
            except asyncio.CancelledError:
                pass


app = FastAPI(title="RiverREM Pipeline", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
)
# StaticFiles serves byte-range requests, which is all the cog protocol needs.
app.mount("/cogs", StaticFiles(directory=COG_DIR), name="cogs")


@app.middleware("http")
async def no_store_cogs(request, call_next):
    """geotiff.js fires many concurrent range requests at each COG. Chrome's HTTP
    cache can't service overlapping partial reads of the same URL and aborts them
    with net::ERR_CACHE_OPERATION_NOT_SUPPORTED, so tiles silently fail to render.
    Marking COG responses no-store keeps every range request on the network path."""
    response = await call_next(request)
    if request.url.path.startswith("/cogs/"):
        response.headers["Cache-Control"] = "no-store"
    return response


# ---------------------------------------------------------------------------
# Job registry + progress. RiverREM logs its KD-tree interpolation progress as
# "<pct>%" lines (the slowest step); we attach a logging handler that attributes
# those lines to the running job's thread and exposes them via GET /compute/{id}.
# ---------------------------------------------------------------------------
JOBS: dict[str, dict] = {}
_THREAD_JOB: dict[int, str] = {}

_PHASE_KEYWORDS = [
    ("river centerline", "Finding centerline"),
    # Check "Interpolating" BEFORE "river elevation": RiverREM logs
    # "Interpolating river elevation across DEM extent" (contains both), and the
    # interpolation is the long KD-tree step we want to surface.
    ("Interpolating", "Interpolating river surface"),
    ("Getting river elevation", "Sampling river elevation"),
    ("river elevation", "Sampling river elevation"),
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
            # Only the interpolation step logs a running %, so a % line means we're
            # interpolating the river surface (the slowest phase).
            JOBS[jid]["pct"] = float(m.group(1))
            JOBS[jid]["phase"] = "Interpolating river surface"
        for kw, phase in _PHASE_KEYWORDS:
            if kw in msg:
                JOBS[jid]["phase"] = phase
                break


logging.getLogger().addHandler(_ProgressHandler())


def _set(job_id: str, **kw):
    if job_id in JOBS:
        JOBS[job_id].update(kw)


def _bounds_intersection(a: list[float], b: list[float]) -> list[float] | None:
    intersection = [max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])]
    return intersection if intersection[0] < intersection[2] and intersection[1] < intersection[3] else None


def _vector_wgs84_bounds(path: str) -> list[float]:
    dataset = ogr.Open(path, 0)
    if dataset is None:
        raise ValueError("The selected centerline could not be opened for the coverage check")
    output_bounds: list[float] | None = None
    for index in range(dataset.GetLayerCount()):
        layer = dataset.GetLayerByIndex(index)
        extent = layer.GetExtent()
        source_srs = layer.GetSpatialRef()
        if extent is None or source_srs is None:
            continue
        source_srs = source_srs.Clone()
        source_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        target_srs = osr.SpatialReference()
        target_srs.ImportFromEPSG(4326)
        target_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        transform = osr.CoordinateTransformation(source_srs, target_srs)
        min_x, max_x, min_y, max_y = extent
        points = [
            transform.TransformPoint(x, y)
            for x, y in ((min_x, min_y), (min_x, max_y), (max_x, min_y), (max_x, max_y))
        ]
        bounds = [
            min(point[0] for point in points), min(point[1] for point in points),
            max(point[0] for point in points), max(point[1] for point in points),
        ]
        if output_bounds is None:
            output_bounds = bounds
        else:
            output_bounds = [
                min(output_bounds[0], bounds[0]), min(output_bounds[1], bounds[1]),
                max(output_bounds[2], bounds[2]), max(output_bounds[3], bounds[3]),
            ]
    dataset = None
    if output_bounds is None or not all(math.isfinite(value) for value in output_bounds):
        raise ValueError("The selected centerline does not have valid geographic bounds")
    return output_bounds


def _preflight_custom_dem(
    req: ComputeRequest,
    source_dem_path: str | None,
    centerline_path: str | None,
) -> None:
    """Reject fixed-extent DEM/analysis combinations that cannot produce a REM."""
    if not req.source_cog_url and not source_dem_path:
        return
    if req.source_cog_url and not req.source_cog_url.startswith(("http://", "https://")):
        raise ValueError("Custom DEM URLs must use http:// or https://")
    source = source_dem_path or f"/vsicurl/{req.source_cog_url}"
    dataset = gdal.OpenEx(source, gdal.OF_RASTER | gdal.OF_READONLY)
    if dataset is None:
        raise ValueError("The selected custom DEM could not be opened")
    if not dataset.GetProjection() or dataset.GetGeoTransform(can_return_null=True) is None:
        dataset = None
        raise ValueError("The selected custom DEM is missing its CRS or georeferencing")
    dem_bounds = _to_wgs84_bounds(dataset)
    dataset = None
    viewport_bounds = [req.bbox.west, req.bbox.south, req.bbox.east, req.bbox.north]
    analysis_bounds = _bounds_intersection(dem_bounds, viewport_bounds)
    if analysis_bounds is None:
        raise ValueError(
            "The selected custom DEM does not overlap the current map viewport. "
            "Move the map to the DEM or choose a different DEM."
        )
    if centerline_path:
        centerline_bounds = _vector_wgs84_bounds(centerline_path)
        if _bounds_intersection(centerline_bounds, analysis_bounds) is None:
            raise ValueError(
                "The centerline does not overlap the part of the selected custom DEM "
                "inside the current map viewport. Check the CRS, viewport, and DEM selection."
            )


def _run_compute(job_id: str, req: ComputeRequest):
    _THREAD_JOB[threading.get_ident()] = job_id
    job_dir = os.path.join(COG_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)
    try:
        if req.source_cog_url and req.source_dem_ref:
            raise ValueError("Choose either a source COG URL or a server DEM reference, not both")
        source_dem_path = _resolve_dem_ref(req.source_dem_ref) if req.source_dem_ref else None

        _set(job_id, phase="Resolving centerline", pct=5)
        centerline_shp = None
        if req.centerline_mode == "geojson":
            if not req.centerline_geojson:
                raise ValueError("centerline_geojson required for geojson mode")
            centerline_shp = geojson_to_shapefile(
                req.centerline_geojson, os.path.join(job_dir, "centerline.shp")
            )
        elif req.centerline_mode == "shapefile":
            if not req.upload_id:
                raise ValueError("upload_id required for shapefile mode")
            centerline_shp = normalize_uploaded_shapefile(os.path.join(UPLOAD_DIR, req.upload_id))

        if req.source_cog_url or source_dem_path:
            _set(job_id, phase="Checking custom DEM coverage", pct=8)
            _preflight_custom_dem(req, source_dem_path, centerline_shp)

        if req.source_dem_ref:
            source_phase = "Preparing server DEM"
        elif req.source_cog_url:
            source_phase = "Reading DEM COG"
        else:
            source_phase = "Fetching terrain tiles"
        _set(job_id, phase=source_phase, pct=10)
        dem_path = os.path.join(job_dir, "dem.tif")
        dem_info = build_dem(
            req.bbox,
            req.zoom,
            req.resolution_multiplier,
            dem_path,
            req.source_cog_url,
            source_dem_path,
        )

        _set(job_id, phase="Running RiverREM")
        rem_cog = os.path.join(job_dir, "rem_REM.tif")
        meta = make_rem_cog(
            dem_path, rem_cog, out_dir=job_dir,
            centerline_shp=centerline_shp,
            interp_pts=req.interp_pts, k=req.k, eps=req.eps, idw_power=req.idw_power,
        )

        rel = os.path.relpath(rem_cog, COG_DIR)
        dem_url = None
        if meta.get("dem_cog") and os.path.exists(meta["dem_cog"]):
            dem_url = f"{PUBLIC_BASE}/cogs/{os.path.relpath(meta['dem_cog'], COG_DIR)}"

        # Persist the centerline alongside the COG so it travels with the run
        # (other users loading a shared run can fetch it). Written as GeoJSON,
        # served statically under /cogs.
        centerline_url = None
        cl_path = os.path.join(job_dir, "centerline.geojson")
        try:
            if req.centerline_geojson:
                with open(cl_path, "w") as f:
                    json.dump(req.centerline_geojson, f)
            elif centerline_shp and os.path.exists(centerline_shp):
                subprocess.run(
                    ["ogr2ogr", "-f", "GeoJSON", "-t_srs", "EPSG:4326", cl_path, centerline_shp],
                    check=True, capture_output=True,
                )
            if os.path.exists(cl_path):
                centerline_url = f"{PUBLIC_BASE}/cogs/{os.path.relpath(cl_path, COG_DIR)}"
        except Exception:
            centerline_url = None

        resp = ComputeResponse(
            job_id=job_id,
            cog_url=f"{PUBLIC_BASE}/cogs/{rel}",
            dem_url=dem_url,
            bounds=[req.bbox.west, req.bbox.south, req.bbox.east, req.bbox.north],
            rem_min=meta["rem_min"], rem_max=meta["rem_max"],
            dem_min=meta.get("dem_min"), dem_max=meta.get("dem_max"),
            river_name=meta.get("river_name"), river_length_m=meta.get("river_length_m"),
            centerline_url=centerline_url,
            width=meta.get("width"), height=meta.get("height"),
            source_max_zoom=dem_info.get("source_max_zoom"),
            dem_zoom=dem_info.get("dem_zoom"),
            requested_zoom=dem_info.get("requested_zoom"),
            dem_downsampled=dem_info.get("dem_downsampled", False),
            native_width=dem_info.get("native_width"),
            native_height=dem_info.get("native_height"),
            processed_dem_width=dem_info.get("dem_width"),
            processed_dem_height=dem_info.get("dem_height"),
        )
        _set(job_id, status="done", phase="Done", pct=100, result=resp.model_dump())
        # Sidecar metadata for the server-side /gallery (filesystem + JSON, no DB).
        try:
            with open(os.path.join(job_dir, "run.json"), "w") as f:
                json.dump({
                    "id": job_id,
                    "cog_url": resp.cog_url, "dem_url": resp.dem_url,
                    "bounds": resp.bounds, "rem_min": resp.rem_min, "rem_max": resp.rem_max,
                    "width": resp.width, "height": resp.height,
                    "river_name": resp.river_name, "river_length_m": resp.river_length_m,
                    "centerline_url": resp.centerline_url, "ts": int(time.time() * 1000),
                }, f)
        except Exception:
            pass
        _evict_old_cogs()
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


@app.post("/runs/prune", response_model=PruneResponse)
def prune_runs(req: PruneRequest):
    """Return the subset of the client's run COG paths that still exist on disk.

    The client stores runs in localStorage; after a container rebuild the COGs may
    be gone. The client posts its known relative /cogs paths and drops any not
    returned here. Paths are constrained to COG_DIR (no traversal)."""
    existing: list[str] = []
    root = os.path.abspath(COG_DIR)
    for rel in req.paths:
        fp = os.path.abspath(os.path.join(COG_DIR, rel))
        if fp.startswith(root) and os.path.exists(fp):
            existing.append(rel)
    return PruneResponse(existing=existing)


@app.post("/thumb", response_model=ThumbResponse)
def save_thumb(req: ThumbRequest):
    """Persist a run's gallery thumbnail server-side (so it survives browser storage
    limits and is shareable). Stored under COG_DIR/thumbs/<id>.jpg, served via /cogs."""
    data = req.image.split(",", 1)[1] if req.image.startswith("data:") else req.image
    try:
        raw = base64.b64decode(data)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid image data")
    if len(raw) > 2_000_000:
        raise HTTPException(status_code=413, detail="thumbnail too large")
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", req.id)[:80] or "thumb"
    tdir = os.path.join(COG_DIR, "thumbs")
    os.makedirs(tdir, exist_ok=True)
    with open(os.path.join(tdir, f"{safe}.jpg"), "wb") as f:
        f.write(raw)
    # Fold the resolved run name + symbology snapshot into the gallery sidecar.
    if req.name or req.symbology:
        rj = os.path.join(COG_DIR, safe, "run.json")
        if os.path.exists(rj):
            try:
                with open(rj) as f:
                    meta = json.load(f)
                if req.name:
                    meta["name"] = req.name
                if req.symbology:
                    meta["symbology"] = req.symbology
                with open(rj, "w") as f:
                    json.dump(meta, f)
            except Exception:
                pass
    return ThumbResponse(url=f"{PUBLIC_BASE}/cogs/thumbs/{safe}.jpg")


@app.get("/gallery")
def gallery():
    """Server-side gallery (filesystem + JSON, no DB): every compute writes a
    `run.json` sidecar next to its COG; this globs them, attaches the hosted
    thumbnail when present, and returns the list newest-first. Read-only."""
    items = []
    for path in glob.glob(os.path.join(COG_DIR, "*", "run.json")):
        try:
            with open(path) as f:
                meta = json.load(f)
        except Exception:
            continue
        rid = meta.get("id")
        thumb_fp = os.path.join(COG_DIR, "thumbs", f"{rid}.jpg") if rid else None
        meta["thumb"] = f"{PUBLIC_BASE}/cogs/thumbs/{rid}.jpg" if (thumb_fp and os.path.exists(thumb_fp)) else None
        items.append(meta)
    items.sort(key=lambda m: m.get("ts", 0), reverse=True)
    return {"runs": items}


async def _save_centerline_upload(file: UploadFile, destination: str) -> None:
    received = 0
    with open(destination, "wb") as file_obj:
        while chunk := await file.read(1024 * 1024):
            received += len(chunk)
            if received > CENTERLINE_UPLOAD_MAX_BYTES:
                raise HTTPException(status_code=413, detail="Centerline file exceeds the 64 MB limit")
            file_obj.write(chunk)
    if received == 0:
        raise HTTPException(status_code=400, detail="The selected centerline file is empty")


def _safe_extract_shapefile_zip(zip_path: str, destination: str) -> list[str]:
    """Extract shapefile components without permitting traversal or zip bombs."""
    allowed = {".shp", ".shx", ".dbf", ".prj", ".cpg", ".qix", ".sbn", ".sbx"}
    extracted_shps: list[str] = []
    total_uncompressed = 0
    with zipfile.ZipFile(zip_path) as archive:
        members = archive.infolist()
        if len(members) > 256:
            raise ValueError("The shapefile archive contains too many files")
        for member in members:
            total_uncompressed += member.file_size
            if total_uncompressed > 256 * 1024**2:
                raise ValueError("The uncompressed shapefile archive exceeds 256 MB")
            if member.is_dir():
                continue
            posix_path = PurePosixPath(member.filename)
            if posix_path.is_absolute() or ".." in posix_path.parts:
                raise ValueError("The shapefile archive contains an unsafe path")
            if ((member.external_attr >> 16) & 0o170000) == 0o120000:
                raise ValueError("Symbolic links are not allowed in shapefile archives")
            # Finder's "Compress" command adds AppleDouble resource-fork files.
            # Their names can still end in .shp/.dbf/etc, but they are metadata,
            # not GIS datasets, and GDAL correctly refuses to open them.
            if "__MACOSX" in posix_path.parts or posix_path.name.startswith("._"):
                continue
            if posix_path.name == ".DS_Store":
                continue
            suffix = posix_path.suffix.lower()
            if suffix not in allowed:
                continue
            target = os.path.realpath(os.path.join(destination, *posix_path.parts))
            if os.path.commonpath((os.path.realpath(destination), target)) != os.path.realpath(destination):
                raise ValueError("The shapefile archive contains an unsafe path")
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with archive.open(member) as source, open(target, "wb") as output:
                shutil.copyfileobj(source, output)
            if suffix == ".shp":
                extracted_shps.append(target)
    if not extracted_shps:
        raise ValueError("The ZIP archive does not contain a .shp file")
    for shp_path in extracted_shps:
        directory = os.path.dirname(shp_path)
        stem = os.path.splitext(os.path.basename(shp_path))[0].lower()
        components = {
            os.path.splitext(filename)[1].lower()
            for filename in os.listdir(directory)
            if os.path.splitext(filename)[0].lower() == stem
        }
        missing = sorted({".dbf", ".shx"} - components)
        if missing:
            raise ValueError(
                f"Shapefile '{os.path.basename(shp_path)}' is incomplete; missing "
                + " and ".join(missing)
                + "."
            )
    return sorted(extracted_shps)


def _normalize_geojson_document(source_path: str, destination: str) -> None:
    try:
        with open(source_path, encoding="utf-8") as file_obj:
            document = json.load(file_obj)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"The selected file is not valid GeoJSON: {exc}") from exc
    doc_type = document.get("type") if isinstance(document, dict) else None
    if doc_type == "FeatureCollection":
        features = document.get("features", [])
    elif doc_type == "Feature":
        features = [document]
    elif doc_type in {"LineString", "MultiLineString"}:
        features = [{"type": "Feature", "properties": {}, "geometry": document}]
    else:
        raise ValueError("GeoJSON must contain a LineString or MultiLineString feature")
    with open(destination, "w", encoding="utf-8") as file_obj:
        json.dump({"type": "FeatureCollection", "features": features}, file_obj)


@app.post("/centerline/import")
async def import_centerline_file(
    file: UploadFile = File(...),
    input_crs: str | None = Form(None),
):
    """Normalize GeoJSON, GeoPackage, or zipped shapefile linework to WGS84."""
    filename = os.path.basename(file.filename or "centerline")
    suffix = os.path.splitext(filename)[1].lower()
    if suffix not in {".geojson", ".json", ".gpkg", ".zip"}:
        raise HTTPException(
            status_code=400,
            detail="Accepted centerline files: .geojson, .json, .gpkg, or zipped shapefile",
        )

    try:
        with tempfile.TemporaryDirectory(prefix="riverrem-centerline-") as temp_dir:
            source_path = os.path.join(temp_dir, f"source{suffix}")
            await _save_centerline_upload(file, source_path)
            layers: list[dict] = []
            if suffix in {".geojson", ".json"}:
                normalized_path = os.path.join(temp_dir, "normalized.geojson")
                _normalize_geojson_document(source_path, normalized_path)
                layers = import_centerline_dataset(
                    normalized_path,
                    display_name=filename,
                    force_geojson_wgs84=True,
                )
                if len(layers) == 1:
                    layers[0]["name"] = os.path.splitext(filename)[0]
            elif suffix == ".gpkg":
                layers = import_centerline_dataset(
                    source_path,
                    display_name=filename,
                    input_crs=input_crs,
                )
            else:
                extract_dir = os.path.join(temp_dir, "shapefile")
                os.makedirs(extract_dir)
                shp_paths = _safe_extract_shapefile_zip(source_path, extract_dir)
                for shp_path in shp_paths:
                    relative = os.path.relpath(shp_path, extract_dir)
                    imported = import_centerline_dataset(
                        shp_path,
                        display_name=relative,
                        input_crs=input_crs,
                        layer_id_prefix=f"{relative}::",
                    )
                    for layer in imported:
                        layer["name"] = os.path.splitext(relative)[0]
                    layers.extend(imported)
            return {"filename": filename, "layers": layers}
    except CenterlineCrsRequired as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "crs_required", "message": str(exc)},
        ) from exc
    except HTTPException:
        raise
    except (ValueError, zipfile.BadZipFile) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logging.getLogger("riverrem.centerline").exception("Centerline import failed")
        raise HTTPException(status_code=400, detail=f"Could not read centerline file: {exc}") from exc


@app.post("/upload")
async def upload_shapefile(file: UploadFile = File(...)):
    """Legacy shapefile upload used by the older compute contract."""
    upload_id = uuid.uuid4().hex
    dest = os.path.join(UPLOAD_DIR, upload_id)
    os.makedirs(dest, exist_ok=True)
    filename = os.path.basename(file.filename or "centerline.zip")
    raw = os.path.join(dest, filename)
    try:
        await _save_centerline_upload(file, raw)
        if raw.lower().endswith(".zip"):
            _safe_extract_shapefile_zip(raw, dest)
        return {"upload_id": upload_id}
    except Exception:
        shutil.rmtree(dest, ignore_errors=True)
        raise


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
        (gt[0] + px * gt[1] + py * gt[2], gt[3] + px * gt[4] + py * gt[5])
        for px, py in ((0, 0), (W, 0), (0, H), (W, H))
    ]
    lons, lats = [], []
    for x, y in corners:
        lon, lat, *_ = ct.TransformPoint(x, y)
        lons.append(lon); lats.append(lat)
    return [min(lons), min(lats), max(lons), max(lats)]


def _inspect_dem(path: str, *, dem_ref: str | None = None, display_name: str | None = None):
    ds = gdal.OpenEx(path, gdal.OF_RASTER | gdal.OF_READONLY)
    if ds is None or ds.RasterCount != 1:
        raise ValueError("The DEM must be a readable, single-band raster")
    if not ds.GetProjection():
        raise ValueError("The DEM does not contain a coordinate reference system")
    if ds.GetGeoTransform(can_return_null=True) is None:
        raise ValueError("The DEM does not contain a geotransform")
    spatial_ref = ds.GetSpatialRef()
    crs = None
    if spatial_ref is not None:
        authority_name = spatial_ref.GetAuthorityName(None)
        authority_code = spatial_ref.GetAuthorityCode(None)
        crs = (
            f"{authority_name}:{authority_code}"
            if authority_name and authority_code
            else spatial_ref.GetName()
        )
    result = {
        "name": display_name or os.path.basename(path),
        "sizeBytes": os.path.getsize(path),
        "width": ds.RasterXSize,
        "height": ds.RasterYSize,
        "bounds": _to_wgs84_bounds(ds),
        "crs": crs,
    }
    if dem_ref:
        result["ref"] = dem_ref
    ds = None
    return result


def _safe_library_files():
    """Return opaque refs for GeoTIFFs beneath the configured library root."""
    if not DEM_LIBRARY_DIR or not os.path.isdir(DEM_LIBRARY_DIR):
        return []
    root = os.path.realpath(DEM_LIBRARY_DIR)
    entries = []
    for current_dir, _, filenames in os.walk(root, followlinks=False):
        for filename in sorted(filenames):
            if not filename.lower().endswith((".tif", ".tiff")):
                continue
            path = os.path.realpath(os.path.join(current_dir, filename))
            try:
                if os.path.commonpath((root, path)) != root or not os.path.isfile(path):
                    continue
            except ValueError:
                continue
            relative = os.path.relpath(path, root)
            key = hashlib.sha256(relative.encode("utf-8")).hexdigest()[:24]
            entries.append((f"library:{key}", relative, path))
    return entries


def _prune_dem_uploads() -> int:
    cutoff = time.time() - DEM_UPLOAD_TTL_HOURS * 3600
    removed = 0
    try:
        entries = os.scandir(DEM_UPLOAD_DIR)
    except FileNotFoundError:
        return removed
    with entries:
        for entry in entries:
            if not entry.is_dir(follow_symlinks=False):
                continue
            try:
                partial_path = os.path.join(entry.path, "dem.part")
                activity_mtime = (
                    os.path.getmtime(partial_path)
                    if os.path.isfile(partial_path)
                    else entry.stat(follow_symlinks=False).st_mtime
                )
                if activity_mtime < cutoff:
                    shutil.rmtree(entry.path, ignore_errors=True)
                    if not os.path.exists(entry.path):
                        removed += 1
            except FileNotFoundError:
                pass
    if removed:
        logging.getLogger("riverrem.dem").info(
            "Automatically removed %d expired DEM upload(s)", removed
        )
    return removed


def _upload_dir(upload_id: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{32}", upload_id):
        raise HTTPException(status_code=404, detail="DEM upload not found")
    return os.path.join(DEM_UPLOAD_DIR, upload_id)


def _resolve_dem_ref(dem_ref: str) -> str:
    if dem_ref.startswith("upload:"):
        if not DEM_UPLOAD_ENABLED:
            raise ValueError("Local DEM uploads are disabled on this server")
        upload_id = dem_ref.removeprefix("upload:")
        if not re.fullmatch(r"[0-9a-f]{32}", upload_id):
            raise ValueError("Invalid uploaded DEM reference")
        target_dir = os.path.join(DEM_UPLOAD_DIR, upload_id)
        path = os.path.join(target_dir, "dem.tif")
        if not os.path.isfile(path):
            raise ValueError("The uploaded DEM is unavailable or has expired")
        if os.path.getmtime(target_dir) < time.time() - DEM_UPLOAD_TTL_HOURS * 3600:
            shutil.rmtree(target_dir, ignore_errors=True)
            raise ValueError("The uploaded DEM has expired")
        return path
    if dem_ref.startswith("library:"):
        for candidate_ref, _, path in _safe_library_files():
            if candidate_ref == dem_ref:
                return path
        raise ValueError("The selected library DEM is unavailable")
    raise ValueError("Invalid DEM reference")


@app.get("/capabilities")
def capabilities():
    return {
        "demSources": {
            "mapterhorn": {"enabled": True},
            "url": {"enabled": True},
            "upload": {
                "enabled": DEM_UPLOAD_ENABLED,
                "maxBytes": DEM_UPLOAD_MAX_BYTES,
                "ttlHours": DEM_UPLOAD_TTL_HOURS,
                "cleanupIntervalMinutes": DEM_UPLOAD_CLEANUP_INTERVAL_MINUTES,
            },
            "library": {
                "enabled": bool(DEM_LIBRARY_DIR and os.path.isdir(DEM_LIBRARY_DIR)),
                "label": DEM_LIBRARY_LABEL,
            },
        }
    }


@app.get("/dem/library")
def dem_library():
    if not DEM_LIBRARY_DIR or not os.path.isdir(DEM_LIBRARY_DIR):
        raise HTTPException(status_code=404, detail="The server DEM library is disabled")
    items = []
    for dem_ref, relative, path in _safe_library_files():
        try:
            items.append(_inspect_dem(path, dem_ref=dem_ref, display_name=relative))
        except Exception as exc:
            logging.getLogger("riverrem.dem").warning("Skipping invalid library DEM %s: %s", relative, exc)
    return {"items": items}


@app.post("/dem/uploads")
def create_dem_upload(req: DemUploadInitRequest):
    if not DEM_UPLOAD_ENABLED:
        raise HTTPException(status_code=404, detail="Local DEM uploads are disabled")
    filename = os.path.basename(req.filename)
    if not filename.lower().endswith((".tif", ".tiff")):
        raise HTTPException(status_code=400, detail="Select a .tif or .tiff DEM")
    if req.size_bytes > DEM_UPLOAD_MAX_BYTES:
        raise HTTPException(status_code=413, detail="DEM exceeds this server's upload limit")
    _prune_dem_uploads()
    if req.size_bytes > shutil.disk_usage(DEM_UPLOAD_DIR).free:
        raise HTTPException(status_code=507, detail="The server does not have enough free storage")
    upload_id = uuid.uuid4().hex
    target_dir = _upload_dir(upload_id)
    os.makedirs(target_dir, mode=0o700)
    with open(os.path.join(target_dir, "upload.json"), "w", encoding="utf-8") as file_obj:
        json.dump({"filename": filename, "sizeBytes": req.size_bytes}, file_obj)
    return {
        "uploadId": upload_id,
        "ref": f"upload:{upload_id}",
        "filename": filename,
        "sizeBytes": req.size_bytes,
    }


@app.put("/dem/uploads/{upload_id}")
async def upload_dem(upload_id: str, request: Request):
    if not DEM_UPLOAD_ENABLED:
        raise HTTPException(status_code=404, detail="Local DEM uploads are disabled")
    target_dir = _upload_dir(upload_id)
    metadata_path = os.path.join(target_dir, "upload.json")
    if not os.path.isfile(metadata_path):
        raise HTTPException(status_code=404, detail="DEM upload not found")
    with open(metadata_path, "r", encoding="utf-8") as file_obj:
        metadata = json.load(file_obj)
    expected_size = int(metadata["sizeBytes"])
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) != expected_size:
        raise HTTPException(status_code=400, detail="Upload size does not match the selected file")
    partial_path = os.path.join(target_dir, "dem.part")
    final_path = os.path.join(target_dir, "dem.tif")
    if os.path.exists(final_path):
        raise HTTPException(status_code=409, detail="This DEM upload is already complete")
    received = 0
    try:
        with open(partial_path, "wb") as file_obj:
            async for chunk in request.stream():
                if not chunk:
                    continue
                received += len(chunk)
                if received > expected_size or received > DEM_UPLOAD_MAX_BYTES:
                    raise HTTPException(status_code=413, detail="DEM exceeds the allowed upload size")
                file_obj.write(chunk)
        if received != expected_size:
            raise HTTPException(status_code=400, detail="Upload ended before the complete DEM was received")
        info = _inspect_dem(
            partial_path,
            dem_ref=f"upload:{upload_id}",
            display_name=metadata["filename"],
        )
        os.replace(partial_path, final_path)
        os.utime(target_dir)
        return info
    except HTTPException:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(target_dir, ignore_errors=True)
        logging.getLogger("riverrem.dem").exception("DEM upload failed")
        raise HTTPException(status_code=400, detail=f"Could not read DEM: {exc}") from exc


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
