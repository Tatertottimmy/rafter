# Rafter — parametric Minecraft roof designer (browser, static files)

Single-page static web app. No build step. Plain ES modules. Must run from a plain
static file host (nginx/apache) AND inside a sandboxed iframe. All files live flat in this folder.

Files and OWNERSHIP (one agent per group; do not edit files you don't own):

| File          | Owner  | Purpose |
|---------------|--------|---------|
| blocks.js     | ENGINE | Material catalog (block families: full / slab / stairs / wall ids + colors) |
| engine.js     | ENGINE | design -> block grid (roof height fields, rasterization, stairs facing/shape, walls, pillars) |
| export.js     | EXPORT | NBT writer; Litematica (.litematic) and Sponge v2 (.schem) encoders (uncompressed bytes; caller gzips) |
| viewer3d.js   | VIEWER | Three.js renderer + mouse interaction (select, drag-move, resize handles, slicing) |
| textures.js   | VIEWER | Procedural 64x64 block textures per family (canvas), used by the 3D view AND by UI swatches |
| plans.js      | UI     | 2D layer plan canvas drawing, per-layer legend |
| app.js        | UI     | State, side panel UI, wiring, JSON save/load, downloads (gzip via pako global) |
| index.html    | UI     | Markup + all CSS (inline style) + importmap + script tags |
| test/*.mjs    | each   | Node tests (Node 18+): `node --test test/*.test.mjs` |

Everything below is a CONTRACT. If you must deviate, add a comment `// SPEC-DEVIATION:` explaining why.

## Coordinates

Minecraft axes: +x = east, +y = up, +z = south. north = -z, west = -x.
Block at integer (x,y,z) occupies [x,x+1)×[y,y+1)×[z,z+1). Three.js uses the same right-handed
y-up frame; map MC (x,y,z) -> three (x,y,z) directly (no flip). Plan view: north up, so canvas row = z - minZ,
canvas column = x - minX.

Directions: 'north'|'south'|'east'|'west'. Offsets (dx,dz): north (0,-1), south (0,+1), east (+1,0), west (-1,0).
rotateYCCW: north->west->south->east->north. rotateYCW: north->east->south->west->north.

## Design model (JSON, serializable; this is what gets saved/loaded)

```js
{
  version: 1,
  name: "Farmhouse",
  author: "",
  dataVersion: 4440,          // Minecraft data version written into schematics (1.21.8 = 4440); user editable
  boxes: [Box],               // footprints; roofs are the max-union of all box roofs
  pillars: [Pillar],
  segments: [Segment],        // free-standing straight wall segments
}
Box = {
  id: "b1", name: "Main hall",
  x: 0, z: 0, w: 11, d: 7,    // footprint columns x..x+w-1, z..z+d-1 (w,d >= 1, integers)
  baseY: 0,                   // lowest wall layer
  wallH: 4,                   // walls occupy y = baseY .. baseY+wallH-1. Eave height E = baseY + wallH
  walls: true,                // generate perimeter walls
  floor: false,               // fill interior (non-perimeter) footprint columns at layer baseY with wallMaterial
  wallMaterial: "oak_planks", // family key from blocks.js (uses .full)
  roof: {
    type: "gable",            // "flat" | "shed" | "gable" | "hip" | "halfhip" | "gambrel" | "mansard" | "round"
    axis: "x",                // "x" | "z". Ridge runs along this axis (gable/halfhip/gambrel). Ignored for hip/mansard/flat/shed.
    shedLow: "south",         // shed only: side of the LOW eave ("north"|"south"|"east"|"west"); roof rises away from it
    rise: 1,                  // rise (blocks) per 1 block of run. Allowed: 0.5, 1, 1.5, 2, 3
    rise2: 0.5, breakAt: 3,   // gambrel/mansard: slope after the break; break happens at run distance breakAt from the eave column
    clip: 2,                  // halfhip: the hip on the gable ends starts clip blocks above the eave height
    overhang: 1,              // integer >= 0, columns beyond footprint that still carry roof
    ridgeCap: "block",        // "block" | "slab" | "wall"  (see Rasterization)
    soffit: false,            // upside-down stairs under the outermost overhang column (see Rasterization)
    material: "spruce",       // family key; ANY family (no slab/stairs -> full blocks)
    profile: "straight",      // "straight" | "rounded" | "flared" | "bell" (curved roofs; ignored by flat/gambrel/mansard)
  },
  details: {                  // automatic details (all off by default)
    trim: false, ridge: false, corners: false, base: false, beams: false, windows: false,
    trimMat: "dark_oak", cornerMat: "spruce_log", baseMat: "cobblestone", beamMat: "stripped_spruce_log", windowMat: "glass",
  }
}
Pillar  = { id: "p1", x: 3, z: 3, baseY: 0, h: 4, material: "oak_log" }
Segment = { id: "s1", x0: 0, z0: 0, x1: 5, z1: 0, baseY: 0, h: 3, material: "cobblestone" }  // axis-aligned, inclusive ends
```

## blocks.js (ENGINE owns)

```js
export const FAMILIES = {
  spruce: { name: "Spruce planks", full: "minecraft:spruce_planks", slab: "minecraft:spruce_slab", stairs: "minecraft:spruce_stairs", wall: null, color: "#6b4a2b", group: "Wood", pattern: "planks" },
  stone_bricks: { name: "Stone bricks", full: "minecraft:stone_bricks", slab: "minecraft:stone_brick_slab", stairs: "minecraft:stone_brick_stairs", wall: "minecraft:stone_brick_wall", color: "#7a7a7a", group: "Stone", pattern: "stone_bricks" },
  oak_log: { name: "Oak log", full: "minecraft:oak_log", slab: null, stairs: null, wall: null, color: "#6e5a35", group: "Logs", pattern: "log" },
  ...
};
export const FAMILY_KEYS = Object.keys(FAMILIES);
export function roofFamilies()  // keys with slab && stairs
export function fullFamilies()  // all keys
```
Cover: all 1.21 wood planks (oak, spruce, birch, jungle, acacia, dark_oak, mangrove, cherry, bamboo, crimson, warped, pale_oak),
stone/cobblestone/mossy variants, stone bricks (+mossy), andesite/diorite/granite (+polished), bricks, nether bricks, red nether bricks,
sandstone/red sandstone (+smooth), prismarine (+bricks, dark), quartz (+smooth), purpur, end stone bricks,
blackstone (+polished, +polished bricks), deepslate (cobbled, polished, bricks, tiles), mud bricks, tuff (+polished, +bricks),
cut copper (4 oxidation levels: cut_copper, exposed_cut_copper, weathered_cut_copper, oxidized_cut_copper), resin bricks,
smooth stone (slab only -> stairs null). Full-only families for walls/pillars: logs and stripped logs (all woods), terracotta (plain + 16 colors),
concrete (16 colors), wool (16). Colors: approximate average top-face color, hex.
`pattern` (string) picks the procedural texture in textures.js. Allowed values: "planks" | "bricks" | "stone_bricks" | "cobble" | "stone" (noisy) |
"smooth" (flat, faint gradient) | "log" (bark) | "tiles" (deepslate tiles: stepped squares) | "copper" (plates with rivet dots) | "prismarine" (mosaic) |
"wool" (fuzzy noise) | "concrete" (flat) | "terracotta" (soft noise) | "quartz" (smooth with faint seams) | "purpur" (bumpy) | "mud" (irregular bricks) | "sandstone" (horizontal strata).
Blockstate ids must be the real vanilla ids (e.g. "minecraft:quartz_block" full, "minecraft:quartz_slab", "minecraft:quartz_stairs";
"minecraft:nether_bricks" / "minecraft:nether_brick_slab" / "minecraft:nether_brick_stairs"; "minecraft:purpur_block"/"purpur_slab"/"purpur_stairs";
"minecraft:stone_bricks"/"stone_brick_slab"/"stone_brick_stairs"; "minecraft:deepslate_tiles"/"deepslate_tile_slab"/"deepslate_tile_stairs").

## Block grid (engine output; consumed by viewer, plans, export)

```js
Grid = {
  blocks: Map<string, Block>,      // key = `${x},${y},${z}` (blockKey())
  min: {x,y,z}, max: {x,y,z},      // inclusive bounds of all placed blocks; if no blocks, min=max={0,0,0}
  surface: Map<string, {s:number, boxId:string}>,  // key `${x},${z}` -> combined roof surface height (multiple of 0.5)
}
Block = {
  id: "minecraft:spruce_stairs",   // full vanilla id
  props: { facing:"north", half:"bottom", shape:"straight", waterlogged:"false" }   // stairs
       | { type:"bottom", waterlogged:"false" }                                        // slab ("bottom" or "top")
       | { up:"true", north:"low", south:"low", east:"none", west:"none", waterlogged:"false" }  // wall
       | {}                                                                            // full block
  kind: "full" | "slab" | "stair" | "wall",
  mat: "spruce",                   // family key
  role: "roof" | "wall" | "pillar" | "floor" | "segment",
  color: "#6b4a2b",
}
export function blockKey(x,y,z) => `${x},${y},${z}`
export function parseKey(key) => [x,y,z]
export function stateString(block) => "minecraft:spruce_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]" (props sorted alphabetically by key; no brackets if no props)
export function buildGrid(design) => Grid
export function defaultDesign() => a sample Design: an 11x7 gable main hall (spruce roof, rise 1, overhang 1) crossed by a 5x9 gable wing (makes valleys), a small hip porch (rise 0.5 slab roof), a 3x3 gable dormer on the main roof (baseY above the main roof surface, walls on), two oak_log pillars at the porch corners.
export function materialTotals(grid) => Array<{id: block.id, name: FAMILIES[mat].name + " " + kind label, count}> sorted by count desc. Group by block.id only (ignore props).
export function newId(design, prefix) => unused id like "b3"
export function validateDesign(design) => design (fills defaults for missing fields, clamps numbers)
```

## Roof surface + rasterization (ENGINE) — follow exactly

1. For every box, the roof region R_b = footprint expanded by overhang on all four sides (columns x-oh..x+w-1+oh, z-oh..z+d-1+oh).
   Eave height E = baseY + wallH. For column (cx,cz) in R_b define distances to the region edge (0 at the outermost column):
   dxW = cx - (x-oh), dxE = (x+w-1+oh) - cx, dzN = cz - (z-oh), dzS = (z+d-1+oh) - cz.
   dX = min(dxW,dxE), dZ = min(dzN,dzS).
   Surface height s_b(cx,cz):
   - flat:    E
   - shed:    E + rise * dist, where dist = distance from the shedLow edge (dzN if shedLow=north, dzS if south, dxE if east, dxW if west)
   - gable:   E + rise * (axis=="x" ? dZ : dX)          // ridge runs along axis
   - hip:     E + rise * min(dX,dZ)
   - halfhip: min( E + rise*dAcross,  E + clip + rise*dAlong ) where dAcross = (axis=="x"? dZ : dX), dAlong = the other one
   - gambrel: E + g(dAcross) with g(d) = d <= breakAt ? rise*d : rise*breakAt + rise2*(d-breakAt)
   - mansard: E + g(min(dX,dZ))
2. Combined surface S(cx,cz) = max over boxes whose region contains the column; record winning boxId (ties: later box in array wins).
   Store in grid.surface. Round s to nearest 0.5 defensively.
3. Rasterize each column with surface s (box b = winner, rise r = b.roof.rise, material m):
   - Neighbor surfaces: for each of the 4 directions, n = S(neighbor) if defined, else VIRTUAL = s - r (the slope continues off the eave).
   - sMin = min of the 4 neighbor values; lowDirs = directions whose n < s.
   - Decide the TOP:
     a. if frac(s) == 0.5: bottom slab at layer floor(s).
     b. else (integer s): topLayer = s - 1.
        - RIDGE iff lowDirs contains both members of at least one opposite pair (north&south or east&west). Then:
          ridgeCap "block" -> full block at topLayer; "slab" -> bottom slab at topLayer; "wall" -> if family has .wall then wall block (up "true", connections "low" toward neighbors that are also ridge cells, else "none"), else full block.
        - else if (s - sMin) <= 0.5: full block at topLayer  (slab-pitch roofs alternate slab / full)
        - else: STAIR at topLayer, half "bottom", facing = opposite of the lowest neighbor direction (ties broken in order north,east,south,west), shape computed in step 5.
   - FILL below the top so no light leaks: fillFrom = (frac(sMin)==0.5) ? floor(sMin) : sMin ; place full blocks (material m, role roof) at layers fillFrom .. topLayer-1 where topLayer is the layer of the TOP block. Skip if range empty.
   - Soffit (if b.roof.soffit && overhang>=1): for columns on the outermost ring of R_b where the TOP was a stair at layer t: if cell (t-1) is empty, place a stair half "top", facing = direction pointing OUT of the region (toward the eave side), material m, role roof. Shape also computed in step 5.
4. A ridge full block MUST NOT be replaced by a stair; the apex of a hip (all 4 lower) is a ridge too.
5. Stair SHAPE pass (after all roof blocks are placed, before walls): for every stair block implement vanilla StairsBlock.getStairShape exactly:
   ```
   front = block at pos + facing
   if front is stair && same half:
     f2 = front.facing
     if axis(f2) != axis(facing) && isDifferent(pos + opposite(f2)):
        return f2 == rotateYCCW(facing) ? "outer_left" : "outer_right"
   back = block at pos + opposite(facing)
   if back is stair && same half:
     f3 = back.facing
     if axis(f3) != axis(facing) && isDifferent(pos + f3):
        return f3 == rotateYCCW(facing) ? "inner_left" : "inner_right"
   return "straight"
   isDifferent(p): other = block at p; return !(other is stair) || other.facing != this.facing || other.half != this.half
   ```
6. Walls (per box with walls=true): perimeter columns of the FOOTPRINT (not the overhang). For each perimeter column, find the lowest layer of any role "roof" block in that column (if none, use E); walk y downward from that layer - 1 down to baseY; at each y: if the cell is occupied by anything -> STOP walking; else place full block wallMaterial, role "wall". Gable ends fill automatically; dormer walls stop at the main roof.
   Floor (floor=true): interior footprint columns at layer baseY, wallMaterial, role "floor", only into empty cells.
7. Pillars: full blocks at (x, baseY..baseY+h-1, z), only into empty cells, role "pillar".
   Segments: all columns on the inclusive axis-aligned line (if not axis aligned, use x0..x1 at z0), layers baseY..baseY+h-1, only into empty cells, role "segment".
8. Order: roofs (all boxes) -> stair shapes -> walls -> floors -> pillars -> segments. Compute min/max.

Slab props: {type:"bottom", waterlogged:"false"}. Stair props: {facing, half, shape, waterlogged:"false"}. Full: {}.

## export.js (EXPORT owns) — pure, no DOM, no pako dependency

```js
export function encodeLitematic(grid, {name, author, description, dataVersion}) => Uint8Array  // UNcompressed NBT; caller gzips
export function encodeSchem(grid, {dataVersion}) => Uint8Array                                  // UNcompressed Sponge v2 NBT; caller gzips
export function writeNBT(rootName, compoundTag) => Uint8Array   // generic writer; export tag helpers too (tagInt, tagLong, tagString, tagList, tagCompound, tagLongArray, tagByteArray, tagShort, tagIntArray)
```
Litematic (Litematica format Version 6, SubVersion 1):
root compound named "" containing: Version (int 6), SubVersion (int 1), MinecraftDataVersion (int), Metadata (compound: Name, Author, Description strings; RegionCount int 1; TotalVolume int; TotalBlocks int (non-air count); TimeCreated long ms; TimeModified long ms; EnclosingSize compound {x,y,z ints}),
Regions (compound with ONE region whose key = design name, containing: Position {x:0,y:0,z:0} ints, Size {x,y,z} ints, BlockStatePalette (list of compounds {Name string, Properties compound of string values; omit Properties if empty}; index 0 = minecraft:air), BlockStates (long array), Entities (empty list), TileEntities (empty list), PendingBlockTicks (empty list), PendingFluidTicks (empty list)).
Region origin = grid.min; local coords lx = x - min.x etc. index = (ly*sizeZ + lz)*sizeX + lx.
Bit packing = Litematica's LitematicaBitArray: bits = max(2, ceil(log2(paletteSize))); entries packed LSB-first starting at bit 0 of long[0]; entries MAY span across long boundaries (unlike vanilla 1.16+). Long array length = ceil(volume*bits/64). Longs written big-endian as TAG_Long_Array (tag id 12).
Sponge v2 .schem: root compound named "Schematic": Version int 2, DataVersion int, Width/Height/Length shorts (x,y,z sizes), Offset int[3] = [0,0,0], PaletteMax int, Palette compound {stateString: int id} (include "minecraft:air": 0), BlockData byte array of unsigned LEB128 varints, index = lx + lz*Width + ly*Width*Length, BlockEntities empty list, Metadata compound {} (empty).
Empty NBT lists: TAG_List with element type 0 (TAG_End) and length 0.
Strings: UTF-8 with u16 big-endian length prefix. All multi-byte values big-endian.
NBT tag ids: End 0, Byte 1, Short 2, Int 3, Long 4, Float 5, Double 6, ByteArray 7, String 8, List 9, Compound 10, IntArray 11, LongArray 12.
Provide a decoder in test/ to round-trip and assert palette, sizes and a few sampled block indices.

## viewer3d.js (VIEWER owns)

ES module. Imports: `import * as THREE from 'three'; import { OrbitControls } from 'three/addons/controls/OrbitControls.js'; import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';`
index.html provides the importmap:
```html
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
```
```js
export class Viewer {
  constructor(containerEl, callbacks)
  // callbacks: { onSelect(id|null), onMove(id, patch) /* live during drag, snapped ints: boxes {x,z}, pillars {x,z}, segments {x0,z0,x1,z1} */,
  //              onResize(id, {x,z,w,d}) /* live during handle drag, boxes only */, onCommit() /* pointerup after a move/resize that changed something */ }
  setDesign(design)      // (re)build pick proxies (invisible boxes per box: footprint × (wallH + roof height), per pillar, per segment),
                         // footprint outline (thin line at baseY) for every box, overhang outline (dashed) + 4 resize handles (small cubes at mid-edges of the top at height E) for the SELECTED box only
  setGrid(grid)          // rebuild instanced meshes: InstancedMesh per geometry kind (full, slab bottom, slab top, 5 stair shapes × 2 halves, wall post), per-instance color from block.color; MeshLambertMaterial + hemisphere + directional light. GridHelper at y = grid.min.y with 1-block cells.
  setSelection(id|null)
  setSliceY(yMax|null)   // when set, hide all blocks with y > yMax. Blocks with y == yMax get a highlight tint (lerp color 35% toward white).
  frameAll()             // fit camera to grid bounds
  resize()               // also observe container with ResizeObserver internally
  dispose()
}
```
Interaction: left-drag on empty space orbits (OrbitControls); wheel zooms; right-drag pans. Pointerdown on a pick proxy selects it (onSelect) and begins a MOVE drag: raycast to the horizontal plane y = the object's baseY; delta snapped to integers; call onMove with new ints. Pointerdown on a resize handle begins a RESIZE drag along its axis: east handle changes w (min 1); west handle changes x and w; south changes d; north changes z and d; onResize with ints. OrbitControls disabled during these drags. onCommit on pointerup if anything changed. Click (no drag) on empty space -> onSelect(null).
Stair geometry, facing north, half bottom: base slab [0,1]×[0,0.5]×[0,1] + top piece [0,1]×[0.5,1]×[0,0.5] (north half = low z). outer_left north = top piece is only the NW quarter x∈[0,0.5], z∈[0,0.5]; outer_right north = NE quarter x∈[0.5,1], z∈[0,0.5]. inner_left north = top covers all but the SE quarter; inner_right north = all but the SW quarter. half "top" = mirror vertically (y -> 1-y). Rotation about +y: east = -90°, south = 180°, west = +90° (so the facing vector (0,0,-1) maps onto the facing direction). Build geometries by merging BoxGeometries. Wall kind: 0.5-wide post (x,z ∈ [0.25,0.75], full height) plus 0.5-wide arms of height 0.875 toward "low" connections.
Must handle grids up to ~150k blocks; dispose old meshes on setGrid.
Camera: PerspectiveCamera fov 50; initial view from the south-east, elevated; OrbitControls target at grid center.
Background color: read CSS variable --viewport-bg from the container's computed style on construction and on every setGrid; fallback #1c1f24.

## textures.js (VIEWER owns) — shared by viewer and UI

```js
export function familyTexture(familyKey) => HTMLCanvasElement  // 64×64, cached per family; deterministic (seeded PRNG) procedural pattern per FAMILIES[key].pattern, tinted from FAMILIES[key].color: seams/mortar ~25% darker, highlights ~10% lighter, mild per-pixel noise. Must look like the Minecraft block it stands in for at a glance.
export function swatchDataURL(familyKey) => string           // data: PNG of the 64×64 texture (cached)
export function familyIcon(familyKey, size=28) => HTMLCanvasElement  // small canvas: isometric mini-cube (top face = texture, sides darkened) for palette chips
```
No DOM dependency beyond document.createElement('canvas'). No three.js import here.

Viewer uses these: one MeshLambertMaterial per family with `map = new THREE.CanvasTexture(familyTexture(key))` (NearestFilter, no mipmaps-blur: magFilter Nearest), so instanced meshes are per (geometry kind × family). Faces: box geometries use the same texture on all faces; the hemisphere light handles top/side shading. Slice highlight: use `material.emissive` on a cloned highlight material instead of per-instance color.

## plans.js (UI owns)

```js
export function drawLayer(canvas, grid, y, opts)  // opts: {cell: px per block (default 22), bounds: {minX,maxX,minZ,maxZ} (default grid bounds), ghostBelow: true (layer y-1 drawn faded underneath), showGrid: true}
// North up. Full block = solid fill block.color + 1px darker border. Slab bottom = fill + 45° hatch; slab top = hatch + bar along the top edge. Stair = fill + bold arrow pointing in `facing` (uphill); outer corner: dot in the tall quarter; inner corner: hollow dot in the low quarter. Top-half stairs: hollow arrow. Wall kind: small centered square. Label every 5th column/row with absolute MC x / z in the margin.
export function layerLegend(grid, y) => Array<{id, kind, mat, name, count, color}>  // what appears on this layer
export function layerRange(grid) => {minY, maxY}
```

## app.js + index.html (UI owns)

DESIGN STANDARD from the user: "I want to be able to pick the palette and visually see the blocks." Every material choice is made from a VISUAL swatch grid (never a bare dropdown): a button showing the current material's icon (familyIcon) + name opens a popover with a search box and swatches (swatchDataURL thumbnails, name under each) grouped by FAMILIES[].group; roof pickers only show roofFamilies(). Header has a PALETTE BAR: chips (familyIcon + name + block count) for every family currently used in the design; clicking a chip opens the same swatch popover and swaps that family everywhere it is used (roof.material / wallMaterial / pillar / segment). Plans canvas uses block.color fills (fine), legend rows show familyIcon.
Layout: header bar (app name "Rafter", design name input, palette bar, Save/Load JSON buttons, Undo/Redo) ; left panel (object list: boxes / pillars / segments with add buttons; properties editor for the selected object: all fields of the model with sensible inputs — selects for type/axis/shedLow/rise/ridgeCap/materials (grouped by family group), number inputs for geometry, checkboxes for walls/floor/soffit; delete button) ; center: 3D viewport filling remaining space with an overlay slice slider ("Show up to layer") and a "Frame" button ; right panel with tabs: "Layer plans" (layer stepper, canvas, legend for that layer), "Materials" (totals table from materialTotals), "Export" (.litematic / .schem download buttons, data version field, help text).
Everything live: any change -> buildGrid -> viewer.setGrid + redraw current plan + materials. Debounce ~30ms. One shared currentLayer state drives both the 3D slice and the plan canvas (toggle "Slice 3D view to this layer", default on).
Downloads: gzip with pako.gzip(bytes) (pako 2.1.0 UMD from cdnjs: https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js, loaded with a classic script tag BEFORE the module script), save via Blob + a.download. Note under the buttons: "If the download does not start you are in an embedded preview; open the hosted copy of Rafter."
Persist the design to localStorage ("rafter.design") on change, wrapped in try/catch; "Reset to sample" button restores defaultDesign().
Undo: history stack (max 50) of design JSON pushed on each commit; Ctrl+Z / Ctrl+Y (ignore when focus is in an input).
Keyboard: Delete removes the selected object (not when in an input); arrow keys nudge the selection 1 block (Shift = 5).
Phone width: panels stack vertically under the viewport (viewport min height 50vh). No horizontal page scroll.
Design tokens (in :root with dark variants):
  Light: --bg #f3f1ec, --panel #ffffff, --fg #1f1d1a, --muted #6d675d, --line #d9d4ca, --accent #a4511f, --accent-fg #ffffff, --viewport-bg #e5e1d8
  Dark:  --bg #15171a, --panel #1d2024, --fg #e8e4dc, --muted #9a948a, --line #2e3237, --accent #d9814a, --accent-fg #1a120c, --viewport-bg #1c1f24
  Type: display "Bricolage Grotesque" (Google Fonts) for the app name and panel titles; body/UI "IBM Plex Sans"; numbers/ids "IBM Plex Mono". Real fallback stacks.
Page contract (the artifact host wraps the file in its own doctype/head/body): write index.html WITHOUT doctype/html/head/body wrappers — start with `<title>Rafter</title>` and `<meta name="claude:viewport-fit-sides" content="cover">`, then the Google Fonts link, then `<style>`, then markup, then scripts. Browsers also render this fine when served as-is from a normal web host. Side gutter: `padding-left: max(16px, env(safe-area-inset-left, 0px))` and the right equivalent on the outer wrapper; vertical padding via padding-block. Toggle visibility with el.hidden. No alert/confirm/prompt; build confirmations into the UI. body background must be var(--bg). Dark theme via BOTH `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {...; color-scheme: dark} }` and `:root[data-theme="dark"] {...; color-scheme: dark}`. Every form control gets a stable id. Respect prefers-reduced-motion. Visible focus states.

## Additions (v2)

- **Catalog**: 332 families. New optional family fields: `pane` (glass pane id), `fullProps` (props for the
  full block, e.g. leaves `persistent=true`), `axis: true` (block has an axis state), `color2` (second colour for
  two-tone textures: ores, glazed terracotta), `transparent: true` (glass, ice, grates: see-through in the viewer).
  `GROUP_ORDER` orders the picker groups. New patterns: glass, ore, leaves, glazed, grainy, metal, chiseled, grate.
- **Block kind `pane`**: props `{east,west,north,south,waterlogged}`; viewer draws a thin post plus arms.
- **Curved roofs** (`roof.profile`): surface = E + rise·D·f(d/D), D = the full run of that slope (same total height as
  straight). f: rounded = sin(tπ/2), flared = 1−cos(tπ/2), bell = (1−cos tπ)/2. Off-region neighbours extrapolate with
  the first step's slope clamped to 0.5..rise.
- **Round roof** (`type: "round"`): ellipse inscribed in the region; d = (1 − r)·min(hx, hz); square corners stay at
  eave height. With the straight profile it is a cone/spire, with rounded a dome.
- **Seal pass** (after stair shapes): any roof stair/slab whose upper half does not cover its face toward a taller
  column gets that column's fill extended down to it, so curved roofs never show see-through gaps.
  `test/seal.test.mjs` floods outside air at half-block resolution to prove it.
- **Details** (wall pass): base course at baseY > corner posts (axis y) > eave beams at E−1 (axis along the wall) >
  windows (panes, rows baseY+1..baseY+min(wallH−2,3), every 3rd column symmetric about each side's centre, never next
  to a corner) > wall material. Trim = the outermost ring of the roof region in trimMat; ridge = ridge cells in trimMat.
- **UI**: any block in every picker; Presets (built-in + saved to localStorage "rafter.presets"); Auto details
  (per box and for all boxes); delete is immediate with an Undo button in the toast.

## Additions (v3)

- **Block sources**: every generated block carries `src` (object id) and `path` (the material field that
  produced it: `wallMaterial`, `roof.material`, `details.trimMat`, ..., or `material` for pillars and
  segments). Paint in "Whole part" mode sets that field on that object.
- **Texture variation** (`box.variation`): `{ wall, roof }` percentages (0–100), `style`
  (`patches` | `scatter` | `grime` | `streaks`), up to two mixes per surface (`wallMix`, `wallMix2`,
  `roofMix`, `roofMix2`; `''` = `suggestVariants(main material)`), `seed`. Applied after walls, floors,
  pillars and segments, only to blocks whose `path` is `wallMaterial` or `roof.material`. A block keeps its
  shape and state (`reskin`); if the mix lacks that shape the block is left alone. Deterministic per seed.
- **Hand edits**: `{ x, y, z, shape, mat?, half?, facing?, axis? }`, `shape` one of `paint` (re-material
  the existing block, keeping shape; no-op on air), `full` | `slab` | `stair` (place), `erase`.
  `design.edits` use world cells; `box.edits` are relative to `(box.x, box.baseY, box.z)` so they move
  with the box, and `rotatePatch` turns them (cells, stair facing, log axis) with it. Applied last, in order
  box edits then design edits; one edit per cell (the last wins). Stair shapes are recomputed afterwards.
- **Irimoya** (`type: "irimoya"`): `dAlong >= clip` → gable `E + slope(dAcross)`; else hip `E + slope(min(dAcross, dAlong))`.
  `clip` is the depth of the hip skirt on the ends; the gable face stands on it.
- **Upturned corners** (`roof.upturn` 0–16 blocks, `roof.upturnReach` 1–64, default 6), for gable, hip, halfhip,
  irimoya, gambrel, mansard: surface += upturn·(1 − a/reach)² for a < reach, a = max(dX, dZ) (Chebyshev distance to
  the nearest region corner, ≥ 0 so off-region neighbours hold the full lift).
- **Multi-box fill**: a column's fill depth and the seal pass follow only the column's own box. A lower roof of
  another box next door no longer drags a tower's roof edge down into a curtain over its walls.
- **Chopped roofs** (`roof.cut` 0–128, 0 = off): `s = min(s, E + cut)` after the corner lift, so the roof ends in a flat
  plateau of full roof blocks.
- **Fills** (`design.fills`, id prefix `f`): `{ id, x, z, w, d (1–256), baseY, h (1–128), material, shape (full | slab |
  stair | pane), half, facing, axis, outline (rect | circle), hollow }`. Built after segments, only into empty cells,
  `role: "fill"`, `path: "material"`. `inOutline()` (exported) tests a column: circle = the ellipse fitting w × d, at
  cell centres, `u² + v² ≤ 1.08`; hollow keeps cells with a 4-neighbour outside the shape. `rotatePatch('fill')`
  swaps w/d about the centre and turns facing / pane axis. Area-mode place drags create one; Make fill converts a
  solid cuboid of identical placed edits into one.
- **Roof caps** (`roof.cap` solid | slab | open, `roof.capMat`, `''` = roof material): columns on the flat of a chopped
  roof (`kind: full` and `s >= E + cut`) are the cap. `slab` puts a bottom slab there; `open` leaves out cap columns whose
  four neighbours are all cap columns of the same box, keeping a one-block rim. Cap blocks carry `path: "roof.capMat"`
  when a cap material is set.
- **Roof tiers** (`box.stack` auto | stack | merge): steps 1–3 (and the soffit) run once per tier, each tier with its own
  height map and per-column `roofMin`. B is on a higher tier than A (tier = 1 + A's) when their footprints overlap and:
  `stack` → B's eave > A's eave; `auto` → (B.baseY > A.baseY and B.baseY ≥ top − 1) or (B's eave > A's eave and B's eave
  > wallTop, or ≥ wallTop when B's footprint is strictly inside A's), top = A's highest surface over the overlap, wallTop =
  A's highest surface on B's perimeter columns inside A's region (a dormer on A's wall line, buried in the slope, merges);
  `merge` → never. Higher tiers overwrite lower ones on collision. For a stacked box with walls, lower-tier roof blocks in
  its footprint (walls included) at or above its base are removed, as are lower-tier eaves outside the lower box whose
  nearest footprint cell lies in the stacked box (no ledge across a tower flush with a gable end); lower-tier walls stop
  below a stacked box's base in its footprint. Step 5 and the seal pass
  then run once over everything; walls start under their own tier's roof.
