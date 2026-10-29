// mesher.js — pure block-shape geometry and face meshing for Rafter (no three.js), so the
// page and the engine worker can both use it. viewer3d.js re-exports all of it.
import { FAMILIES } from './blocks.js';

// ---------------------------------------------------------------------------
// Pure geometry / math helpers (no THREE usage) — exported for node tests.
// ---------------------------------------------------------------------------

/** Rotation about +y so that the north-facing vector (0,0,-1) maps onto `facing`. */
export const FACING_ANGLE = { north: 0, east: -Math.PI / 2, south: Math.PI, west: Math.PI / 2 };
export const DIRS = ['north', 'east', 'south', 'west'];
export const DIR_OFFSET = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
export const STAIR_SHAPES = ['straight', 'outer_left', 'outer_right', 'inner_left', 'inner_right'];
export const STAIR_HALVES = ['bottom', 'top'];

/** (0,0,-1) rotated by FACING_ANGLE[facing] about +y, as integer [dx, dz]. Must equal DIR_OFFSET. */
export function facingVector(facing) {
  const t = FACING_ANGLE[facing] ?? 0;
  const c = Math.round(Math.cos(t)), s = Math.round(Math.sin(t));
  // three.js Matrix4.makeRotationY: x' = c*x + s*z ; z' = -s*x + c*z
  return [(-s) || 0, (-c) || 0]; // "|| 0" normalises -0
}

/** Quarters of the top level of a north-facing stair that are tall (full height). */
export const STAIR_TALL_QUARTERS_NORTH = {
  straight: ['NW', 'NE'],
  outer_left: ['NW'],
  outer_right: ['NE'],
  inner_left: ['NW', 'NE', 'SW'],
  inner_right: ['NW', 'NE', 'SE'],
};
const QUARTER_IDX = { NW: [0, 0], NE: [1, 0], SW: [0, 1], SE: [1, 1] }; // [x half, z half]
const QUARTER_NAME = ['NW', 'NE', 'SW', 'SE'];

/** Tall quarters of a stair with `shape` and `facing` in world terms (N/S/E/W quarter names). */
export function tallQuarters(shape, facing = 'north') {
  const base = STAIR_TALL_QUARTERS_NORTH[shape] || STAIR_TALL_QUARTERS_NORTH.straight;
  const t = FACING_ANGLE[facing] ?? 0;
  const c = Math.round(Math.cos(t)), s = Math.round(Math.sin(t));
  return base.map((q) => {
    const [ix, iz] = QUARTER_IDX[q];
    const rx = ix - 0.5, rz = iz - 0.5;           // quarter centre relative to block centre (×0.5)
    const x = c * rx + s * rz, z = -s * rx + c * rz;
    return QUARTER_NAME[(z > 0 ? 2 : 0) + (x > 0 ? 1 : 0)];
  }).sort();
}

/**
 * Boxes (in block-local [0,1] coords, [minx,miny,minz,maxx,maxy,maxz]) making up a
 * north-facing stair of `shape` and `half`. Half "top" mirrors y -> 1-y.
 */
export function stairBoxes(shape, half = 'bottom') {
  const boxes = [[0, 0, 0, 1, 0.5, 1]]; // base slab
  switch (shape) {
    case 'outer_left': boxes.push([0, 0.5, 0, 0.5, 1, 0.5]); break;
    case 'outer_right': boxes.push([0.5, 0.5, 0, 1, 1, 0.5]); break;
    case 'inner_left': boxes.push([0, 0.5, 0, 1, 1, 0.5], [0, 0.5, 0.5, 0.5, 1, 1]); break;
    case 'inner_right': boxes.push([0, 0.5, 0, 1, 1, 0.5], [0.5, 0.5, 0.5, 1, 1, 1]); break;
    default: boxes.push([0, 0.5, 0, 1, 1, 0.5]); // straight: whole north half
  }
  if (half === 'top') return boxes.map(([x0, y0, z0, x1, y1, z1]) => [x0, 1 - y1, z0, x1, 1 - y0, z1]);
  return boxes;
}

/** Wall pieces (north-facing arm). */
export const WALL_BOXES = {
  wall_post: [[0.25, 0, 0.25, 0.75, 1, 0.75]],
  wall_arm: [[0.25, 0, 0, 0.75, 0.875, 0.25]],
  wall_arm_tall: [[0.25, 0, 0, 0.75, 1, 0.25]],
  pane_post: [[0.4375, 0, 0.4375, 0.5625, 1, 0.5625]],
  pane_arm: [[0.4375, 0, 0, 0.5625, 1, 0.4375]],
};

