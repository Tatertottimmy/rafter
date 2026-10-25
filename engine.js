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
};
// Texture variation: swap a share of wall / roof blocks for look-alike materials so big
// surfaces don't read as one flat repeat. Mix '' = pick automatically (suggestVariants).
export const VARIATION_STYLES = ['patches', 'scatter', 'grime', 'streaks'];
export const VARIATION_DEFAULTS = { wall: 0, roof: 0, style: 'patches', wallMix: '', wallMix2: '', roofMix: '', roofMix2: '', seed: 1 };
// Hand edits: paint keeps the existing block's shape, place puts a new block, erase clears.
export const EDIT_SHAPES = ['paint', 'full', 'slab', 'stair', 'erase'];
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

  const used = new Set();
  const claim = (obj, prefix) => {
    if (typeof obj.id !== 'string' || obj.id === '' || used.has(obj.id)) obj.id = newId({ boxes: d.boxes, pillars: d.pillars, segments: d.segments }, prefix, used);
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
    // Any block can roof: families without slabs/stairs fall back to full blocks.
    r.material = familyKey(r.material, 'spruce', false);
    const det = b.details && typeof b.details === 'object' ? b.details : {};
    b.details = det;
    for (const [k, v] of Object.entries(DETAIL_DEFAULTS)) {
      det[k] = typeof v === 'boolean' ? bool(det[k], v) : familyKey(det[k], v, false);
    }
    const va = b.variation && typeof b.variation === 'object' ? b.variation : {};
    b.variation = va;
    va.wall = int(va.wall, 0, 0, 100);
    va.roof = int(va.roof, 0, 0, 100);
    va.style = oneOf(va.style, VARIATION_STYLES, 'patches');
    for (const k of ['wallMix', 'wallMix2', 'roofMix', 'roofMix2']) va[k] = va[k] === '' || va[k] == null ? '' : familyKey(va[k], '', false);
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
    const k = blockKey(out.x, out.y, out.z);
    byCell.delete(k);
    byCell.set(k, out);
  }
  return [...byCell.values()].slice(-EDITS_MAX);
}

/** Unused id like "b3" (smallest free counter for the prefix). */
/**
 * Rotate an object `q` quarter-turns clockwise (seen from above) about the centre of its
 * footprint. Boxes swap w/d and turn their roof (axis, shed low side); segments turn their
 * endpoints. Returns a patch; odd-by-even footprints round the new corner down.
 */
