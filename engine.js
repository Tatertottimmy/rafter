// engine.js — Rafter roof engine (ENGINE owns).
// design -> block grid. Plain ES module: no DOM, runs in Node and browsers.
// Follows SPEC.md "Roof surface + rasterization" step by step; comments name the steps.

import { FAMILIES } from './blocks.js';

// ---------------------------------------------------------------------------------
// Directions (SPEC "Coordinates")
// ---------------------------------------------------------------------------------
export const DIRS = ['north', 'east', 'south', 'west']; // also the SPEC tie-break order
export const DIR_OFFSET = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
export const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
const AXIS_OF = { north: 'z', south: 'z', east: 'x', west: 'x' };
const CCW = { north: 'west', west: 'south', south: 'east', east: 'north' };
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' };
export function rotateYCCW(d) { return CCW[d]; }
export function rotateYCW(d) { return CW[d]; }

export const ROOF_TYPES = ['flat', 'shed', 'gable', 'hip', 'halfhip', 'irimoya', 'gambrel', 'mansard', 'round'];
// Upturned corners (Japanese / Chinese eaves): roof types the corner lift applies to.
export const UPTURN_TYPES = ['gable', 'hip', 'halfhip', 'irimoya', 'gambrel', 'mansard'];
// Slope profile (curved roofs). straight = the SPEC formulas; the others bend the same total
// height (rise × run) along a curve. Ignored by flat, gambrel and mansard.
export const ROOF_PROFILES = ['straight', 'rounded', 'flared', 'bell'];
// Automatic details per box. Materials are FAMILIES keys; flags switch each detail on.
export const DETAIL_DEFAULTS = {
  trim: false, ridge: false, corners: false, base: false, beams: false, windows: false,
  trimMat: 'dark_oak', cornerMat: 'spruce_log', baseMat: 'cobblestone', beamMat: 'stripped_spruce_log', windowMat: 'glass',
  // Window layout: size, sill row (blocks above the base), gap between windows, which walls.
  winStyle: 'pane', winWidth: 1, winHeight: 3, winSill: 1, winGap: 2, winTop: 'flat',
  winNorth: true, winEast: true, winSouth: true, winWest: true,
  frame: false, frameMat: 'stripped_spruce_log', sills: false, sillMat: 'spruce',
  door: false, doorSide: 'south', doorWidth: 1, doorHeight: 2,
  studs: false, studGap: 3,
};
const DETAIL_ENUMS = { winStyle: ['pane', 'block'], winTop: ['flat', 'arch'], doorSide: ['north', 'east', 'south', 'west'] };
const DETAIL_RANGES = { winWidth: [1, 16], winHeight: [1, 16], winSill: [0, 16], winGap: [0, 16], doorWidth: [1, 8], doorHeight: [1, 16], studGap: [2, 16] };
const SIDE_FLAG = { north: 'winNorth', east: 'winEast', south: 'winSouth', west: 'winWest' };
// Pillars: thickness, shape (full blocks or a wall-block post), base and capital.
export const PILLAR_DEFAULTS = { size: 1, shape: 'block', base: 'none', baseMat: 'stone_bricks', cap: 'none', capMat: 'stone_bricks' };
const PILLAR_ENUMS = { shape: ['block', 'wall'], base: ['none', 'block', 'stairs', 'slab'], cap: ['none', 'block', 'stairs', 'slab'] };
// Texture variation: swap a share of wall / roof blocks for look-alike materials so big
// surfaces don't read as one flat repeat. Mix '' = pick automatically (suggestVariants).
export const VARIATION_STYLES = ['patches', 'scatter', 'grime', 'streaks'];
export const MIX_MAX = 6; // blocks a surface's variation can mix in
export const MIX_KEYS = { wall: ['wallMix', 'wallMix2', 'wallMix3', 'wallMix4', 'wallMix5', 'wallMix6'], roof: ['roofMix', 'roofMix2', 'roofMix3', 'roofMix4', 'roofMix5', 'roofMix6'] };
export const VARIATION_DEFAULTS = { wall: 0, roof: 0, style: 'patches', wallMixCount: 2, roofMixCount: 2, ...Object.fromEntries([...MIX_KEYS.wall, ...MIX_KEYS.roof].map((k) => [k, ''])), seed: 1 };
// Hand edits: paint keeps the existing block's shape, place puts a new block, erase clears.
export const EDIT_SHAPES = ['paint', 'full', 'slab', 'stair', 'pane', 'erase'];
/** Block shapes a fill (a solid rectangle of one block) can be made of. */
export const FILL_SHAPES = ['full', 'slab', 'stair', 'pane'];

/**
 * Is column (x, z) inside a w × d footprint at (x0, z0)? "circle" is the ellipse that fits
 * the footprint, tested at cell centres; a hollow shape keeps only its one-block rim.
 */
export function inOutline(outline, x0, z0, w, d, x, z, hollow = false) {
  const inside = (cx, cz) => {
    if (cx < x0 || cz < z0 || cx >= x0 + w || cz >= z0 + d) return false;
    if (outline !== 'circle') return true;
    const u = (cx + 0.5 - (x0 + w / 2)) / (w / 2), v = (cz + 0.5 - (z0 + d / 2)) / (d / 2);
    return u * u + v * v <= 1.08; // a little slack rounds small circles like hand-built ones
  };
  if (!inside(x, z)) return false;
  return !hollow || !inside(x - 1, z) || !inside(x + 1, z) || !inside(x, z - 1) || !inside(x, z + 1);
}
export const EDITS_MAX = 50000;
export const RISES = [0.5, 1, 1.5, 2, 3];
export const RIDGE_CAPS = ['block', 'slab', 'wall'];
export const DEFAULT_DATA_VERSION = 5023; // Minecraft 26.3 world_version (SPEC text says 4440)

const EPS = 1e-6;

// ---------------------------------------------------------------------------------
// Keys and state strings
// ---------------------------------------------------------------------------------
export function blockKey(x, y, z) { return `${x},${y},${z}`; }
export function parseKey(key) { return key.split(',').map(Number); }
export function colKey(x, z) { return `${x},${z}`; }

/** "minecraft:spruce_stairs[facing=north,half=bottom,...]" with props sorted by key. */
export function stateString(block) {
  const props = block.props || {};
  const keys = Object.keys(props).sort();
  if (keys.length === 0) return block.id;
  return `${block.id}[${keys.map((k) => `${k}=${props[k]}`).join(',')}]`;
}

// ---------------------------------------------------------------------------------
// Design validation / defaults
// ---------------------------------------------------------------------------------
function num(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }
function int(v, def, lo, hi) {
  let n = Math.round(num(v, def));
  if (lo !== undefined) n = Math.max(lo, n);
  if (hi !== undefined) n = Math.min(hi, n);
  return n;
}
function snapRise(v, def) {
  const n = num(v, def);
  return RISES.reduce((best, r) => (Math.abs(r - n) < Math.abs(best - n) ? r : best), RISES[0]);
}
function oneOf(v, list, def) { return list.includes(v) ? v : def; }
function str(v, def) { return typeof v === 'string' ? v : def; }
function bool(v, def) { return typeof v === 'boolean' ? v : def; }
/**
 * Resolve a material string to a FAMILIES key, or null. Planks families are keyed by wood
 * name ("oak", "spruce") per the FAMILIES contract, while the design model examples write
 * "oak_planks"; accept that alias (and "minecraft:" prefixes) so saved designs keep working.
 */
export function resolveFamilyKey(v) {
  if (typeof v !== 'string') return null;
  let k = v.startsWith('minecraft:') ? v.slice(10) : v;
  if (FAMILIES[k]) return k;
  if (k.endsWith('_planks') && FAMILIES[k.slice(0, -7)]?.pattern === 'planks') return k.slice(0, -7);
  return null;
}
function familyKey(v, def, needRoof) {
  const k = resolveFamilyKey(v);
  if (!k) return def;
  const f = FAMILIES[k];
  if (needRoof && !(f.slab && f.stairs)) return def;
  return k;
}

