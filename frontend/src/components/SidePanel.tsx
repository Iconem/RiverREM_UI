import { useEffect, useRef, useState } from "react";
import {
  Upload, Pencil, Waves, Play, Loader2, Download, Share2, Layers, Trash2, FileDown,
  Eye, EyeOff, Check, X, Search, MapPin, Copy, ChevronUp, ChevronDown, ChevronRight, ChevronLeft, Crosshair, ExternalLink,
  List, LayoutGrid, ImageOff, Camera, Save, Sun, Moon, Maximize2, RefreshCw,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { rampCss } from "@/lib/colormap";
import { RAMP_NAMES, useUiState } from "@/lib/state";
import { OVERPASS_PRESETS } from "@/lib/osm";
import type { Run } from "@/lib/history";
import type { ComputeResponse, GeoHit } from "@/lib/api";

type Opts = {
  mode: "osm" | "geojson" | "shapefile";
  engine: "server" | "client"; power: number; samples: number;
  base: "dark" | "light" | "satellite" | "hillshade" | "none";
  ramp: (typeof RAMP_NAMES)[number];
  reverse: boolean; transparent: "none" | "white" | "black"; min: number; max: number; log: boolean; res: number; oversample: number; hillshade: "off" | "dark" | "light"; sliderLo: number | null; sliderHi: number | null; osm: string;
  qleverMode: "longest" | "all" | "waterways";
  showContours: boolean;
  showContourLabels: boolean;
  showRiver: boolean;
  showSamples: boolean;
  showViewport: boolean;
};

function Swatch({ ramp, reverse = false, className = "h-3 w-8" }: { ramp: string; reverse?: boolean; className?: string }) {
  return <span className={`inline-block shrink-0 rounded-sm ${className}`} style={{ background: rampCss(ramp, reverse) }} />;
}

function FoldHeader({ label, folded, onClick }: { label: string; folded: boolean; onClick: () => void }) {
  return (
    <button className="flex w-full items-center justify-between" onClick={onClick}>
      <Label className="cursor-pointer">{label}</Label>
      {folded ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
    </button>
  );
}

function Progress({ active, label, pct }: { active: boolean; label: string; pct: number }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!active) { setSecs(0); return; }
    const t0 = Date.now();
    const iv = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 250);
    return () => clearInterval(iv);
  }, [active]);
  if (!active) return null;
  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-foreground transition-all duration-300" style={{ width: `${Math.max(3, pct)}%` }} />
      </div>
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{label || "Working…"} · {pct}%</span>
        <span>{secs}s</span>
      </div>
    </div>
  );
}