export function rotatePatch(kind, obj, q) {
  q = ((q % 4) + 4) % 4;
  if (!q) return {};
  const turn = (dir) => { for (let i = 0; i < q; i++) dir = CW[dir]; return dir; };
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
  for (const list of [design?.boxes, design?.pillars, design?.segments]) {
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
function pickMixes(a, b, base) {
  const out = [a, b].filter((k) => k && FAMILIES[k] && k !== base);
  return out.length ? out : suggestVariants(base).slice(0, 2);
}

const VARIANT_PREFIXES = ['mossy_', 'cracked_', 'chiseled_', 'weathered_', 'exposed_'];
/** Look-alike materials for breaking up a surface: named variants first, then nearest colours. */
export function suggestVariants(key) {
  const f = FAMILIES[key];
  if (!f) return [];
  const out = [];
  const add = (k) => { if (k && k !== key && FAMILIES[k] && !out.includes(k)) out.push(k); };
  let base = key;
  for (const p of VARIANT_PREFIXES) if (key.startsWith(p)) { base = key.slice(p.length); add(base); }
  for (const p of VARIANT_PREFIXES) add(p + base);
  if (base.endsWith('_tiles')) add(base.replace(/_tiles$/, '_bricks'));
  if (base.endsWith('_bricks')) add(base.replace(/_bricks$/, '_tiles'));
  if (out.length >= 2) return out;
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [r, g, b] = rgb(f.color);
  const dist = (k) => { const [r2, g2, b2] = rgb(FAMILIES[k].color); return Math.hypot(r - r2, g - g2, b - b2); };
  const near = Object.keys(FAMILIES)
    .filter((k) => k !== key && !out.includes(k) && FAMILIES[k].group === f.group && !FAMILIES[k].transparent
      && (!f.stairs || FAMILIES[k].stairs) && FAMILIES[k].pattern === f.pattern)
    .sort((a, c) => dist(a) - dist(c));
  for (const k of near) if (dist(k) < 45) add(k);
  if (!out.length) {
    // Nothing close in the same pattern: settle for the nearest opaque colours anywhere.
    const loose = Object.keys(FAMILIES)
      .filter((k) => k !== key && !FAMILIES[k].transparent && (!f.stairs || FAMILIES[k].stairs) && !['Ores', 'Leaves', 'Glazed terracotta'].includes(FAMILIES[k].group))
      .sort((a, c) => dist(a) - dist(c));
    for (const k of loose.slice(0, 2)) if (dist(k) < 50) add(k);
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

/** Surface height s_b(cx,cz) of one box at a column inside its region. */
function boxSurface(b, reg, cx, cz) {
  return baseSurface(b, reg, cx, cz) + cornerLift(b.roof, reg, cx, cz);
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
// buildGrid
// ---------------------------------------------------------------------------------
export function buildGrid(input) {
  // Work on a validated copy so the caller's design object is never mutated.
  const design = validateDesign(JSON.parse(JSON.stringify(input ?? {})));
  const blocks = new Map();
  const surface = new Map();   // colKey -> {s, boxId}
  const winner = new Map();    // colKey -> box index (internal)
  const roofMin = new Map();   // colKey -> lowest layer holding a role "roof" block
  const regions = design.boxes.map(boxRegion);

  const put = (x, y, z, block) => { blocks.set(blockKey(x, y, z), block); };
  const putRoof = (x, y, z, block) => {
    put(x, y, z, block);
    const ck = colKey(x, z);
    const m = roofMin.get(ck);
    if (m === undefined || y < m) roofMin.set(ck, y);
  };
  const has = (x, y, z) => blocks.has(blockKey(x, y, z));

  // ---- STEP 1 + 2: per-box surfaces, max-union (ties: later box wins) -----------
  design.boxes.forEach((b, bi) => {
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
    const putR = (x, y, z, blk) => putRoof(x, y, z, tag(blk, b.id, path));
    if (dec.kind === 'slab') {
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

  // ---- STEP 5: stair shape pass -------------------------------------------------------
  for (const [key, blk] of blocks) {
    if (blk.kind !== 'stair') continue;
    const [x, y, z] = parseKey(key);
    blk.props.shape = stairShape(blocks, x, y, z, blk);
  }

  // SPEC-DEVIATION (seal): on curved and round roofs a stair can take a corner shape, or a
  // slab can sit, right next to a taller column whose fill starts above it. The open upper
  // part of that block then looks straight into the room. Close every such gap with a full
  // block in the taller column. Straight-profile roofs never trigger this.
  const sealed = [];
  for (const [key, blk] of blocks) {
    if (blk.role !== 'roof' || blk.kind === 'full') continue;
    const [x, y, z] = parseKey(key);
    for (const d of DIRS) {
      if (upperCoversFace(blk, d)) continue;
      const nx = x + DIR_OFFSET[d][0], nz = z + DIR_OFFSET[d][1];
      if (has(nx, y, nz)) continue;
      const low = roofMin.get(colKey(nx, nz));
      if (low === undefined || low <= y) continue;
      // Only within one box: a tower next to a lower roof is open air there, not a gap.
      if (blocks.get(blockKey(nx, low, nz)).src !== blk.src) continue;
      sealed.push([nx, y, nz, blocks.get(blockKey(nx, low, nz)), low]);
    }
  }
  for (const [nx, y, nz, src, low] of sealed) for (let yy = y; yy < low; yy++) if (!has(nx, yy, nz)) putRoof(nx, yy, nz, tag(fullBlock(src.mat, 'roof'), src.src, src.path));

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
    const E = b.baseY + b.wallH;
    const det = b.details;
    const x1 = b.x + b.w - 1, z1 = b.z + b.d - 1;
    const winTop = b.baseY + Math.min(b.wallH - 2, 3); // window rows: baseY+1 .. winTop
    for (let cz = b.z; cz < b.z + b.d; cz++) {
      for (let cx = b.x; cx < b.x + b.w; cx++) {
        const perimeter = cx === b.x || cx === x1 || cz === b.z || cz === z1;
        if (!perimeter) continue;
        const corner = (cx === b.x || cx === x1) && (cz === b.z || cz === z1);
        // Side this column belongs to: runs along x (north/south walls) or z (east/west walls).
        const along = cz === b.z || cz === z1 ? 'x' : 'z';
        const i = along === 'x' ? cx - b.x : cz - b.z, L = along === 'x' ? b.w : b.d;
        // Windows: symmetric about the side's centre, every 3rd column, never next to a corner.
        const k = Math.abs(i - (L - 1) / 2);
        const winCol = det.windows && !corner && i >= 2 && i <= L - 3 && (k % 3) < 1;
        const lowest = roofMin.get(colKey(cx, cz));
        const start = (lowest === undefined ? E : lowest) - 1;
        for (let y = start; y >= b.baseY; y--) {
          if (has(cx, y, cz)) break; // STOP at anything already there (roof, other walls, ...)
          if (insideOtherRoom(b, cx, cz, y, false)) break; // STOP inside another box's room
          let blk;
          if (det.base && y === b.baseY) blk = tag(fullBlock(det.baseMat, 'wall'), b.id, 'details.baseMat');
          else if (det.corners && corner) blk = tag(fullBlock(det.cornerMat, 'wall', 'y'), b.id, 'details.cornerMat');
          else if (det.beams && y === E - 1) blk = tag(fullBlock(det.beamMat, 'wall', along), b.id, 'details.beamMat');
          else if (winCol && y >= b.baseY + 1 && y <= winTop) blk = tag(paneBlock(det.windowMat, along, 'wall'), b.id, 'details.windowMat');
          else blk = tag(fullBlock(b.wallMaterial, 'wall'), b.id, 'wallMaterial');
          put(cx, y, cz, blk);
        }
      }
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
  for (const p of design.pillars) {
    for (let y = p.baseY; y < p.baseY + p.h; y++) {
      if (!has(p.x, y, p.z)) put(p.x, y, p.z, tag(fullBlock(p.material, 'pillar'), p.id, 'material'));
    }
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

  // ---- STEP 7b: texture variation (main wall / roof material only) ------------------------
  for (const b of design.boxes) {
    const va = b.variation;
    if (!va.wall && !va.roof) continue;
    const mixes = {
      wallMaterial: va.wall ? pickMixes(va.wallMix, va.wallMix2, b.wallMaterial) : null,
      'roof.material': va.roof ? pickMixes(va.roofMix, va.roofMix2, b.roof.material) : null,
    };
    const amount = { wallMaterial: va.wall / 100, 'roof.material': va.roof / 100 };
    const E = b.baseY + b.wallH;
    let roofTop = E + 1;
    for (const [key, blk] of blocks) if (blk.src === b.id && blk.path === 'roof.material') roofTop = Math.max(roofTop, parseKey(key)[1] + 1);
    for (const [key, blk] of blocks) {
      if (blk.src !== b.id) continue;
      const mix = mixes[blk.path];
      if (!mix || !mix.length) continue;
      const [x, y, z] = parseKey(key);
      const v = blk.path === 'roof.material'
        ? variationValue(va.style, va.seed, x, y, z, E - 1, roofTop) // roofs weather from the eaves up
        : variationValue(va.style, va.seed, x, y, z, b.baseY, E);
      if (v >= amount[blk.path]) continue;
      // Two mixes: split the hits between them with an independent hash.
      const m = mix.length > 1 && hash3(x, y, z, va.seed + 7) < 0.5 ? mix[1] : mix[0];
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
      blocks.set(key, nb);
      continue;
    }
    let blk;
    if (e.shape === 'slab') blk = slabBlock(e.mat, e.half, 'placed');
    else if (e.shape === 'stair') { blk = stairBlock(e.mat, e.facing, e.half, 'placed'); editedStairs = true; }
    else blk = fullBlock(e.mat, 'placed', e.axis);
    blk.src = e.owner || null;
    blk.edited = true;
    blocks.set(key, blk);
  }
  if (editedStairs || edits.length) {
    for (const [key, blk] of blocks) {
      if (blk.kind !== 'stair') continue;
      const [x, y, z] = parseKey(key);
      blk.props.shape = stairShape(blocks, x, y, z, blk);
    }
  }

  // ---- STEP 8: bounds ----------------------------------------------------------------------
  let min = { x: 0, y: 0, z: 0 }, max = { x: 0, y: 0, z: 0 };
  if (blocks.size > 0) {
    min = { x: Infinity, y: Infinity, z: Infinity };
    max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const key of blocks.keys()) {
      const [x, y, z] = parseKey(key);
      if (x < min.x) min.x = x; if (y < min.y) min.y = y; if (z < min.z) min.z = z;
      if (x > max.x) max.x = x; if (y > max.y) max.y = y; if (z > max.z) max.z = z;
    }
  }
  return { blocks, min, max, surface };
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