/** Fills defaults for missing fields and clamps numbers. Mutates and returns `design`. */
export function validateDesign(design) {
  const d = design && typeof design === 'object' ? design : {};
  d.version = 1;
  d.name = str(d.name, 'Untitled');
  d.author = str(d.author, '');
  d.dataVersion = int(d.dataVersion, DEFAULT_DATA_VERSION, 100);
  d.boxes = Array.isArray(d.boxes) ? d.boxes : [];
  d.pillars = Array.isArray(d.pillars) ? d.pillars : [];
  d.segments = Array.isArray(d.segments) ? d.segments : [];
  d.fills = Array.isArray(d.fills) ? d.fills : [];

  const used = new Set();
  const claim = (obj, prefix) => {
    if (typeof obj.id !== 'string' || obj.id === '' || used.has(obj.id)) obj.id = newId(d, prefix, used);
    used.add(obj.id);
  };

  d.boxes = d.boxes.filter((b) => b && typeof b === 'object');
  for (const b of d.boxes) {
    claim(b, 'b');
    b.name = str(b.name, 'Box');
    b.x = int(b.x, 0, -4096, 4096);
    b.z = int(b.z, 0, -4096, 4096);
    b.w = int(b.w, 5, 1, 512);
    b.d = int(b.d, 5, 1, 512);
    b.baseY = int(b.baseY, 0, -64, 320);
    b.wallH = int(b.wallH, 4, 1, 128);
    b.walls = bool(b.walls, true);
    b.floor = bool(b.floor, false);
    b.stack = oneOf(b.stack, ['auto', 'merge', 'stack'], 'auto'); // how its roof meets lower roofs
    b.wallMaterial = familyKey(b.wallMaterial, 'oak_planks', false);
    const r = b.roof && typeof b.roof === 'object' ? b.roof : {};
    b.roof = r;
    r.type = oneOf(r.type, ROOF_TYPES, 'gable');
    r.axis = oneOf(r.axis, ['x', 'z'], 'x');
    r.shedLow = oneOf(r.shedLow, DIRS, 'south');
    r.rise = snapRise(r.rise, 1);
    r.rise2 = snapRise(r.rise2, 0.5);
    r.breakAt = int(r.breakAt, 3, 1, 128);
    r.clip = int(r.clip, 2, 0, 128);
    r.overhang = int(r.overhang, 1, 0, 32);
    r.ridgeCap = oneOf(r.ridgeCap, RIDGE_CAPS, 'block');
    r.soffit = bool(r.soffit, false);
    r.profile = oneOf(r.profile, ROOF_PROFILES, 'straight');
    r.upturn = int(r.upturn, 0, 0, 16);           // blocks the corners rise (0 = off)
    r.upturnReach = int(r.upturnReach, 6, 1, 64); // how far along the eave the curl reaches
    r.cut = int(r.cut, 0, 0, 128);                // take this many layers off the top of the roof, flat (0 = off)
    r.cap = oneOf(r.cap, ['solid', 'slab', 'open'], 'solid'); // what the chopped top is finished with
    r.capMat = r.capMat === '' || r.capMat == null ? '' : familyKey(r.capMat, '', false); // '' = roof material
    // Any block can roof: families without slabs/stairs fall back to full blocks.
    r.material = familyKey(r.material, 'spruce', false);
    const det = b.details && typeof b.details === 'object' ? b.details : {};
    b.details = det;
    for (const [k, v] of Object.entries(DETAIL_DEFAULTS)) {
      if (typeof v === 'boolean') det[k] = bool(det[k], v);
      else if (typeof v === 'number') det[k] = int(det[k], v, ...DETAIL_RANGES[k]);
      else if (DETAIL_ENUMS[k]) det[k] = oneOf(det[k], DETAIL_ENUMS[k], v);
      else det[k] = familyKey(det[k], v, false);
    }
    const va = b.variation && typeof b.variation === 'object' ? b.variation : {};
    b.variation = va;
    va.wall = int(va.wall, 0, 0, 100);
    va.roof = int(va.roof, 0, 0, 100);
    va.style = oneOf(va.style, VARIATION_STYLES, 'patches');
    va.wallMixCount = int(va.wallMixCount, 2, 1, MIX_MAX);
    va.roofMixCount = int(va.roofMixCount, 2, 1, MIX_MAX);
    for (const k of [...MIX_KEYS.wall, ...MIX_KEYS.roof]) va[k] = va[k] === '' || va[k] == null ? '' : familyKey(va[k], '', false);
    va.seed = int(va.seed, 1, 0, 999999);
    b.edits = validateEdits(b.edits, true);
  }

  d.pillars = d.pillars.filter((p) => p && typeof p === 'object');
  for (const p of d.pillars) {
    claim(p, 'p');
    p.x = int(p.x, 0, -4096, 4096);
    p.z = int(p.z, 0, -4096, 4096);
    p.baseY = int(p.baseY, 0, -64, 320);
    p.h = int(p.h, 4, 1, 256);
    p.material = familyKey(p.material, 'oak_log', false);
    p.size = int(p.size, 1, 1, 5);
    for (const k of ['shape', 'base', 'cap']) p[k] = oneOf(p[k], PILLAR_ENUMS[k], PILLAR_DEFAULTS[k]);
    p.baseMat = familyKey(p.baseMat, PILLAR_DEFAULTS.baseMat, false);
    p.capMat = familyKey(p.capMat, PILLAR_DEFAULTS.capMat, false);
  }

  d.segments = d.segments.filter((s) => s && typeof s === 'object');
  for (const s of d.segments) {
    claim(s, 's');
    s.x0 = int(s.x0, 0, -4096, 4096);
    s.z0 = int(s.z0, 0, -4096, 4096);
    s.x1 = int(s.x1, s.x0, -4096, 4096);
    s.z1 = int(s.z1, s.z0, -4096, 4096);
    s.baseY = int(s.baseY, 0, -64, 320);
    s.h = int(s.h, 3, 1, 256);
    s.material = familyKey(s.material, 'cobblestone', false);
  }

  d.fills = d.fills.filter((f) => f && typeof f === 'object');
  for (const f of d.fills) {
    claim(f, 'f');
    f.x = int(f.x, 0, -4096, 4096);
    f.z = int(f.z, 0, -4096, 4096);
    f.w = int(f.w, 1, 1, 256);
    f.d = int(f.d, 1, 1, 256);
    f.baseY = int(f.baseY, 0, -64, 320);
    f.h = int(f.h, 1, 1, 128);
    f.material = familyKey(f.material, 'oak_planks', false);
    f.shape = oneOf(f.shape, FILL_SHAPES, 'full');
    f.half = oneOf(f.half, ['bottom', 'top'], 'bottom');
    f.facing = oneOf(f.facing, DIRS, 'north');
    f.axis = oneOf(f.axis, ['x', 'y', 'z'], f.shape === 'pane' ? 'x' : 'y');
    if (f.shape === 'pane' && f.axis === 'y') f.axis = 'x';
    f.outline = oneOf(f.outline, ['rect', 'circle'], 'rect');
    f.hollow = bool(f.hollow, false);
  }
  d.edits = validateEdits(d.edits, false);
  return d;
}

/**
 * Hand edits: [{x, y, z, shape, mat, half?, facing?, axis?}]. Box edits (`rel`) are relative
 * to the box's (x, baseY, z) corner so they move and rotate with it; design edits are world
 * coordinates. One edit per cell, the last one wins.
 */
function validateEdits(list, rel) {
  if (!Array.isArray(list)) return [];
  const lim = rel ? 1024 : 4096;
  const byCell = new Map();
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const shape = oneOf(e.shape, EDIT_SHAPES, null);
    if (!shape) continue;
    const out = { x: int(e.x, 0, -4096 - lim, 4096 + lim), y: int(e.y, 0, -400, 400), z: int(e.z, 0, -4096 - lim, 4096 + lim), shape };
    if (shape !== 'erase') {
      out.mat = familyKey(e.mat, '', false);
      if (!out.mat) continue;
    }
    if (shape === 'slab' || shape === 'stair') out.half = oneOf(e.half, ['bottom', 'top'], 'bottom');
    if (shape === 'stair') out.facing = oneOf(e.facing, DIRS, 'north');
    if (shape === 'full' && e.axis) out.axis = oneOf(e.axis, ['x', 'y', 'z'], 'y');
    if (shape === 'pane') out.axis = oneOf(e.axis, ['x', 'z'], 'x');
    const k = blockKey(out.x, out.y, out.z);
    byCell.delete(k);
    byCell.set(k, out);
  }
  return [...byCell.values()].slice(-EDITS_MAX);
}

/** Unused id like "b3" (smallest free counter for the prefix). */
/**
 * The design scaled by `factor` (0.1-8): every object's edges move away from (or toward) an
 * anchor, so shared walls stay shared, gaps grow in proportion and everything keeps its place
 * relative to the rest. The anchor is the centre of the footprint at the lowest base, so the
 * build grows where it stands. Roof pitch stays, so roofs grow with their footprints; lengths
 * (overhang, chop, upturn, windows, doors) scale. Hand-placed blocks become blocks of blocks.
 * `only` (an object id) scales just that object, about its own centre. Returns
 * { design, dropped } (dropped: hand edits over the limit that had to be left out).
 */
export function scaleDesign(input, factor, { only = null } = {}) {
  const d = JSON.parse(JSON.stringify(input));
  const k = Math.min(8, Math.max(0.1, +factor || 1));
  const pick = (o) => !only || o.id === only;
  const boxes = d.boxes || [], pillars = d.pillars || [], segments = d.segments || [], fills = d.fills || [];
  // Anchor: centre of the footprint of what is being scaled, at its lowest base.
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity;
  const extend = (ax0, az0, ax1, az1, ay0) => { x0 = Math.min(x0, ax0); z0 = Math.min(z0, az0); x1 = Math.max(x1, ax1); z1 = Math.max(z1, az1); y0 = Math.min(y0, ay0); };
  for (const b of boxes) if (pick(b)) extend(b.x, b.z, b.x + b.w, b.z + b.d, b.baseY);
  for (const p of pillars) if (pick(p)) extend(p.x, p.z, p.x + (p.size || 1), p.z + (p.size || 1), p.baseY);
  for (const g of segments) if (pick(g)) extend(Math.min(g.x0, g.x1), Math.min(g.z0, g.z1), Math.max(g.x0, g.x1) + 1, Math.max(g.z0, g.z1) + 1, g.baseY);
  for (const f of fills) if (pick(f)) extend(f.x, f.z, f.x + f.w, f.z + f.d, f.baseY);
  if (!only) for (const e of d.edits || []) extend(e.x, e.z, e.x + 1, e.z + 1, e.y);
  if (x0 === Infinity) return { design: d, dropped: 0 };
  const ax = Math.round((x0 + x1) / 2), az = Math.round((z0 + z1) / 2), ay = y0;
  const S = (v, a) => Math.round(a + (v - a) * k);
  // [lo, hi) -> scaled [lo, hi), at least one block
  const span = (lo, hi, a) => { const n0 = S(lo, a); return [n0, Math.max(n0 + 1, S(hi, a))]; };
  const len = (v, min = 0) => (v > 0 ? Math.max(Math.max(min, 1), Math.round(v * k)) : Math.max(min, 0));
  // One cell -> the cells it covers once scaled.
  const cells = (c, a) => { const [lo, hi] = span(c, c + 1, a); const out = []; for (let v = lo; v < hi; v++) out.push(v); return out; };
  let dropped = 0;
  const scaleEdits = (list, ox, oy, oz, nx, ny, nz) => {
    const out = [];
    for (const e of list || []) {
      for (const X of cells(e.x + ox, ax)) for (const Y of cells(e.y + oy, ay)) for (const Z of cells(e.z + oz, az)) out.push({ ...e, x: X - nx, y: Y - ny, z: Z - nz });
    }
    if (out.length > EDITS_MAX) { dropped += out.length - EDITS_MAX; out.length = EDITS_MAX; }
    return out;
  };

  for (const b of boxes) {
    if (!pick(b)) continue;
    const [bx0, bx1] = span(b.x, b.x + b.w, ax), [bz0, bz1] = span(b.z, b.z + b.d, az), [by0, by1] = span(b.baseY, b.baseY + b.wallH, ay);
    b.edits = scaleEdits(b.edits, b.x, b.baseY, b.z, bx0, by0, bz0);
    Object.assign(b, { x: bx0, z: bz0, w: bx1 - bx0, d: bz1 - bz0, baseY: by0, wallH: by1 - by0 });
    const r = b.roof || {};
    for (const [key, min] of [['overhang', 0], ['breakAt', 1], ['clip', 0], ['upturn', 0], ['upturnReach', 1], ['cut', 0]]) if (typeof r[key] === 'number') r[key] = len(r[key], min);
    const det = b.details || {};
    for (const [key, min] of [['winWidth', 1], ['winHeight', 1], ['winSill', 0], ['winGap', 0], ['doorWidth', 1], ['doorHeight', 1], ['studGap', 2]]) if (typeof det[key] === 'number') det[key] = len(det[key], min);
  }
  for (const p of pillars) {
    if (!pick(p)) continue;
    const n = p.size || 1;
    const [px0, px1] = span(p.x, p.x + n, ax), [pz0] = span(p.z, p.z + n, az), [py0, py1] = span(p.baseY, p.baseY + Math.max(1, p.h), ay);
    Object.assign(p, { x: px0, z: pz0, size: Math.min(5, px1 - px0), baseY: py0, h: py1 - py0 });
  }
  for (const g of segments) {
    if (!pick(g)) continue;
    // Lengthen along the line; it stays one block thick (on the scaled middle of its row).
    const fx = g.x0 <= g.x1, fz = g.z0 <= g.z1;
    const [sx0, sx1] = span(Math.min(g.x0, g.x1), Math.max(g.x0, g.x1) + 1, ax), [sz0, sz1] = span(Math.min(g.z0, g.z1), Math.max(g.z0, g.z1) + 1, az);
    const alongX = g.z0 === g.z1, alongZ = g.x0 === g.x1 && !alongX;
    const midX = Math.floor((sx0 + sx1 - 1) / 2), midZ = Math.floor((sz0 + sz1 - 1) / 2);
    const [lx0, lx1] = alongZ ? [midX, midX] : [sx0, sx1 - 1], [lz0, lz1] = alongX ? [midZ, midZ] : [sz0, sz1 - 1];
    const [gy0, gy1] = span(g.baseY, g.baseY + Math.max(1, g.h), ay);
    Object.assign(g, { x0: fx ? lx0 : lx1, x1: fx ? lx1 : lx0, z0: fz ? lz0 : lz1, z1: fz ? lz1 : lz0, baseY: gy0, h: gy1 - gy0 });
  }
  for (const f of fills) {
    if (!pick(f)) continue;
    const [fx0, fx1] = span(f.x, f.x + f.w, ax), [fz0, fz1] = span(f.z, f.z + f.d, az), [fy0, fy1] = span(f.baseY, f.baseY + f.h, ay);
    Object.assign(f, { x: fx0, z: fz0, w: fx1 - fx0, d: fz1 - fz0, baseY: fy0, h: fy1 - fy0 });
  }
  if (!only) d.edits = scaleEdits(d.edits, 0, 0, 0, 0, 0, 0);
  return { design: d, dropped };
}

