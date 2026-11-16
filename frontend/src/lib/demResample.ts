// Height-space resampling for the REM colour relief.
//
// MapLibre's `color-relief` decodes terrarium AFTER the GPU texture filter, so
// its own `resampling: "linear"` blends packed bytes, not heights: about 1 m
// errors at every whole metre and up to 256 m at 0 m (thin rings). And past a
// source's maxzoom it stretches each texel over many screen pixels.
//
// So, like terrain-viewer's LRM (lib/lrm-protocol.ts upsampleDecodedTile), we
// interpolate the float heights ourselves, encode terrarium afterwards, and
// serve tiles at every zoom up to MAX_RENDER_ZOOM. The GPU then samples with
// `nearest` at roughly one texel per screen pixel: exact and smooth.
//
// - `remcog://` reads the server's REM/DEM COGs (EPSG:3857, single band, from
//   /compute or /cog/ingest) with geotiff.js at the overview that matches the
//   tile, then resamples into 256×256. geomatico's cog:// stays registered for
//   other uses but hardcodes nearest and stops at the COG's native zoom.
// - The client engine (remClient.ts buildREMTile) uses `sampleHeight` on its
//   decoded Mapterhorn tile the same way.
//
// NoData never gets blended: if any of the four neighbours is NoData the
// nearest pixel is used, so edges stay crisp instead of growing a ramp fringe.
import { fromUrl, type GeoTIFF, type GeoTIFFImage } from "geotiff";
import { encode as encodePngFast } from "fast-png";

export const MAX_RENDER_ZOOM = 22;
// NoData in the encoded tiles. Below maplibre-contour's valid range (-12000 m),
// so contours skip those cells instead of piling up along the edge, and below
// any ramp minimum, so colorReliefExpr's sub-min stop draws it transparent.
export const NODATA_OUT = -20000;
const TILE = 256;
const HALF = 20037508.342789244; // Web Mercator half extent (m)

export function isNoData(v: number, nodata: number | null): boolean {
  return !Number.isFinite(v) || v <= -9998 || (nodata !== null && v === nodata);
}

/** Height at fractional pixel position (fx, fy) in pixel-centre coordinates
 *  (0,0 = centre of the first pixel). Returns NaN outside the grid. */
export function sampleHeight(
  data: ArrayLike<number>, w: number, h: number, fx: number, fy: number,
  smooth: boolean, nodata: number | null = null,
): number {
  if (fx < -0.5 || fy < -0.5 || fx > w - 0.5 || fy > h - 0.5) return NaN;
  const nx = Math.min(w - 1, Math.max(0, Math.round(fx)));
  const ny = Math.min(h - 1, Math.max(0, Math.round(fy)));
  const nearest = data[ny * w + nx];
  if (!smooth) return nearest;
  const cx = Math.min(w - 1, Math.max(0, fx)), cy = Math.min(h - 1, Math.max(0, fy));
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const wx = cx - x0, wy = cy - y0;
  const v00 = data[y0 * w + x0], v10 = data[y0 * w + x1];
  const v01 = data[y1 * w + x0], v11 = data[y1 * w + x1];
  if (isNoData(v00, nodata) || isNoData(v10, nodata) || isNoData(v01, nodata) || isNoData(v11, nodata)) return nearest;
  return v00 * (1 - wx) * (1 - wy) + v10 * wx * (1 - wy) + v01 * (1 - wx) * wy + v11 * wx * wy;
}

export function encodeTerrariumInto(out: Uint8Array, i: number, elev: number): void {
  const v = elev + 32768;
  const r = Math.floor(v / 256), g = Math.floor(v % 256), b = Math.round((v - Math.floor(v)) * 256);
  out[i] = Math.max(0, Math.min(255, r));
  out[i + 1] = Math.max(0, Math.min(255, g));
  out[i + 2] = Math.max(0, Math.min(255, b));
}

function pngRgb(rgb: Uint8Array, w: number, h: number): ArrayBuffer {
  const png = encodePngFast({ width: w, height: h, data: rgb, channels: 3, depth: 8 }, { zlib: { level: 0 } });
  const out = new Uint8Array(png.byteLength);
  out.set(png);
  return out.buffer;
}

// ── remcog:// ────────────────────────────────────────────────────────────────

type CogInfo = {
  tiff: GeoTIFF;
  levels: { image: GeoTIFFImage; res: number; w: number; h: number }[]; // finest first
  originX: number; originY: number; nodata: number | null;
};
const cogs = new Map<string, Promise<CogInfo>>();
const tiles = new Map<string, ArrayBuffer>();
const TILE_CACHE_MAX = 512;

