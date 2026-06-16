/**
 * Fetch the longest named waterway in a bbox directly from Overpass (client-side),
 * replicating RiverREM's selection: keep named waterways, group by name, sum
 * segment lengths, pick the longest. Returns GeoJSON we can both preview AND send
 * to /compute as the centerline — so the backend never has to run osmnx (which is
 * slow on a cold cache). The backend's own OSM path stays as a fallback.
 *
 * `out geom;` returns node coordinates inline, so no second node lookup is needed.
 */
import type { BBox } from "./api";
// @ts-ignore – CJS module, no default export in Vite's ESM wrapper
import * as _VtLib from "@mapbox/vector-tile";
const VectorTile: any = (_VtLib as any).default ?? _VtLib;
// @ts-ignore – pbf is CJS; Vite wraps it without a named default export
import * as _PbfLib from "pbf";
const Protobuf: any = (_PbfLib as any).default ?? _PbfLib;
import { PMTiles } from "pmtiles";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];

/** Selectable presets for the UI. QLever speaks SPARQL, not Overpass QL, so it is
 *  marked experimental — if it fails the fallback chain takes over.
 *  beta=true entries are vector tile sources, shown in a separate section. */
export const OVERPASS_PRESETS: { label: string; url: string; beta?: boolean }[] = [
  { label: "QLever (fast)", url: "https://qlever.dev/api/osm-planet" },
  { label: "overpass.de", url: "https://overpass-api.de/api/interpreter" },
  { label: "kumi.systems", url: "https://overpass.kumi.systems/api/interpreter" },
  { label: "private.coffee", url: "https://overpass.private.coffee/api/interpreter" },
  { label: "osm.ch", url: "https://overpass.osm.ch/api/interpreter" },
  { label: "OSM Shortbread MVT", url: "https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt", beta: true },
  { label: "OpenFreeMap MVT", url: "https://tiles.openfreemap.org/planet/20260607_080001_pt/{z}/{x}/{y}.pbf", beta: true },
  { label: "Protomaps PMTiles", url: "https://demo-bucket.protomaps.com/v4.pmtiles", beta: true },
];

type LngLat = [number, number];

function haversine(a: LngLat, b: LngLat): number {
  const R = 6371000;
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(b[1] - a[1]);
  const dLon = r(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function lineLength(coords: LngLat[]): number {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += haversine(coords[i - 1], coords[i]);
  return s;
}

export type RiverResult = { geojson: GeoJSON.FeatureCollection; name: string; length_m: number };

type Pt = [number, number];

/**
 * Remove consecutive coordinates closer than `eps` degrees (Chebyshev distance).
 * Keeps first and last point. O(n), no recursion.
 * eps ≈ (bbox_width | bbox_height) / 1000 keeps ~1000 points per viewport width —
 * well below any visible aliasing while sharply reducing payload for dense OSM ways.
 */
function simplifyCoords(coords: LngLat[], eps: number): LngLat[] {
  if (coords.length <= 2) return coords;
  const out: LngLat[] = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    const prev = out[out.length - 1], c = coords[i];
    if (Math.abs(c[0] - prev[0]) >= eps || Math.abs(c[1] - prev[1]) >= eps) out.push(c);
  }
  out.push(coords[coords.length - 1]);
  return out;
}

/** Stitch LineStrings that share endpoints into continuous lines, so the preview
 *  shows (and /compute receives) the merged centerline — no IDW seams at OSM joins. */
export function stitchLines(features: GeoJSON.Feature[]): GeoJSON.Feature[] {
  const lines: Pt[][] = [];
  for (const f of features) {
    const g = f.geometry as any;
    if (g?.type === "LineString") lines.push(g.coordinates as Pt[]);
    else if (g?.type === "MultiLineString") for (const c of g.coordinates) lines.push(c as Pt[]);
  }
  const tol = 1e-7;
  const close = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const A = lines[i], B = lines[j];
        const a0 = A[0], a1 = A[A.length - 1], b0 = B[0], b1 = B[B.length - 1];
        let joined: Pt[] | null = null;
        if (close(a1, b0)) joined = A.concat(B.slice(1));
        else if (close(a1, b1)) joined = A.concat([...B].reverse().slice(1));
        else if (close(a0, b1)) joined = B.concat(A.slice(1));
        else if (close(a0, b0)) joined = [...A].reverse().concat(B.slice(1));
        if (joined) {
          lines.splice(j, 1);
          lines.splice(i, 1, joined);
          merged = true;
          break outer;
        }
      }
    }
  }
  const name = (features[0]?.properties as any)?.name ?? "centerline";
  return lines.map((coords, i) => ({
    type: "Feature",
    properties: { name, part: i },
    geometry: { type: "LineString", coordinates: coords },
  }));
}

