# Centerline file imports

The **Upload Centerline File** control accepts:

- `.geojson` or `.json`: assumed to be RFC 7946 WGS84 (`EPSG:4326`) and rejected
  when coordinates fall outside longitude/latitude ranges;
- `.gpkg`: line layers are read with their embedded CRS;
- `.zip`: a zipped shapefile containing `.shp`, `.shx`, `.dbf`, and preferably
  `.prj`. Archives are checked for traversal, symbolic links, file count, and
  expanded size before extraction.

The API keeps only `LineString` and `MultiLineString` features and converts them
to WGS84 GeoJSON for preview in MapLibre. If a GeoPackage or shapefile has no CRS,
the UI asks for an authority code such as `EPSG:6344` and retries with that CRS.
When a file contains multiple line layers, the UI provides a layer selector and
shows the selected layer's source CRS, feature count, and approximate length.

Uploads are processed in a temporary server directory and the original
centerline file is deleted when the request finishes. The normalized GeoJSON is
sent back to the browser and later included in the compute request. RiverREM
reprojects that normalized centerline into the prepared DEM CRS before sampling.

The default upload limit is 64 MiB and can be changed with:

```dotenv
CENTERLINE_UPLOAD_MAX_BYTES=67108864
CENTERLINE_MAX_FEATURES=10000
CENTERLINE_MAX_VERTICES=500000
```

Keep nginx's `client_max_body_size` for the centerline route aligned if this
limit is increased.

The importer also verifies zipped Shapefile component sets, ignores common
macOS metadata, filters empty, invalid, and non-line geometry with visible
warnings, and rejects unusually complex layers before they consume excessive
memory. For fixed-extent custom DEMs (URL, upload, or server library), compute
checks geographic overlap with the viewport and selected centerline before
warping the DEM or starting RiverREM. Mapterhorn is generated for the viewport
and does not require this fixed-extent check.
