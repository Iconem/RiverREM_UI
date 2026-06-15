import { useMemo, useState } from "react";
import { X, List, LayoutGrid, ImageOff } from "lucide-react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import type { Run } from "@/lib/history";

// Curated featured runs (server ids). Hard-coded for now; later this can come
// from the backend (a `featured` flag in run.json) without touching the UI.
export const FEATURED_IDS = [
  "64daa8c8f51a4d6680c86566effd56c8", // Trysting Tree Golf Club
  "ff31668e2c854ddcbad478d556718ab3", // La Vega, Córdoba
  "e4053f8842f94582bac04ec000fa54b5", // Beyers Pond
];

type Sort = "recent-desc" | "recent-asc" | "name";

function EngineChip({ r }: { r: Run }) {
  const client = r.engine === "client";
  return (
    <span className={`rounded px-1 py-0.5 font-mono text-[8px] uppercase tracking-wide ${client ? "bg-foreground text-background" : "bg-sky-600/90 text-white"}`}>
      {client ? "client" : "server"}
    </span>
  );
}

function Card({ r, view, onPick }: { r: Run; view: "grid" | "list"; onPick: (r: Run) => void }) {
  const title = r.name || r.id.slice(0, 8);
  const date = r.ts ? new Date(r.ts).toLocaleDateString() : "";
  if (view === "list") {
    return (
      <button onClick={() => onPick(r)}
        className="flex w-full items-center gap-3 rounded-md border border-border px-2 py-1.5 text-left transition-colors hover:border-foreground/40 hover:bg-accent">
        <div className="h-10 w-16 shrink-0 overflow-hidden rounded bg-muted">
          {r.thumb
            ? <img src={r.thumb} alt="" className="h-full w-full object-cover" />
            : <div className="flex h-full w-full items-center justify-center text-muted-foreground"><ImageOff className="h-3 w-3" /></div>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs">{title}</div>
          <div className="flex items-center gap-1.5 font-mono text-[9px] text-muted-foreground">
            <EngineChip r={r} /><span>{date} · {r.min}–{r.max} m</span>
          </div>
        </div>
      </button>
    );
  }
  return (
    <button onClick={() => onPick(r)}
      className="group overflow-hidden rounded-lg border border-border text-left transition-colors hover:border-foreground/40">
      <div className="relative aspect-[16/10] w-full bg-muted">
        {r.thumb
          ? <img src={r.thumb} alt="" className="h-full w-full object-cover" />
          : <div className="flex h-full w-full items-center justify-center text-muted-foreground"><ImageOff className="h-5 w-5" /></div>}
        <span className="absolute right-1.5 top-1.5"><EngineChip r={r} /></span>
      </div>
      <div className="px-2.5 py-2">
        <div className="truncate font-mono text-xs">{title}</div>
        <div className="font-mono text-[9px] text-muted-foreground">{date} · {r.min}–{r.max} m</div>
      </div>
    </button>
  );
}

export default function GalleryModal({
  open, onClose, runs, onSelect,
}: {
  open: boolean;
  onClose: () => void;
  runs: Run[];
  onSelect: (r: Run) => void;
}) {
  const [sort, setSort] = useState<Sort>("recent-desc");
  const [view, setView] = useState<"grid" | "list">("grid");

  const featured = useMemo(
    () => FEATURED_IDS.map((id) => runs.find((r) => r.id === id)).filter((r): r is Run => !!r),
    [runs],
  );
  const recent = useMemo(() => {
    const arr = [...runs];
    if (sort === "name") arr.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    else arr.sort((a, b) => sort === "recent-asc" ? (a.ts || 0) - (b.ts || 0) : (b.ts || 0) - (a.ts || 0));
    return arr;
  }, [runs, sort]);

  if (!open) return null;

  const pick = (r: Run) => { onSelect(r); onClose(); };
  const gridCls = view === "grid" ? "grid grid-cols-2 gap-3 sm:grid-cols-3" : "space-y-1.5";

  return (
    <div className="fixed inset-0 z-[20] flex items-center justify-center p-4"
      onClick={onClose} role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="font-sans text-base font-semibold tracking-tight">REM gallery</div>
          <div className="flex items-center gap-2">
            <div className="w-40">
              <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
                <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="recent-desc">Most recent</SelectItem>
                  <SelectItem value="recent-asc">Oldest first</SelectItem>
                  <SelectItem value="name">Name (A–Z)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="inline-flex overflow-hidden rounded-md border border-border">
              {([["grid", LayoutGrid], ["list", List]] as const).map(([v, Icon]) => (
                <button key={v} onClick={() => setView(v)}
                  className={`px-2 py-1 ${view === v ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent"}`}
                  aria-label={v}><Icon className="h-3.5 w-3.5" /></button>
              ))}
            </div>
            <button onClick={onClose} aria-label="close"
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="panel-scroll flex-1 overflow-y-auto px-4 py-4">
          {featured.length > 0 && (
            <section className="mb-6">
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Featured</h3>
              <div className={gridCls}>
                {featured.map((r) => <Card key={`f-${r.id}`} r={r} view={view} onPick={pick} />)}
              </div>
            </section>
          )}
          <section>
            <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Most recent</h3>
            {recent.length === 0
              ? <p className="font-mono text-[11px] text-muted-foreground">No runs yet.</p>
              : <div className={gridCls}>{recent.map((r) => <Card key={r.id} r={r} view={view} onPick={pick} />)}</div>}
          </section>
        </div>
      </div>
    </div>
  );
}
