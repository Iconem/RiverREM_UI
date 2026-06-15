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

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];

/** Selectable presets for the UI. QLever speaks SPARQL, not Overpass QL, so it is
 *  marked experimental — if it fails the fallback chain takes over. */
export const OVERPASS_PRESETS: { label: string; url: string }[] = [
  { label: "QLever (fast)", url: "https://qlever.dev/api/osm-planet" },
  { label: "overpass.de", url: "https://overpass-api.de/api/interpreter" },
  { label: "kumi.systems", url: "https://overpass.kumi.systems/api/interpreter" },
  { label: "private.coffee", url: "https://overpass.private.coffee/api/interpreter" },
  { label: "osm.ch", url: "https://overpass.osm.ch/api/interpreter" },
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
  if (isQlever) {
    try { features = await fetchQlever(bbox, endpoint!); }
    catch { features = await fetchOverpass(bbox, undefined); }
  } else {
    features = await fetchOverpass(bbox, endpoint);
  }
  const byName = new Map<string, NamedLine[]>();
  for (const f of features) {
    const name = (f.properties as any)?.name;
    if (!name || (f.geometry as any)?.type !== "LineString") continue;
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
function wktToFeatures(name: string, wkt: string): NamedLine[] {
  const out: NamedLine[] = [];
  const parse = (body: string): LngLat[] =>
    body.trim().split(",").map((p) => p.trim().split(/\s+/).map(Number) as LngLat);
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

async function fetchQlever(bbox: BBox, endpoint: string): Promise<NamedLine[]> {
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
    if (name && wkt) feats.push(...wktToFeatures(name, wkt));
  }
  if (feats.length === 0) throw new Error("QLever returned no waterways");
  return feats;
}

export async function fetchLongestRiver(bbox: BBox, endpoint?: string): Promise<RiverResult> {
  const isQlever = !!endpoint && /qlever|sparql/i.test(endpoint);
  if (isQlever) {
    try {
      return pickLongest(await fetchQlever(bbox, endpoint!));
    } catch {
      /* fall through to Overpass mirrors */
    }
  }
  return pickLongest(await fetchOverpass(bbox, isQlever ? undefined : endpoint));
}