export function boxVolume(boxes) {
  return boxes.reduce((s, [x0, y0, z0, x1, y1, z1]) => s + (x1 - x0) * (y1 - y0) * (z1 - z0), 0);
}

/** UV for a vertex from its face normal and block-local position, so partial blocks show the matching texture region. */
export function uvForVertex(nx, ny, nz, px, py, pz) {
  if (Math.abs(ny) > 0.5) return [px, 1 - pz];     // top/bottom: north (low z) at top of texture
  if (Math.abs(nx) > 0.5) return [nx > 0 ? 1 - pz : pz, py];
  return [nz > 0 ? px : 1 - px, py];
}

/** Geometry kind for a block + per-instance rotation(s). Returns [{kind, angle}]. */
export function classifyBlock(block) {
  const p = block.props || {};
  switch (block.kind) {
    case 'slab':
      if (p.type === 'double') return [{ kind: 'full', angle: 0 }];
      return [{ kind: p.type === 'top' ? 'slab_top' : 'slab_bottom', angle: 0 }];
    case 'stair': {
      const shape = STAIR_SHAPES.includes(p.shape) ? p.shape : 'straight';
      const half = p.half === 'top' ? 'top' : 'bottom';
      return [{ kind: `stair_${shape}_${half}`, angle: FACING_ANGLE[p.facing] ?? 0 }];
    }
    case 'wall': {
      const out = [];
      if (p.up !== 'false') out.push({ kind: 'wall_post', angle: 0 });
      for (const d of DIRS) {
        if (p[d] === 'low') out.push({ kind: 'wall_arm', angle: FACING_ANGLE[d] });
        else if (p[d] === 'tall') out.push({ kind: 'wall_arm_tall', angle: FACING_ANGLE[d] });
      }
      if (!out.length) out.push({ kind: 'wall_post', angle: 0 });
      return out;
    }
    case 'pane': {
      const out = [{ kind: 'pane_post', angle: 0 }];
      for (const d of DIRS) if (p[d] === 'true') out.push({ kind: 'pane_arm', angle: FACING_ANGLE[d] });
      return out;
    }
    default:
      return [{ kind: 'full', angle: 0 }];
  }
}

/** Rough roof height (blocks above eave) of a box, for pick proxies only. */
export function roofHeightEstimate(box) {
  const roof = box.roof || {};
  const oh = Math.max(0, roof.overhang | 0);
  const r = +roof.rise || 1, r2 = +roof.rise2 || 0.5, brk = +roof.breakAt || 3;
  const runX = (box.w + 2 * oh - 1) / 2, runZ = (box.d + 2 * oh - 1) / 2;
  const across = roof.axis === 'z' ? runX : runZ;
  const g = (d) => (d <= brk ? r * d : r * brk + r2 * (d - brk));
  let h;
  switch (roof.type) {
    case 'flat': h = 0; break;
    case 'shed': h = r * ((roof.shedLow === 'east' || roof.shedLow === 'west') ? box.w + 2 * oh - 1 : box.d + 2 * oh - 1); break;
    case 'hip': h = r * Math.min(runX, runZ); break;
    case 'gambrel': h = g(across); break;
    case 'mansard': h = g(Math.min(runX, runZ)); break;
    case 'gable': case 'halfhip': h = r * across; break;
    default: h = r * Math.max(runX, runZ);
  }
  return Math.ceil(Math.max(0, h)) + 1;
}

/** Binary search: first index in sorted int array with value >= v. */
export function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}


// ---------------------------------------------------------------------------
// Face meshing: one merged mesh per material holding only the faces that can be seen
// ---------------------------------------------------------------------------

const KIND_BOXES = (() => {
  const m = { full: [[0, 0, 0, 1, 1, 1]], slab_bottom: [[0, 0, 0, 1, 0.5, 1]], slab_top: [[0, 0.5, 0, 1, 1, 1]], ...WALL_BOXES };
  for (const s of STAIR_SHAPES) for (const h of STAIR_HALVES) m[`stair_${s}_${h}`] = stairBoxes(s, h);
  return m;
})();

