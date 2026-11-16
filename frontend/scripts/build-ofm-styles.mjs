// Fetch OpenFreeMap's Dark and Positron styles and write their layers to
// src/styles/ofm-<name>.json, ids prefixed so they can sit next to Liberty's in
// the one static style (MapView.tsx). All three share the same sources
// (openmaptiles planet + ne2_shaded), sprite and glyph server, which MapView
// takes from ofm-liberty.json. No API key. Re-run to pick up upstream changes:
//   node scripts/build-ofm-styles.mjs
import { readFileSync, writeFileSync } from "node:fs";

const STYLES = { dark: "ofm-dark", positron: "ofm-positron" };
for (const [name, prefix] of Object.entries(STYLES)) {
  const res = await fetch(`https://tiles.openfreemap.org/styles/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const style = await res.json();
  for (const [id, src] of Object.entries(style.sources)) {
    if (!["openmaptiles", "ne2_shaded"].includes(id)) throw new Error(`${name}: unexpected source ${id} ${JSON.stringify(src)}`);
  }
  const layers = style.layers.map((l) => ({ ...l, id: `${prefix}-${l.id}` }));
  writeFileSync(new URL(`../src/styles/${prefix}.json`, import.meta.url), JSON.stringify({ source: `https://tiles.openfreemap.org/styles/${name}`, layers }) + "\n");
  console.log(`${prefix}.json: ${layers.length} layers`);
}

// "Dark (Maptiler w. OFM tiles)": src/styles/osm-dark.json is a MapTiler style
// drawn with the OFM sprite, which lacks MapTiler's icon names (road_trunk,
// camping, bus_stop.12, place-6...). Rewrite every icon-image to an OFM icon:
// fixed renames, POIs through the names the sprite actually has, shields as
// OFM's road_<ref_length> (sized per ref, not stretched; dark text like
// Liberty's). Idempotent: re-running leaves the file unchanged.
const SPRITE = "https://tiles.openfreemap.org/sprites/ofm_f384/ofm.json";
const spriteRes = await fetch(SPRITE);
if (!spriteRes.ok) throw new Error(`sprite: HTTP ${spriteRes.status}`);
const icons = Object.keys(await spriteRes.json()).filter((k) => !/_\d+(_black)?$/.test(k) && !/^(road|us-|default)/.test(k));
const RENAME = {
  camping: "campsite", "bus_stop.12": "bus_11", square_train: "railway_11", "oneway-path": "oneway",
  "aerodrome.12": "airport_11", peak: "mountain",
  "place-6": "circle_11_black", "place-capital-8": "star_11", " ": "",
};
// subclass if the sprite has it, else class, else the fallback (no icon, label only).
const poiIcon = (fallback) => ["case",
  ["in", ["get", "subclass"], ["literal", icons]], ["get", "subclass"],
  ["in", ["get", "class"], ["literal", icons]], ["get", "class"], fallback];
const SHIELD = ["concat", "road_", ["to-string", ["min", 6, ["max", 1, ["coalesce", ["get", "ref_length"], 3]]]]];
const renameDeep = (v) => typeof v === "string" ? (v in RENAME ? RENAME[v] : v) : Array.isArray(v) ? v.map(renameDeep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renameDeep(x)])) : v;

// JSON.stringify(_, null, 2), except long string lists (the icon names) stay on one line.
const pretty = (v, ind = "") => {
  if (Array.isArray(v) && v.length > 60 && v.every((x) => typeof x === "string")) return JSON.stringify(v);
  if (!v || typeof v !== "object") return JSON.stringify(v);
  const next = ind + "  ";
  const items = Array.isArray(v) ? v.map((x) => next + pretty(x, next)) : Object.entries(v).map(([k, x]) => next + JSON.stringify(k) + ": " + pretty(x, next));
  if (!items.length) return Array.isArray(v) ? "[]" : "{}";
  return (Array.isArray(v) ? "[\n" : "{\n") + items.join(",\n") + "\n" + ind + (Array.isArray(v) ? "]" : "}");
};
const darkUrl = new URL("../src/styles/osm-dark.json", import.meta.url);
const darkText = readFileSync(darkUrl, "utf8");
const dark = JSON.parse(darkText.replace(/^﻿/, ""));
let changed = 0;
for (const l of dark.layers) {
  const img = l.layout?.["icon-image"];
  if (img === undefined) continue;
  const before = JSON.stringify(img);
  if (/shield$/i.test(l.id)) {
    l.layout["icon-image"] = SHIELD;
    l.layout["icon-text-fit"] = "none";
    delete l.layout["icon-text-fit-padding"];
    l.paint = { ...(l.paint ?? {}), "text-color": "hsl(0, 0%, 15%)" };
  } else if (typeof img === "string" && /^\{(sub)?class\}$/.test(img) || (Array.isArray(img) && img[0] === "coalesce")) {
    l.layout["icon-image"] = poiIcon(l.id === "Shop" ? "shop_11" : "");
  } else if (!(Array.isArray(img) && img[0] === "case")) {
    l.layout["icon-image"] = renameDeep(img);
  }
  if (["City labels", "Capital city labels"].includes(l.id)) l.layout["icon-size"] = 0.4;
  if (JSON.stringify(l.layout["icon-image"]) !== before) changed++;
}
const out = (darkText.startsWith("﻿") ? "﻿" : "") + pretty(dark) + "\n";
if (out !== darkText) writeFileSync(darkUrl, out);
console.log(`osm-dark.json: ${changed} icon-image values mapped to the OFM sprite`);
