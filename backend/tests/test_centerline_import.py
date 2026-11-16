import json
import os
import tempfile
import unittest
import zipfile

import geopandas as gpd
from osgeo import gdal, osr
from shapely.geometry import LineString

from app.centerline import CenterlineCrsRequired, geojson_to_shapefile, import_centerline_dataset
from app.main import _normalize_geojson_document, _preflight_custom_dem, _safe_extract_shapefile_zip
from app.schemas import BBox, ComputeRequest


class CenterlineImportTests(unittest.TestCase):
    def test_geojson_is_assumed_wgs84(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = os.path.join(temp_dir, "river.geojson")
            with open(path, "w", encoding="utf-8") as file_obj:
                json.dump({
                    "type": "FeatureCollection",
                    "features": [{
                        "type": "Feature",
                        "properties": {},
                        "geometry": {
                            "type": "LineString",
                            "coordinates": [[-90.86, 38.64], [-90.80, 38.65]],
                        },
                    }],
                }, file_obj)
            layers = import_centerline_dataset(
                path, display_name="river.geojson", force_geojson_wgs84=True
            )
            self.assertEqual(layers[0]["crs"], "EPSG:4326")
            self.assertEqual(layers[0]["featureCount"], 1)

    def test_projected_geojson_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = os.path.join(temp_dir, "projected.geojson")
            gpd.GeoDataFrame(
                geometry=[LineString([(685500, 4282500), (686000, 4282000)])],
                crs="EPSG:6344",
            ).to_file(path, driver="GeoJSON")
            with self.assertRaisesRegex(ValueError, "EPSG:4326"):
                import_centerline_dataset(
                    path, display_name="projected.geojson", force_geojson_wgs84=True
                )

    def test_bare_geojson_line_is_normalized(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source = os.path.join(temp_dir, "line.json")
            normalized = os.path.join(temp_dir, "normalized.geojson")
            with open(source, "w", encoding="utf-8") as file_obj:
                json.dump({
                    "type": "LineString",
                    "coordinates": [[-90.86, 38.64], [-90.80, 38.65]],
                }, file_obj)
            _normalize_geojson_document(source, normalized)
            layers = import_centerline_dataset(
                normalized, display_name="line.json", force_geojson_wgs84=True
            )
            self.assertEqual(layers[0]["featureCount"], 1)

    def test_geopackage_layers_are_reprojected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = os.path.join(temp_dir, "rivers.gpkg")
            first = gpd.GeoDataFrame(
                {"name": ["one"]},
                geometry=[LineString([(685500, 4282500), (686000, 4282000)])],
                crs="EPSG:6344",
            )
            second = gpd.GeoDataFrame(
                {"name": ["two"]},
                geometry=[LineString([(686000, 4282000), (686500, 4281500)])],
                crs="EPSG:6344",
            )
            first.to_file(path, layer="main", driver="GPKG")
            second.to_file(path, layer="tributary", driver="GPKG", mode="a")
            layers = import_centerline_dataset(path, display_name="rivers.gpkg")
            self.assertEqual({layer["name"] for layer in layers}, {"main", "tributary"})
            self.assertTrue(all(layer["crs"] == "EPSG:6344" for layer in layers))
            longitude = layers[0]["geojson"]["features"][0]["geometry"]["coordinates"][0][0]
            self.assertTrue(-180 <= longitude <= 180)

    def test_missing_shapefile_crs_can_be_supplied(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = os.path.join(temp_dir, "river.shp")
            gpd.GeoDataFrame(
                geometry=[LineString([(685500, 4282500), (686000, 4282000)])]
            ).to_file(path)
            with self.assertRaises(CenterlineCrsRequired):
                import_centerline_dataset(path, display_name="river.shp")
            layers = import_centerline_dataset(
                path, display_name="river.shp", input_crs="EPSG:6344"
            )
            self.assertEqual(layers[0]["crs"], "EPSG:6344")

    def test_zip_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            archive_path = os.path.join(temp_dir, "unsafe.zip")
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("../river.shp", b"unsafe")
            with self.assertRaisesRegex(ValueError, "unsafe path"):
                _safe_extract_shapefile_zip(archive_path, os.path.join(temp_dir, "out"))

    def test_macos_zip_metadata_is_ignored(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_dir = os.path.join(temp_dir, "source")
            os.makedirs(source_dir)
            shapefile_path = os.path.join(source_dir, "river.shp")
            gpd.GeoDataFrame(
                geometry=[LineString([(685500, 4282500), (686000, 4282000)])],
                crs="EPSG:6344",
            ).to_file(shapefile_path)

            archive_path = os.path.join(temp_dir, "finder.zip")
            with zipfile.ZipFile(archive_path, "w") as archive:
                for filename in os.listdir(source_dir):
                    archive.write(os.path.join(source_dir, filename), filename)
                    archive.writestr(f"__MACOSX/._{filename}", b"AppleDouble metadata")

            extract_dir = os.path.join(temp_dir, "out")
            extracted = _safe_extract_shapefile_zip(archive_path, extract_dir)
            self.assertEqual([os.path.basename(path) for path in extracted], ["river.shp"])
            layers = import_centerline_dataset(extracted[0], display_name="river.shp")
            self.assertEqual(layers[0]["crs"], "EPSG:6344")

    def test_incomplete_shapefile_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            archive_path = os.path.join(temp_dir, "incomplete.zip")
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("river.shp", b"manifest validation")
            with self.assertRaisesRegex(ValueError, r"missing \.dbf and \.shx"):
                _safe_extract_shapefile_zip(archive_path, os.path.join(temp_dir, "out"))

    def test_non_line_features_are_reported(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = os.path.join(temp_dir, "mixed.geojson")
            with open(path, "w", encoding="utf-8") as file_obj:
                json.dump({
                    "type": "FeatureCollection",
                    "features": [
                        {"type": "Feature", "properties": {}, "geometry": {
                            "type": "LineString", "coordinates": [[-90.9, 38.5], [-90.8, 38.6]],
                        }},
                        {"type": "Feature", "properties": {}, "geometry": {
                            "type": "Point", "coordinates": [-90.85, 38.55],
                        }},
                    ],
                }, file_obj)
            layers = import_centerline_dataset(
                path, display_name="mixed.geojson", force_geojson_wgs84=True
            )
            self.assertEqual(layers[0]["featureCount"], 1)
            self.assertEqual(layers[0]["vertexCount"], 2)
            self.assertIn("Skipped 1 non-line feature.", layers[0]["warnings"])

    def test_custom_dem_centerline_overlap_preflight(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dem_path = os.path.join(temp_dir, "dem.tif")
            dataset = gdal.GetDriverByName("GTiff").Create(dem_path, 10, 10, 1, gdal.GDT_Float32)
            dataset.SetGeoTransform((-91.0, 0.1, 0.0, 39.0, 0.0, -0.1))
            spatial_ref = osr.SpatialReference()
            spatial_ref.ImportFromEPSG(4326)
            dataset.SetProjection(spatial_ref.ExportToWkt())
            dataset.GetRasterBand(1).Fill(100)
            dataset = None

            request = ComputeRequest(
                bbox=BBox(west=-91.0, south=38.0, east=-90.0, north=39.0),
                source_dem_ref="library:test",
                centerline_mode="geojson",
            )
            matching = geojson_to_shapefile({
                "type": "LineString", "coordinates": [[-90.9, 38.5], [-90.8, 38.6]],
            }, os.path.join(temp_dir, "matching.shp"))
            _preflight_custom_dem(request, dem_path, matching)

            outside = geojson_to_shapefile({
                "type": "LineString", "coordinates": [[-80.9, 38.5], [-80.8, 38.6]],
            }, os.path.join(temp_dir, "outside.shp"))
            with self.assertRaisesRegex(ValueError, "centerline does not overlap"):
                _preflight_custom_dem(request, dem_path, outside)


if __name__ == "__main__":
    unittest.main()
