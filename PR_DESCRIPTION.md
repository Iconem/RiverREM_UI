# PR: Client-side REM engine, qlever fix, line-ending normalization, and UX polish

## Suggested commit message
```
feat: client-side REM engine + qlever spatialSearch fix + LF normalization

- Add SERVER/CLIENT REM engine toggle. Client engine (lib/remClient.ts) builds
  the REM live per tile in-browser (Mapterhorn DEM → river WSE sampling → IDW,
  terrarium-encoded via a rem:// protocol) and feeds the same color-relief layer.
- Fix qlever 500: constant-polygon geof:sfIntersects is unsupported; switch to the
  spatialSearch SERVICE (libspatialjoin/intersects) and point at qlever.dev.
- Server compute can use a provided DEM COG (source_cog_url, GDAL /vsicurl/) instead
  of Mapterhorn.
- Bound server COG storage (MAX_COGS, default 200) with oldest-first eviction.
- Server-side thumbnails (/thumb) so the gallery survives browser storage limits.
- Burn the build commit hash into the footer (VITE_GIT_SHA).
- Normalize line endings to LF (.gitattributes) and add client IDW power / sample inputs.
- Fix run-load symbology (ramp/transparent), wider ramp select, restrictive transparency,
  light-theme white background + visible borders, resolution-cap warning only when >1x clamped.
```

## How to land it cleanly (kills CRLF noise)
On your machine, in a checkout of the repo:

```bash
# 1. unzip the delivered archive over the working copy (does not touch .git)
unzip -o riverrem.zip -d RiverREM_UI
cd RiverREM_UI

# 2. apply the LF normalization the new .gitattributes requests
git add --renormalize .

# 3. branch + commit + push
git checkout -b client-rem-engine
git add -A
git commit -F PR_DESCRIPTION.md   # or use the message above
git push -u origin client-rem-engine
```

Then open the PR from the branch. The `git add --renormalize .` step rewrites the
index to LF using `.gitattributes`, so the diff shows only real changes — not a
whole-file CRLF→LF churn.

## What changed

### Engines
- **CLIENT engine** — `frontend/src/lib/remClient.ts`: `rem://tiles/{z}/{x}/{y}` protocol,
  CPU IDW (power-weighted, EPSG:3857), terrarium PNG tiles, river sampling from the
  Mapterhorn DEM. No backend call. Runs persist their sampled points for offline reload.
- **SERVER engine** — unchanged RiverREM/COG path, now optionally fed a DEM COG via
  `source_cog_url` (backend `build_dem` warps it with GDAL `/vsicurl/`).
- Toggle + IDW power + river-sample-count inputs in the side panel.

### Backend
- `MAX_COGS` eviction (default 200) after each compute.
- `POST /thumb` stores run thumbnails under `cogs/thumbs/<id>.jpg`.
- `ComputeRequest.source_cog_url` plumbed into `build_dem`.

### Frontend fixes / polish
- qlever query → spatialSearch SERVICE; endpoint → `qlever.dev`.
- Run load restores full symbology (ramp, reverse, transparent, hillshade, basemap, slider bounds).
- Colour-ramp select: wide swatch, dropdown matches trigger width.
- Transparent mode restrictive (fades only the top 10% toward white/black).
- Light theme: white map background, darker borders, more opaque panel.
- Resolution-cap warning only when an oversample (>1×) was actually clamped.
- Custom slider-bound buttons; per-run thumbnail kept in sync with styling.
- Build commit hash in the footer (`VITE_GIT_SHA`, passed via Docker build-arg / CI).

### Build / ops
- `.gitattributes` normalizes text to LF; binaries marked binary.
- `Dockerfile`, `docker-compose*.yml`, and the GH Actions workflow pass `VITE_GIT_SHA`.
