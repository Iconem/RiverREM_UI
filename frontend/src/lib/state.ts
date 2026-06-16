/**
 * All shareable state lives in the URL via nuqs: map view + every sidepanel
 * control (centerline mode, ramp, min/max, log, resolution). Copying the URL
 * reproduces the exact view and styling.
 */
import {
  createParser,
  parseAsFloat,
  parseAsInteger,
  parseAsBoolean,
  parseAsString,
  parseAsStringEnum,
  parseAsArrayOf,
  useQueryStates,
} from "nuqs";

// Float parser that serialises to a fixed number of decimals — keeps the URL short
// and avoids 14-digit floats. 5 dp ≈ 1 m of latitude/longitude precision.
const parseAsFixed = (decimals: number) =>
  createParser({
    parse: (v: string) => { const n = parseFloat(v); return Number.isNaN(n) ? null : n; },
    serialize: (v: number) => String(Number(v.toFixed(decimals))),
  });

export const RAMP_NAMES = [
  "mako_r", "blues_r", "gray", "viridis", "spectral", "topo",
  "inferno", "magma", "plasma", "cividis", "turbo", "terrain", "rdbu_r", "set3",
] as const;
export const BASEMAPS = ["dark", "light", "satellite", "hillshade", "none"] as const;

export function useMapView() {
  return useQueryStates({
    // Willamette River meanders near Corvallis, OR — clear floodplain channels,
    // good Mapterhorn coverage, REM reads nicely here.
    lng: parseAsFixed(5).withDefault(-123.25),
    lat: parseAsFixed(5).withDefault(44.57),
    zoom: parseAsFixed(2).withDefault(13),
  });
}

export function useRemOptions() {
  return useQueryStates({
    mode: parseAsStringEnum(["osm", "geojson", "shapefile"]).withDefault("osm"),
    engine: parseAsStringEnum(["server", "client"]).withDefault("client"), // server=RiverREM COG, client=pure-JS live tiles
    power: parseAsFloat.withDefault(2), // IDW power (both engines; unused in client JFA mode)
    interp: parseAsStringEnum(["idw", "jfa", "edt"]).withDefault("idw"), // client WSE interpolation mode
    beta: parseAsBoolean.withDefault(false), // enables experimental controls (WSE toggle, perf panel)
    samples: parseAsInteger.withDefault(150), // river WSE sample count (client engine)
    base: parseAsStringEnum([...BASEMAPS]).withDefault("dark"),
    ramp: parseAsStringEnum([...RAMP_NAMES]).withDefault("mako_r"),
    reverse: parseAsBoolean.withDefault(false),
    transparent: parseAsStringEnum(["none", "white", "black"]).withDefault("none"), // make the white/black end see-through
    min: parseAsFloat.withDefault(-1),
    max: parseAsFloat.withDefault(10),
    log: parseAsBoolean.withDefault(true),
    res: parseAsInteger.withDefault(1), // 1 | 2 | 4 resolution multiplier
    oversample: parseAsInteger.withDefault(1), // GPU supersampling factor (× device DPR)
    layer: parseAsStringEnum(["rem", "dem"]).withDefault("rem"), // which COG is streamed
    hillshade: parseAsStringEnum(["off", "dark", "light"]).withDefault("off"), // Mapterhorn relief overlay
    sliderLo: parseAsFloat, // optional custom slider lower bound (null = auto)
    sliderHi: parseAsFloat, // optional custom slider upper bound (null = auto)
    osm: parseAsString.withDefault("https://qlever.dev/api/osm-planet"),
    qleverMode: parseAsStringEnum(["longest", "all", "waterways"]).withDefault("longest"),
    showContours: parseAsBoolean.withDefault(false),
    showContourLabels: parseAsBoolean.withDefault(true),
    showRiver: parseAsBoolean.withDefault(true),
    showSamples: parseAsBoolean.withDefault(false),
    showViewport: parseAsBoolean.withDefault(false),
  });
}

// The active REM COG reference lives in the URL too, so a copied link reloads the
// exact COG (any browser/user — the COG is public) with the same styling.
export function useActiveRem() {
  return useQueryStates({
    cog: parseAsString.withDefault(""),
    dem: parseAsString.withDefault(""),
    bounds: parseAsArrayOf(parseAsFixed(5)).withDefault([]),
  });
}

// Collapsed/expanded state of side-panel sections, persisted in the URL so a shared
// link restores the same layout. Centerline is folded by default.
export function useUiState() {
  return useQueryStates({
    foldCl: parseAsBoolean.withDefault(true), // centerline options folded by default
    foldRamp: parseAsBoolean.withDefault(false),
    foldLayers: parseAsBoolean.withDefault(false), // layers (basemap/relief/chips) section
    foldUtil: parseAsBoolean.withDefault(true), // utilities (basemap/inspect/load) folded
    collapsed: parseAsBoolean.withDefault(false), // whole panel collapsed
    runsView: parseAsStringEnum(["list", "gallery"]).withDefault("gallery"),
    runsSource: parseAsStringEnum(["device", "server"]).withDefault("device"),
    theme: parseAsStringEnum(["dark", "light"]).withDefault("dark"),
    foldComp: parseAsBoolean.withDefault(false),   // compute section folded
    foldExport: parseAsBoolean.withDefault(false), // export section folded
    foldRuns: parseAsBoolean.withDefault(false),   // runs section folded
  });
}
