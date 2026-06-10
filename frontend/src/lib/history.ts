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
  min: number;
  max: number;
  ramp: string;
  reverse?: boolean;
  name?: string | null;
  cl?: string | null; // centerline GeoJSON url (backend-hosted, shareable)
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

export function addRun(run: Run): Run[] {
  const all = [run, ...listRuns().filter((r) => r.cog !== run.cog)].slice(0, 40);
  localStorage.setItem(KEY, JSON.stringify(all));
  return all;
}

export function removeRun(id: string): Run[] {
  const all = listRuns().filter((r) => r.id !== id);
  localStorage.setItem(KEY, JSON.stringify(all));
  return all;
}

export function updateRun(id: string, patch: Partial<Run>): Run[] {
  const all = listRuns().map((r) => (r.id === id ? { ...r, ...patch } : r));
  localStorage.setItem(KEY, JSON.stringify(all));
  return all;
}

/** Keep only runs for which `keep(run)` is true (used to drop stale backend COGs). */
export function pruneRuns(keep: (r: Run) => boolean): Run[] {
  const all = listRuns().filter(keep);
  localStorage.setItem(KEY, JSON.stringify(all));
  return all;
}
