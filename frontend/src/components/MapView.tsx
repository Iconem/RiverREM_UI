import { useCallback, useEffect, useRef, useState } from "react";
import Map, { type MapRef, NavigationControl, Popup } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import mlcontour from "maplibre-contour";
import type { StyleSpecification, Map as MlMap } from "maplibre-gl";
import { cogProtocol, setColorFunction } from "@geomatico/maplibre-cog-protocol";
import { colorReliefExpr } from "@/lib/colormap";
import { ensureRemProtocol, setRemParams, buildREMTile, setRemMaxZoom, type RiverPoint } from "@/lib/remClient";

// Patch window.fetch so maplibre-contour (worker:false) can resolve rem:// tile URLs.
// addProtocol registrations are MapLibre-internal and invisible to external fetch().
let _remFetchPatched = false;
function ensureRemFetchPatch() {
  if (_remFetchPatched) return;
  _remFetchPatched = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.startsWith("rem://tiles/")) {
      const [z, x, y] = url.replace("rem://tiles/", "").split("/").map(Number);
      const buf = await buildREMTile(z, x, y);
      return new Response(buf, { status: 200, headers: { "Content-Type": "image/png" } });
    }
    return orig(input, init);
  };
}
import type { BBox } from "@/lib/api";

// Register the geomatico COG protocol once. For the `cog://…#dem` path we register a
// custom color function (below) that wins over geomatico's built-in terrain encoder,
// so the float COG is encoded as TERRARIUM (~4 mm vertical step) rather than Mapbox
// Terrain-RGB (~100 mm). A native MapLibre `color-relief` layer then tints it.
let registered = false;
function ensureProtocol() {
  if (registered) return;
  try { maplibregl.addProtocol("cog", cogProtocol as never); } catch { /* already */ }
  registered = true;
}
// Register at module load so the protocol is always present before the first tile
// request, even across Strict-Mode double-mounts / HMR.
ensureProtocol();

// float height -> terrarium RGB. NoData (e.g. -9999) round-trips and is made
// transparent by colorReliefExpr's sub-min floor stop.
const terrariumColorFunction = (pixel: any, color: any) => {
  const height = pixel[0];
  const v = height + 32768;
  const r = Math.floor(v / 256);
  const g = Math.floor(v % 256);
  const b = Math.floor((v - Math.floor(v)) * 256);
  color.set([r, g, b, 255]);
};

const MAPTERHORN_DEM = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";

const STYLE: StyleSpecification = {
  version: 8,
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    "carto-dark": {
      type: "raster",
      tiles: ["https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png"],
      tileSize: 256, attribution: "© OpenStreetMap © CARTO",
    },
    "carto-light": {
      type: "raster",
      tiles: ["https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png"],
      tileSize: 256, attribution: "© OpenStreetMap © CARTO",
    },
    "esri-sat": {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256, attribution: "© Esri, Maxar, Earthstar Geographics",
    },
    "mapterhorn-dem": {
      type: "raster-dem", tiles: [MAPTERHORN_DEM], tileSize: 256, maxzoom: 14,
      encoding: "terrarium", attribution: "terrain © Mapterhorn",
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#0a0a0a" } },
    { id: "carto-dark", type: "raster", source: "carto-dark", layout: { visibility: "visible" } },
    { id: "carto-light", type: "raster", source: "carto-light", layout: { visibility: "none" } },
    { id: "esri-sat", type: "raster", source: "esri-sat", layout: { visibility: "none" } },
    // Opaque hillshade BASEMAP: neutral grey fill under a native MapLibre hillshade
    // with opaque shadow/highlight colours, so relief reads as a standalone map.
    { id: "hs-bg", type: "background", layout: { visibility: "none" }, paint: { "background-color": "#9aa0a6" } },
    {
      id: "mapterhorn-hillshade", type: "hillshade", source: "mapterhorn-dem",
      layout: { visibility: "none" },
      paint: {
        "hillshade-shadow-color": "#2b2f33",
        "hillshade-highlight-color": "#ffffff",
        "hillshade-accent-color": "#5a6066",
        "hillshade-exaggeration": 0.7,
      },
    },
  ],
};

