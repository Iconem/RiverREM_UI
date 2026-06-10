import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as MlMap } from "maplibre-gl";
import { MapView } from "@/components/MapView";
import { SidePanel } from "@/components/SidePanel";
import { useMapView, useRemOptions, useActiveRem } from "@/lib/state";
import { api, cogPath, geocode, reverseGeocode, type BBox, type ComputeResponse, type GeoHit } from "@/lib/api";
import { fetchLongestRiver, mergeFeatureCollection } from "@/lib/osm";
import { listRuns, addRun, removeRun, updateRun, pruneRuns, type Run } from "@/lib/history";

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
    Queued: 5, "Fetching terrain tiles": 5, "Resolving centerline": 10,
    "Running RiverREM": 15, "Finding centerline": 20, "Sampling river elevation": 25,
    "Detrending DEM": 90, "Building COG": 95, Done: 100,
  };
  if (phase === "Interpolating river surface") return Math.round(30 + (pct || 0) * 0.60);
  return m[phase] ?? 10;
}

// When the requested zoom exceeds Mapterhorn's deepest zoom here, the multiplier is
// capped (we never upsample past the source). Tell the user the ceiling.
function resolutionNote(res: ComputeResponse, screenZoom: number, reqMult: number): string | null {
  const smz = res.source_max_zoom, rz = res.requested_zoom, dz = res.dem_zoom;
  if (smz == null || rz == null || rz <= smz) return null;
  const headroom = Math.max(0, smz - Math.round(screenZoom));
  const maxMult = headroom >= 2 ? 4 : headroom >= 1 ? 2 : 1;
  return `Mapterhorn's deepest zoom here is z${smz}, so ${reqMult}× was capped to ${maxMult}× (fetched z${dz}). Zoom the map out to oversample further.`;
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
  const layer = opts.layer; // streamed layer (rem/dem) lives in the URL
  type Bounds = { min: number; max: number; log: boolean };
  const [remBounds, setRemBounds] = useState<Bounds | null>(null);
  const [demBounds, setDemBounds] = useState<Bounds | null>(null);
  const [fitSignal, setFitSignal] = useState(0); // bumps only on run load / compute complete
  const [resNote, setResNote] = useState<string | null>(null); // resolution-cap note from last build

  const bboxRef = useRef<{ bbox: BBox; zoom: number } | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const onBounds = useCallback((bbox: BBox, zoom: number) => { bboxRef.current = { bbox, zoom }; }, []);
  const onMapReady = useCallback((m: MlMap) => { mapRef.current = m; }, []);

  // Grab a small JPEG of the current map for the runs gallery. Waits for the COG
  // to finish rendering (map "idle") before drawing the canvas down to 360px wide.
  const drawThumb = useCallback((runId: string) => {
    const map = mapRef.current;
    if (!map) return;
    try {
      const src = map.getCanvas();
      const w = 360, h = Math.max(1, Math.round((w * src.height) / src.width));
      const off = document.createElement("canvas");
      off.width = w; off.height = h;
      const ctx = off.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(src, 0, 0, w, h);
      setRuns(updateRun(runId, { thumb: off.toDataURL("image/jpeg", 0.55) }));
    } catch { /* ignore (e.g. tainted canvas) */ }
  }, []);

  const captureThumb = useCallback((runId: string) => {
    const map = mapRef.current;
    if (!map) return;
    setTimeout(() => { map.once("idle", () => drawThumb(runId)); map.triggerRepaint(); }, 600);
  }, [drawThumb]);

  // Manual override: snapshot the current view immediately (user picked the frame).
  const onRecaptureThumb = useCallback((runId: string) => drawThumb(runId), [drawThumb]);

  // Load saved runs + rehydrate a shared COG from the URL (once).
  useEffect(() => {
    const local = listRuns();
    setRuns(local);
    // Drop runs whose backend COG no longer exists (e.g. after a docker rebuild).
    const paths = local.map((r) => cogPath(r.cog)).filter((x): x is string => !!x);
    if (paths.length) {
      api.prune(paths)
        .then(({ existing }) => {
          const keep = new Set(existing);
          setRuns(pruneRuns((r) => { const pth = cogPath(r.cog); return !pth || keep.has(pth); }));
        })
        .catch(() => { /* offline: keep local runs as-is */ });
    }
    if (activeRem.cog) {
      const b = activeRem.bounds.length === 4 ? (activeRem.bounds as [number, number, number, number]) : null;
      const bounds = b ?? [view.lng - 0.1, view.lat - 0.1, view.lng + 0.1, view.lat + 0.1] as [number, number, number, number];
      const isDem = opts.layer === "dem";
      // The shared URL carries the active layer's symbology in nuqs (min/max/log).
      const cur: { min: number; max: number; log: boolean } = { min: opts.min, max: opts.max, log: opts.log };
      const existing = local.find((r) => r.cog === activeRem.cog);
      const remB = isDem
        ? (existing && existing.min != null ? { min: existing.min, max: existing.max, log: existing.log ?? true } : null)
        : cur;
      const demB = isDem
        ? cur
        : (existing && existing.demMin != null && existing.demMax != null ? { min: existing.demMin, max: existing.demMax, log: existing.demLog ?? false } : null);
      setRemBounds(remB); setDemBounds(demB);
      setResult({
        job_id: existing?.id ?? "shared", cog_url: activeRem.cog, dem_url: activeRem.dem || null,
        bounds, rem_min: remB?.min ?? opts.min, rem_max: remB?.max ?? opts.max,
        dem_min: demB?.min ?? null, dem_max: demB?.max ?? null,
        river_name: existing?.name ?? null, river_length_m: null, centerline_url: existing?.cl ?? null,
      });
      // Surface the shared view under "Runs" (dedups by COG; keeps an existing name).
      const id = existing?.id ?? cogPath(activeRem.cog)?.split("/")[0] ?? crypto.randomUUID();
      setActiveRunId(id);
      setRuns(addRun({
        id, cog: activeRem.cog, dem: activeRem.dem || null, bounds,
        min: remB?.min ?? opts.min, max: remB?.max ?? opts.max, log: remB?.log ?? opts.log,
        demMin: demB?.min ?? null, demMax: demB?.max ?? null, demLog: demB?.log ?? null,
        ramp: opts.ramp, reverse: opts.reverse, name: existing?.name ?? null,
        cl: existing?.cl ?? null, ts: existing?.ts ?? Date.now(),
      }));
      // A shared link may point at a run whose centerline is hosted alongside the COG.
      const pth = cogPath(activeRem.cog);
      if (pth) {
        const clUrl = activeRem.cog.replace(/[^/]+$/, "centerline.geojson");
        api.centerline(clUrl).then((g) => g && setCenterline(g));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live symbology sync: editing ramp/min/max/log updates the active run. Edits to
  // the DEM view write the DEM fields; REM edits write the REM fields — so the two
  // ranges never overwrite each other.
  useEffect(() => {
    if (!activeRunId) return;
    const patch = layer === "dem"
      ? { ramp: opts.ramp, reverse: opts.reverse, demMin: opts.min, demMax: opts.max, demLog: opts.log }
      : { ramp: opts.ramp, reverse: opts.reverse, min: opts.min, max: opts.max, log: opts.log };
    setRuns(updateRun(activeRunId, patch));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.ramp, opts.reverse, opts.min, opts.max, opts.log, layer, activeRunId]);

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

  const recordRun = useCallback(async (res: ComputeResponse, remB: Bounds, demB: Bounds | null) => {
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
      min: remB.min, max: remB.max, log: remB.log,
      demMin: demB?.min ?? null, demMax: demB?.max ?? null, demLog: demB?.log ?? null,
      ramp: opts.ramp, reverse: opts.reverse, name,
      cl: res.centerline_url ?? null, ts: Date.now(),
    }));
    return id;
  }, [opts.ramp, opts.reverse, setActiveRem]);

  const onCompute = useCallback(async () => {
    if (!bboxRef.current) return;
    setBusy(true); setRemVisible(true); setResNote(null); setPhase("Finding river"); setPct(8);
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
      const remB: Bounds = { min: -1, max: Math.max(1, +(res.rem_max * 0.1).toFixed(2)), log: true };
      const demB: Bounds | null = res.dem_min != null && res.dem_max != null
        ? { min: Math.floor(res.dem_min), max: Math.ceil(res.dem_max), log: false } : null;
      setRemBounds(remB); setDemBounds(demB);
      setResult(res); setOpts({ min: remB.min, max: remB.max, log: remB.log, layer: "rem" });
      if (!cl && res.centerline_url) { const g = await api.centerline(res.centerline_url); if (g) setCenterline(g); }
      setResNote(resolutionNote(res, bboxRef.current.zoom, opts.res));
      const id = await recordRun(res, remB, demB);
      setFitSignal((n) => n + 1);
      captureThumb(id);
    } catch (e) { alert(`Compute failed: ${(e as Error).message}`); }
    finally { setBusy(false); setPhase(""); setPct(0); }
  }, [opts.res, opts.mode, opts.osm, centerline, uploadId, setOpts, recordRun, captureThumb]);

  const onLoadCog = useCallback(async (url: string) => {
    setBusy(true); setRemVisible(true); setPhase("Reprojecting COG"); setPct(40);
    try {
      const r = await api.ingestCog(url);
      const res: ComputeResponse = {
        job_id: "external", cog_url: r.cog_url, dem_url: null, bounds: r.bounds,
        rem_min: r.rem_min, rem_max: r.rem_max, river_name: null, river_length_m: null,
      };
      const remB: Bounds = { min: -1, max: Math.ceil(r.rem_max), log: true };
      setRemBounds(remB); setDemBounds(null); setCenterline(null);
      setResult(res); setOpts({ min: remB.min, max: remB.max, log: remB.log, layer: "rem" });
      const id = await recordRun(res, remB, null);
      setFitSignal((n) => n + 1);
      captureThumb(id);
    } catch (e) { alert(`Could not load COG: ${(e as Error).message}`); }
    finally { setBusy(false); setPhase(""); setPct(0); }
  }, [setOpts, recordRun, captureThumb]);

  const onLoadRun = useCallback((r: Run) => {
    const remB: Bounds = { min: r.min, max: r.max, log: r.log ?? true };
    const demB: Bounds | null = r.demMin != null && r.demMax != null
      ? { min: r.demMin, max: r.demMax, log: r.demLog ?? false } : null;
    setResult({ job_id: r.id, cog_url: r.cog, dem_url: r.dem, bounds: r.bounds, rem_min: r.min, rem_max: r.max, dem_min: demB?.min ?? null, dem_max: demB?.max ?? null, river_name: r.name ?? null, river_length_m: null, centerline_url: r.cl ?? null });
    setActiveRem({ cog: r.cog, dem: r.dem || "", bounds: r.bounds });
    setActiveRunId(r.id); setRemVisible(true);
    setRemBounds(remB); setDemBounds(demB);
    setOpts({ ramp: r.ramp as any, reverse: !!r.reverse, min: remB.min, max: remB.max, log: remB.log, layer: "rem" });
    if (r.cl) api.centerline(r.cl).then(setCenterline); else setCenterline(null);
    setResNote(null);
    setFitSignal((n) => n + 1);
    if (!r.thumb) captureThumb(r.id);
  }, [setActiveRem, setOpts, captureThumb]);

  // Switch streamed layer (REM vs DEM) and apply that layer's stored bounds (incl. log).
  const onSetLayer = useCallback((l: "rem" | "dem") => {
    const b = l === "dem" ? demBounds : remBounds;
    setOpts(b ? { layer: l, min: b.min, max: b.max, log: b.log } : { layer: l });
  }, [demBounds, remBounds, setOpts]);

  // Persist slider/min/max/log edits into the active layer's bounds.
  useEffect(() => {
    if (!result) return;
    const b: Bounds = { min: opts.min, max: opts.max, log: opts.log };
    if (layer === "dem") setDemBounds(b); else setRemBounds(b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.min, opts.max, opts.log]);

  const onDeleteRun = useCallback((id: string) => { setRuns(removeRun(id)); if (id === activeRunId) setActiveRunId(null); }, [activeRunId]);
  const onRenameRun = useCallback((id: string, name: string) => setRuns(updateRun(id, { name })), []);

  const onShare = useCallback(async () => {
    try { await navigator.clipboard.writeText(window.location.href); } catch { /* ignore */ }
  }, []);

  const onExportComposite = useCallback(() => {
    const c = mapRef.current?.getCanvas();
    if (!c) return;
    c.toBlob((b) => b && download(b, `rem_${result?.job_id ?? "view"}.jpg`), "image/jpeg", 0.92);
  }, [result]);

  const onCopyImage = useCallback(() => {
    const c = mapRef.current?.getCanvas();
    if (!c) return;
    c.toBlob(async (b) => {
      try { if (b) await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]); } catch { /* ignore */ }
    }, "image/png");
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
    mapRef.current?.flyTo({ center: [lng, lat], zoom: Math.max(mapRef.current.getZoom(), 12), duration: 500 });
  }, []);

  return (
    <div className="relative h-full w-full">
      <MapView
        initialView={{ lng: view.lng, lat: view.lat, zoom: view.zoom }}
        opts={opts}
        cogUrl={result ? (layer === "dem" ? result.dem_url || result.cog_url : result.cog_url) : null}
        cogBounds={result?.bounds ?? null}
        fitSignal={fitSignal}
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
          resNote={resNote}
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
          onRecaptureThumb={onRecaptureThumb}
          onToggleLayer={() => setRemVisible((v) => !v)}
          onTogglePick={() => setPickMode((v) => !v)}
          onGeocode={onGeocode}
          onFlyTo={onFlyTo}
        />
      </div>
    </div>
  );
}
