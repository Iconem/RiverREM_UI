import { useEffect, useRef, useState } from "react";
import {
  Upload, Pencil, Waves, Play, Loader2, Download, Share2, Layers, Trash2, FileDown,
  Eye, EyeOff, Check, X, Search, MapPin, Copy, ChevronUp, ChevronDown, ChevronRight, Crosshair, ExternalLink,
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
  base: "dark" | "satellite" | "hillshade";
  ramp: (typeof RAMP_NAMES)[number];
  reverse: boolean; min: number; max: number; log: boolean; res: number; oversample: number; osm: string;
};

function Swatch({ ramp, reverse = false }: { ramp: string; reverse?: boolean }) {
  return <span className="inline-block h-3 w-8 shrink-0 rounded-sm" style={{ background: rampCss(ramp, reverse) }} />;
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
  result: ComputeResponse | null; hasCenterline: boolean;
  layer: "rem" | "dem"; hasDem: boolean; onSetLayer: (l: "rem" | "dem") => void;
  previewInfo: { river_name: string; river_length_m: number } | null;
  runs: Run[]; activeRunId: string | null; remVisible: boolean; pickMode: boolean;
  pick: { lng: number; lat: number; rem: number | null; dem: number | null } | null;
  geoHits: GeoHit[];
  onPreview: () => void; onCompute: () => void; onUpload: (f: File) => void; onLoadCog: (url: string) => void;
  onShare: () => void; onExportComposite: () => void; onCopyImage: () => void;
  onExportRaw: () => void; onExportDem: () => void; onExportCenterline: () => void;
  onLoadRun: (r: Run) => void; onDeleteRun: (id: string) => void; onRenameRun: (id: string, name: string) => void;
  onToggleLayer: () => void; onTogglePick: () => void;
  onGeocode: (q: string) => void; onFlyTo: (lng: number, lat: number) => void;
}) {
  const { opts, setOpts, busy, result } = p;
  const [ui, setUi] = useUiState();
  const fileRef = useRef<HTMLInputElement>(null);
  const [cogUrl, setCogUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [geoQ, setGeoQ] = useState("");

  // Slider bounds always span the active layer's data range AND the current
  // selection, in both log and linear; min floor is at least -1.
  const isDem = p.layer === "dem";
  const dataMin = result ? Math.floor(isDem ? result.dem_min ?? result.rem_min : result.rem_min) : 0;
  const dataMax = result ? Math.ceil(isDem ? result.dem_max ?? result.rem_max : result.rem_max) : 10;
  const linLo = Math.min(-1, dataMin, opts.min);
  const linHi = Math.max(dataMax, opts.max, Math.ceil((dataMax - Math.min(0, dataMin)) * 2), 1);
  const logLo = -1;
  const logHi = Math.max(1, Math.ceil(Math.log10(Math.max(10, linHi))));
  const toS = (v: number) => (opts.log ? Math.log10(Math.max(0.1, v)) : v);
  const fromS = (x: number) => (opts.log ? +(10 ** x).toFixed(2) : +x.toFixed(2));
  const sMin = opts.log ? logLo : linLo;
  const sMax = opts.log ? logHi : linHi;

  const share = () => { p.onShare(); setCopied(true); setTimeout(() => setCopied(false), 3000); };
  const flipLayer = () => p.onSetLayer(p.layer === "rem" ? "dem" : "rem");

  const cardBase =
    "pointer-events-auto absolute left-4 top-4 z-50 w-[360px] shadow-2xl backdrop-blur supports-[backdrop-filter]:bg-background/85";

  if (ui.collapsed) {
    return (
      <Card className={`${cardBase} flex items-center justify-between px-4 py-2`}>
        <span className="font-sans text-base font-semibold tracking-tight">River REM</span>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setUi({ collapsed: false })} aria-label="expand">
          <ChevronDown className="h-4 w-4" />
        </Button>
      </Card>
    );
  }

  return (
    <Card className={`${cardBase} panel-scroll flex max-h-[calc(100vh-2rem)] flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="font-sans text-base font-semibold tracking-tight">River REM</div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">viewport · terrain → detrend → cog</div>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setUi({ collapsed: true })} aria-label="collapse">
          <ChevronUp className="h-4 w-4" />
        </Button>
      </div>

      {/* Geocoder */}
      <div className="relative">
        <div className="flex items-center gap-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Input placeholder="Search a place…" value={geoQ}
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
              <TabsTrigger value="shapefile"><Upload className="mr-1 h-3 w-3" />File</TabsTrigger>
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
                      {OVERPASS_PRESETS.map((o) => <SelectItem key={o.url} value={o.url}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button variant="outline" size="sm" className="w-full" onClick={p.onPreview} disabled={busy}>Preview longest river</Button>
            </>
          )}
          {opts.mode === "geojson" && (
            <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">Click on the map to draw a centerline. Double-click to finish.</p>
          )}
          {opts.mode === "shapefile" && (
            <>
              <Button variant="outline" size="sm" className="w-full" onClick={() => fileRef.current?.click()}>Upload .geojson / .shp (zip)</Button>
              <input ref={fileRef} type="file" accept=".geojson,.json,.zip,.shp" className="hidden"
                onChange={(e) => e.target.files?.[0] && p.onUpload(e.target.files[0])} />
            </>
          )}
          {p.previewInfo && (
            <p className="font-mono text-[10px] text-muted-foreground">{p.previewInfo.river_name} · {(p.previewInfo.river_length_m / 1000).toFixed(1)} km</p>
          )}
        </>)}
      </div>

      <Separator />

      {/* Resolution + compute */}
      <div className="flex items-center justify-between">
        <Label>Resolution</Label>
        <Tabs value={String(opts.res)} onValueChange={(v) => setOpts({ res: Number(v) })}>
          <TabsList className="w-auto">{[1, 2, 4].map((r) => <TabsTrigger key={r} value={String(r)} className="px-3">{r}×</TabsTrigger>)}</TabsList>
        </Tabs>
      </div>

      <Button className="h-10 w-full" onClick={p.onCompute} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        {busy ? "Computing…" : "Compute REM"}
      </Button>
      <Progress active={busy} label={p.phase} pct={p.pct} />

      {result && p.hasDem && (
        <div className="flex items-center justify-between">
          <Label>Layer (click to flip)</Label>
          <div className="inline-flex overflow-hidden rounded-md border border-border text-xs font-medium">
            {(["rem", "dem"] as const).map((l) => (
              <button key={l} onClick={flipLayer}
                className={`px-3 py-1 transition-colors ${p.layer === l ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent"}`}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      )}

      <Separator />

      {/* Colour ramp (foldable; oversample lives here) */}
      <div className="space-y-3">
        <FoldHeader label="Colour ramp" folded={ui.foldRamp} onClick={() => setUi({ foldRamp: !ui.foldRamp })} />
        {!ui.foldRamp && (<>
          <div className="space-y-2">
            <div className="flex items-center justify-end gap-2">
              <Label htmlFor="rev" className="cursor-pointer">Reverse</Label>
              <Switch id="rev" checked={opts.reverse} onCheckedChange={(v) => setOpts({ reverse: v })} />
            </div>
            <Select value={opts.ramp} onValueChange={(v) => setOpts({ ramp: v as Opts["ramp"] })}>
              <SelectTrigger><span className="flex items-center gap-2"><Swatch ramp={opts.ramp} reverse={opts.reverse} />{opts.ramp}</span></SelectTrigger>
              <SelectContent>
                {RAMP_NAMES.map((n) => <SelectItem key={n} value={n}><span className="flex items-center gap-2"><Swatch ramp={n} reverse={opts.reverse} />{n}</span></SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <div className="h-3 w-full rounded-sm border border-border" style={{ background: rampCss(opts.ramp, opts.reverse) }} />
            <div className="flex justify-between font-mono text-[10px] text-muted-foreground"><span>{opts.min} m</span><span>{opts.max} m</span></div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1"><Label>Min (m)</Label>
              <Input type="number" step="0.1" value={opts.min} onChange={(e) => setOpts({ min: Math.min(parseFloat(e.target.value), opts.max - 0.1) })} /></div>
            <div className="space-y-1"><Label>Max (m)</Label>
              <Input type="number" step="0.1" value={opts.max} onChange={(e) => setOpts({ max: Math.max(parseFloat(e.target.value), opts.min + 0.1) })} /></div>
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
          <div className="flex items-center justify-end gap-2">
            <span className="font-mono text-[10px] text-muted-foreground">log</span>
            <Switch checked={opts.log} onCheckedChange={(v) => setOpts({ log: v })} />
          </div>

          <div className="flex items-center justify-between pt-1">
            <div>
              <Label>Oversample</Label>
              <div className="font-mono text-[9px] text-muted-foreground">display supersampling · sharper on 4K</div>
            </div>
            <Tabs value={String(opts.oversample)} onValueChange={(v) => setOpts({ oversample: Number(v) })}>
              <TabsList className="w-auto">{[1, 2, 4].map((r) => <TabsTrigger key={r} value={String(r)} className="px-3">{r}×</TabsTrigger>)}</TabsList>
            </Tabs>
          </div>
        </>)}
      </div>

      {result && (
        <>
          <Separator />
          {/* Export */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Export</Label>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={p.onCopyImage}><Copy className="h-3 w-3" />Copy</Button>
                <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={share}><Share2 className="h-3 w-3" />{copied ? "Copied!" : "Share"}</Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" onClick={p.onExportComposite}><Download className="mr-1 h-3 w-3" />Composite JPG</Button>
              <Button variant="outline" size="sm" onClick={p.onExportRaw}><FileDown className="mr-1 h-3 w-3" />REM COG</Button>
              <Button variant="outline" size="sm" onClick={p.onExportDem} disabled={!result.dem_url}><FileDown className="mr-1 h-3 w-3" />DEM COG</Button>
              <Button variant="outline" size="sm" onClick={p.onExportCenterline} disabled={!p.hasCenterline}><FileDown className="mr-1 h-3 w-3" />Centerline</Button>
            </div>
            <Button variant="ghost" size="sm" className="h-7 w-full gap-1 text-xs"
              onClick={() => window.open(
                `https://source-cooperative.github.io/cog-viewer/?url=${encodeURIComponent(result.cog_url)}&mode=single&bands=1&rescale=${result.rem_min},${result.rem_max}&panel=open`,
                "_blank", "noreferrer")}>
              <ExternalLink className="h-3 w-3" />View REM in cog-viewer
            </Button>
          </div>
        </>
      )}

      <Separator />

      {/* Utilities (foldable; folded by default): basemap, inspect, load COG */}
      <div className="space-y-3">
        <FoldHeader label="Utilities" folded={ui.foldUtil} onClick={() => setUi({ foldUtil: !ui.foldUtil })} />
        {!ui.foldUtil && (<>
          <div className="flex items-center justify-between">
            <Label>Basemap</Label>
            <div className="w-44">
              <Select value={opts.base} onValueChange={(v) => setOpts({ base: v as Opts["base"] })}>
                <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="dark">Dark (OSM)</SelectItem>
                  <SelectItem value="satellite">Satellite (Esri)</SelectItem>
                  <SelectItem value="hillshade">Hillshade (Mapterhorn)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

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
                  {p.pick.lat.toFixed(5)}, {p.pick.lng.toFixed(5)} · REM {p.pick.rem ?? "–"} m{p.pick.dem != null ? ` · DEM ${p.pick.dem} m` : ""}
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label>Load COG</Label>
            <div className="flex gap-2">
              <Input placeholder="https://…/dem.tif" value={cogUrl} onChange={(e) => setCogUrl(e.target.value)} />
              <Button variant="outline" size="sm" onClick={() => cogUrl && p.onLoadCog(cogUrl)} disabled={busy}>Load</Button>
            </div>
          </div>
        </>)}
      </div>

      {p.runs.length > 0 && (
        <>
          <Separator />
          <div className="space-y-2">
            <Label><span className="inline-flex items-center gap-1"><Layers className="h-3 w-3" />Runs</span></Label>
            <div className="panel-scroll max-h-44 space-y-1 overflow-y-auto">
              {p.runs.map((r) => {
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
                        <div className="font-mono text-[9px] text-muted-foreground">{new Date(r.ts).toLocaleString()} · {r.min}–{r.max} m</div>
                      </button>
                    )}
                    {editId === r.id ? (
                      <>
                        <button onClick={() => { p.onRenameRun(r.id, editName); setEditId(null); }} className="text-muted-foreground hover:text-foreground"><Check className="h-3.5 w-3.5" /></button>
                        <button onClick={() => setEditId(null)} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => { setEditId(r.id); setEditName(r.name || ""); }} aria-label="rename" className="text-muted-foreground hover:text-foreground"><Pencil className="h-3 w-3" /></button>
                        <button onClick={() => p.onDeleteRun(r.id)} aria-label="delete" className="text-muted-foreground hover:text-foreground"><Trash2 className="h-3 w-3" /></button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      <Separator />
      <div className="space-y-1 font-mono text-[9px] leading-relaxed text-muted-foreground">
        <p>
          REM method:{" "}
          <a className="underline" href="https://dancoecarto.com/creating-rems-in-qgis-the-idw-method" target="_blank" rel="noreferrer">Dan Coe — IDW</a>{" "}
          · automated by{" "}
          <a className="underline" href="https://github.com/OpenTopography/RiverREM" target="_blank" rel="noreferrer">OpenTopography RiverREM</a>
        </p>
        <p>
          Made by{" "}
          <a className="underline" href="https://x.com/jo_chemla" target="_blank" rel="noreferrer">jo-chemla</a>
          {" · "}
          <a className="underline" href="https://iconem.com" target="_blank" rel="noreferrer">Iconem</a>
        </p>
      </div>
    </Card>
  );
}