/**
 * Rotate an object `q` quarter-turns clockwise (seen from above) about the centre of its
 * footprint. Boxes swap w/d and turn their roof (axis, shed low side); segments turn their
 * endpoints. Returns a patch; odd-by-even footprints round the new corner down.
 */
export function rotatePatch(kind, obj, q) {
  q = ((q % 4) + 4) % 4;
  if (!q) return {};
  const turn = (dir) => { for (let i = 0; i < q; i++) dir = CW[dir]; return dir; };
  if (kind === 'fill') {
    const cx = obj.x + obj.w / 2, cz = obj.z + obj.d / 2;
    const odd = q % 2 === 1;
    const w = odd ? obj.d : obj.w, d = odd ? obj.w : obj.d;
    const patch = { x: Math.floor(cx - w / 2), z: Math.floor(cz - d / 2), w, d, facing: turn(obj.facing || 'north') };
    if (odd && (obj.axis === 'x' || obj.axis === 'z')) patch.axis = obj.axis === 'x' ? 'z' : 'x';
    return patch;
  }
  if (kind === 'box') {
    const cx = obj.x + obj.w / 2, cz = obj.z + obj.d / 2;
    const odd = q % 2 === 1;
    const w = odd ? obj.d : obj.w, d = odd ? obj.w : obj.d;
    const patch = { x: Math.floor(cx - w / 2), z: Math.floor(cz - d / 2), w, d };
    if (Array.isArray(obj.edits) && obj.edits.length) {
      patch.edits = obj.edits.map((e) => {
        let { x, z } = e, ww = obj.w, dd = obj.d;
        for (let i = 0; i < q; i++) { [x, z] = [dd - 1 - z, x]; [ww, dd] = [dd, ww]; }
        const ne = { ...e, x, z };
        if (ne.facing) ne.facing = turn(ne.facing);
        if (odd && (ne.axis === 'x' || ne.axis === 'z')) ne.axis = ne.axis === 'x' ? 'z' : 'x';
        return ne;
      });
    }
    if (obj.details) {
      // Per-side window switches and the door side turn with the box.
      const det = { ...obj.details };
      for (const side of DIRS) if (SIDE_FLAG[side] in obj.details) det[SIDE_FLAG[turn(side)]] = obj.details[SIDE_FLAG[side]];
      if (obj.details.doorSide) det.doorSide = turn(obj.details.doorSide);
      patch.details = det;
    }
    if (obj.roof) {
      patch.roof = { ...obj.roof, shedLow: turn(obj.roof.shedLow || 'south') };
      if (odd) patch.roof.axis = obj.roof.axis === 'z' ? 'x' : 'z';
    }
    return patch;
  }
  if (kind === 'segment') {
    // Rotate cell centres about the centre of the segment's bounding rectangle.
    const cx = (Math.min(obj.x0, obj.x1) + Math.max(obj.x0, obj.x1) + 1) / 2;
    const cz = (Math.min(obj.z0, obj.z1) + Math.max(obj.z0, obj.z1) + 1) / 2;
    const rot = (x, z) => {
      let vx = x + 0.5 - cx, vz = z + 0.5 - cz;
      for (let i = 0; i < q; i++) [vx, vz] = [-vz, vx];
      return [Math.floor(cx + vx), Math.floor(cz + vz)];
    };
    const [x0, z0] = rot(obj.x0, obj.z0), [x1, z1] = rot(obj.x1, obj.z1);
    return { x0, z0, x1, z1 };
  }
  return {};
}

