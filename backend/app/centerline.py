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

import geopandas as gpd
import osmnx
from shapely.geometry import box, shape

WATERWAY_TAGS = {"waterway": ["river", "stream", "tidal channel"]}


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
        if isinstance(g, LineString):
            lines.append(g)
        elif isinstance(g, MultiLineString):
            lines.extend(g.geoms)
    merged = linemerge(lines) if lines else None
    if isinstance(merged, LineString):
        out_geoms = [merged]
    elif isinstance(merged, MultiLineString):
        out_geoms = list(merged.geoms)
    else:
        out_geoms = geoms

    gdf = gpd.GeoDataFrame({"name": ["centerline"] * len(out_geoms)}, geometry=out_geoms, crs="EPSG:4326")
    gdf.to_file(out_path)
    return out_path


def normalize_uploaded_shapefile(upload_dir: str) -> str:
    """Find the .shp inside an uploaded/unzipped directory."""
    for f in os.listdir(upload_dir):
        if f.lower().endswith(".shp"):
            return os.path.join(upload_dir, f)
    raise FileNotFoundError("No .shp found in the uploaded shapefile bundle.")
