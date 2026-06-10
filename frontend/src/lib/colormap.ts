/**
 * Colour ramps for the REM.
 *
 * Ramps are stored as stop arrays [t in 0..1, [r,g,b]] and interpolated here, so
 * the app runs with zero external palette deps. `cptToStops()` lets you drop in
 * any GMT .cpt palette via cpt2js to produce the same shape — that is the path
 * for "import a custom colour ramp".
 *
 * `makeColorFn({ ramp, min, max, log })` returns (value:number) => [r,g,b,a].
 * min and max are independent (set them to e.g. 0..1 or 0..10 m). `log` mirrors
 * RiverREM's log-scaled colour-relief, which compresses the ramp near the river
 * so the first metre of relief gets most of the colour budget.
 */

export type Stop = [number, [number, number, number]];
export type Ramp = { name: string; stops: Stop[] };

const S = (hexes: [number, string][]): Stop[] =>
  hexes.map(([t, hex]) => {
    const n = hex.replace("#", "");
    return [t, [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)]];
  });

export const RAMPS: Record<string, Ramp> = {
  mako_r: { name: "mako_r", stops: S([[0, "#def5e5"], [0.25, "#3ec1bf"], [0.5, "#3a6b9b"], [0.75, "#403a75"], [1, "#0b0405"]]) },
  blues_r: { name: "blues_r", stops: S([[0, "#08306b"], [0.5, "#4292c6"], [0.8, "#c6dbef"], [1, "#f7fbff"]]) },
  viridis: { name: "viridis", stops: S([[0, "#440154"], [0.25, "#3b528b"], [0.5, "#21918c"], [0.75, "#5ec962"], [1, "#fde725"]]) },
  spectral: { name: "spectral", stops: S([[0, "#5e4fa2"], [0.25, "#3288bd"], [0.5, "#abdda4"], [0.7, "#fdae61"], [0.85, "#d53e4f"], [1, "#9e0142"]]) },
  topo: { name: "topo", stops: S([[0, "#1a468c"], [0.2, "#2e8b8b"], [0.4, "#48a86a"], [0.6, "#c8c45a"], [0.8, "#a3743c"], [1, "#f5f0e6"]]) },
  inferno: { name: "inferno", stops: S([[0, "#000004"], [0.25, "#420a68"], [0.5, "#932667"], [0.7, "#dd513a"], [0.85, "#fca50a"], [1, "#fcffa4"]]) },
  magma: { name: "magma", stops: S([[0, "#000004"], [0.25, "#3b0f70"], [0.5, "#8c2981"], [0.7, "#de4968"], [0.85, "#fe9f6d"], [1, "#fcfdbf"]]) },
  plasma: { name: "plasma", stops: S([[0, "#0d0887"], [0.25, "#6a00a8"], [0.5, "#b12a90"], [0.7, "#e16462"], [0.85, "#fca636"], [1, "#f0f921"]]) },
  cividis: { name: "cividis", stops: S([[0, "#00204d"], [0.3, "#414d6b"], [0.5, "#7c7b78"], [0.75, "#bcaf6f"], [1, "#ffe945"]]) },
  turbo: { name: "turbo", stops: S([[0, "#30123b"], [0.25, "#28bceb"], [0.5, "#a4fc3c"], [0.7, "#fb8022"], [1, "#7a0403"]]) },
  terrain: { name: "terrain", stops: S([[0, "#333399"], [0.25, "#0099ff"], [0.5, "#00cc66"], [0.7, "#ffff66"], [0.85, "#cc9966"], [1, "#ffffff"]]) },
  rdbu_r: { name: "rdbu_r", stops: S([[0, "#053061"], [0.35, "#4393c3"], [0.5, "#f7f7f7"], [0.65, "#d6604d"], [1, "#67001f"]]) },
  gray: { name: "gray", stops: S([[0, "#0a0a0a"], [1, "#f5f5f5"]]) },
};

/** Ramp stops, optionally reversed (flip the colour direction). */
export function rampStops(name: string, reverse = false): Stop[] {
  const s = RAMPS[name]?.stops ?? [];
  return reverse ? s.map(([t, c]) => [1 - t, c] as Stop).reverse() : s;
}

/** CSS linear-gradient string for a ramp, for swatch previews. */
export function rampCss(name: string, reverse = false): string {
  const stops = rampStops(name, reverse);
  if (!stops.length) return "transparent";
  const parts = stops.map(([t, [R, G, B]]) => `rgb(${R},${G},${B}) ${(t * 100).toFixed(0)}%`);
  return `linear-gradient(to right, ${parts.join(", ")})`;
}

/** MapLibre `color-relief-color` expression over ["elevation"] (metres above river).
 *  A transparent floor below `min` makes NoData (encoded as a low sentinel) render
 *  transparent while real values clamp to the first colour. */
export function colorReliefExpr(name: string, min: number, max: number, reverse = false): any[] {
  const stops = rampStops(name, reverse);
  const span = max - min || 1;
  // Everything below the data range — including the COG's nodata (e.g. -9999) — is
  // transparent: clamp a transparent stop just under `min`, then the ramp colours.
  const floor = min - Math.max(0.001, span * 0.001);
  const expr: any[] = ["interpolate", ["linear"], ["elevation"], floor, "rgba(0,0,0,0)"];
  let prev = floor;
  for (const [t, [r, g, b]] of stops) {
    let e = min + t * span;
    if (e <= prev) e = prev + 1e-4; // strictly increasing for interpolate
    prev = e;
    expr.push(e, `rgb(${r},${g},${b})`);
  }
  return expr;
}

/** Convert a GMT .cpt string to the same stop shape using cpt2js.
 *  cpt2js is loaded on demand and its export shape resolved defensively
 *  (it exposes parseColorMap as a default export), so it never affects app load. */
export async function cptToStops(cpt: string): Promise<Stop[]> {
  const mod = (await import("cpt2js")) as any;
  const parse = mod.parseColorMap ?? mod.default ?? mod;
  // cpt2js -> array of [value, "rgba(r,g,b,a)"]; normalise the value domain to 0..1.
  const cm = parse(cpt) as Array<[number, string]>;
  const vals = cm.map((c) => c[0]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  return cm.map(([v, css]) => {
    const m = css.match(/rgba?\(([^)]+)\)/);
    const [r, g, b] = m ? m[1].split(",").map((x) => parseInt(x.trim(), 10)) : [0, 0, 0];
    return [(v - lo) / span, [r, g, b]] as Stop;
  });
}

function sample(stops: Stop[], t: number): [number, number, number] {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return [0, 1, 2].map((j) => Math.round(c0[j] + f * (c1[j] - c0[j]))) as [number, number, number];
    }
  }
  return stops[stops.length - 1][1];
}

export type ColorOpts = { ramp: Stop[]; min: number; max: number; log: boolean };

export function makeColorFn({ ramp, min, max, log }: ColorOpts) {
  const span = max - min || 1;
  return (v: number): [number, number, number, number] => {
    if (!Number.isFinite(v)) return [0, 0, 0, 0];
    let t = (v - min) / span;
    t = Math.max(0, Math.min(1, t));
    if (log) {
      // log compression toward the low end (near-river), matching RiverREM
      t = Math.log1p(t * (Math.E - 1)); // log1p(t*(e-1)) maps [0,1]->[0,1], front-loaded
    }
    const [r, g, b] = sample(ramp, t);
    return [r, g, b, 255];
  };
}