export function newId(design, prefix, extraUsed) {
  const used = new Set(extraUsed || []);
  for (const list of [design?.boxes, design?.pillars, design?.segments, design?.fills]) {
    if (Array.isArray(list)) for (const o of list) if (o && typeof o.id === 'string') used.add(o.id);
  }
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

// ---------------------------------------------------------------------------------
// Sample design
// ---------------------------------------------------------------------------------
export function defaultDesign() {
  return validateDesign({
    version: 1,
    name: 'Farmhouse',
    author: '',
    dataVersion: DEFAULT_DATA_VERSION,
    boxes: [
      {
        id: 'b1', name: 'Main hall', x: 0, z: 0, w: 11, d: 7, baseY: 0, wallH: 4, walls: true, floor: false,
        wallMaterial: 'oak_planks',
        roof: { type: 'gable', axis: 'x', shedLow: 'south', rise: 1, rise2: 0.5, breakAt: 3, clip: 2, overhang: 1, ridgeCap: 'block', soffit: false, material: 'spruce' },
      },
      {
        // Crosses the main hall; ridge along z, extends south past it -> valleys.
        id: 'b2', name: 'Wing', x: 3, z: 2, w: 5, d: 9, baseY: 0, wallH: 4, walls: true, floor: false,
        wallMaterial: 'oak_planks',
        roof: { type: 'gable', axis: 'z', shedLow: 'south', rise: 1, rise2: 0.5, breakAt: 3, clip: 2, overhang: 1, ridgeCap: 'block', soffit: false, material: 'spruce' },
      },
      {
        // Open porch in front of the wing, shallow slab hip roof.
        id: 'b3', name: 'Porch', x: 3, z: 11, w: 5, d: 3, baseY: 0, wallH: 3, walls: false, floor: true,
        wallMaterial: 'stone_bricks',
        roof: { type: 'hip', axis: 'x', shedLow: 'south', rise: 0.5, rise2: 0.5, breakAt: 3, clip: 2, overhang: 0, ridgeCap: 'slab', soffit: false, material: 'spruce' },
      },
      {
        // Dormer on the north slope of the main roof; baseY sits on the main roof surface
        // at its front row (5) and above the eave; walls walk down and stop on the roof.
        id: 'b4', name: 'Dormer', x: 8, z: 0, w: 3, d: 3, baseY: 5, wallH: 2, walls: true, floor: false,
        wallMaterial: 'oak_planks',
        roof: { type: 'gable', axis: 'z', shedLow: 'south', rise: 1, rise2: 0.5, breakAt: 3, clip: 2, overhang: 0, ridgeCap: 'block', soffit: false, material: 'spruce' },
      },
    ],
    pillars: [
      { id: 'p1', x: 3, z: 13, baseY: 0, h: 3, material: 'oak_log' },
      { id: 'p2', x: 7, z: 13, baseY: 0, h: 3, material: 'oak_log' },
    ],
    segments: [],
    fills: [],
  });
}

// ---------------------------------------------------------------------------------
// Block factories
// ---------------------------------------------------------------------------------
function fam(key) { return FAMILIES[key] || FAMILIES.spruce; }

function fullBlock(mat, role, axis) {
  const f = fam(mat);
  const props = f.fullProps ? { ...f.fullProps } : {};
  if (axis && f.axis) props.axis = axis;
  return { id: f.full, props, kind: 'full', mat, role, color: f.color };
}
/** Glass pane running along `axis` ("x" or "z"); full block if the family has no pane. */
function paneBlock(mat, axis, role) {
  const f = fam(mat);
  if (!f.pane) return fullBlock(mat, role);
  const ex = axis === 'x' ? 'true' : 'false', ez = axis === 'x' ? 'false' : 'true';
  return { id: f.pane, props: { east: ex, west: ex, north: ez, south: ez, waterlogged: 'false' }, kind: 'pane', mat, role, color: f.color };
}
function slabBlock(mat, type, role) {
  const f = fam(mat);
  if (!f.slab) return fullBlock(mat, role);
  return { id: f.slab, props: { type, waterlogged: 'false' }, kind: 'slab', mat, role, color: f.color };
}
function stairBlock(mat, facing, half, role) {
  const f = fam(mat);
  if (!f.stairs) return fullBlock(mat, role);
  return { id: f.stairs, props: { facing, half, shape: 'straight', waterlogged: 'false' }, kind: 'stair', mat, role, color: f.color };
}
function wallBlock(mat, conns, role) {
  const f = fam(mat);
  if (!f.wall) return fullBlock(mat, role);
  return { id: f.wall, props: { up: 'true', north: conns.north, south: conns.south, east: conns.east, west: conns.west, waterlogged: 'false' }, kind: 'wall', mat, role, color: f.color };
}

/** Remember which object (and which of its material fields) produced a block. */
function tag(blk, src, path) { blk.src = src; blk.path = path; return blk; }

/** Same shape and state in another family; null when that family lacks the shape. */
export function reskin(blk, mat) {
  const f = FAMILIES[mat];
  if (!f) return null;
  const id = blk.kind === 'full' ? f.full : blk.kind === 'slab' ? f.slab : blk.kind === 'stair' ? f.stairs
    : blk.kind === 'wall' ? f.wall : blk.kind === 'pane' ? f.pane : null;
  if (!id) return null;
  let props = { ...blk.props };
  if (blk.kind === 'full') {
    const axis = props.axis;
    props = f.fullProps ? { ...f.fullProps } : {};
    if (axis && f.axis) props.axis = axis;
  }
  return { ...blk, id, props, mat, color: f.color };
}

// Deterministic hash noise in [0, 1).
function hash3(x, y, z, seed) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647) + Math.imul(seed | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** Smooth 3D value noise in [0, 1), cell size `sc`. */
function valueNoise(x, y, z, seed, sc) {
  const fx = x / sc, fy = y / sc, fz = z / sc;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const sm = (t) => t * t * (3 - 2 * t);
  const tx = sm(fx - x0), ty = sm(fy - y0), tz = sm(fz - z0);
  const L = (a, b, t) => a + (b - a) * t;
  const c = (i, j, k) => hash3(x0 + i, y0 + j, z0 + k, seed);
  return L(L(L(c(0, 0, 0), c(1, 0, 0), tx), L(c(0, 1, 0), c(1, 1, 0), tx), ty),
    L(L(c(0, 0, 1), c(1, 0, 1), tx), L(c(0, 1, 1), c(1, 1, 1), tx), ty), tz);
}
/**
 * Per-block value in [0, 1); a block takes a mix material when the value is below the amount.
 * patches = soft clumps, scatter = salt-and-pepper, grime = heavier toward the base,
 * streaks = vertical runs (rain/drip marks).
 */
function variationValue(style, seed, x, y, z, baseY, E) {
  switch (style) {
    case 'scatter': return hash3(x, y, z, seed);
    case 'grime': {
      const h = Math.max(1, E - baseY);
      const up = Math.min(1, Math.max(0, (y - baseY) / h)); // 0 at the base, 1 at the eave
      return Math.min(0.999, 0.55 * valueNoise(x, y, z, seed, 2.5) + 0.25 * hash3(x, y, z, seed + 3) + 0.6 * up - 0.2);
    }
    case 'streaks': {
      const col = hash3(x, 0, z, seed);
      return Math.min(0.999, Math.max(0, col + 0.3 * (valueNoise(x, y, z, seed + 5, 2) - 0.5)));
    }
    default: { // patches: noise stretched so the share of hits roughly tracks the amount
      const n = 0.7 * valueNoise(x, y, z, seed, 3) + 0.3 * valueNoise(x, y, z, seed + 11, 1.4);
      return Math.min(0.999, Math.max(0, (n - 0.5) * 2.2 + 0.5));
    }
  }
}
/**
 * The blocks one surface mixes in: each slot is the block chosen for it, or else (Auto) the
 * next look-alike suggestion; no repeats, never the base block itself.
 */
function pickMixes(slots, base) {
  const auto = suggestVariants(base, Math.max(2, slots.length));
  const out = [];
  let next = 0;
  for (const k of slots) {
    if (k && FAMILIES[k] && k !== base) { if (!out.includes(k)) out.push(k); continue; }
    while (next < auto.length && (out.includes(auto[next]) || slots.includes(auto[next]))) next++;
    if (next < auto.length) out.push(auto[next++]);
  }
  return out;
}

const VARIANT_PREFIXES = ['mossy_', 'cracked_', 'chiseled_', 'weathered_', 'exposed_'];
/** Look-alike materials for breaking up a surface: named variants first, then nearest colours. */
export function suggestVariants(key, n = 2) {
  const f = FAMILIES[key];
  if (!f) return [];
  const out = [];
  const add = (k) => { if (k && k !== key && FAMILIES[k] && !out.includes(k)) out.push(k); };
  let base = key;
  for (const p of VARIANT_PREFIXES) if (key.startsWith(p)) { base = key.slice(p.length); add(base); }
  for (const p of VARIANT_PREFIXES) add(p + base);
  if (base.endsWith('_tiles')) add(base.replace(/_tiles$/, '_bricks'));
  if (base.endsWith('_bricks')) add(base.replace(/_bricks$/, '_tiles'));
  if (out.length >= n) return out;
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [r, g, b] = rgb(f.color);
  const dist = (k) => { const [r2, g2, b2] = rgb(FAMILIES[k].color); return Math.hypot(r - r2, g - g2, b - b2); };
  const near = Object.keys(FAMILIES)
    .filter((k) => k !== key && !out.includes(k) && FAMILIES[k].group === f.group && !FAMILIES[k].transparent
      && (!f.stairs || FAMILIES[k].stairs) && FAMILIES[k].pattern === f.pattern)
    .sort((a, c) => dist(a) - dist(c));
  for (const k of near) if (dist(k) < 45) add(k);
  // Asked for a bigger mix: widen to further same-pattern colours.
  if (n > 2) for (const k of near) { if (out.length >= n) break; if (dist(k) < 90) add(k); }
  if (!out.length) {
    // Nothing close in the same pattern: settle for the nearest opaque colours anywhere.
    const loose = Object.keys(FAMILIES)
      .filter((k) => k !== key && !FAMILIES[k].transparent && (!f.stairs || FAMILIES[k].stairs) && !['Ores', 'Leaves', 'Glazed terracotta'].includes(FAMILIES[k].group))
      .sort((a, c) => dist(a) - dist(c));
    for (const k of loose.slice(0, Math.max(2, n))) if (dist(k) < (n > 2 ? 80 : 50)) add(k);
  }
  return out;
}

// ---------------------------------------------------------------------------------
// Roof surface (SPEC step 1)
// ---------------------------------------------------------------------------------
function roundHalf(v) { return Math.round(v * 2) / 2; }
function isHalf(v) { return Math.abs(v - Math.floor(v) - 0.5) < EPS; }

/** Region R_b = footprint expanded by overhang. */
function boxRegion(b) {
  const oh = b.roof.overhang;
  return { x0: b.x - oh, x1: b.x + b.w - 1 + oh, z0: b.z - oh, z1: b.z + b.d - 1 + oh };
}

/** Profile curve: t = 0 at the eave .. 1 at the top -> fraction of the full height. */
function profileFn(p, t) {
  t = Math.min(1, Math.max(0, t));
  switch (p) {
    case 'rounded': return Math.sin(t * Math.PI / 2);      // steep eave, flattens at the top (barrel / dome)
    case 'flared': return 1 - Math.cos(t * Math.PI / 2);   // shallow eave, steepens to the top (pagoda)
    case 'bell': return (1 - Math.cos(t * Math.PI)) / 2;   // flared eave, rounded top (ogee / bell)
    default: return t;
  }
}
/**
 * Height above the eave at run distance d on a slope whose full run is D. Straight profiles
 * are exactly rise × d. Curves keep the same total height (rise × D); off-region (d < 0) they
 * extrapolate with the first step's slope, clamped to 0.5..rise so eaves never hang deep.
 */
export function slopeHeight(r, d, D) {
  if (r.profile === 'straight' || !r.profile || D <= 0) return r.rise * d;
  const H = r.rise * D;
  const P = (x) => H * profileFn(r.profile, x / D);
  if (d >= 0) return P(Math.min(d, D));
  const slope0 = Math.max(0.5, Math.min(r.rise, P(1) - P(0)));
  return slope0 * d;
}

/**
 * Corner lift: the surface warps up toward every corner of the region. a = Chebyshev distance
 * to the nearest corner, so the eave line curves up into each corner and the hip lines follow.
 * Off-region (a < 0) it holds the full lift so virtual neighbours don't keep climbing.
 */
function cornerLift(r, reg, cx, cz) {
  if (!r.upturn || !UPTURN_TYPES.includes(r.type)) return 0;
  const dX = Math.min(cx - reg.x0, reg.x1 - cx), dZ = Math.min(cz - reg.z0, reg.z1 - cz);
  const t = Math.max(0, Math.max(dX, dZ)) / r.upturnReach;
  return t >= 1 ? 0 : r.upturn * (1 - t) * (1 - t);
}

/**
 * Roof tier per box. Box B sits on a higher tier than A when its footprint overlaps A's and
 * B "stacks": by default (stack "auto") when B sits on A's roof or rises well clear
 * of it; "stack" forces it whenever B's eave is above A's; "merge" never.
 */
function roofTiers(design, regions) {
  const boxes = design.boxes;
  const n = boxes.length;
  const over = [];
  for (let bi = 0; bi < n; bi++) {
    const B = boxes[bi];
    if (B.stack === 'merge') continue;
    const EB = B.baseY + B.wallH;
    for (let ai = 0; ai < n; ai++) {
      if (ai === bi) continue;
      // Footprints must overlap: brushing another roof's overhang doesn't count.
      const A = boxes[ai], reg = regions[ai];
      const x0 = Math.max(B.x, A.x), x1 = Math.min(B.x + B.w - 1, A.x + A.w - 1);
      const z0 = Math.max(B.z, A.z), z1 = Math.min(B.z + B.d - 1, A.z + A.d - 1);
      if (x0 > x1 || z0 > z1) continue;
      const EA = A.baseY + A.wallH;
      let stacks;
      if (B.stack === 'stack') stacks = EB > EA;
      else {
        // Auto: B sits on A's roof (its base within a block of the roof's top under it), or
        // its walls stand clear of A's roof all the way round: a tower, from the ground or
        // from the roof, or an upper storey set back on it. A dormer or cross wing whose back
        // is buried in the slope does neither and keeps merging.
        let top = -Infinity, wallTop = -Infinity;
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) top = Math.max(top, roundHalf(boxSurface(A, reg, x, z)));
        for (let z = B.z; z < B.z + B.d; z++) for (let x = B.x; x < B.x + B.w; x++) {
          if (x !== B.x && x !== B.x + B.w - 1 && z !== B.z && z !== B.z + B.d - 1) continue;
          if (x < reg.x0 || x > reg.x1 || z < reg.z0 || z > reg.z1) continue;
          wallTop = Math.max(wallTop, roundHalf(boxSurface(A, reg, x, z)));
        }
        // Walls whose top only just meets the slope count as clear for a storey set well in from
        // A's walls, but not for a dormer standing on A's wall line.
        const inside = B.x > A.x && B.z > A.z && B.x + B.w < A.x + A.w && B.z + B.d < A.z + A.d;
        stacks = (B.baseY > A.baseY && B.baseY >= top - 1 - EPS) || (EB > EA && EB > wallTop - (inside ? 1 : 0) + EPS);
      }
      if (stacks) over.push([bi, ai]);
    }
  }
  const tier = new Array(n).fill(0);
  for (let pass = 0; pass < n; pass++) {
    let changed = false;
    for (const [bi, ai] of over) if (tier[bi] < tier[ai] + 1 && tier[ai] + 1 <= n) { tier[bi] = tier[ai] + 1; changed = true; }
    if (!changed) break;
  }
  return tier;
}