/** The boxes of a block in its cell ([0,1] coords), turned the way it faces. */
export function blockBoxes(block) {
  const out = [];
  for (const { kind, angle } of classifyBlock(block)) {
    const c = Math.round(Math.cos(angle)), s = Math.round(Math.sin(angle));
    for (const [x0, y0, z0, x1, y1, z1] of KIND_BOXES[kind] || KIND_BOXES.full) {
      // Same turn as the instance matrix (makeRotationY) about the cell centre.
      const xa = c * (x0 - 0.5) + s * (z0 - 0.5) + 0.5, xb = c * (x1 - 0.5) + s * (z1 - 0.5) + 0.5;
      const za = -s * (x0 - 0.5) + c * (z0 - 0.5) + 0.5, zb = -s * (x1 - 0.5) + c * (z1 - 0.5) + 0.5;
      out.push([Math.min(xa, xb), y0, Math.min(za, zb), Math.max(xa, xb), y1, Math.max(za, zb)]);
    }
  }
  return out;
}

/** A whole, opaque cube: the faces of anything touching it are hidden. */
export function isOpaqueCube(b) {
  return !!b && (b.kind === 'full' || (b.kind === 'slab' && b.props && b.props.type === 'double')) && !(FAMILIES[b.mat] && FAMILIES[b.mat].transparent);
}

// The six faces: normal axis, sign, the two in-face axes (cyclic, so corners wind outward).
const FACES = [[0, 1, 1, 2], [0, -1, 1, 2], [1, 1, 2, 0], [1, -1, 2, 0], [2, 1, 0, 1], [2, -1, 0, 1]];
// Per face: its 4 corners as box-coordinate indices (0-2 = min x,y,z, 3-5 = max) and UVs from uvForVertex.
const FACE_CORNERS = FACES.map(([a, sign, u, v]) => {
  const order = sign > 0 ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[0, 0], [0, 1], [1, 1], [1, 0]];
  return order.map(([cu, cv]) => {
    const pick = [0, 1, 2];
    pick[a] = sign > 0 ? a + 3 : a;
    pick[u] = cu ? u + 3 : u;
    pick[v] = cv ? v + 3 : v;
    return pick;
  });
});
const FACE_CORNERS_FLAT = FACE_CORNERS.map((cs) => Int8Array.from(cs.flat()));
const FACE_NX = FACES.map(([a, sign]) => (a === 0 ? sign * 127 : 0));
const FACE_NY = FACES.map(([a, sign]) => (a === 1 ? sign * 127 : 0));
const FACE_NZ = FACES.map(([a, sign]) => (a === 2 ? sign * 127 : 0));

/** Growable typed arrays for one material's mesh. */
class FaceBuf {
  constructor(quads = 1024) { const v = Math.max(64, quads * 4); this.pos = new Float32Array(v * 3); this.nor = new Int8Array(v * 3); this.uv = new Float32Array(v * 2); this.n = 0; }
  _grow() {
    const g = (a) => { const b = new a.constructor(a.length * 2); b.set(a); return b; };
    this.pos = g(this.pos); this.nor = g(this.nor); this.uv = g(this.uv);
  }
  /** One quad of box `bx` (cell-local) in cell (X, Y, Z), face index f. */
  quad(X, Y, Z, bx, f) {
    if ((this.n + 4) * 3 > this.pos.length) this._grow();
    const pos = this.pos, nor = this.nor, uv = this.uv, cs = FACE_CORNERS_FLAT[f];
    const nx = FACE_NX[f], ny = FACE_NY[f], nz = FACE_NZ[f];
    let i = this.n;
    for (let c = 0; c < 12; c += 3, i++) {
      const px = bx[cs[c]], py = bx[cs[c + 1]], pz = bx[cs[c + 2]];
      const i3 = i * 3, i2 = i * 2;
      pos[i3] = X + px; pos[i3 + 1] = Y + py; pos[i3 + 2] = Z + pz;
      nor[i3] = nx; nor[i3 + 1] = ny; nor[i3 + 2] = nz;
      // = uvForVertex(n, p)
      if (ny) { uv[i2] = px; uv[i2 + 1] = 1 - pz; }
      else if (nx) { uv[i2] = nx > 0 ? 1 - pz : pz; uv[i2 + 1] = py; }
      else { uv[i2] = nz > 0 ? px : 1 - px; uv[i2 + 1] = py; }
    }
    this.n = i;
  }
  /** Index buffer for the quads (two triangles each). */
  indices() {
    const quads = this.n / 4;
    const idx = quads * 4 > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
    for (let q = 0, k = 0; q < quads; q++) { const b = q * 4; idx[k++] = b; idx[k++] = b + 1; idx[k++] = b + 2; idx[k++] = b; idx[k++] = b + 2; idx[k++] = b + 3; }
    return idx;
  }
  /** The finished arrays, trimmed to size. */
  done() {
    return { pos: this.pos.slice(0, this.n * 3), nor: this.nor.slice(0, this.n * 3), uv: this.uv.slice(0, this.n * 2), index: this.indices() };
  }
}

