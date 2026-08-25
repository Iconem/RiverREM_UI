"""River centerline acquisition.

Three modes, mirroring the RiverREM workflow:
  - osm        : find the longest *named* waterway in the bbox (RiverREM's own logic,
                 reproduced here so we can preview it before computing)
  - geojson    : a hand-drawn LineString from the map
  - shapefile  : a user-uploaded shapefile

For `osm`, RiverREM already does this internally inside make_rem(); we replicate it
only to give the UI a preview layer. For the compute step we hand RiverREM either
nothing (osm -> let it do its thing) or a centerline shapefile (geojson/shapefile).
"""
from __future__ import annotations

import os
import json
import math

import geopandas as gpd
import osmnx
from osgeo import ogr
from shapely.geometry import box, shape

WATERWAY_TAGS = {"waterway": ["river", "stream", "tidal channel"]}
CENTERLINE_MAX_FEATURES = max(1, int(os.environ.get("CENTERLINE_MAX_FEATURES", "10000")))
CENTERLINE_MAX_VERTICES = max(2, int(os.environ.get("CENTERLINE_MAX_VERTICES", "500000")))


class CenterlineCrsRequired(ValueError):
    """Raised when a GIS dataset has linework but no assigned CRS."""


def _dataset_layer_names(path: str) -> list[str]:
    dataset = ogr.Open(path, 0)
    if dataset is None:
        raise ValueError("The centerline file could not be opened as a GIS dataset.")
    names = [dataset.GetLayerByIndex(i).GetName() for i in range(dataset.GetLayerCount())]
    dataset = None
    return names


def _crs_label(gdf: gpd.GeoDataFrame) -> str:
    authority = gdf.crs.to_authority() if gdf.crs is not None else None
    return f"{authority[0]}:{authority[1]}" if authority else str(gdf.crs)


def _vertex_count(geometry) -> int:
    if geometry.geom_type == "LineString":
        return len(geometry.coords)
    if geometry.geom_type == "MultiLineString":
        return sum(len(line.coords) for line in geometry.geoms)
    return 0


