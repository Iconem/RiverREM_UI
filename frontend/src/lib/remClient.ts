/**
 * Client-side REM engine — a pure-JS port of public/rem-pure-frontend.html.
 *
 * Instead of asking the backend (OpenTopography RiverREM) to compute a COG, we
 * build the Relative Elevation Model live, per map tile, in the browser:
 *   1. sample the river centreline, reading water-surface elevations from the
 *      Mapterhorn terrarium DEM (sampleRiverPoints),
 *   2. register a `rem://tiles/{z}/{x}/{y}` MapLibre protocol that, for each tile,
 *      fetches the underlying DEM tile and outputs terrarium-encoded `dem − wse`
 *      where `wse` is KNN-free IDW interpolation (power configurable) over the
 *      sampled river points in EPSG:3857 metres.
 *
 * The result is a raster-dem source that feeds the SAME `color-relief` layer the
 * server path uses, so every symbology control keeps working unchanged.
 */
import maplibregl from "maplibre-gl";
import { encode as encodePngFast } from "fast-png";

export type RiverPoint = { mx: number; my: number; elev: number; lineId?: number };

const MAPTERHORN = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
const R_MERC = 6378137;

// ── module state used by the rem:// protocol ───────────────────────────────
let riverPts: RiverPoint[] = [];
let idwPower = 1;
let interpMode: "idw" | "jfa" | "edt" = "idw";
let registered = false;
// Deepest Mapterhorn zoom known to exist for the current area (probed). buildREMTile
// never fetches a DEM tile above this — it overzoom-samples the parent instead — so
// we don't spam 404s for tiles past coverage.
let remMaxZoom = 14;
export function setRemMaxZoom(z: number) { if (Number.isFinite(z) && z >= 1) remMaxZoom = z; }
const tileCache = new Map<string, ArrayBuffer>();
// Decoded tile = tightly-packed RGBA bytes (row stride = sz*4) + side length.
type DecodedTile = { data: { data: Uint8ClampedArray }; sz: number };
const imgCache = new Map<string, DecodedTile>();

// ── projections / tile math (EPSG:3857) ────────────────────────────────────
const lonToMx = (lon: number) => (lon * Math.PI) / 180 * R_MERC;
const latToMy = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R_MERC;
const lon2tile = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2tile = (lat: number, z: number) =>
  Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
const tile2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tile2lat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};
function lonlat2px(lon: number, lat: number, tx: number, ty: number, z: number, sz = 512) {
  const n = 2 ** z;
  const px = (((lon + 180) / 360) * n - tx) * sz;
  const py = (((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n - ty) * sz;
  return { px: Math.floor(px), py: Math.floor(py) };
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ── canvas helper — no color-space tag, willReadFrequently for pixel-exact reads ──
// We do NOT specify colorSpace so the browser uses its internal linear (untagged) buffer.
// Terrarium elevation bytes must survive drawImage → getImageData without ANY gamma transform.
function makeCanvas(w: number, h: number): { canvas: any; ctx: any } {
  let canvas: any;
  if (typeof OffscreenCanvas !== "undefined") canvas = new OffscreenCanvas(w, h);
  else { canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h; }
  return { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true } as any) };
}

// ── PNG encoder (fast-png) — ZERO color-space metadata, no canvas ────────────
// fast-png writes only IHDR/IDAT/IEND — no sRGB, gAMA, or iCCP chunk. That matters:
// canvas.convertToBlob tags the PNG sRGB, which makes maplibre's raster-dem worker
// color-manage the bytes on decode and re-injects the ±1 m speckle (the output-side
// twin of the input bug). An untagged tile decodes raw, exactly like any terrarium
// tile off the web. zlib level 0 = store (no compression), so bytes are byte-exact.
function encodePng(rgba: Uint8ClampedArray, w: number, h: number): ArrayBuffer {
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++) {
    const s = i * 4;
    rgb[j++] = rgba[s]; rgb[j++] = rgba[s + 1]; rgb[j++] = rgba[s + 2];
  }
  const png = encodePngFast(
    { width: w, height: h, data: rgb, channels: 3, depth: 8 },
    { zlib: { level: 0 } },
  );
  // Return a tight ArrayBuffer copy (the view may sit in a larger backing buffer).
  const out = new Uint8Array(png.byteLength);
  out.set(png);
  return out.buffer;
}