/** Surface height s_b(cx,cz) of one box at a column inside its region. */
function boxSurface(b, reg, cx, cz) {
  const s = baseSurface(b, reg, cx, cz) + cornerLift(b.roof, reg, cx, cz);
  // Chopped top: the top `cut` layers of the roof come off and it finishes flat there.
  return b.roof.cut > 0 ? Math.min(s, chopHeight(b, reg)) : s;
}
/** Surface height a chopped roof is cut to: `cut` layers below its peak, never under the eave. */
const chopCache = new WeakMap();
function chopHeight(b, reg) {
  let c = chopCache.get(reg);
  if (c === undefined) {
    let peak = -Infinity;
    for (let cz = reg.z0; cz <= reg.z1; cz++) for (let cx = reg.x0; cx <= reg.x1; cx++) {
      peak = Math.max(peak, roundHalf(baseSurface(b, reg, cx, cz) + cornerLift(b.roof, reg, cx, cz)));
    }
    c = Math.max(b.baseY + b.wallH, Math.ceil(peak - EPS) - b.roof.cut);
    chopCache.set(reg, c);
  }
  return c;
}
function baseSurface(b, reg, cx, cz) {
  const r = b.roof;
  const E = b.baseY + b.wallH;
  const dxW = cx - reg.x0, dxE = reg.x1 - cx, dzN = cz - reg.z0, dzS = reg.z1 - cz;
  const dX = Math.min(dxW, dxE), dZ = Math.min(dzN, dzS);
  const DX = Math.floor((reg.x1 - reg.x0) / 2), DZ = Math.floor((reg.z1 - reg.z0) / 2);
  const dAcross = r.axis === 'x' ? dZ : dX;
  const dAlong = r.axis === 'x' ? dX : dZ;
  const DAcross = r.axis === 'x' ? DZ : DX;
  const DAlong = r.axis === 'x' ? DX : DZ;
  const g = (d) => (d <= r.breakAt ? r.rise * d : r.rise * r.breakAt + r.rise2 * (d - r.breakAt));
  switch (r.type) {
    case 'flat': return E;
    case 'shed': {
      const dist = r.shedLow === 'north' ? dzN : r.shedLow === 'south' ? dzS : r.shedLow === 'east' ? dxE : dxW;
      const D = r.shedLow === 'north' || r.shedLow === 'south' ? reg.z1 - reg.z0 : reg.x1 - reg.x0;
      return E + slopeHeight(r, dist, D);
    }
    case 'gable': return E + slopeHeight(r, dAcross, DAcross);
    case 'hip': return E + slopeHeight(r, Math.min(dX, dZ), Math.min(DX, DZ));
    case 'halfhip': return Math.min(E + slopeHeight(r, dAcross, DAcross), E + r.clip + slopeHeight(r, dAlong, DAlong));
    case 'irimoya': {
      // Hip-and-gable: a hip skirt `clip` blocks deep on the ends, then a gable whose
      // triangle stands on the skirt. Past the skirt the roof is a plain gable.
      if (dAlong >= r.clip) return E + slopeHeight(r, dAcross, DAcross);
      return E + slopeHeight(r, Math.min(dAcross, dAlong), DAcross);
    }
    case 'round': {
      // Dome / cone / spire on an ellipse inscribed in the region. Inside the region but
      // outside the ellipse (square corners) the roof stays at eave height.
      const hx = (reg.x1 - reg.x0) / 2 + 0.5, hz = (reg.z1 - reg.z0) / 2 + 0.5;
      const u = (cx - (reg.x0 + reg.x1) / 2) / hx, v = (cz - (reg.z0 + reg.z1) / 2) / hz;
      const Dr = Math.min(hx, hz);
      let d = (1 - Math.sqrt(u * u + v * v)) * Dr;
      const inside = cx >= reg.x0 && cx <= reg.x1 && cz >= reg.z0 && cz <= reg.z1;
      // Off-region (virtual neighbour): always one step below the eave, never deeper,
      // so the square corners do not grow fill columns down the walls.
      d = inside ? Math.max(0, d) : -1;
      return E + slopeHeight(r, d, Dr);
    }
    case 'gambrel': return E + g(dAcross);
    case 'mansard': return E + g(Math.min(dX, dZ));
    default: return E;
  }
}

// ---------------------------------------------------------------------------------
// Vanilla StairsBlock.getStairShape (SPEC step 5)
// ---------------------------------------------------------------------------------
function stairShape(blocks, x, y, z, st) {
  const facing = st.props.facing, half = st.props.half;
  const at = (px, pz) => blocks.get(blockKey(px, y, pz));
  const atDir = (d) => { const [dx, dz] = DIR_OFFSET[d]; return at(x + dx, z + dz); };
  const isDifferent = (other) => !other || other.kind !== 'stair' || other.props.facing !== facing || other.props.half !== half;

  const front = atDir(facing);
  if (front && front.kind === 'stair' && front.props.half === half) {
    const f2 = front.props.facing;
    if (AXIS_OF[f2] !== AXIS_OF[facing]) {
      const [dx, dz] = DIR_OFFSET[OPPOSITE[f2]];
      if (isDifferent(at(x + dx, z + dz))) return f2 === CCW[facing] ? 'outer_left' : 'outer_right';
    }
  }
  const back = atDir(OPPOSITE[facing]);
  if (back && back.kind === 'stair' && back.props.half === half) {
    const f3 = back.props.facing;
    if (AXIS_OF[f3] !== AXIS_OF[facing]) {
      const [dx, dz] = DIR_OFFSET[f3];
      if (isDifferent(at(x + dx, z + dz))) return f3 === CCW[facing] ? 'inner_left' : 'inner_right';
    }
  }
  return 'straight';
}

/** Does the upper half of a block fully cover its face toward direction d? */
const TALL_QUARTERS_N = { // facing north, (u, v) offsets of the tall quarters
  straight: [[-1, -1], [1, -1]], outer_left: [[-1, -1]], outer_right: [[1, -1]],
  inner_left: [[-1, -1], [1, -1], [-1, 1]], inner_right: [[-1, -1], [1, -1], [1, 1]],
};
const ROT_Q = { north: (u, v) => [u, v], east: (u, v) => [-v, u], south: (u, v) => [-u, -v], west: (u, v) => [v, -u] };
function upperCoversFace(blk, d) {
  if (blk.kind === 'slab') return blk.props.type === 'top';
  if (blk.kind !== 'stair') return true;
  if (blk.props.half === 'top') return true;
  const tall = (TALL_QUARTERS_N[blk.props.shape] || TALL_QUARTERS_N.straight).map(([u, v]) => ROT_Q[blk.props.facing](u, v).join(','));
  const face = { north: ['-1,-1', '1,-1'], south: ['-1,1', '1,1'], east: ['1,-1', '1,1'], west: ['-1,-1', '-1,1'] }[d];
  return face.every((q) => tall.includes(q));
}

// ---------------------------------------------------------------------------------
// Wall openings: windows, door, frames, studs
// ---------------------------------------------------------------------------------
/**
 * Lays out one box's wall openings. at(side, i, y) -> 'glass' | 'door' | 'frameV' | 'frameH' |
 * 'stud' | null for column i (0 = west / north end) of that side at layer y. Windows sit
 * symmetric about each side's centre, winWidth wide with winGap between them, never touching
 * a corner column or its neighbour, and only whole windows are cut.
 */
function wallOpenings(b) {
  const det = b.details;
  const E = b.baseY + b.wallH;
  const top = E - 2; // highest row an opening may use (the eave row stays wall / beam)
  const rowLo = b.baseY + Math.max(det.winSill, det.base ? 1 : 0);
  const rowHi = Math.min(rowLo + det.winHeight - 1, top);
  const W = det.winWidth, P = W + det.winGap;
  const arch = det.winTop === 'arch' && W >= 3 && rowHi + 1 <= top ? rowHi + 1 : null;
  const len = (side) => (side === 'north' || side === 'south' ? b.w : b.d);
  // Columns lo..hi of the centred run of width n on a side of length L (shifted half a block
  // when the parities differ, so a 2-wide door on an odd wall leans east / south).
  const centred = (L, n) => { const lo = Math.floor((L - n) / 2); return [lo, lo + n - 1]; };
  const door = (side) => {
    if (!det.door || side !== det.doorSide) return null;
    const L = len(side);
    const n = Math.min(det.doorWidth, Math.max(1, L - 2));
    const [lo, hi] = centred(L, n);
    // The opening starts one above baseY (the floor / foundation row) and is doorHeight tall.
    return { lo, hi, y0: b.baseY + 1, y1: Math.min(b.baseY + det.doorHeight, top + 1) };
  };
  const doorAt = (side, i, y) => { const d = door(side); return !!d && i >= d.lo && i <= d.hi && y >= d.y0 && y <= d.y1; };
  const winCol = (side, i) => {
    if (!det.windows || !det[SIDE_FLAG[side]]) return false;
    const L = len(side);
    const [lo0] = centred(L, W);
    const j = Math.floor((i - lo0) / P); // each period is a window then its gap
    const lo = lo0 + j * P, hi = lo + W - 1;
    if (i < lo || i > hi || lo < 2 || hi > L - 3) return false;
    const d = door(side);
    return !(d && hi >= d.lo - 1 && lo <= d.hi + 1); // keep windows off the doorway
  };
  const glassAt = (side, i, y) => {
    if (y >= rowLo && y <= rowHi) return winCol(side, i);
    if (y === arch) return winCol(side, i) && winCol(side, i - 1) && winCol(side, i + 1);
    return false;
  };
  const openAt = (side, i, y) => glassAt(side, i, y) || doorAt(side, i, y);
  const at = (side, i, y) => {
    if (doorAt(side, i, y)) return 'door';
    if (glassAt(side, i, y)) return 'glass';
    const L = len(side);
    if (det.frame && i >= 1 && i <= L - 2 && y > b.baseY) {
      if (openAt(side, i - 1, y) || openAt(side, i + 1, y)) return 'frameV';
      for (const dy of [-1, 1]) for (const di of [-1, 0, 1]) if (openAt(side, i + di, y + dy)) return di ? 'frameV' : 'frameH';
    }
    if (det.studs && i % det.studGap === 0 && i > 0 && i < L - 1 && y > b.baseY && y < E - 1) return 'stud';
    return null;
  };
  return { at, rowLo };
}