const FULL_BOXES = [[0, 0, 0, 1, 1, 1]];
const shapeCache = new Map();
/** blockBoxes, cached per shape (the boxes are shared: never modify them). */
export function shapeBoxes(b) {
  if (b.kind === 'full') return FULL_BOXES;
  const p = b.props || {};
  const k = b.kind + '|' + p.type + '|' + p.facing + '|' + p.half + '|' + p.shape + '|' + p.up + '|' + p.north + '|' + p.east + '|' + p.south + '|' + p.west;
  let boxes = shapeCache.get(k);
  if (!boxes) { boxes = blockBoxes(b); shapeCache.set(k, boxes); }
  return boxes;
}


/**
 * Ray against a box [x0,y0,z0,x1,y1,z1] in world coords: {t, axis, sign} of the entry face,
 * or null. Rays starting inside the box don't hit it.
 */
export function rayBox(o, d, b) {
  let tn = -Infinity, tf = Infinity, axis = -1;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) { if (o[a] < b[a] || o[a] > b[a + 3]) return null; continue; }
    let t0 = (b[a] - o[a]) / d[a], t1 = (b[a + 3] - o[a]) / d[a];
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
    if (t0 > tn) { tn = t0; axis = a; }
    if (t1 < tf) tf = t1;
    if (tn > tf) return null;
  }
  if (axis < 0 || tn < 0) return null;
  return { t: tn, axis, sign: d[axis] > 0 ? -1 : 1 };
}

// ---------------------------------------------------------------------------

/**
 * Face meshes for a grid: per material, the visible faces of its blocks in layer order.
 * Each entry: {mat, color, faces, caps, ys, start, capStart, total}; faces/caps hold
 * {pos, nor, uv, index} arrays, start/capStart the index offset where each block begins.
 * A face is left out when the shape next door covers it. Covered TOP faces go to `caps`, so a
 * sliced view can still close the cut layer. Pure (no three.js): the engine worker runs it.
 */