async function openCog(url: string): Promise<CogInfo> {
  const tiff = await fromUrl(url, { allowFullFile: false });
  const count = await tiff.getImageCount();
  const first = await tiff.getImage(0);
  const [originX, originY] = first.getOrigin();
  const [res0] = first.getResolution();
  const w0 = first.getWidth();
  const levels: CogInfo["levels"] = [];
  for (let i = 0; i < count; i++) {
    const image = await tiff.getImage(i);
    // Skip masks and anything that is not a reduced copy of band 1.
    if (i > 0 && image.getSamplesPerPixel() !== first.getSamplesPerPixel()) continue;
    const w = image.getWidth(), h = image.getHeight();
    levels.push({ image, res: Math.abs(res0) * (w0 / w), w, h });
  }
  levels.sort((a, b) => a.res - b.res);
  const nd = first.getGDALNoData();
  return { tiff, levels, originX, originY, nodata: nd === null || Number.isNaN(nd) ? null : nd };
}

export function remcogTileUrl(cogUrl: string, smooth: boolean): string {
  return `remcog://${encodeURIComponent(cogUrl)}/{z}/{x}/{y}?s=${smooth ? 1 : 0}`;
}

export async function buildCogTile(cogUrl: string, z: number, x: number, y: number, smooth: boolean, signal?: AbortSignal): Promise<ArrayBuffer> {
  const key = `${cogUrl}|${z}/${x}/${y}|${smooth ? 1 : 0}`;
  const hit = tiles.get(key);
  if (hit) return hit.slice(0);
  let p = cogs.get(cogUrl);
  if (!p) { p = openCog(cogUrl); cogs.set(cogUrl, p); p.catch(() => cogs.delete(cogUrl)); }
  const cog = await p;

  const size = (2 * HALF) / 2 ** z;
  const minX = -HALF + x * size, maxY = HALF - y * size;
  const tRes = size / TILE;
  // The coarsest level that is still at least as fine as the tile (no detail
  // lost); past the finest level (overzoom) the finest one, upsampled.
  let level = cog.levels[0];
  for (const l of cog.levels) if (l.res <= tRes * 1.0001) level = l;

  // Pixel window covering the tile, padded one pixel for the bilinear kernel.
  const fx0 = (minX - cog.originX) / level.res, fy0 = (cog.originY - maxY) / level.res;
  const span = size / level.res;
  const wx0 = Math.max(0, Math.floor(fx0) - 1), wy0 = Math.max(0, Math.floor(fy0) - 1);
  const wx1 = Math.min(level.w, Math.ceil(fx0 + span) + 1), wy1 = Math.min(level.h, Math.ceil(fy0 + span) + 1);

  const rgb = new Uint8Array(TILE * TILE * 3);
  if (wx1 <= wx0 || wy1 <= wy0) {
    for (let i = 0; i < TILE * TILE; i++) encodeTerrariumInto(rgb, i * 3, NODATA_OUT);
    return pngRgb(rgb, TILE, TILE);
  }
  const rasters = await level.image.readRasters({ window: [wx0, wy0, wx1, wy1], samples: [0], signal });
  const band = (rasters as unknown as ArrayLike<number>[])[0];
  const ww = wx1 - wx0, wh = wy1 - wy0;
  const step = tRes / level.res;
  for (let py = 0; py < TILE; py++) {
    const fy = fy0 + (py + 0.5) * step - 0.5 - wy0;
    for (let px = 0; px < TILE; px++) {
      const fx = fx0 + (px + 0.5) * step - 0.5 - wx0;
      const v = sampleHeight(band, ww, wh, fx, fy, smooth, cog.nodata);
      encodeTerrariumInto(rgb, (py * TILE + px) * 3, isNoData(v, cog.nodata) ? NODATA_OUT : v);
    }
  }
  const buf = pngRgb(rgb, TILE, TILE);
  if (tiles.size >= TILE_CACHE_MAX) tiles.delete(tiles.keys().next().value as string);
  tiles.set(key, buf);
  return buf.slice(0);
}

let registered = false;
/** Register remcog://<encoded COG url>/{z}/{x}/{y}?s=0|1 once. */
export function ensureRemcogProtocol(addProtocol: (name: string, fn: (params: { url: string }, ac: AbortController) => Promise<{ data: ArrayBuffer }>) => void): void {
  if (registered) return;
  registered = true;
  addProtocol("remcog", async (params, ac) => {
    const m = /^remcog:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)(?:\?s=([01]))?$/.exec(params.url);
    if (!m) throw new Error(`bad remcog url ${params.url}`);
    const data = await buildCogTile(decodeURIComponent(m[1]), +m[2], +m[3], +m[4], m[5] !== "0", ac?.signal);
    return { data };
  });
}
