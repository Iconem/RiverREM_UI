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

export type RiverPoint = { mx: number; my: number; elev: number };

const MAPTERHORN = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
const R_MERC = 6378137;

// ── module state used by the rem:// protocol ───────────────────────────────
let riverPts: RiverPoint[] = [];
let idwPower = 1;
let registered = false;
const tileCache = new Map<string, ArrayBuffer>();
const imgCache = new Map<string, ImageData>();

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

// ── canvas helper (OffscreenCanvas when available) ──────────────────────────
function makeCanvas(w: number, h: number): { canvas: any; ctx: CanvasRenderingContext2D } {
  let canvas: any;
  if (typeof OffscreenCanvas !== "undefined") canvas = new OffscreenCanvas(w, h);
  else { canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h; }
  return { canvas, ctx: canvas.getContext("2d") as CanvasRenderingContext2D };
}

async function loadTileImage(z: number, x: number, y: number): Promise<ImageData> {
  const key = `${z}/${x}/${y}`;
  const hit = imgCache.get(key);
  if (hit) return hit;
  const url = MAPTERHORN.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = () => rej(new Error(`DEM tile ${url}`));
    i.src = url;
  });
  const { ctx } = makeCanvas(512, 512);
  ctx.drawImage(img, 0, 0, 512, 512);
  const data = ctx.getImageData(0, 0, 512, 512);
  imgCache.set(key, data);
  return data;
}

async function getElevation(lon: number, lat: number, z: number): Promise<number | null> {
  const tx = lon2tile(lon, z), ty = lat2tile(lat, z);
  let d: ImageData;
  try { d = await loadTileImage(z, tx, ty); } catch { return null; }
  const { px, py } = lonlat2px(lon, lat, tx, ty, z, 512);
  const cx = Math.max(0, Math.min(511, px)), cy = Math.max(0, Math.min(511, py));
  const i = (cy * 512 + cx) * 4;
  return d.data[i] * 256 + d.data[i + 1] + d.data[i + 2] / 256 - 32768;
}

// ── IDW (power-weighted) over ALL river points, EPSG:3857 metres ────────────
function idwValue(qMx: number, qMy: number): number {
  let sw = 0, swz = 0;
  for (const pt of riverPts) {
    const d = Math.sqrt((qMx - pt.mx) ** 2 + (qMy - pt.my) ** 2);
    const dc = d < 10 ? 10 : d; // clamp ≈ half a DEM pixel; avoids div-by-zero speckle
    const w = 1 / dc ** idwPower;
    sw += w; swz += w * pt.elev;
  }
  return sw > 0 ? swz / sw : 0;
}

function encodeTerrarium(elev: number): [number, number, number] {
  const v = elev + 32768;
  const r = Math.floor(v / 256), g = Math.floor(v % 256), b = Math.round((v - Math.floor(v)) * 256);
  const c = (n: number) => Math.max(0, Math.min(255, n));
  return [c(r), c(g), c(b)];
}

async function buildREMTile(z: number, x: number, y: number): Promise<ArrayBuffer> {
  const key = `${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) return cached;

  const sz = 256;
  let demData: ImageData | null = null;
  try { demData = await loadTileImage(z, x, y); } catch { /* tile may not exist at this z */ }

  const { canvas, ctx } = makeCanvas(sz, sz);
  const imgData = ctx.createImageData(sz, sz);
  const lonW = tile2lon(x, z), lonE = tile2lon(x + 1, z);
  const latN = tile2lat(y, z), latS = tile2lat(y + 1, z);
  const havePts = riverPts.length > 0;

  for (let py = 0; py < sz; py++) {
    for (let px = 0; px < sz; px++) {
      let demElev = 0;
      if (demData) {
        const sx = Math.min(511, Math.round((px * 512) / sz));
        const sy = Math.min(511, Math.round((py * 512) / sz));
        const i4 = (sy * 512 + sx) * 4;
        const d = demData.data;
        demElev = d[i4] * 256 + d[i4 + 1] + d[i4 + 2] / 256 - 32768;
      }
      let wse = 0;
      if (havePts) {
        const lon = lonW + (px / sz) * (lonE - lonW);
        const lat = latN + (py / sz) * (latS - latN);
        wse = idwValue(lonToMx(lon), latToMy(lat));
      }
      const [r, g, b] = encodeTerrarium(demElev - wse);
      const i = (py * sz + px) * 4;
      imgData.data[i] = r; imgData.data[i + 1] = g; imgData.data[i + 2] = b; imgData.data[i + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  const blob: Blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: "image/png" })
    : await new Promise<Blob>((res) => (canvas as HTMLCanvasElement).toBlob((b: Blob | null) => res(b!), "image/png"));
  const buf = await blob.arrayBuffer();
  tileCache.set(key, buf);
  return buf;
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

/** Swap the river points / IDW power and invalidate cached tiles. */
export function setRemParams(pts: RiverPoint[], power: number) {
  riverPts = pts;
  idwPower = power;
  tileCache.clear();
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
  const samples: LngLat[] = [];
  for (let i = 0; i < lines.length; i++) {
    const count = Math.max(1, Math.round((nSamples * lens[i]) / total));
    samples.push(...sampleAlongLine(lines[i], count));
  }
  const pts: RiverPoint[] = [];
  for (const [lon, lat] of samples.slice(0, nSamples)) {
    const elev = await getElevation(lon, lat, demZoom);
    if (elev !== null) pts.push({ mx: lonToMx(lon), my: latToMy(lat), elev });
  }
  return pts;
}

/** Flatten / inflate points for compact run persistence. */
export const packPts = (pts: RiverPoint[]): number[] => pts.flatMap((p) => [p.mx, p.my, p.elev]);
export const unpackPts = (a: number[]): RiverPoint[] => {
  const out: RiverPoint[] = [];
  for (let i = 0; i + 2 < a.length; i += 3) out.push({ mx: a[i], my: a[i + 1], elev: a[i + 2] });
  return out;
};
