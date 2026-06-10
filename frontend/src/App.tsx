import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as MlMap } from "maplibre-gl";
import { MapView } from "@/components/MapView";
import { SidePanel } from "@/components/SidePanel";
import { useMapView, useRemOptions, useActiveRem } from "@/lib/state";
import { api, cogPath, geocode, reverseGeocode, type BBox, type ComputeResponse, type GeoHit } from "@/lib/api";
import { fetchLongestRiver, mergeFeatureCollection } from "@/lib/osm";
import { listRuns, addRun, removeRun, updateRun, type Run } from "@/lib/history";

function download(blob: Blob, name: string) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 2000);
}
function downloadUrl(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url; a.download = name; a.target = "_blank"; a.rel = "noreferrer"; a.click();
}

// Map backend phase + RiverREM % to a smooth 0–100 (fake ~20%/step, real % in interp).
function displayPct(phase: string, pct: number): number {
  const m: Record<string, number> = {
    Queued: 5, "Fetching terrain tiles": 15, "Resolving centerline": 30,
    "Running RiverREM": 40, "Finding centerline": 42, "Sampling river elevation": 50,
    "Detrending DEM": 92, "Building COG": 96, Done: 100,
  };
  if (phase === "Interpolating water surface") return Math.round(55 + (pct || 0) * 0.35);
  return m[phase] ?? 10;
}