// ── Minimal single-band float32 GeoTIFF encoder (EPSG:4326, uncompressed) ─────
// Lets QGIS read the EXACT computed metres (DEM / WSE / REM) with no 8-bit
// quantisation — the diagnostic outputs are the real float values, georeferenced.
function encodeGeoTiffF32(
  data: Float32Array, w: number, h: number,
  lonW: number, latN: number, lonE: number, latS: number,
): ArrayBuffer {
  const nEntries = 13;
  const ifdOffset = 8;
  const ifdSize = 2 + nEntries * 12 + 4;
  const scaleOff = ifdOffset + ifdSize;   // ModelPixelScale: 3 doubles
  const tiepointOff = scaleOff + 24;      // ModelTiepoint: 6 doubles
  const geoKeyOff = tiepointOff + 48;     // GeoKeyDirectory: 16 shorts
  const stripOff = geoKeyOff + 32;
  const stripBytes = w * h * 4;
  const buf = new ArrayBuffer(stripOff + stripBytes);
  const dv = new DataView(buf);
  // TIFF header (little-endian)
  dv.setUint16(0, 0x4949, true); dv.setUint16(2, 42, true); dv.setUint32(4, ifdOffset, true);
  dv.setUint16(ifdOffset, nEntries, true);
  let e = ifdOffset + 2;
  const entry = (tag: number, type: number, count: number, value: number) => {
    dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true);
    dv.setUint32(e + 4, count, true); dv.setUint32(e + 8, value, true); e += 12;
  };
  // tags in ascending order (TIFF requirement). type: 3=SHORT 4=LONG 12=DOUBLE
  entry(256, 4, 1, w);            // ImageWidth
  entry(257, 4, 1, h);            // ImageLength
  entry(258, 3, 1, 32);           // BitsPerSample
  entry(259, 3, 1, 1);            // Compression = none
  entry(262, 3, 1, 1);            // Photometric = BlackIsZero
  entry(273, 4, 1, stripOff);     // StripOffsets
  entry(277, 3, 1, 1);            // SamplesPerPixel
  entry(278, 4, 1, h);            // RowsPerStrip
  entry(279, 4, 1, stripBytes);   // StripByteCounts
  entry(339, 3, 1, 3);            // SampleFormat = IEEE float
  entry(33550, 12, 3, scaleOff);     // ModelPixelScaleTag
  entry(33922, 12, 6, tiepointOff);  // ModelTiepointTag
  entry(34735, 3, 16, geoKeyOff);    // GeoKeyDirectoryTag
  dv.setUint32(e, 0, true); // next IFD
  // pixel scale (degrees/px), Y positive (sign carried by the row order, top-down)
  dv.setFloat64(scaleOff, (lonE - lonW) / w, true);
  dv.setFloat64(scaleOff + 8, (latN - latS) / h, true);
  dv.setFloat64(scaleOff + 16, 0, true);
  // raster (0,0,0) → model (lonW, latN, 0)
  dv.setFloat64(tiepointOff + 24, lonW, true);
  dv.setFloat64(tiepointOff + 32, latN, true);
  // GeoKeyDirectory: geographic (4326), pixel-is-area
  const keys = [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326];
  for (let i = 0; i < keys.length; i++) dv.setUint16(geoKeyOff + i * 2, keys[i], true);
  for (let i = 0; i < w * h; i++) dv.setFloat32(stripOff + i * 4, data[i], true);
  return buf;
}

// Decode WebP straight to raw RGBA via WebCodecs — NO canvas, so no premultiplied-
// alpha rounding and no color-space transform. The terrarium elevation bytes come
// out byte-exact, exactly as GDAL reads them. (Routing through a 2D canvas perturbs
// G/B by ±1 → ±1 m elevation speckle, which is what produced the contour rings.)
async function decodeWebpRaw(buf: ArrayBuffer, type: string): Promise<DecodedTile> {
  const dec = new (globalThis as any).ImageDecoder({ data: buf, type: type || "image/webp" });
  const { image } = await dec.decode(); // image: VideoFrame
  const sz: number = image.codedWidth;
  const alloc = image.allocationSize({ format: "RGBA" });
  const raw = new Uint8Array(alloc);
  const layout = await image.copyTo(raw, { format: "RGBA" });
  const stride: number = layout?.[0]?.stride ?? sz * 4;
  const out = new Uint8ClampedArray(sz * sz * 4);
  if (stride === sz * 4) {
    out.set(raw.subarray(0, sz * sz * 4));
  } else {
    for (let row = 0; row < sz; row++)
      out.set(raw.subarray(row * stride, row * stride + sz * 4), row * sz * 4);
  }
  image.close?.();
  dec.close?.();
  return { data: { data: out }, sz };
}

// Fallback for browsers without WebCodecs ImageDecoder (Firefox/Safari): the canvas
// path. colorSpaceConversion/premultiplyAlpha:"none" minimise (but cannot fully
// guarantee) byte-exactness — accepted only as a degraded fallback.
async function decodeViaCanvas(blob: Blob): Promise<DecodedTile> {
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  } as ImageBitmapOptions);
  const sz = bitmap.width;
  const { ctx } = makeCanvas(sz, sz);
  ctx.drawImage(bitmap, 0, 0);
  (bitmap as any).close?.();
  const imgd = ctx.getImageData(0, 0, sz, sz) as ImageData;
  return { data: { data: imgd.data }, sz };
}

async function loadTileImage(z: number, x: number, y: number): Promise<DecodedTile> {
  const key = `${z}/${x}/${y}`;
  const hit = imgCache.get(key);
  if (hit) return hit;
  const url = MAPTERHORN.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`DEM tile ${url} → ${resp.status}`);
  let entry: DecodedTile;
  if (typeof (globalThis as any).ImageDecoder !== "undefined") {
    const buf = await resp.arrayBuffer();
    try { entry = await decodeWebpRaw(buf, resp.headers.get("content-type") || "image/webp"); }
    catch { entry = await decodeViaCanvas(new Blob([buf])); }
  } else {
    entry = await decodeViaCanvas(await resp.blob());
  }
  imgCache.set(key, entry);
  return entry;
}

