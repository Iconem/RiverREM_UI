# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com),
versioning is [SemVer](https://semver.org). Versions are reconstructed from the development
sessions, so dates are approximate; the ordering is chronological.

`0.1.0` is the initial RiverREM Python-backend app. `1.0.0` introduces the pure-frontend
(client-side JS) REM engine. Anything before `1.0.0` is server-only.

## [1.6.0] — 2026-06-16

### Added
- **Live mode** — client engine auto-fetches the river on every map move/zoom without
  pressing Compute. Toggleable per-session (`?live=true`). Works for all three WSE
  interpolation modes (IDW, JFA, EDT); a warning icon appears next to the toggle when IDW
  is selected (IDW recomputes all samples per tile — prefer JFA or EDT for smooth panning).
- **OSM Vector Tiles river source** — Shortbread v1 MVT tiles (e.g. OpenStreetMap vector
  tiles) and PMTiles archives are now supported alongside Overpass and QLever. The Select
  lists them in a labelled "OSM Vector tiles (beta)" subsection. Correctly handles the
  Shortbread two-layer design (`water_lines` for geometry, `water_lines_labels` for names).
- **GeoTIFF COG export from browser tiles** — Export REM or DEM tiles assembled in the
  browser to a tiled Float32 GeoTIFF (Cloud-Optimised compatible). Tile mosaic logic shared
  between REM and DEM paths via a shared `_exportCogImpl` helper.
- **Layer ordering** — viewport fill/outline, river overlay, and sample points are always
  moved to the top of the MapLibre layer stack when added or updated, so they render above
  every basemap and raster layer.
- **Visibility state preserved** — show/hide state for contours, contour labels, REM output,
  river, and river samples chips is tracked in URL state and restored across reloads.
- **Export section visible in live mode** — the Export panel now appears as soon as live
  mode is active, not only after a server compute or run load.

### Changed
- IDW power and River samples row hidden entirely for JFA and EDT (those parameters are not
  used by the nearest-polyline and EDT paths).
- "beta perf" panel (live-mode performance stats) is now shown only when live mode is on,
  and the label uses plain text "beta" instead of the Greek β character.
- QLever endpoint grouped under its own "QLever" subsection label in the Endpoint select.
- "OSM Vector tiles (beta)" section label rendered in foreground (white) instead of amber.

## [1.5.0] — 2026-06-16

### Added
- **Three WSE interpolation modes for the client engine** (behind `?beta=true` URL flag):
  - **IDW** — existing inverse-distance weighting; box-blur band-aid removed now that better modes exist.
  - **Nearest** (JFA concept) — nearest-point-on-polyline: projects each grid cell onto the closest river segment and lerps WSE at the projection parameter `t`. Exact, no bull's-eyes, correct hydrological Voronoi model. O(cells × segments).
  - **EDT** — rasterize centreline into grid then run the exact **Felzenszwalb-Huttenlocher labeled 2-pass distance transform**: column-wise 1D nearest-seed (Phase 1) + row-wise 1D Voronoi via parabola lower envelope (Phase 2). O(cells). Faster than Nearest at higher grid resolutions (512², 1024²); slight rasterisation aliasing at 256².
  - Multi-line rivers (`MultiLineString` / multiple waterways): `sampleRiverPoints` now tags each point with a `lineId`; Nearest and EDT skip cross-line segments so separate tributaries don't generate false diagonal bands.
  - IDW power control hidden when Nearest or EDT is active (unused).
- **Beta mode** (`?beta=true`) — gates experimental controls (WSE interpolation toggle) and a **per-tile performance panel**: WSE grid build time, last-tile breakdown (DEM fetch / pixel loop / PNG encode), rolling average tile time, tile cache size, and live FPS counter.
- **`getRemPerfStats()`** — exported from `remClient.ts`; tracks WSE grid build time and per-tile timing (demFetchMs / pixelLoopMs / pngEncodeMs / totalMs) with a 10-sample EMA on average tile time.

### Changed
- Removed the 4-pass box-blur from IDW grid build (it was a band-aid for bull's-eyes; Nearest/EDT are the correct fix).

## [1.4.0] — 2026-06-16

### Fixed
- **Contour speckle / ring artifacts in the client engine — root-caused and eliminated.**
  The terrarium elevation bytes were being corrupted by browser colour management on
  both ends of the tile pipeline:
  - **Input:** Mapterhorn WebP tiles were decoded through a 2D canvas
    (`createImageBitmap` → `drawImage` → `getImageData`), which applies the canvas
    colour space / premultiplied-alpha rounding and shifted the G/B channels by ±1
    (≈ ±1 m noise). Now decoded with **WebCodecs `ImageDecoder`** straight to raw RGBA —
    no canvas, no colour management — matching what GDAL/QGIS read byte-for-byte.
  - **Output:** `canvas.convertToBlob` tagged the `rem://` PNG as sRGB, so maplibre's
    raster-dem worker re-gamma-corrected the bytes on decode and reintroduced the speckle.
    Output tiles are now written with **`fast-png`** (only IHDR/IDAT/IEND — no sRGB, gAMA,
    or iCCP) at zlib level 0 (no compression), so they decode raw like any terrarium tile.
  - The same two fixes were applied to the **beta pure-client GPU page**
    (`rem-pure-frontend.html`): WebCodecs decode in, `fast-png` out.
- **Client-engine DEM-mode min/max bounds were unset (0–0).** With no server response, DEM
  mode had no min/max; now sampled from a viewport DEM grid (5th / 95th percentile) so the
  ramp is sensible immediately.
- **`fetchAllWaterways` crash** (referenced a non-existent `.geojson` field on the line
  features) — now builds the FeatureCollection correctly.
- **REM contours now toggle on/off repeatedly.** maplibre-contour's `worker: false` path
  returned its *cached* vector-tile buffer directly; maplibre transfers (detaches) it, so a
  cache hit on re-request threw `DataCloneError: ArrayBuffer … already detached`. The REM
  contour `DemSource` now uses `cacheSize: 0` (fresh buffer per request); the DEM path keeps
  its cache (the worker path clones before transfer).
- **Contours no longer get stuck off / rebuild on every toggle.** The source + layers are
  built once when a run exists and kept alive; a dedicated effect only flips `visibility`.
  This removed the teardown/rebuild churn and the detach errors it caused.
- **No more stale contours on reload** when no run is selected (the `showContours` URL flag
  no longer draws raw-DEM contours without an active run).
- **Mapterhorn over-zoom 404s.** Every Mapterhorn-based source (the `rem://` raster-dem, the
  contour `DemSource`, and the hillshade/relief source) is now capped at the probed deepest
  available zoom, and `buildREMTile` overzoom-samples from the parent tile instead of
  requesting tiles past coverage.
- The `rem://` tile cache hands out copies (the cached original survives the worker transfer).

### Added
- **"All waterways (incl. unnamed)" centerline mode** (QLever) — fetches every waterway in
  view (river / stream / canal / drain / tidal_channel), named or not, via a SPARQL spatial
  join, in addition to the existing "longest named river" and "all named rivers" modes.
- **`debugTile(z, x, y)` single-tile diagnostic** (`window.__debugTile`) — runs the REM
  pipeline on one tile and downloads georeferenced intermediates for QGIS: float32 GeoTIFFs
  of DEM / WSE / REM (raw metres, EPSG:4326, via a hand-built minimal GeoTIFF encoder),
  terrarium-encoded DEM/REM PNGs, and a per-pixel CSV.
- **Dedicated "Layers" section** (foldable) split out of Symbology — basemap, relief overlay,
  and the layer-visibility chips, with its own URL fold state.
- **"Contour Labels" visibility chip** (between Contours and the REM/DEM Output chip),
  toggling the major-contour elevation labels independently of the contour lines.
- **On-map pick tooltip** — a themed popup at the picked point showing REM, DEM, and lat/lon
  (in addition to the sidebar readout); dark in dark mode, no arrow tip.
- `fast-png` dependency (metadata-free PNG output).

### Changed
- **Default compute engine is now Client** (pure-JS live tiles) instead of Server.
- River mode option 2 renamed **"All named rivers"**.
- **DEM-mode contours** use 5 / 25 m (minor / major); major contours are labelled and the
  label font is slightly larger.
- River centerline drawn with larger, equal-length dashes (`[4, 4]`).
- "Hillshade Overlay" chip renamed **"Hillshade"**.
- **Debounced max-zoom probe on map move** — the deepest available Mapterhorn zoom is
  re-probed for the view centre as you pan/zoom and applied to all Mapterhorn sources.
- **Shorter URLs:** map `lat`/`lng` serialise to 5 decimals (~1 m), `zoom` to 2, and run
  `bounds` to 5, via a fixed-precision nuqs parser.
- **Recompute now drives the layer chips progressively** — viewport → centerline →
  river samples → REM/DEM + contours are enabled in sequence, and the previous result is
  cleared up front so stale layers don't linger.

## [1.3.1] — 2026-06-12

### Fixed
- **Symbology now round-trips to the server.** The styling snapshot (ramp, min/max, log,
  reverse, transparent, hillshade, base, layer, sliders) is folded into `run.json` via the
  existing `/thumb` debounce, and the gallery restores it instead of falling back to defaults.
- **Edits to a loaded run no longer vanish.** Opening a run from the server gallery now adopts
  it into local storage, so `updateRun` patches a real record rather than no-op'ing on an
  unknown id (the cause of styling "sometimes" not saving).

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