/** Merge any GeoJSON of lines into a stitched FeatureCollection. */
export function mergeFeatureCollection(fc: GeoJSON.GeoJSON): GeoJSON.FeatureCollection {
  const features =
    fc.type === "FeatureCollection" ? fc.features : fc.type === "Feature" ? [fc] : [];
  return { type: "FeatureCollection", features: stitchLines(features as GeoJSON.Feature[]) };
}

type NamedLine = GeoJSON.Feature; // LineString with properties.name

function pickLongest(features: NamedLine[]): RiverResult {
  const byName = new Map<string, NamedLine[]>();
  for (const f of features) {
    const name = (f.properties as any)?.name;
    if (!name || (f.geometry as any)?.type !== "LineString") continue;
    const arr = byName.get(name) ?? [];
    arr.push(f);
    byName.set(name, arr);
  }
  if (byName.size === 0) throw new Error("No named waterways in this view.");
  let best = "", bestLen = -1;
  for (const [name, fs] of byName) {
    const len = fs.reduce((s, f) => s + lineLength((f.geometry as any).coordinates as LngLat[]), 0);
    if (len > bestLen) { bestLen = len; best = name; }
  }
  return {
    geojson: mergeFeatureCollection({ type: "FeatureCollection", features: byName.get(best)! }),
    name: best,
    length_m: bestLen,
  };
}

/** Return all named waterways in the bbox, grouped by name (one RiverResult per name). */
export async function fetchAllRivers(bbox: BBox, endpoint?: string): Promise<RiverResult[]> {
  const isQlever = !!endpoint && /qlever|sparql/i.test(endpoint);
  let features: NamedLine[];
  if (endpoint && (isMvt(endpoint) || isPmTiles(endpoint))) {
    features = await fetchVectorTiles(bbox, endpoint);
  } else if (isQlever) {
    try { features = await fetchQlever(bbox, endpoint!); }
    catch { features = await fetchOverpass(bbox, undefined); }
  } else {
    features = await fetchOverpass(bbox, endpoint);
  }
  const byName = new Map<string, NamedLine[]>();
  for (const f of features) {
    const name = (f.properties as any)?.name;
    if (!name || name === "unnamed" || (f.geometry as any)?.type !== "LineString") continue;
    const arr = byName.get(name) ?? [];
    arr.push(f);
    byName.set(name, arr);
  }
  return [...byName.entries()].map(([name, fs]) => ({
    geojson: mergeFeatureCollection({ type: "FeatureCollection", features: fs }),
    name,
    length_m: fs.reduce((s, f) => s + lineLength((f.geometry as any).coordinates as LngLat[]), 0),
  }));
}

// --- Vector tile helpers (MVT / PMTiles) ---
const _lon2t = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const _lat2t = (lat: number, z: number) =>
  Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
const _t2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const _t2lat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

const isMvt = (url: string) =>
  url.includes("{z}") && (url.endsWith(".mvt") || url.endsWith(".pbf") || url.includes(".mvt?") || url.includes(".pbf?"));
const isPmTiles = (url: string) => url.includes(".pmtiles");

const WATERWAY_KINDS = new Set(["river", "stream", "canal", "tidal_channel", "drain", "ditch"]);