// ---------------------------------------------------------------------------------
// buildGrid
// ---------------------------------------------------------------------------------
export function buildGrid(input) {
  // Work on a validated copy so the caller's design object is never mutated.
  const design = validateDesign(JSON.parse(JSON.stringify(input ?? {})));
  const blocks = new Map();
  const surface = new Map();   // colKey -> {s, boxId} (highest tier's roof per column)
  const outSurface = new Map();
  const regions = design.boxes.map(boxRegion);
  const boxIndex = new Map(design.boxes.map((o, i) => [o.id, i]));
  // Roof tiers: a box that stands clear above another box's roof (a tower on a roof) gets its
  // own roof layer instead of joining that roof's height map, so the lower roof runs on
  // underneath, right up to its walls. Boxes on one tier merge as before (L-shapes, dormers).
  const tierOf = roofTiers(design, regions);
  const tiers = [...new Set(tierOf)].sort((a, b) => a - b);
  const roofMins = tiers.map(() => new Map()); // per tier: colKey -> lowest layer holding a roof block
  let roofMin = roofMins[0];
  const roofMinOf = (bi) => roofMins[tiers.indexOf(tierOf[bi])];

  // Every block carries its own cell (x, y, z), so passes over the map never re-parse keys.
  const put = (x, y, z, block) => {
    if (block.x !== undefined && (block.x !== x || block.y !== y || block.z !== z)) block = { ...block };
    block.x = x; block.y = y; block.z = z;
    blocks.set(blockKey(x, y, z), block);
  };
  const putRoof = (x, y, z, block) => {
    put(x, y, z, block);
    const ck = colKey(x, z);
    const m = roofMin.get(ck);
    if (m === undefined || y < m) roofMin.set(ck, y);
  };
  const has = (x, y, z) => blocks.has(blockKey(x, y, z));

  for (let ti = 0; ti < tiers.length; ti++) {
  roofMin = roofMins[ti];
  const surface = new Map();   // this tier: colKey -> {s, boxId}
  const winner = new Map();    // colKey -> box index (internal)
  // ---- STEP 1 + 2: per-box surfaces, max-union (ties: later box wins) -----------
  design.boxes.forEach((b, bi) => {
    if (tierOf[bi] !== tiers[ti]) return;
    const reg = regions[bi];
    for (let cz = reg.z0; cz <= reg.z1; cz++) {
      for (let cx = reg.x0; cx <= reg.x1; cx++) {
        const s = roundHalf(boxSurface(b, reg, cx, cz));
        const k = colKey(cx, cz);
        const cur = surface.get(k);
        if (!cur || s >= cur.s - EPS) {
          surface.set(k, { s, boxId: b.id });
          winner.set(k, bi);
        }
      }
    }
  });

  // ---- STEP 3: decide the TOP of every column -------------------------------------
  // decision = { kind: 'slab'|'full'|'ridge'|'stair', layer, facing?, fillFrom, cx, cz, bi }
  const decisions = new Map();
  for (const [k, cell] of surface) {
    const bi = winner.get(k);
    const b = design.boxes[bi];
    const [cx, cz] = parseKey(k);
    const s = cell.s;
    // Neighbour surfaces. Off-region neighbours are VIRTUAL: "the slope continues off the
    // eave". SPEC-DEVIATION: the virtual value is the winning box's own surface formula
    // extrapolated one column past its region instead of the literal `s - rise` in every
    // direction. On eave sides that IS s - rise (identical to SPEC); on gable ends and shed
    // side edges (slope parallel to the edge) it is s. The literal rule makes the gable-end
    // virtual neighbour "lower", so with the N,E,S,W tie order every gable's SE eave corner
    // became a west-facing outer_right hip stair, and every flat roof grew inward-facing
    // stairs round its edge.
    const reg = regions[bi];
    const nb = {};
    let sMin = Infinity, fillMin = Infinity;
    for (const d of DIRS) {
      const [dx, dz] = DIR_OFFSET[d];
      const n = surface.get(colKey(cx + dx, cz + dz));
      const own = roundHalf(boxSurface(b, reg, cx + dx, cz + dz));
      const v = n ? n.s : own;
      nb[d] = v;
      if (v < sMin) sMin = v;
      // Fill depth only follows this box's own slope: a lower roof of ANOTHER box next door
      // (a tower rising out of a main roof) must not drag the fill down to it, or the
      // tower turns into a solid column of roof blocks and its walls never show.
      const fv = Math.max(v, own);
      if (fv < fillMin) fillMin = fv;
    }
    const lowDirs = DIRS.filter((d) => nb[d] < s - EPS);
    const highDirs = DIRS.filter((d) => nb[d] > s + EPS);
    let dec;
    if (isHalf(s)) {
      // 3a. half-block surface -> bottom slab at floor(s)
      dec = { kind: 'slab', layer: Math.floor(s) };
    } else {
      // 3b. integer surface
      const topLayer = s - 1;
      const ridge = (lowDirs.includes('north') && lowDirs.includes('south')) || (lowDirs.includes('east') && lowDirs.includes('west'));
      if (ridge) {
        dec = { kind: 'ridge', layer: topLayer };
      } else if (s - sMin <= 0.5 + EPS) {
        dec = { kind: 'full', layer: topLayer };
        // Valley candidate: nothing lower, exactly two higher neighbours on perpendicular
        // sides (concave corner). Resolved in the valley pass below.
        if (lowDirs.length === 0 && highDirs.length === 2 && AXIS_OF[highDirs[0]] !== AXIS_OF[highDirs[1]]) dec.valley = highDirs;
      } else {
        let lowest = DIRS[0];
        for (const d of DIRS) if (nb[d] < nb[lowest] - EPS) lowest = d; // ties: first in N,E,S,W order
        dec = { kind: 'stair', layer: topLayer, facing: OPPOSITE[lowest] };
      }
    }
    dec.fillFrom = isHalf(fillMin) ? Math.floor(fillMin) : fillMin;
    dec.cx = cx; dec.cz = cz; dec.bi = bi;
    // On the flat of a chopped roof: the cap.
    if (b.roof.cut > 0 && dec.kind === 'full' && s >= chopHeight(b, reg) - EPS) dec.cap = true;
    decisions.set(k, dec);
  }

  // SPEC-DEVIATION (valleys): the literal step-3b rule renders every valley cell (no lower
  // neighbour, two perpendicular higher neighbours) as a full block. With that, step 5 can
  // never produce inner_* stairs, because a roof stair's "back" cell is always its strictly
  // lower neighbour, i.e. air at the stair's layer. So a valley cell whose downhill-side
  // neighbour (opposite one of the higher sides) is a same-layer stair climbing toward the
  // other higher side becomes a stair facing the first higher side; step 5 then yields the
  // correct inner_left/inner_right valley stair. Everything else is unchanged.
  for (const dec of decisions.values()) {
    if (!dec.valley) continue;
    const [hA, hB] = dec.valley; // perpendicular higher directions, tie order
    const nbA = decisions.get(colKey(dec.cx + DIR_OFFSET[OPPOSITE[hA]][0], dec.cz + DIR_OFFSET[OPPOSITE[hA]][1]));
    const nbB = decisions.get(colKey(dec.cx + DIR_OFFSET[OPPOSITE[hB]][0], dec.cz + DIR_OFFSET[OPPOSITE[hB]][1]));
    if (nbA && nbA.kind === 'stair' && nbA.layer === dec.layer && nbA.facing === hB) { dec.kind = 'stair'; dec.facing = hA; }
    else if (nbB && nbB.kind === 'stair' && nbB.layer === dec.layer && nbB.facing === hA) { dec.kind = 'stair'; dec.facing = hB; }
    delete dec.valley;
  }

  // ---- STEP 3 (cont.): place TOP + FILL ----------------------------------------------
  const onRing = (reg, cx, cz) => cx === reg.x0 || cx === reg.x1 || cz === reg.z0 || cz === reg.z1;
  const roofMat = (b, reg, cx, cz) => (b.details.trim && onRing(reg, cx, cz) ? b.details.trimMat : b.roof.material);
  const roofPath = (b, reg, cx, cz) => (b.details.trim && onRing(reg, cx, cz) ? 'details.trimMat' : 'roof.material');
  for (const [k, dec] of decisions) {
    const b = design.boxes[dec.bi];
    const { cx, cz, layer } = dec;
    let m = roofMat(b, regions[dec.bi], cx, cz);
    let path = roofPath(b, regions[dec.bi], cx, cz);
    if (dec.kind === 'ridge' && b.details.ridge) { m = b.details.trimMat; path = 'details.trimMat'; }
    if (dec.cap && b.roof.capMat) { m = b.roof.capMat; path = 'roof.capMat'; }
    const putR = (x, y, z, blk) => putRoof(x, y, z, tag(blk, b.id, path));
    if (dec.cap && b.roof.cap === 'open') {
      // Open top: keep a one-block rim, leave the middle open.
      const inner = DIRS.every((d) => { const nd = decisions.get(colKey(cx + DIR_OFFSET[d][0], cz + DIR_OFFSET[d][1])); return nd && nd.cap && nd.bi === dec.bi; });
      if (inner) continue;
    }
    if (dec.cap && b.roof.cap === 'slab') {
      putR(cx, layer, cz, slabBlock(m, 'bottom', 'roof'));
    } else if (dec.kind === 'slab') {
      putR(cx, layer, cz, slabBlock(m, 'bottom', 'roof'));
    } else if (dec.kind === 'ridge') {
      // STEP 4: a ridge block is never a stair.
      const cap = b.roof.ridgeCap;
      if (cap === 'slab') putR(cx, layer, cz, slabBlock(m, 'bottom', 'roof'));
      else if (cap === 'wall' && fam(m).wall) {
        const conns = {};
        for (const d of DIRS) {
          const nd = decisions.get(colKey(cx + DIR_OFFSET[d][0], cz + DIR_OFFSET[d][1]));
          conns[d] = nd && nd.kind === 'ridge' && nd.layer === layer ? 'low' : 'none';
        }
        putR(cx, layer, cz, wallBlock(m, conns, 'roof'));
      } else putR(cx, layer, cz, fullBlock(m, 'roof'));
    } else if (dec.kind === 'full') {
      putR(cx, layer, cz, fullBlock(m, 'roof'));
    } else {
      putR(cx, layer, cz, stairBlock(m, dec.facing, 'bottom', 'roof'));
    }
    // FILL: full blocks from fillFrom up to the layer under the TOP (skip if empty range).
    for (let y = dec.fillFrom; y <= layer - 1; y++) putR(cx, y, cz, fullBlock(m, 'roof'));
  }

  // ---- STEP 3 soffit: upside-down stairs under the outermost ring ----------------------
  for (const dec of decisions.values()) {
    if (dec.kind !== 'stair') continue;
    const b = design.boxes[dec.bi];
    if (!b.roof.soffit || b.roof.overhang < 1) continue;
    const reg = regions[dec.bi];
    const { cx, cz, layer: t } = dec;
    const edges = [];
    if (cz === reg.z0) edges.push('north');
    if (cx === reg.x1) edges.push('east');
    if (cz === reg.z1) edges.push('south');
    if (cx === reg.x0) edges.push('west');
    if (edges.length === 0) continue; // not on the outermost ring
    if (has(cx, t - 1, cz)) continue;
    // "OUT" direction: prefer the stair's downhill side when it is a region edge.
    const down = OPPOSITE[dec.facing];
    const out = edges.includes(down) ? down : edges[0];
    putRoof(cx, t - 1, cz, tag(stairBlock(roofMat(b, reg, cx, cz), out, 'top', 'roof'), b.id, roofPath(b, reg, cx, cz)));
  }

  for (const [k, v] of surface) { const o = outSurface.get(k); if (!o || v.s >= o.s) outSurface.set(k, v); }
  } // tiers

  // A stacked box stands on its own: lower-tier roof in its footprint (its room and the line
  // of its walls), at or above its base, goes. Without walls it is open, and that roof stays.
  design.boxes.forEach((b, bi) => {
    if (tierOf[bi] === tiers[0] || !b.walls) return;
    for (let cz = b.z; cz < b.z + b.d; cz++) for (let cx = b.x; cx < b.x + b.w; cx++) {
      for (let ti = 0; tiers[ti] < tierOf[bi]; ti++) {
        const low = roofMins[ti].get(colKey(cx, cz));
        if (low === undefined) continue;
        for (let y = Math.max(low, b.baseY); y <= low + 512; y++) {
          const k = blockKey(cx, y, cz), blk = blocks.get(k);
          if (!blk) break;
          if (blk.role === 'roof' && tierOf[boxIndex.get(blk.src)] === tiers[ti]) blocks.delete(k);
        }
      }
    }
    // Eaves of a lower roof that hang off a wall this box now owns (a tower flush with a gable
    // end) would stick out across its face as a ledge: they go too.
    design.boxes.forEach((A, ai) => {
      if (tierOf[ai] >= tierOf[bi]) return;
      const reg = regions[ai], mins = roofMinOf(ai);
      for (let z = reg.z0; z <= reg.z1; z++) for (let x = reg.x0; x <= reg.x1; x++) {
        if (x >= A.x && x < A.x + A.w && z >= A.z && z < A.z + A.d) continue; // under A itself
        const px = Math.min(Math.max(x, A.x), A.x + A.w - 1), pz = Math.min(Math.max(z, A.z), A.z + A.d - 1);
        if (px < b.x || px >= b.x + b.w || pz < b.z || pz >= b.z + b.d) continue;
        const low = mins.get(colKey(x, z));
        if (low === undefined) continue;
        for (let y = Math.max(low, b.baseY); y <= low + 512; y++) {
          const k = blockKey(x, y, z), blk = blocks.get(k);
          if (!blk) break;
          if (blk.role === 'roof' && blk.src === A.id) blocks.delete(k);
        }
      }
    });
  });

  // ---- STEP 5: stair shape pass -------------------------------------------------------
  for (const blk of blocks.values()) {
    if (blk.kind === 'stair') blk.props.shape = stairShape(blocks, blk.x, blk.y, blk.z, blk);
  }

  // SPEC-DEVIATION (seal): on curved and round roofs a stair can take a corner shape, or a
  // slab can sit, right next to a taller column whose fill starts above it. The open upper
  // part of that block then looks straight into the room. Close every such gap with a full
  // block in the taller column. Straight-profile roofs never trigger this.
  const sealed = [];
  for (const blk of blocks.values()) {
    if (blk.role !== 'roof' || blk.kind === 'full') continue;
    const { x, y, z } = blk;
    for (const d of DIRS) {
      if (upperCoversFace(blk, d)) continue;
      const nx = x + DIR_OFFSET[d][0], nz = z + DIR_OFFSET[d][1];
      if (has(nx, y, nz)) continue;
      const srcBi = boxIndex.get(blk.src) ?? -1;
      const low = srcBi < 0 ? undefined : roofMinOf(srcBi).get(colKey(nx, nz));
      if (low === undefined || low <= y) continue;
      // Only within one box: a tower next to a lower roof is open air there, not a gap.
      if (blocks.get(blockKey(nx, low, nz))?.src !== blk.src) continue;
      sealed.push([nx, y, nz, blocks.get(blockKey(nx, low, nz)), low]);
    }
  }
  for (const [nx, y, nz, src, low] of sealed) {
    roofMin = roofMinOf(boxIndex.get(src.src));
    for (let yy = y; yy < low; yy++) if (!has(nx, yy, nz)) putRoof(nx, yy, nz, tag(fullBlock(src.mat, 'roof'), src.src, src.path));
  }

  // ---- STEP 6: walls, then floors -----------------------------------------------------
  // Shared-room rule (SPEC amendment): a cell (cx, y, cz) is "inside another room" when
  // the column lies STRICTLY inside (not on the perimeter of) some other box B's footprint and
  // y < B.baseY + B.wallH (B's eave). Box A's walls stop there and A's floor skips such cells
  // (for floors the layer must also be >= B.baseY). Dormers (baseY >= main eave) and gable
  // walls above a lower neighbouring box are unaffected.
  const insideOtherRoom = (a, cx, cz, y, forFloor) => {
    for (const b of design.boxes) {
      if (b === a) continue;
      if (cx <= b.x || cx >= b.x + b.w - 1 || cz <= b.z || cz >= b.z + b.d - 1) continue; // not strictly inside
      if (y < b.baseY + b.wallH && (!forFloor || y >= b.baseY)) return true;
    }
    return false;
  };
  for (const b of design.boxes) {
    if (!b.walls) continue;
    const bi = design.boxes.indexOf(b);
    const E = b.baseY + b.wallH;
    const det = b.details;
    const x1 = b.x + b.w - 1, z1 = b.z + b.d - 1;
    const op = wallOpenings(b);
    const sills = [];
    for (let cz = b.z; cz < b.z + b.d; cz++) {
      for (let cx = b.x; cx < b.x + b.w; cx++) {
        const perimeter = cx === b.x || cx === x1 || cz === b.z || cz === z1;
        if (!perimeter) continue;
        const corner = (cx === b.x || cx === x1) && (cz === b.z || cz === z1);
        // Side this column belongs to: runs along x (north/south walls) or z (east/west walls).
        const along = cz === b.z || cz === z1 ? 'x' : 'z';
        const side = along === 'x' ? (cz === b.z ? 'north' : 'south') : (cx === b.x ? 'west' : 'east');
        const i = along === 'x' ? cx - b.x : cz - b.z;
        const lowest = roofMinOf(bi).get(colKey(cx, cz));
        let start = (lowest === undefined ? E : lowest) - 1;
        // A box stacked on this one (another floor, or a tower on a higher roof tier) builds
        // its own walls: stop below it.
        design.boxes.forEach((o, oi) => {
          if (o !== b && o.walls && (o.baseY > b.baseY || tierOf[oi] > tierOf[bi]) && o.baseY <= start && cx >= o.x && cx < o.x + o.w && cz >= o.z && cz < o.z + o.d) start = o.baseY - 1;
        });
        for (let y = start; y >= b.baseY; y--) {
          if (has(cx, y, cz)) break; // STOP at anything already there (roof, other walls, ...)
          if (insideOtherRoom(b, cx, cz, y, false)) break; // STOP inside another box's room
          const cell = corner ? null : op.at(side, i, y);
          let blk;
          if (det.base && y === b.baseY) blk = tag(fullBlock(det.baseMat, 'wall'), b.id, 'details.baseMat');
          else if (det.corners && corner) blk = tag(fullBlock(det.cornerMat, 'wall', 'y'), b.id, 'details.cornerMat');
          else if (det.beams && y === E - 1) blk = tag(fullBlock(det.beamMat, 'wall', along), b.id, 'details.beamMat');
          else if (cell === 'door') continue; // doorway: leave the opening
          else if (cell === 'glass') {
            blk = tag(det.winStyle === 'block' ? fullBlock(det.windowMat, 'wall') : paneBlock(det.windowMat, along, 'wall'), b.id, 'details.windowMat');
            if (det.sills && y === op.rowLo) sills.push([cx, cz, side]);
          } else if (cell === 'frameV') blk = tag(fullBlock(det.frameMat, 'wall', 'y'), b.id, 'details.frameMat');
          else if (cell === 'frameH') blk = tag(fullBlock(det.frameMat, 'wall', along), b.id, 'details.frameMat');
          else if (cell === 'stud') blk = tag(fullBlock(det.beamMat, 'wall', 'y'), b.id, 'details.beamMat');
          else blk = tag(fullBlock(b.wallMaterial, 'wall'), b.id, 'wallMaterial');
          put(cx, y, cz, blk);
        }
      }
    }
    // Window sills: an upside-down stair (or slab) just outside the wall under each window.
    for (const [cx, cz, side] of sills) {
      const [dx, dz] = DIR_OFFSET[side];
      const x = cx + dx, y = op.rowLo - 1, z = cz + dz;
      if (has(x, y, z)) continue;
      const f = fam(det.sillMat);
      const blk = f.stairs ? stairBlock(det.sillMat, OPPOSITE[side], 'top', 'wall') : slabBlock(det.sillMat, 'top', 'wall');
      put(x, y, z, tag(blk, b.id, 'details.sillMat'));
    }
  }
  for (const b of design.boxes) {
    if (!b.floor) continue;
    for (let cz = b.z + 1; cz < b.z + b.d - 1; cz++) {
      for (let cx = b.x + 1; cx < b.x + b.w - 1; cx++) {
        if (has(cx, b.baseY, cz)) continue;
        if (insideOtherRoom(b, cx, cz, b.baseY, true)) continue;
        put(cx, b.baseY, cz, tag(fullBlock(b.wallMaterial, 'floor'), b.id, 'wallMaterial'));
      }
    }
  }

  // ---- STEP 7: pillars, segments ---------------------------------------------------------
  let pillarStairs = false;
  for (const p of design.pillars) {
    const n = p.size, top = p.baseY + p.h - 1;
    const x1 = p.x + n - 1, z1 = p.z + n - 1;
    // Wall-block posts connect to their neighbours inside a thick pillar.
    const conns = (x, z) => ({ north: z > p.z ? 'tall' : 'none', south: z < z1 ? 'tall' : 'none', west: x > p.x ? 'tall' : 'none', east: x < x1 ? 'tall' : 'none' });
    for (let y = p.baseY; y <= top; y++) {
      for (let z = p.z; z <= z1; z++) for (let x = p.x; x <= x1; x++) {
        if (has(x, y, z)) continue;
        const blk = p.shape === 'wall' ? wallBlock(p.material, conns(x, z), 'pillar') : fullBlock(p.material, 'pillar', 'y');
        put(x, y, z, tag(blk, p.id, 'material'));
      }
    }
    // Base (plinth) and capital: a one-block ring round the bottom / top row.
    const ring = (y, kind, mat, path, half) => {
      if (kind === 'none') return;
      for (let z = p.z - 1; z <= z1 + 1; z++) for (let x = p.x - 1; x <= x1 + 1; x++) {
        const edge = x === p.x - 1 || x === x1 + 1 || z === p.z - 1 || z === z1 + 1;
        if (!edge || has(x, y, z)) continue;
        let blk;
        if (kind === 'block') blk = fullBlock(mat, 'pillar');
        else if (kind === 'slab') blk = slabBlock(mat, half, 'pillar');
        else {
          // Stairs climb toward the pillar; corner pieces become outer corners in the shape pass.
          const facing = z === p.z - 1 ? 'south' : z === z1 + 1 ? 'north' : x === p.x - 1 ? 'east' : 'west';
          blk = stairBlock(mat, facing, half, 'pillar');
          pillarStairs = true;
        }
        put(x, y, z, tag(blk, p.id, path));
      }
    };
    ring(p.baseY, p.base, p.baseMat, 'baseMat', 'bottom');
    if (p.h > 1 || p.base === 'none') ring(top, p.cap, p.capMat, 'capMat', 'top');
  }
  for (const sg of design.segments) {
    const cols = [];
    if (sg.x0 === sg.x1 || sg.z0 === sg.z1) {
      const xa = Math.min(sg.x0, sg.x1), xb = Math.max(sg.x0, sg.x1);
      const za = Math.min(sg.z0, sg.z1), zb = Math.max(sg.z0, sg.z1);
      for (let z = za; z <= zb; z++) for (let x = xa; x <= xb; x++) cols.push([x, z]);
    } else {
      // not axis aligned: use x0..x1 at z0
      const xa = Math.min(sg.x0, sg.x1), xb = Math.max(sg.x0, sg.x1);
      for (let x = xa; x <= xb; x++) cols.push([x, sg.z0]);
    }
    for (const [x, z] of cols) {
      for (let y = sg.baseY; y < sg.baseY + sg.h; y++) {
        if (!has(x, y, z)) put(x, y, z, tag(fullBlock(sg.material, 'segment'), sg.id, 'material'));
      }
    }
  }
  // Fills: a solid rectangle of one block shape, only where nothing is built yet.
  for (const f of design.fills || []) {
    const make = () => {
      if (f.shape === 'slab') return slabBlock(f.material, f.half, 'fill');
      if (f.shape === 'stair') { pillarStairs = true; return stairBlock(f.material, f.facing, f.half, 'fill'); }
      if (f.shape === 'pane') return paneBlock(f.material, f.axis, 'fill');
      return fullBlock(f.material, 'fill', f.axis);
    };
    for (let y = f.baseY; y < f.baseY + f.h; y++) {
      for (let z = f.z; z < f.z + f.d; z++) for (let x = f.x; x < f.x + f.w; x++) {
        if (!inOutline(f.outline, f.x, f.z, f.w, f.d, x, z, f.hollow)) continue;
        if (!has(x, y, z)) put(x, y, z, tag(make(), f.id, 'material'));
      }
    }
  }

  // ---- STEP 7b: texture variation (main wall / roof material only) ------------------------
  for (const b of design.boxes) {
    const va = b.variation;
    if (!va.wall && !va.roof) continue;
    const mixes = {
      wallMaterial: va.wall ? pickMixes(MIX_KEYS.wall.slice(0, va.wallMixCount).map((k) => va[k]), b.wallMaterial) : null,
      'roof.material': va.roof ? pickMixes(MIX_KEYS.roof.slice(0, va.roofMixCount).map((k) => va[k]), b.roof.material) : null,
    };
    const amount = { wallMaterial: va.wall / 100, 'roof.material': va.roof / 100 };
    const E = b.baseY + b.wallH;
    let roofTop = E + 1;
    for (const blk of blocks.values()) if (blk.src === b.id && blk.path === 'roof.material') roofTop = Math.max(roofTop, blk.y + 1);
    for (const [key, blk] of blocks) {
      if (blk.src !== b.id) continue;
      const mix = mixes[blk.path];
      if (!mix || !mix.length) continue;
      const { x, y, z } = blk;
      const v = blk.path === 'roof.material'
        ? variationValue(va.style, va.seed, x, y, z, E - 1, roofTop) // roofs weather from the eaves up
        : variationValue(va.style, va.seed, x, y, z, b.baseY, E);
      if (v >= amount[blk.path]) continue;
      // Several mixes: share the hits out between them with an independent hash. (With two,
      // the low half goes to the second, as it always has.)
      const h = Math.min(mix.length - 1, Math.floor(hash3(x, y, z, va.seed + 7) * mix.length));
      const m = mix[mix.length === 2 ? 1 - h : h];
      const nb = reskin(blk, m);
      if (nb) blocks.set(key, nb);
    }
  }

  // ---- STEP 7c: hand edits (box edits move with their box; design edits are world cells) ----
  const edits = [];
  for (const b of design.boxes) for (const e of b.edits) edits.push({ ...e, x: b.x + e.x, y: b.baseY + e.y, z: b.z + e.z, owner: b.id });
  for (const e of design.edits) edits.push(e);
  let editedStairs = false;
  for (const e of edits) {
    const key = blockKey(e.x, e.y, e.z);
    const cur = blocks.get(key);
    if (e.shape === 'erase') { blocks.delete(key); continue; }
    if (e.shape === 'paint') {
      if (!cur) continue;
      const nb = reskin(cur, e.mat) || tag(fullBlock(e.mat, cur.role), cur.src, cur.path);
      nb.edited = true;
      put(e.x, e.y, e.z, nb);
      continue;
    }
    let blk;
    if (e.shape === 'slab') blk = slabBlock(e.mat, e.half, 'placed');
    else if (e.shape === 'stair') { blk = stairBlock(e.mat, e.facing, e.half, 'placed'); editedStairs = true; }
    else if (e.shape === 'pane') blk = paneBlock(e.mat, e.axis, 'placed');
    else blk = fullBlock(e.mat, 'placed', e.axis);
    blk.src = e.owner || null;
    blk.edited = true;
    put(e.x, e.y, e.z, blk);
  }
  if (editedStairs || edits.length || pillarStairs) {
    for (const blk of blocks.values()) {
      if (blk.kind === 'stair') blk.props.shape = stairShape(blocks, blk.x, blk.y, blk.z, blk);
    }
  }

  // ---- STEP 8: bounds ----------------------------------------------------------------------
  let min = { x: 0, y: 0, z: 0 }, max = { x: 0, y: 0, z: 0 };
  if (blocks.size > 0) {
    min = { x: Infinity, y: Infinity, z: Infinity };
    max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const { x, y, z } of blocks.values()) {
      if (x < min.x) min.x = x; if (y < min.y) min.y = y; if (z < min.z) min.z = z;
      if (x > max.x) max.x = x; if (y > max.y) max.y = y; if (z > max.z) max.z = z;
    }
  }
  return { blocks, min, max, surface: outSurface };
}