async function getElevation(lon: number, lat: number, z: number): Promise<number | null> {
  const tx = lon2tile(lon, z), ty = lat2tile(lat, z);
  let entry: DecodedTile;
  try { entry = await loadTileImage(z, tx, ty); } catch { return null; }
  const { data: imgd, sz } = entry;
  const { px, py } = lonlat2px(lon, lat, tx, ty, z, sz);
  const cx = Math.max(0, Math.min(sz - 1, px)), cy = Math.max(0, Math.min(sz - 1, py));
  const i = (cy * sz + cx) * 4;
  return imgd.data[i] * 256 + imgd.data[i + 1] + imgd.data[i + 2] / 256 - 32768;
}

// ── IDW (power-weighted) over ALL river points, EPSG:3857 metres ────────────
function idwValue(qMx: number, qMy: number): number {
  let sw = 0, swz = 0;
  for (const pt of riverPts) {
    const d = Math.sqrt((qMx - pt.mx) ** 2 + (qMy - pt.my) ** 2);
    const dc = d < 10 ? 10 : d;
    const w = 1 / dc ** idwPower;
    sw += w; swz += w * pt.elev;
  }
  return sw > 0 ? swz / sw : 0;
}

// ── Pre-computed WSE grid (eliminates inter-zoom DEM inconsistency) ──
// Evaluated once on a coarse grid and bilinearly interpolated at tile-render time.
// Three modes: IDW, JFA (nearest-point-on-polyline), EDT (rasterize + F-H 2-pass).
type WseGrid = { data: Float32Array; w: number; h: number; mx0: number; my0: number; mx1: number; my1: number };
let wseGrid: WseGrid | null = null;

const GRID_SZ = 256;

function gridExtent(pts: RiverPoint[], margin: number) {
  const xs = pts.map((p) => p.mx), ys = pts.map((p) => p.my);
  return {
    mx0: Math.min(...xs) - margin, mx1: Math.max(...xs) + margin,
    my0: Math.min(...ys) - margin, my1: Math.max(...ys) + margin,
  };
}

function buildWseGridIDW(pts: RiverPoint[]): WseGrid | null {
  if (pts.length === 0) return null;
  const { mx0, mx1, my0, my1 } = gridExtent(pts, 8000);
  const w = GRID_SZ, h = GRID_SZ;
  const raw = new Float32Array(w * h);
  for (let yi = 0; yi < h; yi++) {
    for (let xi = 0; xi < w; xi++) {
      raw[yi * w + xi] = idwValue(
        mx0 + (xi / (w - 1)) * (mx1 - mx0),
        my0 + (yi / (h - 1)) * (my1 - my0),
      );
    }
  }
  return { data: raw, w, h, mx0, my0, mx1, my1 };
}

// ── JFA mode: nearest-point-on-polyline (labeled EDT / Voronoi) ───────────
// For each grid cell, project onto every river segment, keep the closest projection,
// and linearly interpolate the sampled WSE at the projection parameter t.
// This is the physically-correct hydrological model: WSE varies only along the river,
// producing clean cross-channel bands with no IDW bull's-eyes.
function buildWseGridNearest(pts: RiverPoint[]): WseGrid | null {
  if (pts.length === 0) return null;
  const { mx0, mx1, my0, my1 } = gridExtent(pts, 8000);
  const w = GRID_SZ, h = GRID_SZ;
  const data = new Float32Array(w * h);

  if (pts.length === 1) { data.fill(pts[0].elev); return { data, w, h, mx0, my0, mx1, my1 }; }

  const dMx = (mx1 - mx0) / (w - 1);
  const dMy = (my1 - my0) / (h - 1);
  const nSeg = pts.length - 1;

  for (let yi = 0; yi < h; yi++) {
    const qy = my0 + yi * dMy;
    for (let xi = 0; xi < w; xi++) {
      const qx = mx0 + xi * dMx;
      let bestDist2 = Infinity, bestElev = pts[0].elev;

      for (let i = 0; i < nSeg; i++) {
        // Skip segments that cross a line boundary (separate tributaries)
        if (pts[i].lineId !== undefined && pts[i].lineId !== pts[i + 1].lineId) continue;
        const ax = pts[i].mx, ay = pts[i].my, bx = pts[i + 1].mx, by = pts[i + 1].my;
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = 0;
        if (len2 > 0) { t = ((qx - ax) * dx + (qy - ay) * dy) / len2; t = t < 0 ? 0 : t > 1 ? 1 : t; }
        const px = ax + t * dx, py = ay + t * dy;
        const dist2 = (qx - px) * (qx - px) + (qy - py) * (qy - py);
        if (dist2 < bestDist2) {
          bestDist2 = dist2;
          bestElev = pts[i].elev + t * (pts[i + 1].elev - pts[i].elev);
        }
      }

      // Fallback to nearest point (handles single-point rivers or all-cross-line pts)
      if (bestDist2 === Infinity) {
        for (const pt of pts) {
          const d2 = (qx - pt.mx) * (qx - pt.mx) + (qy - pt.my) * (qy - pt.my);
          if (d2 < bestDist2) { bestDist2 = d2; bestElev = pt.elev; }
        }
      }

      data[yi * w + xi] = bestElev;
    }
  }

  return { data, w, h, mx0, my0, mx1, my1 };
}

