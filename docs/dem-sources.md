# Custom DEM sources

The server engine always supports Mapterhorn and a remote COG URL. It can also
offer two opt-in sources:

- **Upload local DEM** streams a browser-selected `.tif` or `.tiff` directly to
  the API. nginx does not buffer the whole request, and the API enforces the
  configured size limit while writing it to the persistent `/data` volume.
- **Server library** lists valid GeoTIFFs from a server-owner-controlled,
  read-only directory. The browser receives opaque references, never filesystem
  paths. The API rejects references outside the configured directory.

The frontend reads `GET /capabilities`, so disabled choices are not displayed.
The backend also enforces every setting; hiding a control is not the security
boundary. Both optional sources are disabled by default, including on public
deployments.

## Enable streamed uploads

In `.env`:

```dotenv
DEM_UPLOAD_ENABLED=true
DEM_UPLOAD_MAX_BYTES=21474836480
DEM_UPLOAD_TTL_HOURS=24
DEM_UPLOAD_CLEANUP_INTERVAL_MINUTES=15
```

Then rebuild/restart the stack:

```sh
docker compose -f docker-compose.local.yml up --build
```

The default maximum is 20 GiB. nginx limits this route to 20 GiB too; if you
change the API maximum, keep `client_max_body_size` in `frontend/nginx.conf`
aligned. Incomplete or invalid uploads are removed, valid uploads are checked by
GDAL, and expired upload directories are automatically pruned at server startup
and every 15 minutes by default. No administrator cleanup is required. Files live
in the Compose `cogs` volume under `/data/dem_uploads`. For a public server,
consider authentication and rate limiting before enabling uploads for untrusted
users.

RiverREM holds several complete raster arrays in memory. To keep a very large or
high-resolution custom DEM from exhausting the API container, the server keeps
native resolution up to `CUSTOM_DEM_MAX_PIXELS` (45 million by default) within
the selected viewport and downsamples larger windows before processing. Set this
to a different positive value only if the server has enough RAM; `0` disables
the guard and is not recommended for public deployments.

## Enable a server library

Create a directory on the Docker host and place georeferenced `.tif`/`.tiff`
DEMs inside it (nested directories are supported). Configure its host path and
the fixed read-only container path:

```dotenv
DEM_LIBRARY_HOST_DIR=/absolute/host/path/to/dems
DEM_LIBRARY_DIR=/dem-library
DEM_LIBRARY_LABEL=Available DEMs
```

Restart the stack. The option appears only when the in-container directory
exists. The Compose mount is read-only (`:ro`), and symlinks or paths resolving
outside the library root are excluded.

This works on localhost and online: on a public site, the library contains only
files deliberately installed by that server's owner. To hide the option again,
leave `DEM_LIBRARY_DIR` blank and restart.

## Source selection API

`POST /compute` accepts one of:

- neither field: use Mapterhorn;
- `source_cog_url`: use a remote COG;
- `source_dem_ref`: use a reference returned by the upload or library API.

Sending both custom-source fields is rejected. Client-provided filesystem paths
are never accepted.