// ---------------------------------------------------------------------------------
// Material totals (group by block.id only)
// ---------------------------------------------------------------------------------
const KIND_LABEL = { full: 'block', slab: 'slab', stair: 'stairs', wall: 'wall', pane: 'pane' };

export function materialTotals(grid) {
  const totals = new Map();
  for (const blk of grid.blocks.values()) {
    let t = totals.get(blk.id);
    if (!t) {
      const f = FAMILIES[blk.mat];
      t = { id: blk.id, name: `${f ? f.name : blk.mat} ${KIND_LABEL[blk.kind] || blk.kind}`, count: 0 };
      totals.set(blk.id, t);
    }
    t.count++;
  }
  return [...totals.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------------
// Compact transfer of a built grid (from the engine worker to the page)
// ---------------------------------------------------------------------------------

/**
 * A grid as transferable arrays: every block's cell in `xyz` and an index into `palette`,
 * the list of distinct block templates (without x/y/z). The surface map is left out.
 */
export function encodeGrid(grid) {
  const n = grid.blocks.size;
  const xyz = new Int32Array(n * 3), pal = new Uint32Array(n);
  const palette = [], seen = new Map();
  let i = 0;
  for (const b of grid.blocks.values()) {
    const p = b.props;
    let ps = '';
    for (const k in p) ps += k + '=' + p[k] + ',';
    const key = b.id + '|' + ps + '|' + b.kind + '|' + b.mat + '|' + b.role + '|' + b.src + '|' + b.path + '|' + (b.edited ? 1 : 0) + '|' + b.color;
    let t = seen.get(key);
    if (t === undefined) {
      const { x, y, z, ...rest } = b;
      t = palette.length;
      palette.push(rest);
      seen.set(key, t);
    }
    xyz[i * 3] = b.x; xyz[i * 3 + 1] = b.y; xyz[i * 3 + 2] = b.z;
    pal[i++] = t;
  }
  return { xyz, pal, palette, min: grid.min, max: grid.max };
}

/** The grid back from encodeGrid. Blocks of one template share its props object. */
export function decodeGrid({ xyz, pal, palette, min, max, meshes }) {
  const blocks = new Map();
  for (let i = 0, n = pal.length; i < n; i++) {
    const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
    blocks.set(x + ',' + y + ',' + z, { ...palette[pal[i]], x, y, z });
  }
  return meshes ? { blocks, min, max, surface: new Map(), meshes } : { blocks, min, max, surface: new Map() };
}
