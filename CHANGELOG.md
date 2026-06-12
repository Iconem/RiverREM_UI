# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com),
versioning is [SemVer](https://semver.org). Versions are reconstructed from the development
sessions, so dates are approximate; the ordering is chronological.

`0.1.0` is the initial RiverREM Python-backend app. `1.0.0` introduces the pure-frontend
(client-side JS) REM engine. Anything before `1.0.0` is server-only.

## [1.3.0] — 2026-06-12

### Added
- **Gallery modal** — an expand icon on the Runs header opens a centered overlay (SPA, no
  route) with a **Featured** section (curated server runs) and **Most recent**, sortable
  (recent / oldest / name) with grid and list views. Picking a run loads it into the sidebar
  with its data + styling. Combines device runs and the server `/gallery`, deduped by id.
- Server runs now fold their **resolved name** into `run.json` (piggybacked on the thumbnail
  upload) so the gallery shows meaningful names.

### Fixed
- **Thumbnail re-capture now updates immediately** (cache-busted URL) instead of only after refresh.

### Changed
- Header subtitle → "River Relative Elevation Model".
- Footer: "Automated by" (capital A).
- IDW power: removed the info icon (label fits one line); the hover tooltip is now on the
  number input.
- Symbology panel: "Colour ramp" and "Layers style" subsection titles match the section
  heading size; **Reverse** moved onto the Colour ramp title line; "Transparent" capitalised;
  Relief overlay tabs widened to match the Basemap select.
- Geocoder and DEM-COG-URL inputs use a smaller (0.75rem) font.

## [1.2.1] — 2026-06-12

### Fixed
- **`/gallery`, `/thumb`, `/runs` now reach the API** — nginx only proxied a fixed list of
  paths, so these fell through to the SPA (returning index.html). Added them to the proxy
  rule. (This also fixes server-side thumbnail uploads, which had been silently failing.)
- IDW power / River-samples labels and inputs are now aligned.

### Changed
- IDW power column narrowed to ~25% (Resolution/Samples ~75%); Resolution tabs fill width.
- **"View REM in cog-viewer"** disabled for client runs; download buttons reordered
  (Composite JPG + REM COG on the first row, Centerline + DEM COG on the second).
- The "Colour ramp" panel is now **Symbology**, with a **Colour ramp** subsection and a
  **Layers style** subsection holding Basemap + Relief overlay (moved out of Utilities).

## [1.2.0] — 2026-06-12

### Added
- **Server-side gallery** — `GET /gallery` reads `run.json` sidecars written next to each
  COG (filesystem + JSON, no DB) and returns past server runs with their thumbnails. The
  Runs panel gains a **This device / Server** source toggle; server items load read-only
  (no rename/delete) and are shared across devices.
- **Run metadata** in Utilities: engine, image W × H px (server), altitude range, and the
  **deepest Mapterhorn zoom probed** at the viewport centre.
- **IDW power help** tooltip (RiverREM uses 1; Dan Coe's QGIS method uses 2).
- **Waves favicon** (lucide `waves-horizontal`).

### Changed
- Client runs now **persist + restore the river centreline geometry** (preview), their
  probed max zoom, and dimensions — fixing the river/thumbnail not surviving reload.
- Metadata is keyed on the actual engine (server W × H no longer vanishes when reloading a run).
- **Client COG exports disabled** (REM/DEM) with a hover note — only Composite JPG, Copy,
  Share and Centerline apply to client runs.
- **Client run chip** uses the theme background colour (white on dark, dark on light);
  server stays blue.
- OSM endpoint label `qlever` → **QLever**, with a separator before the Overpass endpoints.
- Footer: "automated by OpenTopography RiverREM" on its own line; build hash links to the
  **iconem** fork and shows the 7-char short SHA.

### Repo
- Consolidated to two compose files (`docker-compose.yml` public, `docker-compose.local.yml`
  dev); removed the GHCR variant and all personal domain defaults (placeholders only).
  README rewritten with a dedicated pure-frontend section; `.gitattributes` (LF).

## [1.1.0] — 2026-06-12

### Added
- **Client engine: Mapterhorn zoom probe.** Before sampling, the deepest available
  zoom is probed at the viewport centre (z18→down); the `rem://` source `maxzoom`
  and the elevation-sampling zoom are clamped to it, so no 404 tiles are requested.
- **IDW power in both engines.** The control now applies to server compute too —
  the backend parses `idw_power` from the request and passes it to `REMMaker` when
  the installed RiverREM exposes a power kwarg (otherwise parsed-and-ignored).
  Default power is now **2**.
- **Basemap “Light (OSM)”** (Carto Positron).
- **Server/client run chips** in the runs list and gallery; loading a run restores
  the correct engine into the URL state.
- New standalone `rem-pure-frontend.html` (faster, speckle-free) shipped to `public/`.

### Changed
- **Hillshade basemap** now uses a native MapLibre `hillshade` layer over a neutral
  grey fill with opaque shadow/highlight colours, so relief reads as a standalone map.
- **Transparent “black”** reworked to a smooth smoothstep fade across the dark end
  (no hard alpha border); “white” stays restrictive (only near-white fades).
- **River-sample count** range widened to 10–1000.

### Fixed
- **Negative elevations are typable** in the Min/Max inputs (local text state,
  committed on blur/Enter) — `type="number"` + parseFloat rejected a lone `-`.
- **Shapefile upload** now sets the centreline mode from the file type, and upload
  is offered in both Draw and File modes.

### Repo
- Added `.gitattributes` to normalise line endings to LF; removed `PR_DESCRIPTION.md`.

## [1.0.0] — 2026-06

### Added
- **Client-side (pure-JS) REM engine** with a **Server / Client** toggle. The client
  engine samples the centreline against the Mapterhorn terrarium DEM, then builds the
  REM live per tile via a `rem://tiles/{z}/{x}/{y}` MapLibre protocol (per-pixel
  `dem − wse`, power-weighted IDW in EPSG:3857), feeding the **same** `color-relief`
  layer — every symbology control keeps working. Client runs persist their sampled
  points for offline reload.
- **Server compute can use a provided DEM COG** (`source_cog_url`, read remotely via
  GDAL `/vsicurl/`) instead of Mapterhorn.
- **Build commit hash** burned into the footer (`VITE_GIT_SHA`, via Docker build-arg / CI).
- Footer link to the experimental pure-frontend client.

## [0.6.0] — 2026-06

### Added
- Light / dark **theme toggle** (map background + panel tokens follow it).
- **Custom slider bounds** — disk buttons set the slider min/max to the entered value.
- Server-side **COG cap** (`MAX_COGS`, default 200) with oldest-first eviction.
- **Server-side thumbnails** (`POST /thumb` → `cogs/thumbs/<id>.jpg`) so the gallery
  survives browser-storage limits; active run’s thumbnail stays synced with styling.
- Basemap **“None”**.

### Fixed
- **qlever 500** — constant-polygon `geof:sfIntersects` is unsupported; switched to the
  `spatialSearch` SERVICE (`libspatialjoin`/`intersects`) and pointed at `qlever.dev`.
- Run load restores full symbology (ramp, reverse, transparent, hillshade, basemap, bounds).
- Resolution-cap warning only fires when an oversample (>1×) was actually clamped.
- Colour-ramp select: wide swatch, dropdown matches the trigger width.

## [0.5.0] — 2026-05

### Added
- **Runs history** (localStorage), shareable URLs that register as runs, list + gallery
  views, rename / delete / duplicate, manual thumbnail recapture.
- **Resolution multiplier** (1×/2×/4×) with source-zoom probing (never upsamples).
- **Mapterhorn hillshade overlay** (off / dark / light) rendered above the REM.
- **Transparent ramp ends** (none / white / black) so a basemap shows through.
- Exports: image, raw COG, centreline GeoJSON. ColorBrewer **Set3** ramp.

## [0.4.0] — 2026-05

### Added
- Centreline modes: **OSM longest-river**, **draw on map**, **shapefile upload**.
- OSM providers: Overpass presets + qlever; Photon geocoder with flyTo.
- DEM vs REM **layer toggle** with independent per-layer bounds (log/linear defaults).

## [0.3.0] — 2026-05

### Added
- Symbology: multiple **colormaps**, reverse, independent **min/max**, **log** colour
  scaling (shifted-log slider so negatives stay reachable), `.cpt` import path.

## [0.2.0] — 2026-04

### Added
- COG rendering via `@geomatico/maplibre-cog-protocol` with **terrarium** encoding and
  a native MapLibre `color-relief` layer; basemaps (dark / satellite / hillshade).
- All UI state mirrored in the URL via **nuqs**.

### Fixed
- `tileSize: 512` rendered blank → pinned raster-dem to `tileSize: 256`.
- `setColorFunction` keyed by the bare COG url (no `cog://`/`#dem`).

## [0.1.0] — 2026-04

### Added
- Initial **RiverREM web app**: FastAPI + GDAL + RiverREM backend (Mapterhorn terrain
  tiles → UTM DEM → `REMMaker.make_rem()` → EPSG:3857 float32 COG), Vite/React/TS +
  MapLibre frontend, job-based `/compute` with progress, Docker / Compose deployment.