// ── EDT mode: rasterize polyline → labeled Felzenszwalb-Huttenlocher 2-pass EDT ──
// Burns the centerline into the grid with lerped WSE per cell (Bresenham-style),
// then runs an exact O(cells) 2-pass distance transform: column-wise 1D nearest-seed
// (Phase 1) then row-wise 1D Voronoi via parabola lower envelope (Phase 2).
// Slightly aliased vs nearest-polyline (JFA) at the grid resolution, but O(cells)
// vs O(cells × segments) — advantageous when raising GRID_SZ.
function buildWseGridEDT(pts: RiverPoint[]): WseGrid | null {
  if (pts.length === 0) return null;
  const { mx0, mx1, my0, my1 } = gridExtent(pts, 8000);
  const w = GRID_SZ, h = GRID_SZ;
  const dMx = (mx1 - mx0) / (w - 1), dMy = (my1 - my0) / (h - 1);

  // Step 1: burn river segments into seed grid (NaN = no seed)
  const seedWse = new Float32Array(w * h).fill(NaN);
  if (pts.length === 1) {
    const xi = Math.round((pts[0].mx - mx0) / dMx);
    const yi = Math.round((pts[0].my - my0) / dMy);
    if (xi >= 0 && xi < w && yi >= 0 && yi < h) seedWse[yi * w + xi] = pts[0].elev;
  } else {
    for (let i = 0; i < pts.length - 1; i++) {
      if (pts[i].lineId !== undefined && pts[i].lineId !== pts[i + 1].lineId) continue;
      const gax = (pts[i].mx - mx0) / dMx, gay = (pts[i].my - my0) / dMy;
      const gbx = (pts[i + 1].mx - mx0) / dMx, gby = (pts[i + 1].my - my0) / dMy;
      const steps = Math.ceil(Math.hypot(gbx - gax, gby - gay)) + 1;
      for (let s = 0; s <= steps; s++) {
        const t = steps > 0 ? s / steps : 0;
        const xi = Math.round(gax + t * (gbx - gax));
        const yi = Math.round(gay + t * (gby - gay));
        if (xi >= 0 && xi < w && yi >= 0 && yi < h)
          seedWse[yi * w + xi] = pts[i].elev + t * (pts[i + 1].elev - pts[i].elev);
      }
    }
  }

  // Phase 1: column-wise 1D nearest seed row
  // colG[y*w+x] = row of nearest seed in column x for row y  (-1 = none)
  const colG = new Int32Array(w * h).fill(-1);
  for (let xi = 0; xi < w; xi++) {
    let last = -1;
    for (let yi = 0; yi < h; yi++) {
      if (!isNaN(seedWse[yi * w + xi])) last = yi;
      colG[yi * w + xi] = last;
    }
    last = -1;
    for (let yi = h - 1; yi >= 0; yi--) {
      if (!isNaN(seedWse[yi * w + xi])) last = yi;
      if (last >= 0) {
        const prev = colG[yi * w + xi];
        if (prev < 0 || Math.abs(yi - last) < Math.abs(yi - prev)) colG[yi * w + xi] = last;
      }
    }
  }

  // Phase 2: row-wise 1D Voronoi — lower envelope of parabolas (Felzenszwalb-Huttenlocher)
  // For row y, each column x' with a seed contributes parabola f_{x'}(q) = (q-x')² + |y-colG[y,x']|²
  // We find the minimising source for each query column q.
  const data = new Float32Array(w * h);
  const envSrc = new Int32Array(w);   // source columns in the lower envelope
  const envSep = new Float32Array(w); // envSep[i] = x where we switch from parabola i-1 to i

  for (let yi = 0; yi < h; yi++) {
    let k = 0;
    for (let xi = 0; xi < w; xi++) {
      const sr = colG[yi * w + xi];
      if (sr < 0) continue;
      const d = Math.abs(yi - sr);
      // Add parabola at xi, popping predecessors it dominates
      while (k >= 1) {
        const prev = envSrc[k - 1];
        const prevD = Math.abs(yi - colG[yi * w + prev]);
        // Crossing of parabola prev and xi: (q-prev)²+prevD² = (q-xi)²+d²
        const xover = (xi * xi - prev * prev + d * d - prevD * prevD) / (2 * (xi - prev));
        if (k === 1 || xover > envSep[k - 1]) { envSep[k] = xover; envSrc[k] = xi; k++; break; }
        k--;
      }
      if (k === 0) { envSep[0] = -Infinity; envSrc[0] = xi; k = 1; }
    }

    if (k === 0) {
      // No seeds in any column — nearest-point fallback
      for (let xi = 0; xi < w; xi++) {
        const qx = mx0 + xi * dMx, qy = my0 + yi * dMy;
        let bestD2 = Infinity, bestE = pts[0].elev;
        for (const pt of pts) {
          const d2 = (qx - pt.mx) ** 2 + (qy - pt.my) ** 2;
          if (d2 < bestD2) { bestD2 = d2; bestE = pt.elev; }
        }
        data[yi * w + xi] = bestE;
      }
      continue;
    }

    let j = 0;
    for (let xi = 0; xi < w; xi++) {
      while (j < k - 1 && xi > envSep[j + 1]) j++;
      const srcX = envSrc[j], srcY = colG[yi * w + srcX];
      data[yi * w + xi] = seedWse[srcY * w + srcX];
    }
  }

  return { data, w, h, mx0, my0, mx1, my1 };
}

