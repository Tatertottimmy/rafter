# Rafter

Try it: **https://mikemadeit.io/rafter/**

## Run it on your own computer (no install)

1. Download **[rafter.html](https://github.com/Tatertottimmy/rafter/releases/latest/download/rafter.html)**
   (or the same file from the Export tab on the website).
2. Double-click it. It opens in your browser and works offline.

That one file has everything inside it (the app, the 3D engine and the fonts), so there is
nothing else to install. Designs are kept in that browser; use **Save JSON** to keep a copy or
move a design to another computer.

Parametric Minecraft roof designer that runs in the browser. Lay out footprint boxes, pick a roof
type and pitch per box, and Rafter builds the roof the way Minecraft builders do: slabs for 1:2,
stairs for 1:1, block-plus-stair for 2:1, with vanilla stair corner shapes at hips and valleys.
Roofs from overlapping boxes merge automatically, so crossing gables make valleys and a small box on
a big roof makes a dormer. Output: a 3D preview, layer-by-layer build plans, a materials list, and
`.litematic` / `.schem` schematics.

Also: every building block (332, from planks to glazed terracotta, leaves and glass), curved roofs
(rounded / flared pagoda / bell), Japanese irimoya roofs and upturned eave corners, round domes, cones and spires, style presets you can save,
and one-click details (roof trim, ridge, corner posts, eave beams, foundation course, glass-pane windows).

Static files only. No build tooling, no server code.

## Files

| File | What it is |
|------|------------|
| `page.html` | The page source (body only; the claude.ai artifact host wraps it) |
| `index.html` | Generated from `page.html` by `python build.py`; this is what a web server serves |
| `app.js` | UI state, panels, swatch pickers, downloads |
| `engine.js` | Design -> blocks (height fields, rasterization, stair shapes, walls, pillars) |
| `blocks.js` | Material catalog (155 block families with ids, colours, texture pattern) |
| `textures.js` | Procedural block textures used by the 3D view and the swatches |
| `viewer3d.js` | Three.js renderer and mouse interaction |
| `plans.js` | Layer plan canvas and legend |
| `export.js` | NBT writer, Litematica v6 and Sponge v2 encoders |
| `SPEC.md` | Module contract (data model, algorithm, interfaces) |
| `test/` | Node tests plus `sample-farmhouse.litematic` / `.schem` built from the sample design |

External dependencies load from CDNs at runtime: three.js 0.160.0 (jsDelivr), pako 2.1.0 (cdnjs),
Google Fonts. The page needs internet access for those; everything else is local.

## Building

No build step is needed to develop: serve the folder with any static web server
(`python3 -m http.server`, nginx, Caddy, ...) and open it. `.js` files must be served as
`text/javascript`, which every common server does by default.

- `python3 build.py` regenerates `index.html` after editing `page.html`.
- `node standalone.mjs` (Node 18+) builds `dist/rafter.html`, the single offline file, with
  three.js, pako and the fonts inlined. It downloads its build tools once into `.standalone-cache/`.

## Using it

- **Boxes** are footprints. Click one in the list or in the 3D view, drag it to move, drag the
  edge handles to resize (hold Shift to keep it square), drag the round corner handle to rotate in
  90° steps (or press R / Shift+R, or the Rotate button), or type exact numbers in Properties. Wall
  segments rotate too.
- **Move arrows**: a selected box, pillar or wall segment shows red (x), green (up/down) and blue (z)
  arrows. Drag one to move along just that axis; the green one lifts the box, e.g. to sit a tower or
  spire on top of another roof. Keys: arrows move, Page Up / Page Down raise and lower (Shift = 5).
- **Roof types**: flat, shed, gable, hip, half-hip (jerkinhead), irimoya (Japanese hip-and-gable:
  a hip skirt on the ends with a gable standing on it), gambrel, mansard, round. **Upturned corners**
  curl the eaves up into each corner (lift in blocks + how far along the eave the curl reaches); try it
  with the Japanese preset. Pitch is rise per
  block of run: 0.5 (slabs), 1 (stairs), 1.5, 2 (block + stair), 3. Overhang, ridge cap
  (block / slab / wall), and under-eave soffit stairs are per box.
- **Tools** (bar at the bottom of the 3D view): **Select** (V) moves and edits objects. **Paint** (B)
  repaints the whole wall, roof, trim, post or foundation you click, or just one block in
  "One block" mode. **Place** (P) puts a block, slab or stairs against the face you click or on the
  ground; stairs face the way you look, slabs go top or bottom by where you click. **Erase** (E)
  removes blocks. Shift+drag paints, places or erases a stroke; Alt+click picks up a block's
  material. The layer plan takes clicks too, on the current layer. In **Select**, click a block
  you placed to select it (Shift+click for more). Drag them to move, or use the arrow keys
  (Shift = 5) and Page Up / Page Down; Delete removes them and R turns stairs. Edits on a box move and rotate
  with it; "Clear edits" removes them all.
- **Texture**: per box, mix a share of look-alike blocks into the walls and roof (mossy and
  cracked bricks, nearby wood tones, ...) as patches, scatter, grime (heavier low down) or
  streaks. Mixes are picked automatically or chosen by hand; Reshuffle gives a new layout.
- **Peaks and valleys** come from overlapping boxes; the higher roof wins at each column.
- **Walls** are generated under the roof per box (gable ends fill automatically) and stop where they
  would enter another box's room or hit another roof. Add free-standing wall segments and pillars
  from the Objects panel.
- **Palette**: every material is chosen from a swatch grid. The palette bar in the header lists the
  families in use; click a chip to swap that material everywhere.
- **Layer plans**: step through Y layers; arrows point uphill on stairs, hatch marks slabs. The 3D
  view slices to the same layer so you can build along.
- **Export**: `.litematic` for Litematica (put it in `.minecraft/schematics`) or `.schem` for
  WorldEdit. The data version defaults to 5023 (Minecraft 26.3); change it for other versions.
- Designs save as JSON and are also kept in the browser's local storage.

## Tests

```bash
node --test test/*.test.mjs
```

Open `test/viewer.smoke.html` from a local static server to eyeball every stair shape and texture.

## Support

Rafter is free. If it saved you some building time and you'd like to say thanks, you can
[buy me a coffee on Ko-fi](https://ko-fi.com/tatertottimmy). Totally optional.

## License

MIT: free to use, copy, change and share, for any purpose, including commercial. See [LICENSE](LICENSE).
