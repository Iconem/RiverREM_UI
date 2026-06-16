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
// @ts-ignore – pbf v5 / @mapbox/vector-tile v3 are ESM with named exports
import { VectorTile } from "@mapbox/vector-tile";
// @ts-ignore
import { PbfReader } from "pbf";
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
export async function fetchAllRivers(bbox: BBox, endpoint?: string, polyWater = false, groupBy = false, signal?: AbortSignal): Promise<RiverResult[]> {
  const isQlever = !!endpoint && /qlever|sparql/i.test(endpoint);
  let features: NamedLine[];
  if (endpoint && (isMvt(endpoint) || isPmTiles(endpoint))) {
    features = await fetchVectorTiles(bbox, endpoint, polyWater);
  } else if (isQlever) {
    try { features = await fetchQlever(bbox, endpoint!, groupBy, signal); }
    catch (e) { if ((e as Error).name === "AbortError") throw e; features = await fetchOverpass(bbox, undefined, signal); }
  } else {
    features = await fetchOverpass(bbox, endpoint, signal);
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

function parseMvtBuffer(buf: ArrayBuffer, tx: number, ty: number, z: number, eps: number, polyWater: boolean): NamedLine[] {
  if (buf.byteLength === 0) return [];
  let tile: any;
  try {
    tile = new VectorTile(new PbfReader(new Uint8Array(buf)));
  } catch (e) {
    console.log(`[mvt] PARSE ERROR:`, String(e));
    return [];
  }
  const features: NamedLine[] = [];
  // Shortbread v1:    water_lines / water_lines_labels
  // OpenMapTiles/OpenFreeMap: waterway  (class attr)
  // Protomaps v4:     water  (pmap:kind attr, lines and polygons)
  for (const layerName of ["water_lines", "water_lines_labels", "waterway", "water"]) {
    const layer = tile.layers[layerName];
    if (!layer) continue;
    for (let i = 0; i < layer.length; i++) {
      const feat = layer.feature(i);
      if (feat.type !== 2 && feat.type !== 3) continue; // skip points
      const props = feat.properties as Record<string, any>;
      const kind = String(props["pmap:kind"] ?? props.kind ?? props.class ?? props.waterway ?? "");
      if (kind && !WATERWAY_KINDS.has(kind)) continue;
      const name = typeof props.name === "string" ? props.name : undefined;

      if (feat.type === 2) {
        const gf = feat.toGeoJSON(tx, ty, z) as GeoJSON.Feature<GeoJSON.LineString>;
        const coords = gf.geometry.coordinates as LngLat[];
        const simplified = eps > 0 ? simplifyCoords(coords, eps) : coords;
        if (simplified.length < 2) continue;
        features.push({ type: "Feature", properties: { name: name ?? "unnamed" }, geometry: { type: "LineString", coordinates: simplified } });
      } else if (polyWater) {
        // Polygon — extract exterior ring(s) as open LineStrings (drop closing coord)
        const gf = feat.toGeoJSON(tx, ty, z) as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
        const rings: LngLat[][] = gf.geometry.type === "Polygon"
          ? [gf.geometry.coordinates[0] as LngLat[]]
          : gf.geometry.coordinates.map((p) => p[0] as LngLat[]);
        for (const ring of rings) {
          const coords = ring.slice(0, -1); // remove closing duplicate
          const simplified = eps > 0 ? simplifyCoords(coords, eps) : coords;
          if (simplified.length < 2) continue;
          features.push({ type: "Feature", properties: { name: name ?? "unnamed" }, geometry: { type: "LineString", coordinates: simplified } });
        }
      }
    }
  }
  return features;
}

async function fetchMvtTiles(bbox: BBox, urlTemplate: string, polyWater: boolean): Promise<NamedLine[]> {
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
          .then((r) => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))
          .then((buf) => parseMvtBuffer(buf, _tx, _ty, z, eps, polyWater))
          .catch(() => [] as NamedLine[]),
      );
    }
  }
  return (await Promise.all(fetches)).flat();
}

const _pmTilesCache = new Map<string, PMTiles>();

async function fetchPmTilesTiles(bbox: BBox, archiveUrl: string, polyWater: boolean): Promise<NamedLine[]> {
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
          .then((resp) => (resp ? parseMvtBuffer(resp.data, _tx, _ty, z, eps, polyWater) : []))
          .catch(() => [] as NamedLine[]),
      );
    }
  }
  return (await Promise.all(fetches)).flat();
}