function parseMvtBuffer(buf: ArrayBuffer, tx: number, ty: number, z: number, eps: number): NamedLine[] {
  let tile: any;
  try {
    const Cls = VectorTile.VectorTile ?? VectorTile;
    tile = new Cls(new Protobuf(buf));
  } catch { return []; }
  const allLayerNames = Object.keys(tile.layers);
  console.log(`[mvt] ${z}/${tx}/${ty} layers:`, allLayerNames);

  const features: NamedLine[] = [];
  // Shortbread v1: water_lines (full geometry, no name) + water_lines_labels (simplified + name, z10+)
  // OpenMapTiles: waterway (geometry + name)
  // Process all three — water_lines_labels features are added as standalone named linestrings.
  for (const layerName of ["water_lines", "water_lines_labels", "waterway"]) {
    const layer = tile.layers[layerName];
    if (!layer) continue;
    const extent: number = layer.extent ?? 4096;
    const lon0 = _t2lon(tx, z), lon1 = _t2lon(tx + 1, z);
    const lat0 = _t2lat(ty, z), lat1 = _t2lat(ty + 1, z);
    let added = 0;
    for (let i = 0; i < layer.length; i++) {
      const feat = layer.feature(i);
      if (feat.type !== 2) continue; // 2 = LineString
      const props = feat.properties as Record<string, any>;
      const kind = String(props.kind ?? props.class ?? props.waterway ?? "");
      if (kind && !WATERWAY_KINDS.has(kind)) continue;
      const name = typeof props.name === "string" ? props.name : undefined;
      const geom: { x: number; y: number }[][] = feat.loadGeometry();
      for (const ring of geom) {
        if (ring.length < 2) continue;
        const coords: LngLat[] = ring.map((pt) => [
          lon0 + (pt.x / extent) * (lon1 - lon0),
          lat0 + (pt.y / extent) * (lat1 - lat0),
        ]);
        const simplified = eps > 0 ? simplifyCoords(coords, eps) : coords;
        if (simplified.length < 2) continue;
        features.push({
          type: "Feature",
          properties: { name: name ?? "unnamed" },
          geometry: { type: "LineString", coordinates: simplified },
        });
        added++;
      }
    }
    console.log(`[mvt] ${z}/${tx}/${ty} layer="${layerName}": ${added} waterway linestrings (layer total=${layer.length})`);
  }
  const named = features.filter((f) => f.properties.name !== "unnamed");
  console.log(`[mvt] ${z}/${tx}/${ty} result: ${features.length} features, ${named.length} named`);
  if (named.length > 0) console.log(`[mvt] sample names:`, named.slice(0, 5).map((f) => f.properties.name));
  return features;
}

async function fetchMvtTiles(bbox: BBox, urlTemplate: string): Promise<NamedLine[]> {
  const z = 12;
  const eps = Math.max(bbox.east - bbox.west, bbox.north - bbox.south) / 1000;
  const x0 = _lon2t(bbox.west, z), x1 = _lon2t(bbox.east, z);
  const y0 = _lat2t(bbox.north, z), y1 = _lat2t(bbox.south, z);
  const fetches: Promise<NamedLine[]>[] = [];
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      const url = urlTemplate.replace("{z}", String(z)).replace("{x}", String(tx)).replace("{y}", String(ty));
      const _tx = tx, _ty = ty;
      fetches.push(
        fetch(url)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
          .then((buf) => parseMvtBuffer(buf, _tx, _ty, z, eps))
          .catch(() => [] as NamedLine[]),
      );
    }
  }
  return (await Promise.all(fetches)).flat();
}

const _pmTilesCache = new Map<string, PMTiles>();

async function fetchPmTilesTiles(bbox: BBox, archiveUrl: string): Promise<NamedLine[]> {
  let pm = _pmTilesCache.get(archiveUrl);
  if (!pm) { pm = new PMTiles(archiveUrl); _pmTilesCache.set(archiveUrl, pm); }
  const z = 12;
  const eps = Math.max(bbox.east - bbox.west, bbox.north - bbox.south) / 1000;
  const x0 = _lon2t(bbox.west, z), x1 = _lon2t(bbox.east, z);
  const y0 = _lat2t(bbox.north, z), y1 = _lat2t(bbox.south, z);
  const fetches: Promise<NamedLine[]>[] = [];
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      const _tx = tx, _ty = ty;
      fetches.push(
        pm.getZxy(z, tx, ty)
          .then((resp) => (resp ? parseMvtBuffer(resp.data, _tx, _ty, z, eps) : []))
          .catch(() => [] as NamedLine[]),
      );
    }
  }
  return (await Promise.all(fetches)).flat();
}

