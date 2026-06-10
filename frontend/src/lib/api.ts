const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

export type BBox = { west: number; south: number; east: number; north: number };

export type ComputeRequest = {
  bbox: BBox;
  zoom: number;
  resolution_multiplier: 1 | 2 | 4;
  centerline_mode: "osm" | "geojson" | "shapefile";
  centerline_geojson?: GeoJSON.GeoJSON | null;
  upload_id?: string | null;
  interp_pts?: number;
  k?: number | null;
  eps?: number;
};

export type ComputeResponse = {
  job_id: string;
  cog_url: string;
  dem_url?: string | null;
  bounds: [number, number, number, number];
  rem_min: number;
  rem_max: number;
  dem_min?: number | null;
  dem_max?: number | null;
  river_name: string | null;
  river_length_m: number | null;
  centerline_url?: string | null;
};

export type JobStatus = {
  status: "running" | "done" | "error";
  phase: string;
  pct: number;
  result?: ComputeResponse;
  error?: string;
};

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? r.statusText);
  return r.json();
}
async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? r.statusText);
  return r.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Relative /cogs path from a public cog_url, for the /sample endpoint. */
export function cogPath(url: string): string | null {
  const i = url.indexOf("/cogs/");
  return i >= 0 ? url.slice(i + "/cogs/".length) : null;
}

export const api = {
  centerlineOsm: (req: Partial<ComputeRequest> & { bbox: BBox; zoom: number }) =>
    post<{ geojson: GeoJSON.GeoJSON; river_name: string; river_length_m: number }>(
      "/centerline/osm",
      { centerline_mode: "osm", resolution_multiplier: 1, ...req }
    ),

  // Job-based compute: start, then poll until done. RiverREM's interpolation %
  // is surfaced through onProgress(phase, pct).
  compute: async (req: ComputeRequest, onProgress?: (phase: string, pct: number) => void) => {
    const { job_id } = await post<{ job_id: string }>("/compute", req);
    for (;;) {
      await sleep(500);
      const s = await get<JobStatus>(`/compute/${job_id}`);
      onProgress?.(s.phase, s.pct);
      if (s.status === "done" && s.result) return s.result;
      if (s.status === "error") throw new Error(s.error || "compute failed");
    }
  },

  ingestCog: (url: string) =>
    post<{ cog_url: string; bounds: [number, number, number, number]; rem_min: number; rem_max: number }>(
      "/cog/ingest",
      { url }
    ),

  sample: (path: string, lng: number, lat: number) =>
    get<{ value: number | null }>(`/sample?path=${encodeURIComponent(path)}&lng=${lng}&lat=${lat}`),

  // Given relative /cogs paths of locally-stored runs, return those still present
  // on the backend (so the client can drop runs whose COGs vanished on rebuild).
  prune: (paths: string[]) => post<{ existing: string[] }>("/runs/prune", { paths }),

  // Fetch a run's saved centerline GeoJSON (returns null if none).
  centerline: async (url: string): Promise<GeoJSON.GeoJSON | null> => {
    try {
      const r = await fetch(url);
      return r.ok ? ((await r.json()) as GeoJSON.GeoJSON) : null;
    } catch { return null; }
  },

  upload: async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(`${BASE}/upload`, { method: "POST", body: fd });
    if (!r.ok) throw new Error("upload failed");
    return (await r.json()) as { upload_id: string };
  },
};

// Open-data geocoder (Photon / komoot, OSM-based, no key).
export type GeoHit = { label: string; lng: number; lat: number };
export async function geocode(q: string, signal?: AbortSignal): Promise<GeoHit[]> {
  const r = await fetch(`https://photon.komoot.io/api/?limit=5&q=${encodeURIComponent(q)}`, { signal });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.features ?? []).map((f: any) => {
    const p = f.properties ?? {};
    const label = [p.name, p.city, p.state, p.country].filter(Boolean).join(", ");
    return { label: label || p.name || "?", lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
  });
}

/** Reverse geocode a point to a short place label (for auto-naming runs). */
export async function reverseGeocode(lng: number, lat: number): Promise<string | null> {
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lon=${lng}&lat=${lat}`);
    if (!r.ok) return null;
    const j = await r.json();
    const p = j.features?.[0]?.properties ?? {};
    return [p.name, p.city ?? p.county, p.country].filter(Boolean).join(", ") || null;
  } catch {
    return null;
  }
}
