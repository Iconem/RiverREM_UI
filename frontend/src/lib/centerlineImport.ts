// GeoJSON centerlines are read in the browser: they are already WGS84 (RFC 7946),
// so there is nothing for the server to reproject, the file never leaves the
// machine, and the client engine keeps working with no backend at all.
// GeoPackage and zipped Shapefile still go through POST /centerline/import,
// which needs GDAL for their CRS. Same rules and limits as the server
// (backend/app/centerline.py): lines only, lon/lat in range, 10,000 features,
// 500,000 coordinates.
import type { CenterlineImportLayer, CenterlineImportResult } from "@/lib/api";

const MAX_FEATURES = 10_000;
const MAX_VERTICES = 500_000;
const MAX_BYTES = 64 * 1024 * 1024;

type Line = GeoJSON.LineString | GeoJSON.MultiLineString;

function validPosition(p: unknown): p is [number, number] {
  return Array.isArray(p) && p.length >= 2 &&
    typeof p[0] === "number" && typeof p[1] === "number" &&
    Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
    Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
}

function haversineM(a: number[], b: number[]): number {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isGeoJsonFile(file: File): boolean {
  return /\.(geo)?json$/i.test(file.name);
}

export async function importGeoJsonCenterline(file: File): Promise<CenterlineImportResult> {
  if (file.size > MAX_BYTES) throw new Error("Centerline file exceeds the 64 MB limit");
  let doc: any;
  try { doc = JSON.parse(await file.text()); } catch (e) {
    throw new Error(`The selected file is not valid GeoJSON: ${(e as Error).message}`);
  }
  const features: GeoJSON.Feature[] =
    doc?.type === "FeatureCollection" && Array.isArray(doc.features) ? doc.features :
    doc?.type === "Feature" ? [doc] :
    doc?.type === "LineString" || doc?.type === "MultiLineString" ? [{ type: "Feature", properties: {}, geometry: doc }] :
    (() => { throw new Error("GeoJSON must contain a LineString or MultiLineString feature"); })();

  const kept: GeoJSON.Feature<Line>[] = [];
  let empty = 0, nonLine = 0, invalid = 0, vertices = 0, lengthM = 0;
  for (const f of features) {
    const g = f?.geometry as GeoJSON.Geometry | null | undefined;
    if (!g) { empty++; continue; }
    if (g.type !== "LineString" && g.type !== "MultiLineString") { nonLine++; continue; }
    const parts: unknown[] = g.type === "LineString" ? [g.coordinates] : (Array.isArray(g.coordinates) ? g.coordinates : []);
    const goodParts: [number, number][][] = [];
    let bad = false;
    for (const part of parts) {
      if (!Array.isArray(part)) { bad = true; break; }
      if (!part.every(validPosition)) {
        throw new Error("GeoJSON coordinates must use WGS 84 (EPSG:4326) in [longitude, latitude] order.");
      }
      if (part.length >= 2) goodParts.push(part as [number, number][]);
    }
    if (bad || goodParts.length === 0) { invalid++; continue; }
    let len = 0, n = 0;
    for (const part of goodParts) {
      n += part.length;
      for (let i = 1; i < part.length; i++) len += haversineM(part[i - 1], part[i]);
    }
    if (len <= 0) { invalid++; continue; }
    vertices += n; lengthM += len;
    const geometry: Line = g.type === "LineString"
      ? { type: "LineString", coordinates: goodParts[0] }
      : { type: "MultiLineString", coordinates: goodParts };
    kept.push({ type: "Feature", properties: f.properties ?? {}, geometry });
    if (kept.length > MAX_FEATURES) throw new Error(`The file contains more than ${MAX_FEATURES.toLocaleString()} line features.`);
    if (vertices > MAX_VERTICES) throw new Error(`The file contains more than ${MAX_VERTICES.toLocaleString()} coordinates. Simplify the centerline and try again.`);
  }
  if (kept.length === 0) throw new Error(`${file.name} has no usable centerlines. Centerlines must be non-empty LineString or MultiLineString features.`);

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const warnings: string[] = [];
  if (empty) warnings.push(`Skipped ${plural(empty, "empty geometry", "empty geometries")}.`);
  if (nonLine) warnings.push(`Skipped ${plural(nonLine, "non-line feature", "non-line features")}.`);
  if (invalid) warnings.push(`Skipped ${plural(invalid, "invalid or zero-length line", "invalid or zero-length lines")}.`);

  const name = file.name.replace(/\.[^.]+$/, "");
  const layer: CenterlineImportLayer = {
    id: name, name, crs: "EPSG:4326",
    featureCount: kept.length, vertexCount: vertices, lengthM: Math.round(lengthM * 10) / 10,
    warnings, geojson: { type: "FeatureCollection", features: kept },
  };
  return { filename: file.name, layers: [layer] };
}

/** [west, south, east, north] of a line collection, without spreading
 *  coordinates into Math.min/max (that overflows the stack past ~100k points). */
export function lineBounds(features: GeoJSON.Feature[]): [number, number, number, number] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const visit = (p: number[]) => {
    if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1];
  };
  for (const f of features) {
    const g = f.geometry;
    if (g?.type === "LineString") g.coordinates.forEach(visit);
    else if (g?.type === "MultiLineString") for (const line of g.coordinates) line.forEach(visit);
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}