async function fetchVectorTiles(bbox: BBox, endpoint: string): Promise<NamedLine[]> {
  return isMvt(endpoint) ? fetchMvtTiles(bbox, endpoint) : fetchPmTilesTiles(bbox, endpoint);
}

// --- Overpass QL ---
async function fetchOverpass(bbox: BBox, endpoint?: string): Promise<NamedLine[]> {
  const q =
    `[out:json][timeout:25];` +
    `(way["waterway"~"^(river|stream|tidal_channel)$"]` +
    `(${bbox.south},${bbox.west},${bbox.north},${bbox.east}););out geom;`;
  const tryList = [...(endpoint ? [endpoint] : []), ...OVERPASS_ENDPOINTS.filter((u) => u !== endpoint)];
  let data: any = null, lastErr: unknown;
  for (const url of tryList) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(q),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      data = await res.json();
      break;
    } catch (e) { lastErr = e; }
  }
  if (!data) throw new Error(`Overpass unreachable (${String(lastErr)})`);
  return (data.elements ?? [])
    .filter((e: any) => e.type === "way" && Array.isArray(e.geometry) && e.tags?.name)
    .map((w: any) => ({
      type: "Feature",
      properties: { name: w.tags.name },
      geometry: { type: "LineString", coordinates: w.geometry.map((g: any) => [g.lon, g.lat]) },
    })) as NamedLine[];
}

// --- QLever (SPARQL over the osm2rdf / GeoSPARQL planet) ---
// Best-effort query; if it fails we fall back to Overpass QL. WKT is lon/lat (CRS84).
function wktToFeatures(name: string, wkt: string, eps = 0): NamedLine[] {
  const out: NamedLine[] = [];
  const parse = (body: string): LngLat[] => {
    const raw = body.trim().split(",").map((p) => p.trim().split(/\s+/).map(Number) as LngLat);
    return eps > 0 ? simplifyCoords(raw, eps) : raw;
  };
  const up = wkt.toUpperCase();
  if (up.startsWith("LINESTRING")) {
    const m = wkt.match(/\(([^()]*)\)/);
    if (m) out.push({ type: "Feature", properties: { name }, geometry: { type: "LineString", coordinates: parse(m[1]) } });
  } else if (up.startsWith("MULTILINESTRING")) {
    for (const m of wkt.matchAll(/\(([^()]*)\)/g))
      out.push({ type: "Feature", properties: { name }, geometry: { type: "LineString", coordinates: parse(m[1]) } });
  }
  return out;
}

/** Fetch ALL waterways in the bbox regardless of name (includes unnamed streams). */
async function fetchQleverAll(bbox: BBox, endpoint: string): Promise<NamedLine[]> {
  const eps = Math.max(bbox.east - bbox.west, bbox.north - bbox.south) / 1000;
  const poly =
    `POLYGON((${bbox.west} ${bbox.south},${bbox.east} ${bbox.south},` +
    `${bbox.east} ${bbox.north},${bbox.west} ${bbox.north},${bbox.west} ${bbox.south}))`;
  const sparql = `
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:>
PREFIX spatialSearch: <https://qlever.cs.uni-freiburg.de/spatialSearch/>
SELECT ?name ?wkt WHERE {
  BIND("${poly}"^^geo:wktLiteral AS ?area)
  SERVICE spatialSearch: {
    _:config spatialSearch:algorithm spatialSearch:libspatialjoin ;
             spatialSearch:joinType spatialSearch:intersects ;
             spatialSearch:left ?area ;
             spatialSearch:right ?wkt ;
             spatialSearch:payload ?name .
    {
      ?osm osmkey:waterway ?ww .
      OPTIONAL { ?osm osmkey:name ?n . }
      BIND(COALESCE(?n, "unnamed") AS ?name)
      ?osm geo:hasGeometry/geo:asWKT ?wkt .
      FILTER(?ww = "river" || ?ww = "stream" || ?ww = "tidal_channel" || ?ww = "canal" || ?ww = "drain")
    }
  }
} LIMIT 5000`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/sparql-results+json" },
    body: "query=" + encodeURIComponent(sparql),
  });
  if (!res.ok) throw new Error(`QLever ${res.status}`);
  const json = await res.json();
  const rows = json?.results?.bindings ?? [];
  const feats: NamedLine[] = [];
  for (const r of rows) {
    const name = r.name?.value ?? "unnamed";
    const wkt = (r.wkt?.value ?? "").replace(/^<[^>]*>\s*/, "");
    if (wkt) feats.push(...wktToFeatures(name, wkt, eps));
  }
  if (feats.length === 0) throw new Error("QLever returned no waterways");
  return feats;
}

