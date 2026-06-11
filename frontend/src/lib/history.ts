/**
 * Run history in browser localStorage. No auth — everything the backend serves is
 * public, so a saved run is just the public COG urls + bounds + styling. These power
 * the "Runs" list (load a past REM as the active layer) and the share permalink.
 */
export type Run = {
  id: string;
  cog: string;
  dem?: string | null;
  bounds: [number, number, number, number];
  min: number;          // REM symbology
  max: number;
  log?: boolean;        // REM log/linear
  demMin?: number | null;  // DEM symbology (so toggling DEM restores its own range)
  demMax?: number | null;
  demLog?: boolean | null;
  ramp: string;
  reverse?: boolean;
  transparent?: "none" | "white" | "black" | null;
  hillshade?: "off" | "dark" | "light" | null;
  base?: string | null;
  layer?: "rem" | "dem" | null;       // which layer was being viewed
  sliderLo?: number | null;           // custom slider bounds (null = auto)
  sliderHi?: number | null;
  name?: string | null;
  cl?: string | null; // centerline GeoJSON url (backend-hosted, shareable)
  thumb?: string | null; // small JPEG data-URL preview for the gallery
  ts: number;
};

const KEY = "riverrem.runs";

export function listRuns(): Run[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

// Write runs, surviving QuotaExceeded (thumbnails are large): first drop the
// oldest thumbnails, then, if still too big, drop the oldest runs entirely.
function persist(all: Run[]): Run[] {
  let cur = all;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      localStorage.setItem(KEY, JSON.stringify(cur));
      return cur;
    } catch {
      const withThumb = cur.map((r, i) => ({ r, i })).filter((x) => x.r.thumb);
      if (withThumb.length) {
        // strip the oldest thumbnail (highest index = oldest, list is newest-first)
        const drop = withThumb[withThumb.length - 1].i;
        cur = cur.map((r, i) => (i === drop ? { ...r, thumb: null } : r));
      } else if (cur.length > 1) {
        cur = cur.slice(0, -1); // drop the oldest run
      } else {
        return cur; // give up; nothing else to shed
      }
    }
  }
  return cur;
}

export function addRun(run: Run, dedupeByCog = true): Run[] {
  const prev = dedupeByCog ? listRuns().filter((r) => r.cog !== run.cog) : listRuns();
  return persist([run, ...prev].slice(0, 40));
}

export function removeRun(id: string): Run[] {
  return persist(listRuns().filter((r) => r.id !== id));
}

export function updateRun(id: string, patch: Partial<Run>): Run[] {
  return persist(listRuns().map((r) => (r.id === id ? { ...r, ...patch } : r)));
}

/** Keep only runs for which `keep(run)` is true (used to drop stale backend COGs). */
export function pruneRuns(keep: (r: Run) => boolean): Run[] {
  return persist(listRuns().filter(keep));
}