export default function App() {
  const [view, setView] = useMapView();
  const [opts, setOpts] = useRemOptions();
  const [activeRem, setActiveRem] = useActiveRem();

  const [result, setResult] = useState<ComputeResponse | null>(null);
  const [centerline, setCenterline] = useState<GeoJSON.GeoJSON | null>(null);
  const [centerInfo, setCenterInfo] = useState<{ river_name: string; river_length_m: number } | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [pct, setPct] = useState(0);
  const [runs, setRuns] = useState<Run[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [remVisible, setRemVisible] = useState(true);
  const [pickMode, setPickMode] = useState(false);
  const [pick, setPick] = useState<{ lng: number; lat: number; rem: number | null; dem: number | null } | null>(null);
  const [layer, setLayer] = useState<"rem" | "dem">("rem");
  const [remBounds, setRemBounds] = useState<{ min: number; max: number } | null>(null);
  const [demBounds, setDemBounds] = useState<{ min: number; max: number } | null>(null);

  const bboxRef = useRef<{ bbox: BBox; zoom: number } | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const onBounds = useCallback((bbox: BBox, zoom: number) => { bboxRef.current = { bbox, zoom }; }, []);
  const onMapReady = useCallback((m: MlMap) => { mapRef.current = m; }, []);

  // Load saved runs + rehydrate a shared COG from the URL (once).
  useEffect(() => {
    setRuns(listRuns());
    if (activeRem.cog) {
      const b = activeRem.bounds.length === 4 ? (activeRem.bounds as [number, number, number, number]) : null;
      setResult({
        job_id: "shared", cog_url: activeRem.cog, dem_url: activeRem.dem || null,
        bounds: b ?? [view.lng - 0.1, view.lat - 0.1, view.lng + 0.1, view.lat + 0.1],
        rem_min: opts.min, rem_max: opts.max, river_name: null, river_length_m: null,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live symbology sync: editing ramp/min/max/reverse updates the active run.
  useEffect(() => {
    if (!activeRunId) return;
    setRuns(updateRun(activeRunId, { ramp: opts.ramp, reverse: opts.reverse, min: opts.min, max: opts.max }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.ramp, opts.reverse, opts.min, opts.max, activeRunId]);

  const onPreview = useCallback(async () => {
    if (!bboxRef.current) return;
    setBusy(true);
    try {
      const r = await fetchLongestRiver(bboxRef.current.bbox, opts.osm);
      setCenterline(r.geojson);
      setCenterInfo({ river_name: r.name, river_length_m: r.length_m });
    } catch (e) { alert(`No river found: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }, [opts.osm]);

  const onDrawn = useCallback((g: GeoJSON.GeoJSON) => { setCenterline(mergeFeatureCollection(g)); setCenterInfo(null); }, []);

  const onImport = useCallback(async (f: File) => {
    setBusy(true);
    try {
      if (/\.(geojson|json)$/i.test(f.name)) {
        setCenterline(mergeFeatureCollection(JSON.parse(await f.text())));
        setUploadId(null); setCenterInfo(null);
      } else { const r = await api.upload(f); setUploadId(r.upload_id); setCenterline(null); }
    } catch (e) { alert(`Import failed: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }, []);

  const recordRun = useCallback(async (res: ComputeResponse, mn: number, mx: number) => {
    setActiveRem({ cog: res.cog_url, dem: res.dem_url || "", bounds: res.bounds });
    const id = res.job_id && res.job_id !== "external" ? res.job_id : crypto.randomUUID();
    let name = res.river_name;
    if (!name) {
      const c = bboxRef.current?.bbox;
      if (c) name = await reverseGeocode((c.west + c.east) / 2, (c.south + c.north) / 2);
    }
    setActiveRunId(id);
    setRuns(addRun({
      id, cog: res.cog_url, dem: res.dem_url, bounds: res.bounds,
      min: mn, max: mx, ramp: opts.ramp, reverse: opts.reverse, name, ts: Date.now(),
    }));
  }, [opts.ramp, opts.reverse, setActiveRem]);

  const onCompute = useCallback(async () => {
    if (!bboxRef.current) return;
    setBusy(true); setRemVisible(true); setPhase("Finding river"); setPct(8);
    try {
      let cl = centerline;
      if (opts.mode !== "shapefile" && !cl) {
        const r = await fetchLongestRiver(bboxRef.current.bbox, opts.osm);
        cl = r.geojson; setCenterline(r.geojson);
        setCenterInfo({ river_name: r.name, river_length_m: r.length_m });
      }
      const usingShp = opts.mode === "shapefile" && uploadId;
      const res = await api.compute(
        {
          bbox: bboxRef.current.bbox, zoom: bboxRef.current.zoom,
          resolution_multiplier: opts.res as 1 | 2 | 4,
          centerline_mode: usingShp ? "shapefile" : "geojson",
          centerline_geojson: usingShp ? null : cl, upload_id: usingShp ? uploadId : null,
        },
        (ph, p) => { setPhase(ph); setPct(displayPct(ph, p)); }
      );
      const remB = { min: Math.floor(res.rem_min), max: Math.max(1, +(res.rem_max * 0.1).toFixed(2)) };
      const demB = res.dem_min != null && res.dem_max != null
        ? { min: Math.floor(res.dem_min), max: Math.ceil(res.dem_max) } : null;
      setRemBounds(remB); setDemBounds(demB); setLayer("rem");
      setResult(res); setOpts({ min: remB.min, max: remB.max });
      await recordRun(res, remB.min, remB.max);
    } catch (e) { alert(`Compute failed: ${(e as Error).message}`); }
    finally { setBusy(false); setPhase(""); setPct(0); }
  }, [opts.res, opts.mode, opts.osm, centerline, uploadId, setOpts, recordRun]);

  const onLoadCog = useCallback(async (url: string) => {
    setBusy(true); setRemVisible(true); setPhase("Reprojecting COG"); setPct(40);
    try {
      const r = await api.ingestCog(url);
      const res: ComputeResponse = {
        job_id: "external", cog_url: r.cog_url, dem_url: null, bounds: r.bounds,
        rem_min: r.rem_min, rem_max: r.rem_max, river_name: null, river_length_m: null,
      };
      const remB = { min: Math.floor(r.rem_min), max: Math.ceil(r.rem_max) };
      setRemBounds(remB); setDemBounds(null); setLayer("rem");
      setResult(res); setOpts({ min: remB.min, max: remB.max });
      await recordRun(res, remB.min, remB.max);
    } catch (e) { alert(`Could not load COG: ${(e as Error).message}`); }
    finally { setBusy(false); setPhase(""); setPct(0); }
  }, [setOpts, recordRun]);

  const onLoadRun = useCallback((r: Run) => {
    setResult({ job_id: r.id, cog_url: r.cog, dem_url: r.dem, bounds: r.bounds, rem_min: r.min, rem_max: r.max, river_name: r.name ?? null, river_length_m: null });
    setActiveRem({ cog: r.cog, dem: r.dem || "", bounds: r.bounds });
    setActiveRunId(r.id); setRemVisible(true);
    setLayer("rem"); setRemBounds({ min: r.min, max: r.max }); setDemBounds(null);
    setOpts({ ramp: r.ramp as any, reverse: !!r.reverse, min: r.min, max: r.max });
  }, [setActiveRem, setOpts]);

  // Switch streamed layer (REM vs DEM) and apply that layer's stored bounds.
  const onSetLayer = useCallback((l: "rem" | "dem") => {
    setLayer(l);
    const b = l === "dem" ? demBounds : remBounds;
    if (b) setOpts({ min: b.min, max: b.max });
  }, [demBounds, remBounds, setOpts]);

  // Persist slider/min/max edits into the active layer's bounds.
  useEffect(() => {
    if (!result) return;
    if (layer === "dem") setDemBounds({ min: opts.min, max: opts.max });
    else setRemBounds({ min: opts.min, max: opts.max });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.min, opts.max]);

  const onDeleteRun = useCallback((id: string) => { setRuns(removeRun(id)); if (id === activeRunId) setActiveRunId(null); }, [activeRunId]);
  const onRenameRun = useCallback((id: string, name: string) => setRuns(updateRun(id, { name })), []);

  const onShare = useCallback(async () => {
    try { await navigator.clipboard.writeText(window.location.href); } catch { /* ignore */ }
  }, []);

  // Capture the map canvas in-frame. react-map-gl v8 doesn't forward
  // preserveDrawingBuffer, so reading the canvas later yields black; instead we read
  // it synchronously inside a fresh render frame.
  const captureCanvas = (type: string, quality?: number): Promise<Blob | null> => {
    const map = mapRef.current;
    if (!map) return Promise.resolve(null);
    return new Promise((resolve) => {
      map.once("render", () => {
        try {
          const url = map.getCanvas().toDataURL(type, quality);
          const [meta, b64] = url.split(",");
          const mime = /:(.*?);/.exec(meta)?.[1] ?? type;
          const bin = atob(b64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type: mime }));
        } catch { resolve(null); }
      });
      map.triggerRepaint();
    });
  };

  const onExportComposite = useCallback(async () => {
    const b = await captureCanvas("image/jpeg", 0.92);
    if (b) download(b, `rem_${result?.job_id ?? "view"}.jpg`);
  }, [result]);

  const onCopyImage = useCallback(async () => {
    const b = await captureCanvas("image/png");
    try { if (b) await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]); } catch { /* ignore */ }
  }, []);

  const onExportRaw = useCallback(() => result && downloadUrl(result.cog_url, `rem_${result.job_id}.tif`), [result]);
  const onExportDem = useCallback(() => result?.dem_url && downloadUrl(result.dem_url, `dem_${result.job_id}.tif`), [result]);
  const onExportCenterline = useCallback(() => {
    if (!centerline) return;
    download(new Blob([JSON.stringify(centerline, null, 2)], { type: "application/geo+json" }), "centerline.geojson");
  }, [centerline]);

  const onPick = useCallback(async (lng: number, lat: number) => {
    if (!result) return;
    const remP = cogPath(result.cog_url);
    const demP = result.dem_url ? cogPath(result.dem_url) : null;
    const [rem, dem] = await Promise.all([
      remP ? api.sample(remP, lng, lat).then((r) => r.value).catch(() => null) : Promise.resolve(null),
      demP ? api.sample(demP, lng, lat).then((r) => r.value).catch(() => null) : Promise.resolve(null),
    ]);
    setPick({ lng, lat, rem, dem });
  }, [result]);

  const [geoHits, setGeoHits] = useState<GeoHit[]>([]);
  const geoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const geoAbort = useRef<AbortController | null>(null);
  const onGeocode = useCallback((q: string) => {
    if (geoTimer.current) clearTimeout(geoTimer.current);
    if (!q.trim()) { setGeoHits([]); return; }
    // Debounce keystrokes and abort the previous in-flight request so the latest
    // query resolves first and stale slow responses can't overwrite it.
    geoTimer.current = setTimeout(async () => {
      geoAbort.current?.abort();
      geoAbort.current = new AbortController();
      try { setGeoHits(await geocode(q, geoAbort.current.signal)); } catch { /* aborted */ }
    }, 120);
  }, []);
  const onFlyTo = useCallback((lng: number, lat: number) => {
    setGeoHits([]);
    mapRef.current?.flyTo({ center: [lng, lat], zoom: Math.max(mapRef.current.getZoom(), 12) });
  }, []);

  return (
    <div className="relative h-full w-full">
      <MapView
        initialView={{ lng: view.lng, lat: view.lat, zoom: view.zoom }}
        opts={opts}
        cogUrl={result ? (layer === "dem" ? result.dem_url || result.cog_url : result.cog_url) : null}
        cogBounds={result?.bounds ?? null}
        preview={centerline}
        remVisible={remVisible}
        pickMode={pickMode}
        onBounds={onBounds}
        onView={setView}
        onDrawn={onDrawn}
        onMapReady={onMapReady}
        onPick={onPick}
      />
      <div className="pointer-events-none absolute inset-0">
        <SidePanel
          opts={opts}
          setOpts={setOpts}
          busy={busy}
          phase={phase}
          pct={pct}
          result={result}
          layer={layer}
          hasDem={!!result?.dem_url}
          onSetLayer={onSetLayer}
          hasCenterline={!!centerline}
          previewInfo={centerInfo}
          runs={runs}
          activeRunId={activeRunId}
          remVisible={remVisible}
          pickMode={pickMode}
          pick={pick}
          geoHits={geoHits}
          onPreview={onPreview}
          onCompute={onCompute}
          onUpload={onImport}
          onLoadCog={onLoadCog}
          onShare={onShare}
          onExportComposite={onExportComposite}
          onCopyImage={onCopyImage}
          onExportRaw={onExportRaw}
          onExportDem={onExportDem}
          onExportCenterline={onExportCenterline}
          onLoadRun={onLoadRun}
          onDeleteRun={onDeleteRun}
          onRenameRun={onRenameRun}
          onToggleLayer={() => setRemVisible((v) => !v)}
          onTogglePick={() => setPickMode((v) => !v)}
          onGeocode={onGeocode}
          onFlyTo={onFlyTo}
        />
      </div>
    </div>
  );
}
