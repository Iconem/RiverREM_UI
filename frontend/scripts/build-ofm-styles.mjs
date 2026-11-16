// Fetch OpenFreeMap's Dark and Positron styles and write their layers to
// src/styles/ofm-<name>.json, ids prefixed so they can sit next to Liberty's in
// the one static style (MapView.tsx). All three share the same sources
// (openmaptiles planet + ne2_shaded), sprite and glyph server, which MapView
// takes from ofm-liberty.json. No API key. Re-run to pick up upstream changes:
//   node scripts/build-ofm-styles.mjs
import { writeFileSync } from "node:fs";

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