async function fetchQlever(bbox: BBox, endpoint: string): Promise<NamedLine[]> {
  const eps = Math.max(bbox.east - bbox.west, bbox.north - bbox.south) / 1000;
  const poly =
    `POLYGON((${bbox.west} ${bbox.south},${bbox.east} ${bbox.south},` +
    `${bbox.east} ${bbox.north},${bbox.west} ${bbox.north},${bbox.west} ${bbox.south}))`;
  const sparql = `
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:>
PREFIX spatialSearch: <https://qlever.cs.uni-freiburg.de/spatialSearch/>
SELECT ?name ?wkt WHERE {
  BIND("${poly}"^^geo:wktLiteral AS ?area)
  SERVICE spatialSearch: {
    _:config spatialSearch:algorithm spatialSearch:libspatialjoin ;
             spatialSearch:joinType spatialSearch:intersects ;
             spatialSearch:left ?area ;
             spatialSearch:right ?wkt ;
             spatialSearch:payload ?name .
    {
      ?osm osmkey:waterway ?ww .
      ?osm osmkey:name ?name .
      ?osm geo:hasGeometry/geo:asWKT ?wkt .
      FILTER(?ww = "river" || ?ww = "stream" || ?ww = "tidal_channel")
    }
  }
} LIMIT 5000`;
  // Use a "simple" CORS request (form-encoded body + only safelisted headers) so the
  // browser skips the OPTIONS preflight — qlever's endpoint 308-redirects preflights,
  // which CORS forbids. Accept is a safelisted header; application/x-www-form-urlencoded
  // is a safelisted content-type.
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/sparql-results+json" },
    body: "query=" + encodeURIComponent(sparql),
  });
  if (!res.ok) throw new Error(`QLever ${res.status}`);
  const json = await res.json();
  const rows = json?.results?.bindings ?? [];
  const feats: NamedLine[] = [];
  for (const r of rows) {
    const name = r.name?.value;
    const wkt = (r.wkt?.value ?? "").replace(/^<[^>]*>\s*/, ""); // strip optional CRS URI
    if (name && wkt) feats.push(...wktToFeatures(name, wkt, eps));
  }
  if (feats.length === 0) throw new Error("QLever returned no waterways");
  return feats;
}

/** Fetch all waterways (named + unnamed) as a single merged FeatureCollection. */
export async function fetchAllWaterways(bbox: BBox, endpoint: string): Promise<{ geojson: GeoJSON.FeatureCollection; count: number }> {
  let feats: NamedLine[];
  if (isMvt(endpoint) || isPmTiles(endpoint)) {
    feats = await fetchVectorTiles(bbox, endpoint);
  } else {
    feats = await fetchQleverAll(bbox, endpoint);
  }
  const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: feats };
  return { geojson: fc, count: feats.length };
}

export async function fetchLongestRiver(bbox: BBox, endpoint?: string): Promise<RiverResult> {
  if (endpoint && (isMvt(endpoint) || isPmTiles(endpoint))) {
    return pickLongest(await fetchVectorTiles(bbox, endpoint));
  }
  const isQlever = !!endpoint && /qlever|sparql/i.test(endpoint);
  if (isQlever) {
    try { return pickLongest(await fetchQlever(bbox, endpoint!)); }
    catch { /* fall through to Overpass mirrors */ }
  }
  return pickLongest(await fetchOverpass(bbox, isQlever ? undefined : endpoint));
}