function buildWseGrid(pts: RiverPoint[]): WseGrid | null {
  const t0 = performance.now();
  const result = interpMode === "jfa" ? buildWseGridNearest(pts)
               : interpMode === "edt" ? buildWseGridEDT(pts)
               : buildWseGridIDW(pts);
  _perf.wseGridMs = performance.now() - t0;
  _perf.wseMode = interpMode;
  return result;
}

function sampleWse(mx: number, my: number): number {
  if (!wseGrid) return idwValue(mx, my);
  const { data, w, h, mx0, my0, mx1, my1 } = wseGrid;
  const gx = ((mx - mx0) / (mx1 - mx0)) * (w - 1);
  const gy = ((my - my0) / (my1 - my0)) * (h - 1);
  if (gx < 0 || gy < 0 || gx >= w - 1 || gy >= h - 1) return idwValue(mx, my);
  const xi = gx | 0, yi = gy | 0;
  const tx = gx - xi, ty = gy - yi;
  return (
    data[yi * w + xi]           * (1 - tx) * (1 - ty) +
    data[yi * w + xi + 1]       * tx       * (1 - ty) +
    data[(yi + 1) * w + xi]     * (1 - tx) * ty       +
    data[(yi + 1) * w + xi + 1] * tx       * ty
  );
}

function encodeTerrarium(elev: number): [number, number, number] {
  const v = elev + 32768;
  const r = Math.floor(v / 256), g = Math.floor(v % 256), b = Math.round((v - Math.floor(v)) * 256);
  const c = (n: number) => Math.max(0, Math.min(255, n));
  return [c(r), c(g), c(b)];
}