export function meshGrid(grid) {
  const blocks = grid && grid.blocks ? grid.blocks : new Map();
  const cellOf = (key, b) => (b.x !== undefined ? [b.x, b.y, b.z] : key.split(',').map(Number));
  const seeThrough = (b) => !!(FAMILIES[b.mat] && FAMILIES[b.mat].transparent);
  // Each cell holds a shape id: 0 air, 1 opaque cube, then one id per other (shape, see-through)
  // seen. A Uint16 grid over the bounds (one cell of margin) is far faster than string keys; a
  // design too big for one looks its neighbours up in the map instead.
  const shapes = [null, FULL_BOXES], shapeSee = [false, false], shapeIds = new Map();
  const sidOf = (b) => {
    if (!b) return 0;
    const see = seeThrough(b);
    if (!see && isOpaqueCube(b)) return 1;
    const boxes = shapeBoxes(b);
    const k = see ? 't' : 'o';
    let m = shapeIds.get(k);
    if (!m) { m = new Map(); shapeIds.set(k, m); }
    let id = m.get(boxes);
    if (id === undefined) { id = shapes.length; shapes.push(boxes); shapeSee.push(see); m.set(boxes, id); }
    return id;
  };
  const { min: lo = { x: 0, y: 0, z: 0 }, max: hi = { x: 0, y: 0, z: 0 } } = grid || {};
  const sy = hi.y - lo.y + 3, sz = hi.z - lo.z + 3, vol = (hi.x - lo.x + 3) * sy * sz;
  const occ = blocks.size && vol <= 1 << 27 ? new Uint16Array(vol) : null;
  const at = (x, y, z) => ((x - lo.x + 1) * sy + (y - lo.y + 1)) * sz + (z - lo.z + 1);
  const STEP = [sy * sz, -sy * sz, sz, -sz, 1, -1]; // index offset to the neighbour across face f

  // Is face f of box bx (block b, see-through or not) hidden by shape id `nid` next door?
  const coveredBy = (b, see, x, y, z, bx, f, nid) => {
    if (nid === 1) return true;
    if (nid === 0) return false;
    const a = f >> 1, sign = f & 1 ? -1 : 1, u = (a + 1) % 3, v = (a + 2) % 3;
    if (shapeSee[nid]) {
      // See-through blocks only hide faces of the same block (a glass wall has no inner faces).
      if (!see) return false;
      const o = blocks.get(`${x + (a === 0 ? sign : 0)},${y + (a === 1 ? sign : 0)},${z + (a === 2 ? sign : 0)}`);
      if (!o || o.mat !== b.mat) return false;
    } else if (see) return false;
    for (const ob of shapes[nid]) {
      if ((sign > 0 ? ob[a] !== 0 : ob[a + 3] !== 1)) continue;
      if (ob[u] <= bx[u] && ob[u + 3] >= bx[u + 3] && ob[v] <= bx[v] && ob[v + 3] >= bx[v + 3]) return true;
    }
    return false;
  };

  // Per material: blocks in layer order (a counting sort on y), then only their visible faces
  // into one mesh. Top faces under a block are left out too; when the view is sliced, the cut
  // layer gets its covered tops back from a separate "cap" mesh so it never shows holes.
  const byMat = new Map();
  const ny = hi.y - lo.y + 1;
  for (const [key, b] of blocks) {
    const [x, y, z] = cellOf(key, b);
    const sid = sidOf(b);
    if (occ) occ[at(x, y, z)] = sid;
    const mat = b.mat || 'unknown';
    let list = byMat.get(mat);
    if (!list) { list = { color: b.color || '#888888', refs: [], cells: [], sids: [], perY: new Uint32Array(ny + 1) }; byMat.set(mat, list); }
    list.refs.push(b); list.cells.push(x, y, z); list.sids.push(sid); list.perY[y - lo.y + 1]++;
  }
  const out = [];
  const nidAt = (x, y, z, f) => {
    const a = f >> 1, sign = f & 1 ? -1 : 1;
    return sidOf(blocks.get(`${x + (a === 0 ? sign : 0)},${y + (a === 1 ? sign : 0)},${z + (a === 2 ? sign : 0)}`));
  };
  for (const [mat, { color, refs, cells, sids, perY }] of byMat) {
    const n = refs.length;
    for (let i = 1; i <= ny; i++) perY[i] += perY[i - 1];
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[perY[cells[i * 3 + 1] - lo.y]++] = i;
    const ys = new Int32Array(n), start = new Uint32Array(n + 1), capStart = new Uint32Array(n + 1);
    const faces = new FaceBuf(n * 3), caps = new FaceBuf(n >> 2);
    const see = seeThrough({ mat });
    for (let k = 0; k < n; k++) {
      const i = order[k], b = refs[i], x = cells[i * 3], y = cells[i * 3 + 1], z = cells[i * 3 + 2];
      ys[k] = y; start[k] = faces.n * 1.5; capStart[k] = caps.n * 1.5; // 6 indices per 4 vertices
      const idx = occ ? at(x, y, z) : 0;
      for (const bx of shapes[sids[i]] || shapeBoxes(b)) {
        for (let f = 0; f < 6; f++) {
          const a = f >> 1;
          let hidden = false;
          if (f & 1 ? bx[a] === 0 : bx[a + 3] === 1) { // on the cell's edge
            const nid = occ ? occ[idx + STEP[f]] : nidAt(x, y, z, f);
            hidden = nid === 1 || (nid !== 0 && coveredBy(b, see, x, y, z, bx, f, nid));
          }
          if (!hidden) faces.quad(x, y, z, bx, f);
          else if (f === 2) caps.quad(x, y, z, bx, f); // a covered top face
        }
      }
    }
    start[n] = faces.n * 1.5; capStart[n] = caps.n * 1.5;
    out.push({ mat, color, faces: faces.done(), caps: caps.done(), ys, start, capStart, total: n });
  }
  return out;
}