def import_centerline_dataset(
    path: str,
    *,
    display_name: str,
    input_crs: str | None = None,
    force_geojson_wgs84: bool = False,
    layer_id_prefix: str = "",
) -> list[dict]:
    """Read all line layers and return WGS84 GeoJSON plus layer metadata.

    RFC 7946 GeoJSON is always treated as EPSG:4326. Other formats use their
    embedded CRS, or `input_crs` when the dataset does not declare one.
    """
    layer_names = _dataset_layer_names(path)
    if not layer_names:
        raise ValueError(f"{display_name} does not contain any GIS layers.")

    results: list[dict] = []
    missing_crs_layers: list[str] = []
    unsupported_layers: list[str] = []
    for layer_name in layer_names:
        gdf = gpd.read_file(path, layer=layer_name)
        if gdf.empty or "geometry" not in gdf:
            continue
        warnings: list[str] = []
        usable_mask = gdf.geometry.notna() & ~gdf.geometry.is_empty
        empty_count = int((~usable_mask).sum())
        if empty_count:
            warnings.append(f"Skipped {empty_count} empty geometr{'y' if empty_count == 1 else 'ies'}.")
        gdf = gdf[usable_mask].copy()
        line_mask = gdf.geometry.geom_type.isin(["LineString", "MultiLineString"])
        unsupported_count = int((~line_mask).sum())
        if unsupported_count:
            warnings.append(
                f"Skipped {unsupported_count} non-line feature{'s' if unsupported_count != 1 else ''}."
            )
        gdf = gdf[line_mask].copy()
        if len(gdf) > CENTERLINE_MAX_FEATURES:
            raise ValueError(
                f"Layer '{layer_name}' contains {len(gdf):,} line features; "
                f"the server limit is {CENTERLINE_MAX_FEATURES:,}."
            )
        # Inspect individual Shapely objects here rather than GeoSeries.length:
        # source data can be geographic, where GeoPandas warns about interpreting
        # length as a real-world distance (we only need a zero-length check).
        nonzero_mask = gdf.geometry.map(lambda geometry: geometry.length > 0)
        valid_mask = gdf.geometry.is_valid & nonzero_mask
        invalid_count = int((~valid_mask).sum())
        if invalid_count:
            warnings.append(
                f"Skipped {invalid_count} invalid or zero-length line{'s' if invalid_count != 1 else ''}."
            )
        gdf = gdf[valid_mask].copy()
        if gdf.empty:
            unsupported_layers.append(layer_name)
            continue

        vertex_count = sum(_vertex_count(geometry) for geometry in gdf.geometry)
        if vertex_count > CENTERLINE_MAX_VERTICES:
            raise ValueError(
                f"Layer '{layer_name}' contains {vertex_count:,} coordinates; "
                f"the server limit is {CENTERLINE_MAX_VERTICES:,}. Simplify the centerline and try again."
            )

        if force_geojson_wgs84:
            # GeoJSON coordinates are defined as WGS84 longitude/latitude. Do
            # not honor legacy/non-standard projected `crs` members silently.
            gdf = gdf.set_crs("EPSG:4326", allow_override=True)
            bounds = gdf.total_bounds
            if (
                not all(math.isfinite(float(value)) for value in bounds)
                or bounds[0] < -180 or bounds[2] > 180
                or bounds[1] < -90 or bounds[3] > 90
            ):
                raise ValueError(
                    "GeoJSON coordinates must use WGS 84 (EPSG:4326) in "
                    "[longitude, latitude] order."
                )
        elif gdf.crs is None:
            if not input_crs:
                missing_crs_layers.append(layer_name)
                continue
            try:
                gdf = gdf.set_crs(input_crs, allow_override=True)
            except Exception as exc:
                raise ValueError(f"Invalid input CRS '{input_crs}': {exc}") from exc

        source_crs = _crs_label(gdf)
        try:
            wgs84 = gdf.to_crs("EPSG:4326")
        except Exception as exc:
            raise ValueError(f"Could not convert layer '{layer_name}' to EPSG:4326: {exc}") from exc
        bounds = wgs84.total_bounds
        if (
            not all(math.isfinite(float(value)) for value in bounds)
            or bounds[0] < -180 or bounds[2] > 180
            or bounds[1] < -90 or bounds[3] > 90
        ):
            raise ValueError(f"Layer '{layer_name}' produced coordinates outside the WGS84 range.")

        try:
            metric_crs = wgs84.estimate_utm_crs()
            length_m = float(wgs84.to_crs(metric_crs).geometry.length.sum()) if metric_crs else 0.0
        except Exception:
            length_m = 0.0

        layer_id = f"{layer_id_prefix}{layer_name}"
        results.append({
            "id": layer_id,
            "name": layer_name,
            "crs": source_crs,
            "featureCount": int(len(wgs84)),
            "vertexCount": vertex_count,
            "lengthM": round(length_m, 1),
            "warnings": warnings,
            "geojson": json.loads(wgs84.to_json(drop_id=True)),
        })

    if missing_crs_layers:
        raise CenterlineCrsRequired(
            "CRS metadata is missing for line layer(s): " + ", ".join(missing_crs_layers)
        )
    if not results:
        if unsupported_layers:
            raise ValueError(
                f"{display_name} has no usable centerlines. Centerlines must be non-empty "
                "LineString or MultiLineString features."
            )
        raise ValueError(f"{display_name} does not contain a LineString or MultiLineString layer.")
    return results


def _features_from_bbox(west, south, east, north):
    """osmnx changed this API across versions; support both."""
    osmnx.settings.cache_folder = "./.osm_cache"
    # osmnx >= 2.0
    if hasattr(osmnx, "features_from_bbox"):
        try:
            return osmnx.features_from_bbox(bbox=(west, south, east, north), tags=WATERWAY_TAGS)
        except TypeError:
            return osmnx.features_from_bbox(north, south, east, west, tags=WATERWAY_TAGS)
    # osmnx < 2.0
    return osmnx.geometries_from_bbox(north, south, east, west, tags=WATERWAY_TAGS)


