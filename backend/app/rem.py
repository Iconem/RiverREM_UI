"""Run RiverREM and turn its raw REM into a web-mercator COG.

RiverREM's make_rem() writes a single-band float GeoTIFF of detrended elevation
(metres above the river surface) in the DEM's CRS (UTM here). It does NOT write a
COG, and it is not in EPSG:3857, so we:

  1. run REMMaker.make_rem()  -> raw REM (UTM, float32)
  2. gdal.Warp to EPSG:3857
  3. gdal.Translate -of COG (float32, LZW, internal overviews)

We deliberately keep a *single float band* (not RiverREM's pretty hillshade-colour
blend) so the colour ramp / min-max / log scaling all happen client-side in
MapLibre via the cog protocol. The DEM is also published as a COG so the client
can add hillshade if desired.
"""
from __future__ import annotations

import numpy as np
from osgeo import gdal

from riverrem.REMMaker import REMMaker

gdal.UseExceptions()


def _to_cog(src_path: str, out_path: str, src_nodata=None) -> str:
    warped = src_path + ".3857.tif"
    gdal.Warp(
        warped, src_path,
        dstSRS="EPSG:3857",
        resampleAlg="bilinear",
        srcNodata=src_nodata,
        dstNodata=src_nodata,
        format="GTiff",
    )
    gdal.Translate(
        out_path, warped,
        format="COG",
        creationOptions=[
            "COMPRESS=DEFLATE",
            "BLOCKSIZE=256",
            "OVERVIEW_RESAMPLING=AVERAGE",
            "PREDICTOR=2",
        ],
    )
    return out_path


def _percentiles(path: str, nodata=None) -> tuple[float, float]:
    ds = gdal.Open(path)
    arr = ds.GetRasterBand(1).ReadAsArray().astype("f8")
    if nodata is not None:
        arr = arr[arr != nodata]
    arr = arr[np.isfinite(arr)]
    if arr.size == 0:
        return 0.0, 10.0
    lo, hi = np.percentile(arr, [2, 98])
    return float(lo), float(hi)


def make_rem_cog(
    dem_path: str,
    out_cog_path: str,
    out_dir: str,
    centerline_shp: str | None = None,
    interp_pts: int = 1000,
    k: int | None = None,
    eps: float = 0.1,
) -> dict:
    """Run RiverREM on `dem_path` and write a 3857 COG to `out_cog_path`.

    Returns metadata: {rem_min, rem_max, river_name, river_length_m, dem_cog}.
    """
    maker = REMMaker(
        dem=dem_path,
        centerline_shp=centerline_shp,
        out_dir=out_dir,
        interp_pts=interp_pts,
        k=k,
        eps=eps,
        cache_dir=out_dir,
    )
    try:
        rem_ras = maker.make_rem()  # raw REM GeoTIFF (UTM, float32)
    except (IndexError, ValueError) as e:
        # RiverREM raises these when the centerline finds no valid DEM pixels
        # (river over NoData, or centerline doesn't overlap the viewport DEM).
        raise ValueError(
            "Could not detrend: the river centerline doesn't overlap valid terrain "
            "in this viewport. Try a lower resolution multiplier, zoom/pan so the "
            f"river is well inside the view, or pick a different river. ({e})"
        )

    nodata = getattr(maker, "nodata_val", None) or -9999.0
    _to_cog(rem_ras, out_cog_path, src_nodata=nodata)
    rem_min, rem_max = _percentiles(rem_ras, nodata=nodata)

    # publish the source DEM as a COG too, for optional client-side hillshade / DEM view
    dem_cog = out_cog_path.replace("_REM", "_DEM")
    dem_min = dem_max = None
    try:
        _to_cog(dem_path, dem_cog, src_nodata=-9999.0)
        dem_min, dem_max = _percentiles(dem_cog, nodata=-9999.0)
    except Exception:
        dem_cog = None

    return {
        "rem_min": round(rem_min, 3),
        "rem_max": round(rem_max, 3),
        "dem_min": round(dem_min, 3) if dem_min is not None else None,
        "dem_max": round(dem_max, 3) if dem_max is not None else None,
        # REMMaker logs the chosen river name but doesn't store it as an attribute;
        # it does store river_length. Use the OSM preview endpoint for the name.
        "river_name": None,
        "river_length_m": round(float(getattr(maker, "river_length", 0.0)), 1) or None,
        "dem_cog": dem_cog,
    }