const BASE_LAYERS: Record<string, string[]> = {
  dark: ["carto-dark"], light: ["carto-light"], satellite: ["esri-sat"],
  hillshade: ["hs-bg", "mapterhorn-hillshade"],
};

type Opts = { ramp: string; min: number; max: number; mode: string; base: string; reverse: boolean; oversample: number; hillshade: string; transparent: "none" | "white" | "black" };

export function MapView({
  initialView, opts, cogUrl, cogBounds, fitSignal, theme, preview, remVisible, pickMode,
  engine, riverPoints, idwPower, interpMode, clientMaxZoom, remToken,
  riverGeojson, showContours, showContourLabels, isDemMode, showRiver, showSamples, showViewport, pick,
  onBounds, onView, onDrawn, onMapReady, onPick, onTerraDrawRef, onFps,
}: {
  initialView: { lng: number; lat: number; zoom: number };
  opts: Opts;
  cogUrl: string | null;
  cogBounds: [number, number, number, number] | null;
  fitSignal: number;
  theme: "dark" | "light";
  preview: GeoJSON.GeoJSON | null;
  riverGeojson: GeoJSON.GeoJSON | null;
  showContours: boolean;
  showContourLabels: boolean;
  isDemMode: boolean;
  showRiver: boolean;
  showSamples: boolean;
  showViewport?: boolean;
  engine: "server" | "client";
  riverPoints: RiverPoint[] | null;
  idwPower: number;
  interpMode: "idw" | "jfa" | "edt";
  clientMaxZoom: number;
  remToken: number;
  remVisible: boolean;
  pickMode: boolean;
  pick: { lng: number; lat: number; rem: number | null; dem: number | null } | null;
  onBounds: (b: BBox, zoom: number) => void;
  onView: (v: { lng: number; lat: number; zoom: number }) => void;
  onDrawn: (g: GeoJSON.GeoJSON) => void;
  onMapReady: (map: MlMap) => void;
  onPick: (lng: number, lat: number) => void;
  onTerraDrawRef?: (draw: any | null) => void;
  onFps?: (fps: number) => void;
}) {
  const mapRef = useRef<MapRef | null>(null);
  const remRef = useRef<{ src: string; layer: string } | null>(null);
  const [ready, setReady] = useState(false);

  const emitBounds = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const b = map.getBounds();
    onBounds({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }, Math.round(map.getZoom()));
    onView({ lng: map.getCenter().lng, lat: map.getCenter().lat, zoom: map.getZoom() });
  }, [onBounds, onView]);

  // Add / replace the COG (REM or DEM) color-relief layer. Each COG gets a fresh
  // source+layer id so switching runs/layers tears the old one down and the protocol
  // re-requests tiles for the new URL (no stale-source reuse).
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    if (remRef.current) {
      if (map.getLayer(remRef.current.layer)) map.removeLayer(remRef.current.layer);
      if (map.getSource(remRef.current.src)) map.removeSource(remRef.current.src);
      remRef.current = null;
    }

    const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const src = `rem-src-${key}`;
    const layer = `rem-layer-${key}`;

    if (engine === "client") {
      if (isDemMode) {
        // Client DEM mode: show raw Mapterhorn elevation via a dedicated source.
        map.addSource(src, {
          type: "raster-dem",
          tiles: [MAPTERHORN_DEM],
          tileSize: 256,
          encoding: "terrarium",
        } as any);
      } else {
        // Pure-JS REM engine: build the REM live per tile from sampled river points.
        if (!riverPoints || riverPoints.length === 0) return;
        ensureRemProtocol();
        setRemParams(riverPoints, idwPower, interpMode);
        map.addSource(src, {
          type: "raster-dem",
          tiles: ["rem://tiles/{z}/{x}/{y}"],
          tileSize: 256,
          encoding: "terrarium",
          bounds: cogBounds ?? undefined,
          maxzoom: clientMaxZoom,
        } as any);
      }
    } else {
      if (!cogUrl) return;
      const url = `cog://${cogUrl}#dem`;
      // Force TERRARIUM encoding (~4 mm step) on the #dem path: a custom color function
      // wins over geomatico's built-in terrain encoder. IMPORTANT: geomatico keys the
      // function by the BARE cog url (no cog:// prefix, no #dem) — see its README.
      setColorFunction(cogUrl, terrariumColorFunction);
      map.addSource(src, {
        type: "raster-dem",
        url,
        tileSize: 256,
        encoding: "terrarium",
        bounds: cogBounds ?? undefined,
      } as any);
    }

    map.addLayer({
      id: layer, type: "color-relief", source: src,
      layout: { visibility: remVisible ? "visible" : "none" },
      paint: { "color-relief-color": colorReliefExpr(opts.ramp, opts.min, opts.max, opts.reverse, opts.transparent) as any, "color-relief-opacity": 0.95 },
    } as any);
    remRef.current = { src, layer };
    // Bring overlay layers above the freshly added REM tint (river stays below REM intentionally)
    if (map.getLayer("contours-minor")) map.moveLayer("contours-minor");
    if (map.getLayer("contours-major")) map.moveLayer("contours-major");
    if (map.getLayer("contours-label")) map.moveLayer("contours-label");
    if (map.getLayer("hillshade-overlay")) map.moveLayer("hillshade-overlay");
    if (map.getLayer("preview-line")) map.moveLayer("preview-line");
    if (map.getLayer("river-overlay")) map.moveLayer("river-overlay");
    if (map.getLayer("samples-layer")) map.moveLayer("samples-layer");
    if (map.getLayer("viewport-fill")) map.moveLayer("viewport-fill");
    if (map.getLayer("viewport-line")) map.moveLayer("viewport-line");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, cogUrl, remToken, clientMaxZoom, isDemMode, ready]);

  // Fit the camera to the COG only on an explicit signal (run load / compute
  // complete) — never on a plain REM/DEM layer toggle, which also changes cogUrl.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready || !cogBounds || !fitSignal) return;
    map.fitBounds(cogBounds, { padding: 40, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSignal, ready]);

  // Mapterhorn hillshade overlay, rendered ABOVE the REM/DEM tint (MapLibre can't
  // multiply-blend yet, so we offer a transparent dark or light relief instead).
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    const id = "hillshade-overlay";
    if (opts.hillshade === "off") {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
      return;
    }
    if (!map.getLayer(id)) {
      map.addLayer({ id, type: "hillshade", source: "mapterhorn-dem", paint: {} } as any);
    }
    const dark = opts.hillshade === "dark";
    map.setPaintProperty(id, "hillshade-shadow-color", dark ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0)");
    map.setPaintProperty(id, "hillshade-highlight-color", dark ? "rgba(0,0,0,0)" : "rgba(255,255,255,0.65)");
    map.setPaintProperty(id, "hillshade-accent-color", "rgba(0,0,0,0)");
    map.setPaintProperty(id, "hillshade-exaggeration", 0.5);
    map.setLayoutProperty(id, "visibility", "visible");
    map.moveLayer(id);
    if (map.getLayer("preview-line")) map.moveLayer("preview-line");
    if (map.getLayer("river-overlay")) map.moveLayer("river-overlay");
    if (map.getLayer("samples-layer")) map.moveLayer("samples-layer");
    if (map.getLayer("viewport-fill")) map.moveLayer("viewport-fill");
    if (map.getLayer("viewport-line")) map.moveLayer("viewport-line");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.hillshade, ready, cogUrl, remToken, engine]);

  // River overlay (dashed white, below REM layer). Rebuilds on geojson or visibility change.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    if (map.getLayer("river-overlay")) map.removeLayer("river-overlay");
    if (map.getSource("river-overlay-src")) map.removeSource("river-overlay-src");
    if (!riverGeojson) return;
    map.addSource("river-overlay-src", { type: "geojson", data: riverGeojson });
    // Insert below the REM layer so it's visible through the semi-transparent REM.
    const remLayerId = remRef.current?.layer;
    map.addLayer({
      id: "river-overlay", type: "line", source: "river-overlay-src",
      layout: { "line-join": "round", "line-cap": "round", visibility: showRiver ? "visible" : "none" },
      paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [4, 4], "line-opacity": 0.75 },
    } as any); // no beforeId → top of stack
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riverGeojson, showRiver, ready]);

  // Preview (dashed drawn centerline).
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    if (map.getLayer("preview-line")) map.removeLayer("preview-line");
    if (map.getSource("preview")) map.removeSource("preview");
    if (!preview) return;
    map.addSource("preview", { type: "geojson", data: preview });
    map.addLayer({
      id: "preview-line", type: "line", source: "preview",
      paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [2, 1] },
    } as any);
  }, [preview, ready]);

  // Contours overlay via maplibre-contour (vector tiles from Mapterhorn DEM, 1m spacing).
  // DemSource is created once per map instance and torn down on unmount.
  const demSourceRef = useRef<any>(null);
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;

    const CONTOUR_SRC = "contour-dem-src";
    const LAYER_MINOR = "contours-minor";
    const LAYER_MAJOR = "contours-major";
    const LAYER_LABEL = "contours-label";

    const removeContours = () => {
      if (map.getLayer(LAYER_LABEL)) map.removeLayer(LAYER_LABEL);
      if (map.getLayer(LAYER_MINOR)) map.removeLayer(LAYER_MINOR);
      if (map.getLayer(LAYER_MAJOR)) map.removeLayer(LAYER_MAJOR);
      if (map.getSource(CONTOUR_SRC)) map.removeSource(CONTOUR_SRC);
    };

    // Build the source/layers whenever an actual REM/DEM layer would render — NOT
    // gated on showContours (a dedicated effect toggles visibility). This keeps the
    // source alive across on/off toggles, fixing the "won't re-enable" + detach churn.
    // hasRun also prevents stale raw-DEM contours on reload when no run is selected.
    const hasRun = engine === "client"
      ? (isDemMode || (!!riverPoints && riverPoints.length > 0))
      : !!cogUrl;
    if (!hasRun) { removeContours(); return; }

    // Always rebuild when isDemMode changes (different thresholds = different tile URL).
    removeContours();

    try {
      // Client non-DEM mode: use the live REM tiles (rem://). We patch window.fetch
      // so maplibre-contour (worker:false) can resolve the custom scheme in the main thread.
      // All other modes: use Mapterhorn absolute-elevation tiles (web worker is fine there).
      const useRemTiles = engine === "client" && !isDemMode;
      const contourUrl = useRemTiles ? "rem://tiles/{z}/{x}/{y}" : MAPTERHORN_DEM;
      if (useRemTiles) ensureRemFetchPatch();
      // Recreate DemSource when the tile URL changes (e.g. switching REM ↔ DEM mode or engine).
      const srcKey = `${contourUrl}@${clientMaxZoom}`;
      if (!demSourceRef.current || (demSourceRef.current as any).__key !== srcKey) {
        demSourceRef.current = new mlcontour.DemSource({
          url: contourUrl,
          encoding: "terrarium",
          maxzoom: clientMaxZoom, // cap at probed Mapterhorn depth (no over-zoom 404s)
          worker: !useRemTiles, // rem:// only resolves in main thread via patched fetch
          // worker:false path returns its CACHED MVT buffer directly; maplibre transfers
          // (detaches) it, so a cache hit on re-request throws DataCloneError. Disabling
          // the cache forces a fresh buffer per request. The worker path clones, so it's fine.
          cacheSize: useRemTiles ? 0 : 100,
        });
        (demSourceRef.current as any).__key = srcKey;
      }
      const demSource = demSourceRef.current;
      // setupMaplibre needs the maplibregl namespace (has addProtocol), NOT the Map instance.
      demSource.setupMaplibre(maplibregl);
      const thresholds = isDemMode
        ? { 9: [5, 25], 11: [5, 25], 13: [5, 25] }
        : { 11: [1, 5], 12: [1, 5], 13: [1, 5] };
      const tilesUrl = demSource.contourProtocolUrl({ thresholds });
      // Initial visibility from showContours; the dedicated visibility effect keeps
      // it in sync afterwards WITHOUT tearing the source down (avoids detach churn).
      const vis = showContours ? "visible" : "none";
      map.addSource(CONTOUR_SRC, { type: "vector", tiles: [tilesUrl], maxzoom: 15 });
      map.addLayer({
        id: LAYER_MINOR, type: "line", source: CONTOUR_SRC, "source-layer": "contours",
        filter: ["==", ["get", "level"], 0],
        layout: { visibility: vis },
        paint: { "line-color": "rgba(255,255,255,0.3)", "line-width": 0.7 },
      } as any);
      map.addLayer({
        id: LAYER_MAJOR, type: "line", source: CONTOUR_SRC, "source-layer": "contours",
        filter: ["==", ["get", "level"], 1],
        layout: { visibility: vis },
        paint: { "line-color": "rgba(255,255,255,0.7)", "line-width": 1.2 },
      } as any);
      map.addLayer({
        id: LAYER_LABEL, type: "symbol", source: CONTOUR_SRC, "source-layer": "contours",
        filter: ["==", ["get", "level"], 1],
        layout: {
          "symbol-placement": "line",
          "text-field": ["concat", ["to-string", ["get", "ele"]], "m"],
          "text-size": 12,
          "text-font": ["Noto Sans Regular"],
          "text-keep-upright": true,
          visibility: showContours && showContourLabels ? "visible" : "none",
        },
        paint: {
          "text-color": "rgba(255,255,255,0.9)",
          "text-halo-color": "rgba(0,0,0,0.6)",
          "text-halo-width": 1.5,
        },
      } as any);
      if (map.getLayer("hillshade-overlay")) map.moveLayer("hillshade-overlay");
      if (map.getLayer("preview-line")) map.moveLayer("preview-line");
      if (map.getLayer("river-overlay")) map.moveLayer("river-overlay");
      if (map.getLayer("samples-layer")) map.moveLayer("samples-layer");
      if (map.getLayer("viewport-fill")) map.moveLayer("viewport-fill");
      if (map.getLayer("viewport-line")) map.moveLayer("viewport-line");
    } catch (e) {
      console.warn("[contours] setup failed:", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDemMode, engine, remToken, ready, riverPoints, cogUrl, clientMaxZoom]);

  // Cap the Mapterhorn hillshade/relief source at the probed deepest zoom so it
  // overzooms (reuses parent tiles) instead of requesting 404s above coverage.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    setRemMaxZoom(clientMaxZoom); // cap buildREMTile's Mapterhorn fetches (no 404s past coverage)
    if (!map || !ready) return;
    const s: any = map.getSource("mapterhorn-dem");
    if (s && s.maxzoom !== clientMaxZoom) { s.maxzoom = clientMaxZoom; map.triggerRepaint(); }
  }, [clientMaxZoom, ready]);

  // Contour visibility toggle — no source teardown, so it always re-enables.
  // Labels have their own chip, gated additionally on showContourLabels.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    for (const id of ["contours-minor", "contours-major"])
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", showContours ? "visible" : "none");
    if (map.getLayer("contours-label"))
      map.setLayoutProperty("contours-label", "visibility", showContours && showContourLabels ? "visible" : "none");
  }, [showContours, showContourLabels, ready]);

  // Samples layer (elevation points used for IDW — client mode only).
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    if (map.getLayer("samples-layer")) map.removeLayer("samples-layer");
    if (map.getSource("samples-src")) map.removeSource("samples-src");
    if (!riverPoints || riverPoints.length === 0 || !showSamples) return;
    // Convert EPSG:3857 (mx, my) → WGS84 (lng, lat) for GeoJSON.
    const mxToLng = (mx: number) => (mx / 20037508.342) * 180;
    const myToLat = (my: number) => {
      const lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((my / 20037508.342) * Math.PI)) - Math.PI / 2);
      return lat;
    };
    const geojson: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: riverPoints.map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [mxToLng(p.mx), myToLat(p.my)] },
        properties: { elev: Math.round(p.elev * 10) / 10 },
      })),
    };
    map.addSource("samples-src", { type: "geojson", data: geojson });
    map.addLayer({
      id: "samples-layer", type: "circle", source: "samples-src",
      paint: {
        "circle-radius": 3, "circle-color": "#fbbf24",
        "circle-stroke-color": "#09090b", "circle-stroke-width": 1, "circle-opacity": 0.9,
      },
    } as any);
  }, [riverPoints, showSamples, ready]);

  // Samples visibility toggle without full rebuild.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready || !map.getLayer("samples-layer")) return;
    map.setLayoutProperty("samples-layer", "visibility", showSamples ? "visible" : "none");
  }, [showSamples, ready]);

  // Live recolour — just update the paint expression (GPU, instant).
  useEffect(() => {
    const map = mapRef.current?.getMap();
    const id = remRef.current?.layer;
    if (!map || !ready || !id || !map.getLayer(id)) return;
    map.setPaintProperty(id, "color-relief-color", colorReliefExpr(opts.ramp, opts.min, opts.max, opts.reverse, opts.transparent) as any);
  }, [opts.ramp, opts.reverse, opts.min, opts.max, opts.transparent, cogUrl, remToken, engine, ready]);

  // Layer show/hide (eye toggle).
  useEffect(() => {
    const map = mapRef.current?.getMap();
    const id = remRef.current?.layer;
    if (!map || !ready || !id || !map.getLayer(id)) return;
    map.setLayoutProperty(id, "visibility", remVisible ? "visible" : "none");
  }, [remVisible, ready, cogUrl, remToken, engine]);

  // Basemap switching.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    for (const [base, ids] of Object.entries(BASE_LAYERS))
      for (const id of ids)
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", base === opts.base ? "visible" : "none");
  }, [opts.base, ready]);

  // Background colour follows the UI theme (visible when basemap = none).
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready || !map.getLayer("bg")) return;
    map.setPaintProperty("bg", "background-color", theme === "light" ? "#ffffff" : "#0a0a0a");
  }, [theme, ready]);

  // Oversampling: render the GL canvas at (factor × device DPR), capped, to
  // supersample away blockiness on hi-res / 4K displays. This is the practical
  // lever for color-relief since MapLibre has no `raster-resampling` for it yet
  // (see maplibre-gl-js#7154). NOTE: the real detail ceiling is the COG's own
  // resolution — oversampling past it only anti-aliases, it can't invent pixels.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    // oversample is an absolute backing-store target (×) so 1/2/4 are distinct
    // regardless of device DPR; floored at the native DPR so we never downsample.
    const ratio = Math.min(8, Math.max(opts.oversample, dpr));
    map.setPixelRatio(ratio);
    map.resize();          // re-cover tiles + resize the backing store at the new ratio
    map.triggerRepaint();
  }, [opts.oversample, ready]);

  // Viewport bounds rectangle — shows the compute bbox when the chip is on.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    if (map.getLayer("viewport-line")) map.removeLayer("viewport-line");
    if (map.getLayer("viewport-fill")) map.removeLayer("viewport-fill");
    if (map.getSource("viewport-src")) map.removeSource("viewport-src");
    if (!showViewport || !cogBounds) return;
    const [w, s, e, n] = cogBounds;
    const poly: GeoJSON.Feature = {
      type: "Feature", properties: {},
      geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    };
    map.addSource("viewport-src", { type: "geojson", data: poly });
    map.addLayer({ id: "viewport-fill", type: "fill", source: "viewport-src", paint: { "fill-color": "#a78bfa", "fill-opacity": 0.08 } } as any);
    map.addLayer({ id: "viewport-line", type: "line", source: "viewport-src", paint: { "line-color": "#a78bfa", "line-width": 1.5, "line-dasharray": [4, 3] } } as any);
  }, [showViewport, cogBounds, ready]);

  // Pick mode: click to sample REM/DEM elevation; cursor feedback.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    map.getCanvas().style.cursor = pickMode ? "crosshair" : "";
    if (!pickMode) return;
    const handler = (e: any) => onPick(e.lngLat.lng, e.lngLat.lat);
    map.on("click", handler);
    return () => { map.off("click", handler); map.getCanvas().style.cursor = ""; };
  }, [pickMode, ready, onPick]);

  // FPS counter — uses MapLibre render events; only active when onFps is provided.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready || !onFps) return;
    let frames = 0, last = performance.now();
    const onRender = () => { frames++; };
    map.on("render", onRender);
    const id = setInterval(() => {
      const now = performance.now();
      const elapsed = (now - last) / 1000;
      if (elapsed > 0) onFps(Math.round(frames / elapsed));
      frames = 0; last = now;
    }, 1000);
    return () => { map.off("render", onRender); clearInterval(id); };
  }, [ready, onFps]);

  // Hand-drawing with terra-draw (LineString). Exposes instance via onTerraDrawRef
  // so App.tsx can call draw.addFeatures() for imported GeoJSON files.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready || opts.mode !== "geojson") {
      onTerraDrawRef?.(null);
      return;
    }
    let draw: any, cancelled = false;
    (async () => {
      try {
        const td = await import("terra-draw");
        const adapterMod: any = await import("terra-draw-maplibre-gl-adapter").catch(() => td);
        const Adapter = adapterMod.TerraDrawMapLibreGLAdapter ?? (td as any).TerraDrawMapLibreGLAdapter;
        draw = new td.TerraDraw({ adapter: new Adapter({ map, lib: maplibregl }), modes: [new td.TerraDrawLineStringMode()] });
        if (cancelled) return;
        draw.start();
        draw.setMode("linestring");
        draw.on("finish", () => {
          const snap = draw.getSnapshot() as GeoJSON.Feature[];
          console.log("[terra-draw] finish — features:", snap.length, snap.map((f: GeoJSON.Feature) => f.geometry?.type));
          onDrawn({ type: "FeatureCollection", features: snap } as GeoJSON.GeoJSON);
        });
        onTerraDrawRef?.(draw);
      } catch (e) { console.warn("terra-draw unavailable:", e); }
    })();
    return () => {
      cancelled = true;
      onTerraDrawRef?.(null);
      try { draw?.stop?.(); } catch { /* noop */ }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.mode, ready, onDrawn]);

  return (
    <Map
      ref={mapRef}
      mapLib={maplibregl as never}
      initialViewState={{ longitude: initialView.lng, latitude: initialView.lat, zoom: initialView.zoom, pitch: 0 }}
      mapStyle={STYLE}
      maxPitch={0}
      canvasContextAttributes={{ preserveDrawingBuffer: true }}
      onLoad={() => {
        ensureProtocol();
        setReady(true);
        emitBounds();
        const m = mapRef.current?.getMap();
        if (m) onMapReady(m);
      }}
      onMoveEnd={emitBounds}
      style={{ position: "absolute", inset: 0 }}
    >
      <NavigationControl position="top-right" />
      {pick && (
        <Popup longitude={pick.lng} latitude={pick.lat} closeButton={false} closeOnClick={false}
          anchor="bottom" offset={12} className="rem-pick-popup">
          <div className="font-mono text-[11px] leading-tight">
            <div>REM&nbsp;{pick.rem ?? "–"} m</div>
            <div>DEM&nbsp;{pick.dem ?? "–"} m</div>
            <div>{pick.lat.toFixed(5)}, {pick.lng.toFixed(5)}</div>
          </div>
        </Popup>
      )}
    </Map>
  );
}
