"""Request / response models for the REM pipeline API."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


class BBox(BaseModel):
    """Web-mercator viewport, in WGS84 lon/lat degrees (the order MapLibre gives us)."""
    west: float = Field(..., description="min longitude")
    south: float = Field(..., description="min latitude")
    east: float = Field(..., description="max longitude")
    north: float = Field(..., description="max latitude")


class ComputeRequest(BaseModel):
    bbox: BBox
    # Base map zoom of the viewport. The DEM is fetched from terrain tiles at
    # (zoom + log2(resolution_multiplier)), clamped to the source max zoom.
    zoom: int = Field(12, ge=0, le=20)
    resolution_multiplier: Literal[1, 2, 4] = 1

    # Centerline source.
    #   "osm"  -> let the pipeline find the longest named waterway (RiverREM mechanism)
    #   "geojson" -> use `centerline_geojson` (hand-drawn line)
    #   "shapefile" -> use a shapefile previously uploaded via /upload (pass `upload_id`)
    centerline_mode: Literal["osm", "geojson", "shapefile"] = "osm"
    centerline_geojson: Optional[dict] = None
    upload_id: Optional[str] = None

    # Optional elevation COG to use as the DEM instead of Mapterhorn terrain tiles
    # (read remotely via GDAL /vsicurl/). When set, the zoom machinery is bypassed.
    source_cog_url: Optional[str] = None

    # IDW power for the river-surface interpolation (applied if the installed
    # RiverREM exposes a power kwarg; otherwise parsed and ignored).
    idw_power: float = Field(2.0, ge=0.5, le=4.0)

    # RiverREM knobs (mirror REMMaker kwargs).
    interp_pts: int = 1000
    k: Optional[int] = None
    eps: float = 0.1


class ComputeResponse(BaseModel):
    job_id: str
    cog_url: str          # single-band float32 REM, EPSG:3857, COG -> maplibre cog protocol
    dem_url: Optional[str] = None  # source DEM as a 3857 COG (for export / hillshade)
    bounds: list[float]   # [west, south, east, north] in WGS84, for map.fitBounds
    # Robust value range of the REM (2nd / 98th percentile), in metres above the
    # river surface. Seeds the colour-ramp min/max in the UI.
    rem_min: float
    rem_max: float
    dem_min: Optional[float] = None
    dem_max: Optional[float] = None
    river_name: Optional[str] = None
    river_length_m: Optional[float] = None
    centerline_url: Optional[str] = None  # backend-hosted GeoJSON, shareable with the run
    # Zoom decision from the DEM build, so the UI can explain when the resolution
    # multiplier was capped by the terrain source.
    source_max_zoom: Optional[int] = None  # deepest zoom Mapterhorn serves at this spot
    dem_zoom: Optional[int] = None         # zoom actually fetched (clamped)
    requested_zoom: Optional[int] = None   # screen zoom + multiplier


class PruneRequest(BaseModel):
    """Relative /cogs paths of the client's locally-stored runs."""
    paths: list[str] = []


class PruneResponse(BaseModel):
    existing: list[str] = []  # subset of `paths` whose COG still exists on disk


class ThumbRequest(BaseModel):
    id: str
    image: str  # data-URL or bare base64 JPEG


class ThumbResponse(BaseModel):
    url: str


class CenterlineResponse(BaseModel):
    """Preview of the OSM-derived centerline so the UI can show it before computing."""
    geojson: dict
    river_name: Optional[str] = None
    river_length_m: Optional[float] = None


class CogIngestRequest(BaseModel):
    url: str  # remote single-band float COG, any CRS


class CogIngestResponse(BaseModel):
    cog_url: str          # reprojected EPSG:3857 COG served by us
    bounds: list[float]   # full source extent in WGS84 [w, s, e, n] for fitBounds
    rem_min: float
    rem_max: float