def longest_osm_centerline(bbox):
    """Return (GeoDataFrame in EPSG:4326 of the longest named river, name, length_m).

    Reproduces REMMaker.get_river_centerline: keep named waterways, group by name,
    sum segment lengths, pick the longest. Lengths are measured in a local UTM CRS
    so they are in metres.
    """
    gdf = _features_from_bbox(bbox.west, bbox.south, bbox.east, bbox.north)
    if gdf is None or len(gdf) == 0:
        raise ValueError("No waterways found in this viewport on OpenStreetMap.")

    # keep only line geometries, clip to the viewport
    gdf = gdf[gdf.geometry.type.isin(["LineString", "MultiLineString"])].copy()
    gdf = gpd.clip(gdf, box(bbox.west, bbox.south, bbox.east, bbox.north))
    if "name" not in gdf.columns:
        raise ValueError("Found waterways but none have a name tag.")
    gdf = gdf.dropna(subset=["name"])
    if len(gdf) == 0:
        raise ValueError("Found waterways but none have a name tag.")

    # measure length in metres via local UTM
    cx = (bbox.west + bbox.east) / 2.0
    cy = (bbox.south + bbox.north) / 2.0
    epsg_utm = (32600 if cy >= 0 else 32700) + int((cx + 180) / 6) + 1
    metric = gdf.to_crs(epsg=epsg_utm)
    metric["__len"] = metric.geometry.length

    lengths = metric.groupby("name")["__len"].sum()
    name = lengths.idxmax()
    length_m = float(lengths.max())

    longest = gdf[gdf["name"] == name].to_crs(epsg=4326)
    return longest, str(name), length_m


def osm_centerline_geojson(bbox) -> tuple[dict, str, float]:
    longest, name, length_m = longest_osm_centerline(bbox)
    return longest.__geo_interface__, name, length_m


def geojson_to_shapefile(geojson: dict, out_path: str) -> str:
    """Write a drawn / OSM / imported centerline (WGS84) to a shapefile.

    Multiple segments of the same river are stitched with shapely.linemerge so
    connected pieces become continuous lines — this avoids the IDW artifacts that
    appear at the seams between separate OSM way segments.
    """
    from shapely.ops import linemerge
    from shapely.geometry import LineString, MultiLineString

    if geojson.get("type") == "FeatureCollection":
        geoms = [shape(f["geometry"]) for f in geojson["features"]]
    elif geojson.get("type") == "Feature":
        geoms = [shape(geojson["geometry"])]
    else:
        geoms = [shape(geojson)]

    # flatten to LineStrings, then merge touching ones
    lines = []
    for g in geoms:
        if isinstance(g, LineString) and not g.is_empty:
            lines.append(g)
        elif isinstance(g, MultiLineString):
            lines.extend(line for line in g.geoms if not line.is_empty)
    if not lines:
        raise ValueError("The uploaded GeoJSON contains no usable LineString centerline.")
    for line in lines:
        for x, y, *_ in line.coords:
            if abs(x) > 180 or abs(y) > 90:
                raise ValueError(
                    "Centerline coordinates must use WGS 84 (EPSG:4326) in longitude, latitude order."
                )
    merged = linemerge(lines)
    if isinstance(merged, LineString):
        out_geoms = [merged]
    elif isinstance(merged, MultiLineString):
        out_geoms = list(merged.geoms)
    else:
        raise ValueError("The uploaded GeoJSON centerline could not be converted to line geometry.")

    gdf = gpd.GeoDataFrame({"name": ["centerline"] * len(out_geoms)}, geometry=out_geoms, crs="EPSG:4326")
    gdf.to_file(out_path)
    return out_path


def normalize_uploaded_shapefile(upload_dir: str) -> str:
    """Find the .shp inside an uploaded/unzipped directory."""
    for root, _dirs, files in os.walk(upload_dir):
        for filename in files:
            if filename.lower().endswith(".shp"):
                return os.path.join(root, filename)
    raise FileNotFoundError("No .shp found in the uploaded shapefile bundle.")
