import { useCallback, useEffect, useRef, useState } from "react";
import Map, { Source, Layer, type MapRef } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import type { StyleSpecification, Map as MlMap } from "maplibre-gl";
import { cogProtocol, setColorFunction } from "@geomatico/maplibre-cog-protocol";
import { colorReliefExpr } from "@/lib/colormap";
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
    "esri-sat": {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256, attribution: "© Esri, Maxar, Earthstar Geographics",
    },
    "mapterhorn-dem": {
      type: "raster-dem", tiles: [MAPTERHORN_DEM], tileSize: 256,
      encoding: "terrarium", attribution: "terrain © Mapterhorn",
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#0a0a0a" } },
    { id: "carto-dark", type: "raster", source: "carto-dark", layout: { visibility: "visible" } },
    { id: "esri-sat", type: "raster", source: "esri-sat", layout: { visibility: "none" } },
    {
      id: "mapterhorn-hillshade", type: "hillshade", source: "mapterhorn-dem",
      layout: { visibility: "none" },
      paint: { "hillshade-shadow-color": "#000000", "hillshade-exaggeration": 0.6 },
    },
  ],
};

const BASE_LAYERS: Record<string, string[]> = {
  dark: ["carto-dark"], satellite: ["esri-sat"], hillshade: ["mapterhorn-hillshade"],
};

type Opts = { ramp: string; min: number; max: number; mode: string; base: string; reverse: boolean; oversample: number };

export function MapView({
  initialView, opts, cogUrl, cogBounds, preview, remVisible, pickMode,
  onBounds, onView, onDrawn, onMapReady, onPick,
}: {
  initialView: { lng: number; lat: number; zoom: number };
  opts: Opts;
  cogUrl: string | null;
  cogBounds: [number, number, number, number] | null;
  preview: GeoJSON.GeoJSON | null;
  remVisible: boolean;
  pickMode: boolean;
  onBounds: (b: BBox, zoom: number) => void;
  onView: (v: { lng: number; lat: number; zoom: number }) => void;
  onDrawn: (g: GeoJSON.GeoJSON) => void;
  onMapReady: (map: MlMap) => void;
  onPick: (lng: number, lat: number) => void;
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
    if (!cogUrl) return;

    const url = `cog://${cogUrl}#dem`;
    // Force TERRARIUM encoding (4 mm step): this custom renderer wins over geomatico's
    // built-in terrain encoder for the #dem path.
    setColorFunction(url, terrariumColorFunction);

    const key = `${cogUrl.replace(/\W+/g, "").slice(-10)}-${Date.now().toString(36)}`;
    const src = `rem-src-${key}`;
    const layer = `rem-layer-${key}`;
    map.addSource(src, {
      type: "raster-dem",
      url,
      tileSize: 512, // read 4× more COG pixels per tile than 256 → less blocky
      encoding: "terrarium",
      bounds: cogBounds ?? undefined,
    } as any);
    map.addLayer({
      id: layer, type: "color-relief", source: src,
      layout: { visibility: remVisible ? "visible" : "none" },
      paint: { "color-relief-color": colorReliefExpr(opts.ramp, opts.min, opts.max, opts.reverse) as any, "color-relief-opacity": 0.95 },
    } as any);
    remRef.current = { src, layer };
    if (cogBounds) map.fitBounds(cogBounds, { padding: 40, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cogUrl, ready]);

  // Live recolour — just update the paint expression (GPU, instant).
  useEffect(() => {
    const map = mapRef.current?.getMap();
    const id = remRef.current?.layer;
    if (!map || !ready || !id || !map.getLayer(id)) return;
    map.setPaintProperty(id, "color-relief-color", colorReliefExpr(opts.ramp, opts.min, opts.max, opts.reverse) as any);
  }, [opts.ramp, opts.reverse, opts.min, opts.max, ready]);

  // Layer show/hide (eye toggle).
  useEffect(() => {
    const map = mapRef.current?.getMap();
    const id = remRef.current?.layer;
    if (!map || !ready || !id || !map.getLayer(id)) return;
    map.setLayoutProperty(id, "visibility", remVisible ? "visible" : "none");
  }, [remVisible, ready, cogUrl]);

  // Basemap switching.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    for (const [base, ids] of Object.entries(BASE_LAYERS))
      for (const id of ids)
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", base === opts.base ? "visible" : "none");
  }, [opts.base, ready]);

  // Oversampling: render the GL canvas at (factor × device DPR), capped, to
  // supersample away blockiness on hi-res / 4K displays. This is the practical
  // lever for color-relief since MapLibre has no `raster-resampling` for it yet
  // (see maplibre-gl-js#7154). Combined with the 512px source tiles above.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const ratio = Math.min(4, Math.max(1, opts.oversample) * dpr);
    map.setPixelRatio(ratio);
  }, [opts.oversample, ready]);

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

  // Hand-drawing with terra-draw (LineString). Defensive across versions.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready || opts.mode !== "geojson") return;
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
        draw.on("finish", () => onDrawn({ type: "FeatureCollection", features: draw.getSnapshot() } as GeoJSON.GeoJSON));
      } catch (e) { console.warn("terra-draw unavailable:", e); }
    })();
    return () => { cancelled = true; try { draw?.stop?.(); } catch { /* noop */ } };
  }, [opts.mode, ready, onDrawn]);

  return (
    <Map
      ref={mapRef}
      mapLib={maplibregl as never}
      initialViewState={{ longitude: initialView.lng, latitude: initialView.lat, zoom: initialView.zoom }}
      mapStyle={STYLE}
      {...({ preserveDrawingBuffer: true } as object)}
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
      {preview && (
        <Source id="preview" type="geojson" data={preview}>
          <Layer id="preview-line" type="line" paint={{ "line-color": "#ffffff", "line-width": 2, "line-dasharray": [2, 1] }} />
        </Source>
      )}
    </Map>
  );
}