export function SidePanel(p: {
  opts: Opts; setOpts: (o: Partial<Opts>) => void;
  busy: boolean; phase: string; pct: number;
  resNote: string | null;
  result: ComputeResponse | null; hasCenterline: boolean;
  layer: "rem" | "dem"; hasDem: boolean; onSetLayer: (l: "rem" | "dem") => void;
  previewInfo: { river_name: string; river_length_m: number } | null;
  runs: Run[]; serverRuns: Run[]; activeRunId: string | null; remVisible: boolean; pickMode: boolean;
  pick: { lng: number; lat: number; rem: number | null; dem: number | null } | null;
  geoHits: GeoHit[];
  onPreview: () => void; onCompute: () => void; onUpload: (f: File) => void; onLoadCog: (url: string) => void;
  demCogUrl: string; setDemCogUrl: (v: string) => void;
  onShare: () => void; onExportComposite: () => void; onCopyImage: () => void;
  onExportRaw: () => void; onExportDem: () => void; onExportCenterline: () => void;
  onLoadRun: (r: Run) => void; onDeleteRun: (id: string) => void; onRenameRun: (id: string, name: string) => void;
  onRecaptureThumb: (id: string) => void;
  onSaveSymbology: () => void; onOpenGallery: () => void;
  onToggleLayer: () => void; onTogglePick: () => void;
  onGeocode: (q: string) => void; onFlyTo: (lng: number, lat: number) => void; onCropToViewport?: () => void; onFitBounds?: () => void;
  serverSynced: boolean;
  syncFlash: boolean;
  onSyncServer: () => void;
}) {
  const { opts, setOpts, busy, result } = p;
  const [ui, setUi] = useUiState();
  const fileRef = useRef<HTMLInputElement>(null);
  const [cogUrl, setCogUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [geoQ, setGeoQ] = useState("");

  // Min/Max use local text state so partial input like "-" or "-12." is typable;
  // committed (parsed + clamped) on blur / Enter.
  const [minStr, setMinStr] = useState("");
  const [maxStr, setMaxStr] = useState("");
  useEffect(() => { setMinStr(String(opts.min)); }, [opts.min]);
  useEffect(() => { setMaxStr(String(opts.max)); }, [opts.max]);

  // Samples input: same blur/Enter pattern to avoid clamping partial keystrokes.
  const [samplesStr, setSamplesStr] = useState(String(opts.samples));
  const [imgCopyMsg, setImgCopyMsg] = useState<"" | "Copying…" | "Copied!">("");
  useEffect(() => { setSamplesStr(String(opts.samples)); }, [opts.samples]);

  // Remember last non-off basemap + hillshade for chip toggle.
  const prevBaseRef = useRef<string>("dark");
  const prevHillshadeRef = useRef<string>("dark");

  const isDem = p.layer === "dem";
  const REM_FLOOR = -1;
  const dataMin = result ? Math.floor(isDem ? result.dem_min ?? result.rem_min : result.rem_min) : 0;
  const dataMax = result ? Math.ceil(isDem ? result.dem_max ?? result.rem_max : result.rem_max) : 10;
  const autoLo = isDem ? Math.min(dataMin, opts.min) : Math.min(REM_FLOOR, opts.min);
  const autoHi = Math.max(dataMax, opts.max, Math.ceil((dataMax - Math.min(0, dataMin)) * 2), 1);
  const linLo = opts.sliderLo != null ? Math.min(opts.sliderLo, opts.min) : autoLo;
  const linHi = opts.sliderHi != null ? Math.max(opts.sliderHi, opts.max) : autoHi;
  const logOff = 1 - linLo;
  const toS = (v: number) => (opts.log ? Math.log10(v + logOff) : v);
  const fromS = (x: number) => (opts.log ? +(10 ** x - logOff).toFixed(2) : +x.toFixed(2));
  const sMin = opts.log ? toS(linLo) : linLo;
  const sMax = opts.log ? toS(linHi) : linHi;

  const share = () => { p.onShare(); setCopied(true); setTimeout(() => setCopied(false), 3000); };
  const flipLayer = () => p.onSetLayer(p.layer === "rem" ? "dem" : "rem");

  const cardBase =
    `pointer-events-auto absolute left-4 top-4 z-50 w-[360px] shadow-2xl backdrop-blur ${
      ui.theme === "light" ? "supports-[backdrop-filter]:bg-background/95" : "supports-[backdrop-filter]:bg-background/85"
    }`;

  const allFolded = ui.foldCl && ui.foldComp && ui.foldRamp && ui.foldLayers && ui.foldExport && ui.foldUtil && ui.foldRuns;

  if (ui.collapsed) {
    return (
      <Card
        onClick={() => setUi({ collapsed: false })}
        className={`${cardBase} flex cursor-pointer items-center justify-between px-4 py-2`}>
        <span className="font-sans text-base font-semibold tracking-tight">River REM</span>
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      </Card>
    );
  }

  return (
    <Card className={`${cardBase} panel-scroll flex max-h-[calc(100vh-2rem)] flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0`}>
      {/* Header — clicking title or whitespace collapses the sidebar */}
      <div className="flex cursor-pointer items-start justify-between" onClick={() => setUi({ collapsed: true })}>
        <div>
          <div className="font-sans text-base font-semibold tracking-tight">River REM</div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">River Relative Elevation Model</div>
        </div>
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {/* Expand/collapse all sections */}
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => {
            setUi({ foldCl: !allFolded, foldComp: !allFolded, foldRamp: !allFolded, foldLayers: !allFolded, foldExport: !allFolded, foldUtil: !allFolded, foldRuns: !allFolded });
          }}
            title={allFolded ? "Expand all sections" : "Collapse all sections"}
            aria-label={allFolded ? "expand all sections" : "collapse all sections"}>
            {allFolded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </Button>
          {/* Theme toggle */}
          <Button variant="ghost" size="icon" className="h-6 w-6"
            onClick={() => setUi({ theme: ui.theme === "light" ? "dark" : "light" })}
            title="Toggle theme" aria-label="toggle theme">
            {ui.theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          </Button>
          {/* Collapse sidebar */}
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setUi({ collapsed: true })}
            title="Collapse sidebar" aria-label="collapse sidebar">
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Geocoder */}
      <div className="relative">
        <div className="flex items-center gap-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Input className="text-xs" placeholder="Search a place…" value={geoQ}
            onChange={(e) => { setGeoQ(e.target.value); p.onGeocode(e.target.value); }} />
        </div>
        {p.geoHits.length > 0 && (
          <div className="absolute z-[60] mt-1 w-full overflow-hidden rounded-md border border-border bg-background shadow-lg">
            {p.geoHits.map((h, i) => (
              <button key={i} className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => { p.onFlyTo(h.lng, h.lat); setGeoQ(""); }}>
                <MapPin className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{h.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <Separator />

      {/* Centerline (foldable; folded by default) */}
      <div className="space-y-2">
        <FoldHeader label="Centerline" folded={ui.foldCl} onClick={() => setUi({ foldCl: !ui.foldCl })} />
        {!ui.foldCl && (<>
          <Tabs value={opts.mode} onValueChange={(v) => setOpts({ mode: v as Opts["mode"] })}>
            <TabsList>
              <TabsTrigger value="osm"><Waves className="mr-1 h-3 w-3" />OSM</TabsTrigger>
              <TabsTrigger value="geojson"><Pencil className="mr-1 h-3 w-3" />Draw</TabsTrigger>
            </TabsList>
          </Tabs>
          {opts.mode === "osm" && (
            <>
              <div className="flex items-center justify-between gap-2">
                <Label>Endpoint</Label>
                <div className="w-44">
                  <Select value={opts.osm} onValueChange={(v) => setOpts({ osm: v })}>
                    <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {OVERPASS_PRESETS.filter((o) => o.url.includes("qlever")).map((o) => (
                        <SelectItem key={o.url} value={o.url}>{o.label}</SelectItem>
                      ))}
                      <div className="my-1 border-t border-border" />
                      <div className="px-2 pb-1 pt-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">Overpass</div>
                      {OVERPASS_PRESETS.filter((o) => !o.url.includes("qlever")).map((o) => (
                        <SelectItem key={o.url} value={o.url}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {opts.osm.includes("qlever") && (
                <div className="flex items-center justify-between gap-2">
                  <Label>River mode</Label>
                  <div className="w-44">
                    <Select value={opts.qleverMode} onValueChange={(v) => setOpts({ qleverMode: v as "longest" | "all" | "waterways" })}>
                      <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="longest">Longest named river</SelectItem>
                        <SelectItem value="all">All named rivers</SelectItem>
                        <SelectItem value="waterways">All waterways (incl. unnamed)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
              <Button variant="outline" size="sm" className="w-full" onClick={p.onPreview} disabled={busy}>
                {opts.osm.includes("qlever") && opts.qleverMode === "all" ? "Preview named rivers" : opts.osm.includes("qlever") && opts.qleverMode === "waterways" ? "Preview all waterways" : "Preview longest river"}
              </Button>
            </>
          )}
          {opts.mode === "geojson" && (
            <>
              <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">Click on the map to draw a centerline. Double-click to finish, or upload a file.</p>
              <Button variant="outline" size="sm" className="w-full" onClick={() => fileRef.current?.click()}>Upload .geojson</Button>
            </>
          )}
          <input ref={fileRef} type="file" accept=".geojson,.json" className="hidden"
            onClick={(e) => { (e.target as HTMLInputElement).value = ""; }}
            onChange={(e) => e.target.files?.[0] && p.onUpload(e.target.files[0])} />
          {p.previewInfo && (
            <p className="font-mono text-[10px] text-muted-foreground">{p.previewInfo.river_name} · {(p.previewInfo.river_length_m / 1000).toFixed(1)} km</p>
          )}
          {p.onCropToViewport && p.previewInfo && (
            <Button variant="outline" size="sm" className="w-full gap-1" onClick={p.onCropToViewport}>
              <Crosshair className="h-3 w-3" />Crop centerline to viewport
            </Button>
          )}
        </>)}
      </div>

      <Separator />

      {/* Compute (foldable) */}
      <div className="space-y-2">
        <FoldHeader label="Compute" folded={ui.foldComp} onClick={() => setUi({ foldComp: !ui.foldComp })} />
        {!ui.foldComp && (<>
          <div className="flex items-center justify-between">
            <Label>Engine</Label>
            <Tabs value={opts.engine} onValueChange={(v) => setOpts({ engine: v as Opts["engine"] })}>
              <TabsList className="w-auto">
                <TabsTrigger value="server" className="px-3">Server</TabsTrigger>
                <TabsTrigger value="client" className="px-3">Client</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <div className="grid grid-cols-[1fr_3fr] items-end gap-2">
            <div className="space-y-1">
              <div className="flex h-4 items-center"><Label>IDW power</Label></div>
              <Input type="number" step="0.5" min="0.5" max="4" value={opts.power} className="text-xs"
                title="Inverse-distance weighting exponent. OpenTopography/RiverREM uses 1; Dan Coe's original QGIS method uses 2. Higher = more local (closer samples dominate)."
                onChange={(e) => setOpts({ power: Math.max(0.5, Math.min(4, parseFloat(e.target.value) || 2)) })} />
            </div>
            {opts.engine === "client" ? (
              <div className="space-y-1">
                <div className="flex h-4 items-center"><Label>River samples</Label></div>
                <Input type="number" step="10" min="10" max="1000" value={samplesStr} className="text-xs"
                  title="Spacing between river elevation samples. Roughly should match the river width — narrower river = fewer samples needed."
                  onChange={(e) => setSamplesStr(e.target.value)}
                  onBlur={() => { const v = parseInt(samplesStr); if (Number.isFinite(v)) setOpts({ samples: Math.max(10, Math.min(1000, v)) }); else setSamplesStr(String(opts.samples)); }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              </div>
            ) : (
              <div className="space-y-1">
                <div className="flex h-4 items-center"><Label>Resolution</Label></div>
                <Tabs value={String(opts.res)} onValueChange={(v) => setOpts({ res: Number(v) })}>
                  <TabsList className="grid w-full grid-cols-3">{[1, 2, 4].map((r) => <TabsTrigger key={r} value={String(r)}>{r}×</TabsTrigger>)}</TabsList>
                </Tabs>
              </div>
            )}
          </div>

          {opts.engine === "client" ? (
            <p className="font-mono text-[10px] leading-snug text-muted-foreground">
              Experimental — REM is sampled &amp; built live in your browser (Mapterhorn DEM, IDW), no server compute.
            </p>
          ) : (
            <div className="space-y-1">
              <Label>Custom DEM COG (optional)</Label>
              <Input className="text-xs" value={p.demCogUrl} onChange={(e) => p.setDemCogUrl(e.target.value)} placeholder="https://…/dem.tif — overrides Mapterhorn" />
            </div>
          )}

          <Button className="h-10 w-full" onClick={p.onCompute} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {busy ? "Computing…" : "Compute REM"}
          </Button>
          <Progress active={busy} label={p.phase} pct={p.pct} />
          {!busy && p.resNote && (
            <p className="font-mono text-[10px] leading-relaxed text-amber-500/90">{p.resNote}</p>
          )}

        </>)}
      </div>

      <Separator />

      {/* Metadata (foldable; folded by default) */}
      <div className="space-y-3">
        <FoldHeader label="Metadata" folded={ui.foldUtil} onClick={() => setUi({ foldUtil: !ui.foldUtil })} />
        {!ui.foldUtil && (<>
          {result && (
            <div className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
              <div>Engine · {opts.engine === "client" ? "client (live tiles)" : "server (RiverREM COG)"}</div>
              {opts.engine === "server" && result.width && result.height
                ? <div>Image · {result.width} × {result.height} px</div> : null}
              <div>Altitude · {result.rem_min.toFixed(1)} – {result.rem_max.toFixed(1)} m above river</div>
              {result.source_max_zoom != null ? <div>Max terrain zoom · z{result.source_max_zoom} (Mapterhorn)</div> : null}
              {result.river_length_m ? <div>River · {(result.river_length_m / 1000).toFixed(1)} km</div> : null}
            </div>
          )}
          {result && (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label>Inspect</Label>
                <Button variant={p.pickMode ? "default" : "outline"} size="sm" className="h-7 gap-1 px-2 text-xs" onClick={p.onTogglePick}>
                  <Crosshair className="h-3 w-3" />{p.pickMode ? "Picking" : "Pick value"}
                </Button>
              </div>
              {p.pick && (
                <p className="font-mono text-[10px] text-muted-foreground">
                  DEM {p.pick.dem ?? "–"} m · REM {p.pick.rem ?? "–"} m · {p.pick.lat.toFixed(5)}, {p.pick.lng.toFixed(5)}
                </p>
              )}
            </div>
          )}
        </>)}
      </div>

      <Separator />

      {/* Symbology (foldable) */}
      <div className="space-y-3">
        {/* Title bar: clicking label, chevron, or whitespace toggles fold; action buttons stop propagation */}
        <div className="flex cursor-pointer items-center justify-between gap-1" onClick={() => setUi({ foldRamp: !ui.foldRamp })}>
          <Label className="cursor-pointer">Symbology</Label>
          <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {result && p.onFitBounds && (
              <button onClick={p.onFitBounds}
                title="Zoom to run extent" aria-label="zoom to run extent"
                className="shrink-0 text-muted-foreground hover:text-foreground">
                <Crosshair className="h-3.5 w-3.5" />
              </button>
            )}
            {result && (
              <button onClick={p.onSaveSymbology}
                title="Export current symbology as new run" aria-label="Export current symbology as new run"
                className="shrink-0 text-muted-foreground hover:text-foreground">
                <Save className="h-3.5 w-3.5" />
              </button>
            )}
            {result && opts.engine === "server" && (
              <button onClick={p.onSyncServer}
                title={p.syncFlash ? "Synced!" : p.serverSynced ? "In sync with server" : "Local edits not yet synced — click to sync"}
                aria-label="sync symbology to server"
                className={`shrink-0 transition-colors ${
                  p.syncFlash ? "text-green-500" : p.serverSynced ? "text-muted-foreground/40" : "text-amber-500"
                }`}>
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            )}
            <button onClick={() => setUi({ foldRamp: !ui.foldRamp })}>
              {ui.foldRamp ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </button>
          </div>
        </div>

        {!ui.foldRamp && (<>
          {result && (
            <div className="space-y-1">
              <Label>Layer (click to flip)</Label>
              <div className="flex h-8 overflow-hidden rounded-md border border-border text-xs font-medium">
                {(["rem", "dem"] as const).map((l) => (
                  <button key={l} onClick={flipLayer}
                    className={`flex-1 transition-colors ${p.layer === l ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent"}`}>
                    {l.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Colour ramp</Label>
              <div className="flex items-center gap-2">
                <Label htmlFor="rev" className="cursor-pointer text-xs text-muted-foreground">Reverse</Label>
                <Switch id="rev" checked={opts.reverse} onCheckedChange={(v) => setOpts({ reverse: v })} />
              </div>
            </div>
            <Select value={opts.ramp} onValueChange={(v) => setOpts({ ramp: v as Opts["ramp"] })}>
              <SelectTrigger>
                <span className="flex w-full items-center gap-2">
                  <Swatch ramp={opts.ramp} reverse={opts.reverse} className="h-4 w-52" />
                  <span className="flex-1 truncate text-right text-xs text-muted-foreground">{opts.ramp}</span>
                </span>
              </SelectTrigger>
              <SelectContent className="w-[var(--radix-select-trigger-width)]">
                {RAMP_NAMES.map((n) => (
                  <SelectItem key={n} value={n} className="py-2">
                    <span className="flex w-full items-center gap-2">
                      <Swatch ramp={n} reverse={opts.reverse} className="h-4 w-52" />
                      <span className="flex-1 truncate text-right text-xs">{n}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>Min (m)</Label>
              <div className="flex items-center gap-1">
                <button onClick={() => setOpts({ sliderLo: opts.min })} title="Set slider min bound to this value"
                  aria-label="set slider min bound" className="shrink-0 text-muted-foreground hover:text-foreground"><Save className="h-3.5 w-3.5" /></button>
                <Input type="text" inputMode="decimal" value={minStr}
                  onChange={(e) => setMinStr(e.target.value)}
                  onBlur={() => { const v = parseFloat(minStr); if (Number.isFinite(v)) setOpts({ min: Math.max(isDem ? -1e9 : REM_FLOOR, Math.min(v, opts.max - 0.1)) }); else setMinStr(String(opts.min)); }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Max (m)</Label>
              <div className="flex items-center gap-1">
                <Input type="text" inputMode="decimal" value={maxStr}
                  onChange={(e) => setMaxStr(e.target.value)}
                  onBlur={() => { const v = parseFloat(maxStr); if (Number.isFinite(v)) setOpts({ max: Math.max(v, opts.min + 0.1) }); else setMaxStr(String(opts.max)); }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                <button onClick={() => setOpts({ sliderHi: opts.max })} title="Set slider max bound to this value"
                  aria-label="set slider max bound" className="shrink-0 text-muted-foreground hover:text-foreground"><Save className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          </div>

          <Slider
            min={sMin} max={sMax}
            step={opts.log ? 0.02 : Math.max(0.05, (sMax - sMin) / 200)}
            value={[toS(opts.min), toS(opts.max)]}
            onValueChange={([a, b]) => {
              let mn = fromS(Math.min(a, b)), mx = fromS(Math.max(a, b));
              if (mn >= mx) mx = mn + 0.1;
              setOpts({ min: mn, max: mx });
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] text-muted-foreground">Transparent</span>
              <Tabs value={opts.transparent} onValueChange={(v) => setOpts({ transparent: v as Opts["transparent"] })}>
                <TabsList className="w-auto">
                  <TabsTrigger value="none" className="px-1.5">None</TabsTrigger>
                  <TabsTrigger value="white" className="px-1.5">White</TabsTrigger>
                  <TabsTrigger value="black" className="px-1.5">Black</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-muted-foreground">log</span>
              <Switch checked={opts.log} onCheckedChange={(v) => setOpts({ log: v })} />
            </div>
          </div>
        </>)}
      </div>

      <Separator />

      {/* Layers (foldable) — basemap, relief overlay, visibility chips */}
      <div className="space-y-3">
        <FoldHeader label="Layers" folded={ui.foldLayers} onClick={() => setUi({ foldLayers: !ui.foldLayers })} />
        {!ui.foldLayers && (<>
          <div className="flex items-center justify-between">
            <Label>Basemap</Label>
            <div className="w-44">
              <Select value={opts.base} onValueChange={(v) => setOpts({ base: v as Opts["base"] })}>
                <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="dark">Dark (OSM)</SelectItem>
                  <SelectItem value="light">Light (OSM)</SelectItem>
                  <SelectItem value="satellite">Satellite (Esri)</SelectItem>
                  <SelectItem value="hillshade">Hillshade (Mapterhorn)</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <Label>Relief overlay</Label>
            <Tabs value={opts.hillshade} onValueChange={(v) => setOpts({ hillshade: v as Opts["hillshade"] })}>
              <TabsList className="grid w-44 grid-cols-3">
                <TabsTrigger value="off">Off</TabsTrigger>
                <TabsTrigger value="dark">Dark</TabsTrigger>
                <TabsTrigger value="light">Light</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {/* Layer visibility chips */}
          <div className="space-y-1.5">
            <Label>Visibility</Label>
            <div className="flex flex-wrap gap-1.5">
              {/* Contours chip — label changes with active layer */}
              {([
                { key: "showContours", label: isDem ? "DEM Contours" : "REM Contours", color: "#94a3b8", needsResult: true },
                { key: "showContourLabels", label: "Contour Labels", color: "#cbd5e1", needsResult: true },
              ] as { key: keyof Opts & string; label: string; color: string; needsResult: boolean }[]).map(({ key, label, color, needsResult }) => {
                const on = opts[key] as boolean;
                const disabled = needsResult && !result;
                return (
                  <button key={key} disabled={disabled} onClick={() => !disabled && setOpts({ [key]: !on } as any)}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${disabled ? "cursor-not-allowed border-border text-muted-foreground opacity-30" : on ? "border-transparent bg-foreground/10 text-foreground" : "border-border text-muted-foreground opacity-50"}`}>
                    <span className="h-2 w-2 rounded-full" style={{ background: on && !disabled ? color : "#666" }} />
                    {label}
                  </button>
                );
              })}
              {/* REM/DEM Output chip */}
              <button disabled={!result} onClick={result ? p.onToggleLayer : undefined}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${!result ? "cursor-not-allowed border-border text-muted-foreground opacity-30" : p.remVisible ? "border-transparent bg-foreground/10 text-foreground" : "border-border text-muted-foreground opacity-50"}`}>
                <span className="h-2 w-2 rounded-full" style={{ background: result && p.remVisible ? "#60a5fa" : "#666" }} />
                {isDem ? "DEM Output" : "REM Output"}
              </button>
              {/* River — always enabled when centerline exists; River Samples needs result + client */}
              {([
                { key: "showRiver", label: "River", color: "#94a3b8", needsResult: false },
                { key: "showSamples", label: "River Samples", color: "#fbbf24", needsResult: true },
              ] as { key: keyof Opts & string; label: string; color: string; needsResult: boolean }[]).map(({ key, label, color, needsResult }) => {
                const on = opts[key] as boolean;
                const disabled = needsResult && !result;
                return (
                  <button key={key} disabled={disabled} onClick={() => !disabled && setOpts({ [key]: !on } as any)}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${disabled ? "cursor-not-allowed border-border text-muted-foreground opacity-30" : on ? "border-transparent bg-foreground/10 text-foreground" : "border-border text-muted-foreground opacity-50"}`}>
                    <span className="h-2 w-2 rounded-full" style={{ background: on && !disabled ? color : "#666" }} />
                    {label}
                  </button>
                );
              })}
              {/* Hillshade Overlay */}
              {(() => {
                const on = opts.hillshade !== "off";
                return (
                  <button onClick={() => {
                    if (on) { prevHillshadeRef.current = opts.hillshade; setOpts({ hillshade: "off" }); }
                    else { setOpts({ hillshade: (prevHillshadeRef.current || "dark") as Opts["hillshade"] }); }
                  }}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${on ? "border-transparent bg-foreground/10 text-foreground" : "border-border text-muted-foreground opacity-50"}`}>
                    <span className="h-2 w-2 rounded-full" style={{ background: on ? "#d97706" : "#666" }} />
                    Hillshade
                  </button>
                );
              })()}
              {/* Basemap */}
              {(() => {
                const on = opts.base !== "none";
                return (
                  <button onClick={() => {
                    if (on) { prevBaseRef.current = opts.base; setOpts({ base: "none" }); }
                    else { setOpts({ base: (prevBaseRef.current || "dark") as Opts["base"] }); }
                  }}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${on ? "border-transparent bg-foreground/10 text-foreground" : "border-border text-muted-foreground opacity-50"}`}>
                    <span className="h-2 w-2 rounded-full" style={{ background: on ? "#34d399" : "#666" }} />
                    Basemap
                  </button>
                );
              })()}
              {/* Viewport */}
              <button onClick={() => setOpts({ showViewport: !opts.showViewport })}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${opts.showViewport ? "border-transparent bg-foreground/10 text-foreground" : "border-border text-muted-foreground opacity-50"}`}>
                <span className="h-2 w-2 rounded-full" style={{ background: opts.showViewport ? "#a78bfa" : "#666" }} />
                Viewport
              </button>
            </div>
          </div>
        </>)}
      </div>

      {result && (
        <>
          <Separator />
          {/* Export (foldable) */}
          <div className="space-y-2">
            <div className="flex cursor-pointer items-center justify-between gap-1" onClick={() => setUi({ foldExport: !ui.foldExport })}>
              <Label className="cursor-pointer">Export</Label>
              <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={!!imgCopyMsg} onClick={() => {
                  setImgCopyMsg("Copying…");
                  Promise.resolve(p.onCopyImage()).then(() => {
                    setImgCopyMsg("Copied!"); setTimeout(() => setImgCopyMsg(""), 3000);
                  }).catch(() => setImgCopyMsg(""));
                }}><Copy className="h-3 w-3" />{imgCopyMsg || "Copy image"}</Button>
                <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={share}><Share2 className="h-3 w-3" />{copied ? "Copied!" : "Share"}</Button>
                <button onClick={() => setUi({ foldExport: !ui.foldExport })}>
                  {ui.foldExport ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                </button>
              </div>
            </div>
            {!ui.foldExport && (<>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" size="sm" onClick={p.onExportComposite}><Download className="mr-1 h-3 w-3" />Composite JPG</Button>
                <Button variant="outline" size="sm" onClick={p.onExportRaw} disabled={opts.engine === "client"}
                  title={opts.engine === "client" ? "COGs can only be exported for server runs" : undefined}><FileDown className="mr-1 h-3 w-3" />REM COG</Button>
                <Button variant="outline" size="sm" onClick={p.onExportCenterline} disabled={!p.hasCenterline}><FileDown className="mr-1 h-3 w-3" />Centerline</Button>
                <Button variant="outline" size="sm" onClick={p.onExportDem} disabled={opts.engine === "client" || !result.dem_url}
                  title={opts.engine === "client" ? "COGs can only be exported for server runs" : undefined}><FileDown className="mr-1 h-3 w-3" />DEM COG</Button>
              </div>
              <Button variant="ghost" size="sm" className="h-7 w-full gap-1 text-xs"
                disabled={opts.engine === "client"}
                title={opts.engine === "client" ? "cog-viewer is only available for server runs" : undefined}
                onClick={() => {
                  const dem = p.layer === "dem" && result.dem_url;
                  const url = dem ? result.dem_url! : result.cog_url;
                  window.open(
                    `https://source-cooperative.github.io/cog-viewer/?url=${encodeURIComponent(url)}&mode=single&bands=1&rescale=${opts.min},${opts.max}&panel=open`,
                    "_blank", "noreferrer");
                }}>
                <ExternalLink className="h-3 w-3" />View {p.layer === "dem" && result.dem_url ? "DEM" : "REM"} in cog-viewer
              </Button>
            </>)}
          </div>
        </>
      )}

      {/* Runs (always visible) */}
      {(() => {
        const list = ui.runsSource === "server" ? p.serverRuns : p.runs;
        const isServer = ui.runsSource === "server";
        return (
          <>
            <Separator />
            <div className="space-y-2">
              <div className="flex cursor-pointer items-center justify-between gap-1" onClick={() => setUi({ foldRuns: !ui.foldRuns })}>
                <Label className="inline-flex items-center gap-1 cursor-pointer"><Layers className="h-3 w-3" />Runs</Label>
                <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <div className="inline-flex overflow-hidden rounded-md border border-border">
                    {([["device", "This device"], ["server", "Server"]] as const).map(([v, lbl]) => (
                      <button key={v} onClick={() => setUi({ runsSource: v })}
                        className={`px-2 py-1 font-mono text-[9px] uppercase ${ui.runsSource === v ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent"}`}
                        aria-label={lbl}>{lbl}</button>
                    ))}
                  </div>
                  <div className="inline-flex overflow-hidden rounded-md border border-border">
                    {([["list", List], ["gallery", LayoutGrid]] as const).map(([v, Icon]) => (
                      <button key={v} onClick={() => setUi({ runsView: v })}
                        className={`px-2 py-1 ${ui.runsView === v ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent"}`}
                        aria-label={v}>
                        <Icon className="h-3.5 w-3.5" />
                      </button>
                    ))}
                  </div>
                  <button onClick={p.onOpenGallery} aria-label="open gallery"
                    title="Open gallery"
                    className="rounded-md border border-border px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                    <Maximize2 className="h-3.5 w-3.5" />
                  </button>
                  <button className="shrink-0" onClick={() => setUi({ foldRuns: !ui.foldRuns })}>
                    {ui.foldRuns ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                  </button>
                </div>
              </div>
              {!ui.foldRuns && isServer && list.length === 0 && (
                <p className="font-mono text-[10px] text-muted-foreground">No server runs yet (server computes are saved here, shared across devices).</p>
              )}
              {!ui.foldRuns && (
                ui.runsView === "gallery" ? (
                  <div className="panel-scroll max-h-[28rem] space-y-2 overflow-y-auto">
                    {list.map((r) => {
                      const active = r.id === p.activeRunId;
                      return (
                        <div key={r.id} className={`overflow-hidden rounded-md border ${active ? "border-foreground/40" : "border-border"}`}>
                          <button className="relative block w-full" onClick={() => p.onLoadRun(r)} aria-label="load run">
                            {r.thumb ? (
                              <img src={r.thumb} alt="" className="h-24 w-full object-cover" />
                            ) : (
                              <div className="flex h-24 w-full items-center justify-center bg-muted/60">
                                <ImageOff className="h-5 w-5 text-muted-foreground" />
                              </div>
                            )}
                            <span className={`absolute right-1 top-1 rounded px-1 py-0.5 font-mono text-[8px] uppercase tracking-wide ${r.engine === "client" ? "bg-foreground text-background" : "bg-sky-600/90 text-white"}`}>
                              {r.engine === "client" ? "client" : "server"}
                            </span>
                          </button>
                          <div className="flex items-center gap-1.5 px-2 py-1">
                            {active && (
                              <button onClick={p.onToggleLayer} aria-label="toggle layer" className="text-muted-foreground hover:text-foreground">
                                {p.remVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                              </button>
                            )}
                            {editId === r.id ? (
                              <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") { p.onRenameRun(r.id, editName); setEditId(null); } if (e.key === "Escape") setEditId(null); }}
                                className="min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none" />
                            ) : (
                              <button className="min-w-0 flex-1 truncate text-left font-mono text-[11px]" onClick={() => p.onLoadRun(r)}>
                                {r.name || r.id.slice(0, 8)}
                              </button>
                            )}
                            {editId === r.id ? (
                              <>
                                <button onClick={() => { p.onRenameRun(r.id, editName); setEditId(null); }} className="text-muted-foreground hover:text-foreground"><Check className="h-3.5 w-3.5" /></button>
                                <button onClick={() => setEditId(null)} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
                              </>
                            ) : (
                              <>
                                {active && (<button onClick={() => p.onRecaptureThumb(r.id)} aria-label="recapture thumbnail" className="text-muted-foreground hover:text-foreground"><Camera className="h-3 w-3" /></button>)}
                                {!isServer && (<button onClick={() => { setEditId(r.id); setEditName(r.name || ""); }} aria-label="rename" className="text-muted-foreground hover:text-foreground"><Pencil className="h-3 w-3" /></button>)}
                                {!isServer && (<button onClick={() => p.onDeleteRun(r.id)} aria-label="delete" className="text-muted-foreground hover:text-foreground"><Trash2 className="h-3 w-3" /></button>)}
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="panel-scroll max-h-44 space-y-1 overflow-y-auto">
                    {list.map((r) => {
                      const active = r.id === p.activeRunId;
                      return (
                        <div key={r.id} className={`flex items-center gap-1.5 rounded-md border px-2 py-1 ${active ? "border-foreground/40" : "border-border"}`}>
                          {active && (
                            <button onClick={p.onToggleLayer} aria-label="toggle layer" className="text-muted-foreground hover:text-foreground">
                              {p.remVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                            </button>
                          )}
                          {editId === r.id ? (
                            <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") { p.onRenameRun(r.id, editName); setEditId(null); } if (e.key === "Escape") setEditId(null); }}
                              className="min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none" />
                          ) : (
                            <button className="min-w-0 flex-1 text-left" onClick={() => p.onLoadRun(r)}>
                              <div className="truncate font-mono text-[11px]">{r.name || r.id.slice(0, 8)}</div>
                              <div className="flex items-center gap-1 font-mono text-[9px] text-muted-foreground">
                                <span className={`rounded px-1 uppercase ${r.engine === "client" ? "bg-foreground text-background" : "bg-sky-600/20 text-sky-700 dark:text-sky-400"}`}>
                                  {r.engine === "client" ? "client" : "server"}
                                </span>
                                <span>{new Date(r.ts).toLocaleString()} · {r.min}–{r.max} m</span>
                              </div>
                            </button>
                          )}
                          {editId === r.id ? (
                            <>
                              <button onClick={() => { p.onRenameRun(r.id, editName); setEditId(null); }} className="text-muted-foreground hover:text-foreground"><Check className="h-3.5 w-3.5" /></button>
                              <button onClick={() => setEditId(null)} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
                            </>
                          ) : (
                            <>
                              {active && (<button onClick={() => p.onRecaptureThumb(r.id)} aria-label="recapture thumbnail" className="text-muted-foreground hover:text-foreground"><Camera className="h-3 w-3" /></button>)}
                              {!isServer && (<button onClick={() => { setEditId(r.id); setEditName(r.name || ""); }} aria-label="rename" className="text-muted-foreground hover:text-foreground"><Pencil className="h-3 w-3" /></button>)}
                              {!isServer && (<button onClick={() => p.onDeleteRun(r.id)} aria-label="delete" className="text-muted-foreground hover:text-foreground"><Trash2 className="h-3 w-3" /></button>)}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )
              )}
            </div>
          </>
        );
      })()}

      <Separator />
      <div className="space-y-1 font-mono text-[9px] leading-relaxed text-muted-foreground">
        <p>
          REM method:{" "}
          <a className="underline" href="https://dancoecarto.com/creating-rems-in-qgis-the-idw-method" target="_blank" rel="noreferrer">Dan Coe — IDW</a>
          <br />
          Automated by{" "}
          <a className="underline" href="https://opentopography.org/blog/new-package-automates-river-relative-elevation-model-rem-generation" target="_blank" rel="noreferrer">OpenTopography RiverREM</a>{" "}
          (<a className="underline" href="https://github.com/OpenTopography/RiverREM" target="_blank" rel="noreferrer">repo</a>).
        </p>
        <p>
          <a className="underline" href="/rem-pure-frontend.html" target="_blank" rel="noreferrer">
            Beta pure-client frontend GPU REM
          </a>
        </p>
        <p>
          Made by{" "}
          <a className="underline" href="https://x.com/jo_chemla" target="_blank" rel="noreferrer">jo-chemla</a>
          {" · "}
          <a className="underline" href="https://iconem.com" target="_blank" rel="noreferrer">Iconem</a>
          {(() => {
            const sha = import.meta.env.VITE_GIT_SHA;
            if (!sha || sha === "dev") return <span className="opacity-70">{" · build dev"}</span>;
            return (<>
              {" · build "}
              <a className="underline" target="_blank" rel="noreferrer"
                href={`https://github.com/iconem/RiverREM_UI/commit/${sha}`}>{sha.slice(0, 7)}</a>
            </>);
          })()}
        </p>
      </div>
    </Card>
  );
}