async function fetchVectorTiles(bbox: BBox, endpoint: string, polyWater = false): Promise<NamedLine[]> {
  return isMvt(endpoint) ? fetchMvtTiles(bbox, endpoint, polyWater) : fetchPmTilesTiles(bbox, endpoint, polyWater);
}

// --- Overpass QL ---
async function fetchOverpass(bbox: BBox, endpoint?: string, signal?: AbortSignal): Promise<NamedLine[]> {
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
        signal,
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
async function fetchQleverAll(bbox: BBox, endpoint: string, signal?: AbortSignal): Promise<NamedLine[]> {
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
} LIMIT 20000`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/sparql-results+json" },
    body: "query=" + encodeURIComponent(sparql),
    signal,
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

async function fetchQlever(bbox: BBox, endpoint: string, groupBy = false, signal?: AbortSignal): Promise<NamedLine[]> {
  const eps = Math.max(bbox.east - bbox.west, bbox.north - bbox.south) / 1000;
  const poly =
    `POLYGON((${bbox.west} ${bbox.south},${bbox.east} ${bbox.south},` +
    `${bbox.east} ${bbox.north},${bbox.west} ${bbox.north},${bbox.west} ${bbox.south}))`;
  // groupBy=true: GROUP BY ?name collapses segments → LIMIT = distinct rivers, no geographic
  // clipping. Slower (full aggregation before first result). URL opt-in: ?qleverGroupBy=true.
  // groupBy=false (default): per-segment, ORDER BY ?name, LIMIT 50000. Fast; may clip at
  // continent scale but ORDER BY keeps each river's segments contiguous so stitchLines works.
  const sparql = groupBy ? `
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:>
PREFIX spatialSearch: <https://qlever.cs.uni-freiburg.de/spatialSearch/>
SELECT ?name (GROUP_CONCAT(STR(?wkt); SEPARATOR=" ||| ") AS ?allwkt) WHERE {
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
} GROUP BY ?name LIMIT 5000` : `
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
} ORDER BY ?name LIMIT 50000`;
  // Simple CORS request — no OPTIONS preflight (qlever 308-redirects preflights).
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/sparql-results+json" },
    body: "query=" + encodeURIComponent(sparql),
    signal,
  });
  if (!res.ok) throw new Error(`QLever ${res.status}`);
  const json = await res.json();
  const rows = json?.results?.bindings ?? [];
  const feats: NamedLine[] = [];
  if (groupBy) {
    for (const r of rows) {
      const name = r.name?.value;
      if (!name) continue;
      for (const seg of (r.allwkt?.value ?? "").split(" ||| ")) {
        const wkt = seg.trim().replace(/^<[^>]*>\s*/, "");
        if (wkt) feats.push(...wktToFeatures(name, wkt, eps));
      }
    }
  } else {
    for (const r of rows) {
      const name = r.name?.value;
      const wkt = (r.wkt?.value ?? "").replace(/^<[^>]*>\s*/, "");
      if (name && wkt) feats.push(...wktToFeatures(name, wkt, eps));
    }
  }
  if (feats.length === 0) throw new Error("QLever returned no waterways");
  return feats;
}

/** Fetch all waterways (named + unnamed) as a single merged FeatureCollection. */
export async function fetchAllWaterways(bbox: BBox, endpoint: string, polyWater = false, signal?: AbortSignal): Promise<{ geojson: GeoJSON.FeatureCollection; count: number }> {
  let feats: NamedLine[];
  if (isMvt(endpoint) || isPmTiles(endpoint)) {
    feats = await fetchVectorTiles(bbox, endpoint, polyWater);
  } else {
    feats = await fetchQleverAll(bbox, endpoint, signal);
  }
  const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: feats };
  return { geojson: fc, count: feats.length };
}

export async function fetchLongestRiver(bbox: BBox, endpoint?: string, polyWater = false, groupBy = false, signal?: AbortSignal): Promise<RiverResult> {
  if (endpoint && (isMvt(endpoint) || isPmTiles(endpoint))) {
    return pickLongest(await fetchVectorTiles(bbox, endpoint, polyWater));
  }
  const isQlever = !!endpoint && /qlever|sparql/i.test(endpoint);
  if (isQlever) {
    try { return pickLongest(await fetchQlever(bbox, endpoint!, groupBy, signal)); }
    catch (e) { if ((e as Error).name === "AbortError") throw e; /* fall through to Overpass mirrors */ }
  }
  return pickLongest(await fetchOverpass(bbox, isQlever ? undefined : endpoint, signal));
}