export async function buildREMTile(z: number, x: number, y: number): Promise<ArrayBuffer> {
  const key = `${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  // maplibre-contour transfers (detaches) the returned ArrayBuffer to its worker,
  // so hand out a fresh copy each time — the cached original must stay intact.
  if (cached) { _perf.cacheHits++; return cached.slice(0); }
  const _t0 = performance.now();

  const outSz = 256; // output tile resolution

  // Load the DEM tile, clamping to the probed coverage: never request a Mapterhorn
  // tile above remMaxZoom (overzoom from the parent instead → no 404s). Walk further
  // up only if a tile is still missing (per-tile coverage gaps near the edge).
  let demZoom = Math.min(z, remMaxZoom);
  let demEntry: DecodedTile | null = null;
  let dz = z - demZoom;
  for (; demZoom >= 1; demZoom--, dz = z - demZoom) {
    try { demEntry = await loadTileImage(demZoom, x >> dz, y >> dz); break; }
    catch { /* missing at this zoom — try the parent */ }
  }
  const demData = demEntry?.data ?? null;
  const demSz = demEntry?.sz ?? 512; // Mapterhorn = 512×512
  // Position of this output tile within the (possibly coarser) DEM tile we loaded.
  const span = 1 << dz;                       // # output tiles per DEM tile, per axis
  const subX = x - ((x >> dz) << dz);          // 0 … span-1
  const subY = y - ((y >> dz) << dz);

  const lonW = tile2lon(x, z), lonE = tile2lon(x + 1, z);
  const latN = tile2lat(y, z), latS = tile2lat(y + 1, z);
  const havePts = riverPts.length > 0;
  const _t1 = performance.now(); // DEM fetch done

  const rgba = new Uint8ClampedArray(outSz * outSz * 4);

  for (let py = 0; py < outSz; py++) {
    for (let px = 0; px < outSz; px++) {
      let demElev = 0;
      if (demData) {
        const d = demData.data;
        // Fractional position inside the loaded DEM tile [0,1), accounting for overzoom.
        const u = (subX + (px + 0.5) / outSz) / span;
        const v = (subY + (py + 0.5) / outSz) / span;
        const cx0 = Math.min(demSz - 1, Math.floor(u * demSz));
        const cy0 = Math.min(demSz - 1, Math.floor(v * demSz));
        // 3×3 average on decoded-float elevations to suppress any residual noise.
        let sum = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const nx = Math.min(demSz - 1, Math.max(0, cx0 + kx));
            const ny = Math.min(demSz - 1, Math.max(0, cy0 + ky));
            const i4 = (ny * demSz + nx) * 4;
            sum += d[i4] * 256 + d[i4 + 1] + d[i4 + 2] / 256 - 32768;
          }
        }
        demElev = sum / 9;
      }
      let wse = 0;
      if (havePts) {
        const lon = lonW + (px / outSz) * (lonE - lonW);
        const lat = latN + (py / outSz) * (latS - latN);
        wse = sampleWse(lonToMx(lon), latToMy(lat));
      }
      const [r, g, b] = encodeTerrarium(demElev - wse);
      const i = (py * outSz + px) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
    }
  }
  const _t2 = performance.now(); // pixel loop done
  const buf = await encodePng(rgba, outSz, outSz);
  const _t3 = performance.now(); // PNG encode done
  _perf.tileCount++;
  const tileMs = _t3 - _t0;
  _perf.lastTile = { demFetchMs: _t1 - _t0, pixelLoopMs: _t2 - _t1, pngEncodeMs: _t3 - _t2, totalMs: tileMs };
  _perf.avgTileMs = _perf.avgTileMs === null ? tileMs : _perf.avgTileMs * 0.9 + tileMs * 0.1;
  tileCache.set(key, buf);
  return buf.slice(0); // copy — the cached original must survive worker transfer
}

// ── Perf stats ────────────────────────────────────────────────────────────────
export type RemTilePerf = { demFetchMs: number; pixelLoopMs: number; pngEncodeMs: number; totalMs: number };
export type RemPerfStats = {
  wseGridMs: number | null;
  wseMode: string;
  tileCount: number;
  cacheHits: number;
  cacheSize: number;
  lastTile: RemTilePerf | null;
  avgTileMs: number | null;
};
let _perf: Omit<RemPerfStats, "cacheSize"> = {
  wseGridMs: null, wseMode: "idw", tileCount: 0, cacheHits: 0, lastTile: null, avgTileMs: null,
};
export function getRemPerfStats(): RemPerfStats {
  return { ..._perf, cacheSize: tileCache.size };
}

// ── public API ──────────────────────────────────────────────────────────────

/** Register the rem:// protocol once. Safe to call repeatedly. */
export function ensureRemProtocol() {
  if (registered) return;
  maplibregl.addProtocol("rem", async (params: any) => {
    const [z, x, y] = params.url.replace("rem://tiles/", "").split("/").map(Number);
    return { data: await buildREMTile(z, x, y) };
  });
  registered = true;
}

/** Swap the river points / IDW power / interpolation mode, rebuild the WSE grid, and invalidate cached tiles. */
export function setRemParams(pts: RiverPoint[], power: number, interp: "idw" | "jfa" | "edt" = "idw") {
  riverPts = pts;
  idwPower = power;
  interpMode = interp;
  tileCache.clear();
  wseGrid = buildWseGrid(pts);
}

export function clearRemCache() {
  tileCache.clear();
}

// Cache of probed deepest-available zoom, keyed by coarse lon/lat.
const zoomProbeCache = new Map<string, number>();

/**
 * Find the deepest Mapterhorn zoom whose centre tile actually exists, by probing
 * top-down (z`ceiling`→1). Avoids requesting 404 tiles in the client engine.
 */
export async function probeMaxZoom(lon: number, lat: number, ceiling = 18): Promise<number> {
  const key = `${lon.toFixed(2)},${lat.toFixed(2)},${ceiling}`;
  const hit = zoomProbeCache.get(key);
  if (hit !== undefined) return hit;
  const exists = (z: number) =>
    new Promise<boolean>((res) => {
      const x = lon2tile(lon, z), y = lat2tile(lat, z);
      const i = new Image();
      i.crossOrigin = "anonymous";
      i.onload = () => res(true);
      i.onerror = () => res(false);
      i.src = MAPTERHORN.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
    });
  let found = 12;
  for (let z = ceiling; z >= 1; z--) {
    // eslint-disable-next-line no-await-in-loop
    if (await exists(z)) { found = z; break; }
  }
  zoomProbeCache.set(key, found);
  return found;
}

type LngLat = [number, number];

function extractLines(geojson: GeoJSON.GeoJSON | null): LngLat[][] {
  const out: LngLat[][] = [];
  const feats: GeoJSON.Feature[] =
    geojson?.type === "FeatureCollection" ? geojson.features
      : geojson?.type === "Feature" ? [geojson] : [];
  for (const f of feats) {
    const g = f.geometry as any;
    if (g?.type === "LineString") out.push(g.coordinates as LngLat[]);
    else if (g?.type === "MultiLineString") for (const c of g.coordinates) out.push(c as LngLat[]);
  }
  return out;
}

function sampleAlongLine(coords: LngLat[], n: number): LngLat[] {
  if (coords.length === 0) return [];
  const dist = [0];
  for (let i = 1; i < coords.length; i++)
    dist.push(dist[i - 1] + haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  const total = dist[dist.length - 1];
  if (n < 2 || total === 0) return coords.slice(0, Math.max(1, n));
  const step = total / (n - 1), out: LngLat[] = [];
  for (let s = 0; s < n; s++) {
    const target = s * step;
    let idx = dist.findIndex((d) => d >= target);
    if (idx < 0) idx = coords.length - 1;
    if (idx === 0) { out.push(coords[0]); continue; }
    const t = (target - dist[idx - 1]) / (dist[idx] - dist[idx - 1]);
    out.push([
      coords[idx - 1][0] + t * (coords[idx][0] - coords[idx - 1][0]),
      coords[idx - 1][1] + t * (coords[idx][1] - coords[idx - 1][1]),
    ]);
  }
  return out;
}

/**
 * Sample the centreline into water-surface-elevation points. `demZoom` controls
 * the terrain tile resolution read for elevations; `nSamples` the total density.
 * Returns points pre-projected to EPSG:3857 (mx,my) with their elevation.
 */
export async function sampleRiverPoints(
  geojson: GeoJSON.GeoJSON | null, demZoom: number, nSamples: number,
): Promise<RiverPoint[]> {
  const lines = extractLines(geojson);
  if (lines.length === 0) return [];
  const lens = lines.map((c) => { let l = 0; for (let i = 1; i < c.length; i++) l += haversine(c[i - 1][1], c[i - 1][0], c[i][1], c[i][0]); return l; });
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const samples: [number, number, number][] = []; // [lon, lat, lineId]
  for (let i = 0; i < lines.length; i++) {
    const count = Math.max(1, Math.round((nSamples * lens[i]) / total));
    for (const [lon, lat] of sampleAlongLine(lines[i], count)) samples.push([lon, lat, i]);
  }
  const pts: RiverPoint[] = [];
  for (const [lon, lat, lineId] of samples.slice(0, nSamples)) {
    const elev = await getElevation(lon, lat, demZoom);
    if (elev !== null) pts.push({ mx: lonToMx(lon), my: latToMy(lat), elev, lineId });
  }
  return pts;
}

/**
 * Sample DEM and REM elevations at a specific point for the inspect picker.
 * Uses the same IDW WSE field as the tile renderer so values match the displayed REM.
 */
export async function sampleAt(lon: number, lat: number, demZoom: number): Promise<{ dem: number | null; rem: number | null }> {
  const dem = await getElevation(lon, lat, demZoom);
  if (dem === null) return { dem: null, rem: null };
  const wse = riverPts.length > 0 ? sampleWse(lonToMx(lon), latToMy(lat)) : 0;
  return { dem, rem: +(dem - wse).toFixed(3) };
}

/**
 * Sample DEM elevations on a regular grid across the bbox and return the
 * 5th / 95th percentile — used to set sensible DEM min/max in the UI when
 * the server hasn't provided explicit dem_min/dem_max (e.g. client engine).
 */
export async function sampleDemBounds(
  bbox: { west: number; south: number; east: number; north: number },
  demZoom: number,
  gridN = 9,
): Promise<{ min: number; max: number } | null> {
  const elevs: number[] = [];
  for (let yi = 0; yi <= gridN; yi++) {
    for (let xi = 0; xi <= gridN; xi++) {
      const lon = bbox.west + (xi / gridN) * (bbox.east - bbox.west);
      const lat = bbox.north - (yi / gridN) * (bbox.north - bbox.south);
      // eslint-disable-next-line no-await-in-loop
      const e = await getElevation(lon, lat, demZoom);
      if (e !== null) elevs.push(e);
    }
  }
  if (elevs.length < 4) return null;
  elevs.sort((a, b) => a - b);
  return {
    min: Math.floor(elevs[Math.floor(elevs.length * 0.05)]),
    max: Math.ceil(elevs[Math.floor(elevs.length * 0.95)]),
  };
}

// ── Tile diagnostics — download intermediate layers for QGIS inspection ──────
function _download(buf: ArrayBuffer, filename: string, mime = "image/png") {
  const url = URL.createObjectURL(new Blob([buf], { type: mime }));
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function _downloadText(text: string, filename: string) {
  _download(new TextEncoder().encode(text).buffer, filename, "text/plain");
}
function _worldFile(lonW: number, latN: number, lonE: number, latS: number, sz: number): string {
  // ESRI world file: pixelSizeX, rotX, rotY, -pixelSizeY, topLeftLon, topLeftLat
  const pw = (lonE - lonW) / sz, ph = (latN - latS) / sz;
  return `${pw}\n0\n0\n${-ph}\n${lonW + pw / 2}\n${latN - ph / 2}\n`;
}
/**
 * Diagnostic: runs buildREMTile logic step-by-step on one tile and downloads
 * georeferenced outputs for QGIS to pinpoint where artifacts enter the pipeline.
 *   dem_elev.tif   — float32 GeoTIFF: decoded Mapterhorn elevation (metres)
 *   wse.tif        — float32 GeoTIFF: IDW/grid water-surface elevation (metres)
 *   rem.tif        — float32 GeoTIFF: REM = DEM − WSE (metres) — the real values
 *   dem_terr.png   — raw terrarium R/G/B bytes straight off the DEM tile (input check)
 *   rem_terr.png   — terrarium-encoded REM (the actual rem:// tile output)
 *   values.csv     — every pixel's raw values
 * GeoTIFFs are self-georeferenced (EPSG:4326); the PNGs ship a .pgw world file.
 *
 * Call from browser console:  window.__debugTile(13, 1292, 2959)
 */
export async function debugTile(z: number, x: number, y: number): Promise<void> {
  console.log(`[debugTile] z=${z} x=${x} y=${y} — loading DEM tile...`);
  const entry = await loadTileImage(z, x, y);
  const { data: demPx, sz: demSz } = entry;
  const outSz = demSz; // output at full DEM resolution for debug

  const lonW = tile2lon(x, z), lonE = tile2lon(x + 1, z);
  const latN = tile2lat(y, z), latS = tile2lat(y + 1, z);
  console.log(`[debugTile] tile bounds lon=[${lonW.toFixed(6)},${lonE.toFixed(6)}] lat=[${latS.toFixed(6)},${latN.toFixed(6)}]`);

  const nPix = outSz * outSz;
  const demArr = new Float32Array(nPix);
  const wseArr = new Float32Array(nPix);
  const remArr = new Float32Array(nPix);
  const demTerrRgba = new Uint8ClampedArray(nPix * 4); // raw terrarium bytes as-decoded
  const remTerrRgba = new Uint8ClampedArray(nPix * 4); // terrarium-encoded REM

  for (let py = 0; py < outSz; py++) {
    for (let px = 0; px < outSz; px++) {
      const idx = py * outSz + px;
      const i4 = idx * 4;
      const demElev = demPx.data[i4] * 256 + demPx.data[i4 + 1] + demPx.data[i4 + 2] / 256 - 32768;
      const lon = lonW + (px / outSz) * (lonE - lonW);
      const lat = latN + (py / outSz) * (latS - latN);
      const wse = riverPts.length > 0 ? sampleWse(lonToMx(lon), latToMy(lat)) : 0;
      demArr[idx] = demElev; wseArr[idx] = wse; remArr[idx] = demElev - wse;
      demTerrRgba[i4] = demPx.data[i4]; demTerrRgba[i4 + 1] = demPx.data[i4 + 1];
      demTerrRgba[i4 + 2] = demPx.data[i4 + 2]; demTerrRgba[i4 + 3] = 255;
      const [r, g, b] = encodeTerrarium(remArr[idx]);
      remTerrRgba[i4] = r; remTerrRgba[i4 + 1] = g; remTerrRgba[i4 + 2] = b; remTerrRgba[i4 + 3] = 255;
    }
  }

  const rng = (a: Float32Array) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < a.length; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; }
    return `${lo.toFixed(2)} – ${hi.toFixed(2)} m`;
  };
  console.log(`[debugTile] DEM range: ${rng(demArr)}`);
  console.log(`[debugTile] WSE range: ${rng(wseArr)}`);
  console.log(`[debugTile] REM range: ${rng(remArr)}`);

  const prefix = `tile_${z}_${x}_${y}`;
  const wld = _worldFile(lonW, latN, lonE, latS, outSz);
  console.log("[debugTile] encoding GeoTIFFs + PNGs...");
  const [demTerrPng, remTerrPng] = await Promise.all([
    encodePng(demTerrRgba, outSz, outSz),
    encodePng(remTerrRgba, outSz, outSz),
  ]);

  _download(encodeGeoTiffF32(demArr, outSz, outSz, lonW, latN, lonE, latS), `${prefix}_dem_elev.tif`, "image/tiff");
  _download(encodeGeoTiffF32(wseArr, outSz, outSz, lonW, latN, lonE, latS), `${prefix}_wse.tif`, "image/tiff");
  _download(encodeGeoTiffF32(remArr, outSz, outSz, lonW, latN, lonE, latS), `${prefix}_rem.tif`, "image/tiff");
  _download(demTerrPng, `${prefix}_dem_terr.png`); _downloadText(wld, `${prefix}_dem_terr.pgw`);
  _download(remTerrPng, `${prefix}_rem_terr.png`); _downloadText(wld, `${prefix}_rem_terr.pgw`);

  let csv = "row,col,lat,lon,dem_R,dem_G,dem_B,dem_elev_m,wse_m,rem_m\n";
  for (let py = 0; py < outSz; py++) {
    for (let px = 0; px < outSz; px++) {
      const idx = py * outSz + px;
      const lon = lonW + (px / outSz) * (lonE - lonW);
      const lat = latN + (py / outSz) * (latS - latN);
      const i4 = idx * 4;
      csv += `${py},${px},${lat.toFixed(7)},${lon.toFixed(7)},${demPx.data[i4]},${demPx.data[i4 + 1]},${demPx.data[i4 + 2]},${demArr[idx].toFixed(4)},${wseArr[idx].toFixed(4)},${remArr[idx].toFixed(4)}\n`;
    }
  }
  _downloadText(csv, `${prefix}_values.csv`);
  console.log(`[debugTile] done — 3 float32 GeoTIFFs + 2 terrarium PNGs + CSV. Drop the .tif straight into QGIS (self-georeferenced, raw metres).`);
}

// Expose for browser console debugging
if (typeof window !== "undefined") (window as any).__debugTile = debugTile;

/** Flatten / inflate points for compact run persistence. */
export const packPts = (pts: RiverPoint[]): number[] => pts.flatMap((p) => [p.mx, p.my, p.elev]);
export const unpackPts = (a: number[]): RiverPoint[] => {
  const out: RiverPoint[] = [];
  for (let i = 0; i + 2 < a.length; i += 3) out.push({ mx: a[i], my: a[i + 1], elev: a[i + 2] });
  return out;
};
