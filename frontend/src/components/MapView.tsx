import { useCallback, useEffect, useRef, useState } from "react";
import Map, { Source, Layer, type MapRef } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import type { StyleSpecification, Map as MlMap } from "maplibre-gl";
import { cogProtocol } from "@geomatico/maplibre-cog-protocol";
import { colorReliefExpr } from "@/lib/colormap";
import type { BBox, ComputeResponse } from "@/lib/api";

// Register the geomatico COG protocol once. The `cog://…#dem` path decodes the
// float COG (using the COG's own scale/offset/noData) into terrarium-encoded
// raster-dem tiles, which a native MapLibre `color-relief` layer tints on the GPU.
let registered = false;
function ensureProtocol() {
  if (registered) return;
  try { maplibregl.addProtocol("cog", cogProtocol as never); } catch { /* already */ }
  registered = true;
}

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

const REM_SOURCE = "rem-dem";
const REM_LAYER = "rem-color";

type Opts = { ramp: string; min: number; max: number; mode: string; base: string; reverse: boolean; oversample: number };

export function MapView({
  initialView, opts, result, preview, remVisible, pickMode,
  onBounds, onView, onDrawn, onMapReady, onPick,
}: {
  initialView: { lng: number; lat: number; zoom: number };
  opts: Opts;
  result: ComputeResponse | null;
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
  const [ready, setReady] = useState(false);

  const emitBounds = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const b = map.getBounds();
    onBounds({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }, Math.round(map.getZoom()));
    onView({ lng: map.getCenter().lng, lat: map.getCenter().lat, zoom: map.getZoom() });
  }, [onBounds, onView]);

  // Add / replace the REM color-relief layer when a new COG is computed.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    if (map.getLayer(REM_LAYER)) map.removeLayer(REM_LAYER);
    if (map.getSource(REM_SOURCE)) map.removeSource(REM_SOURCE);
    if (!result) return;

    map.addSource(REM_SOURCE, {
      type: "raster-dem",
      url: `cog://${result.cog_url}#dem`,
      tileSize: 512, // read 4× more COG pixels per tile than 256 → less blocky
      encoding: "terrarium",
      bounds: result.bounds,
    } as any);
    map.addLayer({
      id: REM_LAYER, type: "color-relief", source: REM_SOURCE,
      layout: { visibility: remVisible ? "visible" : "none" },
      paint: { "color-relief-color": colorReliefExpr(opts.ramp, opts.min, opts.max, opts.reverse) as any, "color-relief-opacity": 0.95 },
    } as any);
    map.fitBounds(result.bounds, { padding: 40, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, ready]);

  // Live recolour — just update the paint expression (GPU, instant).
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready || !map.getLayer(REM_LAYER)) return;
    map.setPaintProperty(REM_LAYER, "color-relief-color", colorReliefExpr(opts.ramp, opts.min, opts.max, opts.reverse) as any);
  }, [opts.ramp, opts.reverse, opts.min, opts.max, ready]);

  // Layer show/hide (eye toggle).
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready || !map.getLayer(REM_LAYER)) return;
    map.setLayoutProperty(REM_LAYER, "visibility", remVisible ? "visible" : "none");
  }, [remVisible, ready, result]);

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
