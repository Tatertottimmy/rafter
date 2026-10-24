// viewer3d.js — Three.js renderer + mouse interaction for Rafter.
// Instanced meshes per (geometry kind × family), pick proxies, outlines,
// resize handles, move/resize drags, layer slicing.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { familyTexture } from './textures.js';
import { FAMILIES } from './blocks.js';
import { rotatePatch } from './engine.js';

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
// THREE geometry construction
// ---------------------------------------------------------------------------

function boxGeometry(b) {
  const [x0, y0, z0, x1, y1, z1] = b;
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const [u, v] = uvForVertex(nor.getX(i), nor.getY(i), nor.getZ(i), pos.getX(i), pos.getY(i), pos.getZ(i));
    uv.setXY(i, u, v);
  }
  return g;
}

function kindGeometry(boxes) {
  const parts = boxes.map(boxGeometry);
  let g = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (parts.length > 1) parts.forEach((p) => p.dispose());
  g.translate(-0.5, -0.5, -0.5); // centre on origin; instances are placed at block centres
  g.computeBoundingSphere();
  return g;
}

/** Build all geometry kinds (centred at origin). */
export function buildGeometries() {
  const geos = new Map();
  geos.set('full', kindGeometry([[0, 0, 0, 1, 1, 1]]));
  geos.set('slab_bottom', kindGeometry([[0, 0, 0, 1, 0.5, 1]]));
  geos.set('slab_top', kindGeometry([[0, 0.5, 0, 1, 1, 1]]));
  for (const s of STAIR_SHAPES) for (const h of STAIR_HALVES) geos.set(`stair_${s}_${h}`, kindGeometry(stairBoxes(s, h)));
  for (const k of Object.keys(WALL_BOXES)) geos.set(k, kindGeometry(WALL_BOXES[k]));
  return geos;
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

function cssVar(el, name, fallback) {
  try {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
}

export class Viewer {
  /**
   * @param {HTMLElement} containerEl
   * @param {{onSelect?:Function,onMove?:Function,onResize?:Function,onCommit?:Function}} callbacks
   */
  constructor(containerEl, callbacks = {}) {
    this.container = containerEl;
    this.cb = callbacks || {};
    this.design = null;
    this.grid = null;
    this.selectedId = null;
    this.sliceY = null;
    this._raf = 0;
    this._disposed = false;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const el = this.renderer.domElement;
    el.style.display = 'block';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.touchAction = 'none';
    el.setAttribute('aria-label', '3D view');
    containerEl.appendChild(el);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    this.camera.position.set(20, 16, 20);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x9a8a72, 1.15);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.45);
    this.sun.position.set(0.55, 1, 0.4).multiplyScalar(100);
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this.blockGroup = new THREE.Group();
    this.overlayGroup = new THREE.Group();   // proxies + footprint outlines
    this.selGroup = new THREE.Group();       // selection outline + handles
    this.scene.add(this.blockGroup, this.overlayGroup, this.selGroup);
    this.gridHelper = null;

    this.geos = buildGeometries();
    this.materials = new Map(); // family key -> {base, hl, tex}
    this.instanced = [];        // [{mesh, hl, ys}]
    this.proxies = [];
    this.handles = [];

    this.raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._tmpV = new THREE.Vector3();
    this._drag = null;
    this._down = null;
    this.tool = 'select';       // select | paint | place | erase
    this.toolOpts = {};
    this._hoverGroup = new THREE.Group();
    this.scene.add(this._hoverGroup);
    this._hoverKey = null;
    this._hoverEvt = null;
    this._hoverRaf = 0;
    this._stroke = null;

    // Pointer listeners in the capture phase run before OrbitControls' own handlers.
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onContextMenu = (e) => e.preventDefault();
    el.addEventListener('pointerdown', this._onPointerDown, { capture: true });
    el.addEventListener('pointermove', this._onPointerMove, { capture: true });
    el.addEventListener('pointerup', this._onPointerUp, { capture: true });
    el.addEventListener('pointercancel', this._onPointerUp, { capture: true });
    el.addEventListener('contextmenu', this._onContextMenu);

    this.controls = new OrbitControls(this.camera, el);
    this.controls.enableDamping = false;
    this.controls.maxPolarAngle = Math.PI * 0.52;
    this.controls.target.set(0, 0, 0);
    this._onControlsChange = () => this.requestRender();
    this.controls.addEventListener('change', this._onControlsChange);

    this._applyBackground();
    this._ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null;
    if (this._ro) this._ro.observe(containerEl);
    this.resize();
  }

  // ----- public API --------------------------------------------------------

  setDesign(design) {
    this.design = design;
    this._clearGroup(this.overlayGroup);
    this.proxies = [];
    if (!design) { this._rebuildSelection(); this.requestRender(); return; }

    const lineColor = new THREE.Color(cssVar(this.container, '--muted', '#9a948a'));
    const proxyMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const outlineMat = new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0.8 });

    const addProxy = (x0, y0, z0, x1, y1, z1, data) => {
      const g = new THREE.BoxGeometry(Math.max(0.01, x1 - x0), Math.max(0.01, y1 - y0), Math.max(0.01, z1 - z0));
      const m = new THREE.Mesh(g, proxyMat);
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      m.userData = data;
      m.renderOrder = -1;
      this.overlayGroup.add(m);
      this.proxies.push(m);
    };

    for (const b of design.boxes || []) {
      const E = b.baseY + b.wallH;
      const top = E + roofHeightEstimate(b);
      addProxy(b.x, b.baseY, b.z, b.x + b.w, top, b.z + b.d, { type: 'box', id: b.id, baseY: b.baseY });
      const outline = this._rectLine(b.x, b.z, b.x + b.w, b.z + b.d, b.baseY + 0.02, outlineMat);
      this.overlayGroup.add(outline);
    }
    for (const p of design.pillars || []) {
      addProxy(p.x, p.baseY, p.z, p.x + 1, p.baseY + Math.max(1, p.h), p.z + 1, { type: 'pillar', id: p.id, baseY: p.baseY });
    }
    for (const s of design.segments || []) {
      const x0 = Math.min(s.x0, s.x1), x1 = Math.max(s.x0, s.x1) + 1;
      const z0 = Math.min(s.z0, s.z1), z1 = Math.max(s.z0, s.z1) + 1;
      addProxy(x0, s.baseY, z0, x1, s.baseY + Math.max(1, s.h), z1, { type: 'segment', id: s.id, baseY: s.baseY });
    }
    this._rebuildSelection();
    this.requestRender();
  }

  setGrid(grid) {
    this.grid = grid;
    this._applyBackground();
    this._disposeInstanced();

    // Pass 1: bucket instances per (kind|family).
    const buckets = new Map(); // key -> {kind, mat, color, items: [x,y,z,angle,...]}
    if (grid && grid.blocks) {
      for (const [key, block] of grid.blocks) {
        let x, y, z;
        if (block.x !== undefined && block.y !== undefined && block.z !== undefined) { x = block.x; y = block.y; z = block.z; }
        else { const p = key.split(','); x = +p[0]; y = +p[1]; z = +p[2]; }
        const mat = block.mat || 'unknown';
        for (const { kind, angle } of classifyBlock(block)) {
          const bk = kind + '|' + mat;
          let b = buckets.get(bk);
          if (!b) { b = { kind, mat, color: block.color || '#888888', items: [] }; buckets.set(bk, b); }
          b.items.push(x, y, z, angle);
        }
      }
    }

    // Pass 2: build an InstancedMesh per bucket with instances sorted by y (slicing uses .count).
    const m4 = new THREE.Matrix4();
    for (const b of buckets.values()) {
      const n = b.items.length / 4;
      const order = new Uint32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      const items = b.items;
      order.sort((a, c) => items[a * 4 + 1] - items[c * 4 + 1]);
      const ys = new Int32Array(n);
      const { base, hl } = this._getMaterials(b.mat, b.color);
      const geo = this.geos.get(b.kind);
      const mesh = new THREE.InstancedMesh(geo, base, n);
      mesh.frustumCulled = false;
      let maxLayer = 0, run = 0, lastY = null;
      for (let i = 0; i < n; i++) {
        const j = order[i] * 4;
        const y = items[j + 1];
        ys[i] = y;
        if (y === lastY) run++; else { run = 1; lastY = y; }
        if (run > maxLayer) maxLayer = run;
        m4.makeRotationY(items[j + 3]);
        m4.setPosition(items[j] + 0.5, y + 0.5, items[j + 2] + 0.5);
        mesh.setMatrixAt(i, m4);
      }
      mesh.instanceMatrix.needsUpdate = true;
      const hlMesh = new THREE.InstancedMesh(geo, hl, Math.max(1, maxLayer));
      hlMesh.frustumCulled = false;
      hlMesh.count = 0;
      hlMesh.visible = false;
      hlMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.blockGroup.add(mesh, hlMesh);
      this.instanced.push({ mesh, hl: hlMesh, ys, total: n });
    }

    // Grid helper at the lowest layer.
    if (this.gridHelper) { this.scene.remove(this.gridHelper); this.gridHelper.geometry.dispose(); this.gridHelper.material.dispose(); this.gridHelper = null; }
    const { min, max } = this._bounds();
    const span = Math.max(max.x - min.x + 1, max.z - min.z + 1);
    let size = span + 8; if (size % 2) size++;
    const gc = new THREE.Color(cssVar(this.container, '--line', '#6b6f75'));
    this.gridHelper = new THREE.GridHelper(size, size, gc, gc);
    this.gridHelper.material.transparent = true;
    this.gridHelper.material.opacity = 0.45;
    // SPEC-DEVIATION: grid sits 0.005 below grid.min.y (instead of exactly on it) to avoid z-fighting with the lowest block faces.
    this.gridHelper.position.set(Math.round((min.x + max.x + 1) / 2), min.y - 0.005, Math.round((min.z + max.z + 1) / 2));
    this.scene.add(this.gridHelper);

    this._applySlice();
    this._hoverKey = null;
    if (this._hoverEvt && this.tool !== 'select' && !this._stroke) this._setHover(this.pickBlock(this._hoverEvt));
    this.requestRender();
  }

  /** Active editing tool. Non-select tools act on blocks; plain drag still orbits. */
  setTool(tool, opts = {}) {
    this.tool = tool || 'select';
    this.toolOpts = opts || {};
    this.renderer.domElement.style.cursor = this.tool === 'select' ? '' : 'crosshair';
    this._hoverKey = null;
    this._setHover(this._hoverEvt && this.tool !== 'select' ? this.pickBlock(this._hoverEvt) : null);
  }

  /**
   * Block under the pointer: { cell, place, normal, half, facing } in world cells.
   * `place` is the empty neighbour on the hit face; with nothing hit, the ground (or the
   * sliced layer) under the pointer, so you can build from nothing.
   */
  pickBlock(e) {
    this._setNDC(e);
    const targets = [];
    for (const it of this.instanced) { if (it.mesh.count > 0) targets.push(it.mesh); if (it.hl.visible && it.hl.count > 0) targets.push(it.hl); }
    const hits = this.raycaster.intersectObjects(targets, false);
    const dir = this.raycaster.ray.direction;
    // Stairs face the way you look (like Minecraft), on the dominant horizontal axis.
    const facing = Math.abs(dir.x) > Math.abs(dir.z) ? (dir.x > 0 ? 'east' : 'west') : (dir.z > 0 ? 'south' : 'north');
    if (hits.length) {
      const hit = hits[0];
      const m4 = new THREE.Matrix4();
      hit.object.getMatrixAt(hit.instanceId, m4);
      const n = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(m4)).normalize();
      const nr = [Math.round(n.x), Math.round(n.y), Math.round(n.z)];
      const p = hit.point;
      const cell = [Math.floor(p.x - n.x * 0.01), Math.floor(p.y - n.y * 0.01), Math.floor(p.z - n.z * 0.01)];
      const place = [Math.floor(p.x + n.x * 0.5), Math.floor(p.y + n.y * 0.5), Math.floor(p.z + n.z * 0.5)];
      // Top half when you click a bottom face, or the upper half of a side face.
      const fy = p.y - Math.floor(p.y);
      const half = nr[1] < 0 ? 'top' : nr[1] > 0 ? 'bottom' : (fy > 0.5 ? 'top' : 'bottom');
      return { cell, place, normal: nr, half, facing, ground: false };
    }
    const y = this.sliceY ?? (this.grid && this.grid.blocks && this.grid.blocks.size ? this.grid.min.y : 0);
    const gp = this._planePoint(e, y);
    if (!gp) return null;
    return { cell: null, place: [Math.floor(gp.x), y, Math.floor(gp.z)], normal: [0, 1, 0], half: 'bottom', facing, ground: true };
  }

  _setHover(info) {
    let key = null, target = null;
    if (info && this.tool !== 'select') {
      target = this.tool === 'place' ? info.place : info.cell;
      if (target) key = this.tool + ':' + target.join(',');
    }
    if (key === this._hoverKey) return;
    this._hoverKey = key;
    this._clearGroup(this._hoverGroup);
    if (target) {
      const color = new THREE.Color(this.tool === 'erase' ? cssVar(this.container, '--danger', '#c0392b') : cssVar(this.container, '--accent', '#d9814a'));
      const line = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02)),
        new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
      line.position.set(target[0] + 0.5, target[1] + 0.5, target[2] + 0.5);
      line.renderOrder = 20;
      const fill = new THREE.Mesh(new THREE.BoxGeometry(1.01, 1.01, 1.01), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false }));
      fill.position.copy(line.position);
      this._hoverGroup.add(line, fill);
    }
    this.requestRender();
  }

  setSelection(id) {
    this.selectedId = id ?? null;
    this._rebuildSelection();
    this.requestRender();
  }

  setSliceY(yMax) {
    this.sliceY = (yMax === null || yMax === undefined || Number.isNaN(+yMax)) ? null : Math.floor(+yMax);
    this._applySlice();
    this.requestRender();
  }

  frameAll() {
    const { min, max } = this._bounds();
    const cx = (min.x + max.x + 1) / 2, cy = (min.y + max.y + 1) / 2, cz = (min.z + max.z + 1) / 2;
    const sx = max.x - min.x + 1, sy = max.y - min.y + 1, sz = max.z - min.z + 1;
    const radius = Math.max(4, Math.sqrt(sx * sx + sy * sy + sz * sz) / 2);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const aspect = this.camera.aspect || 1;
    const hfov = 2 * Math.atan(Math.tan(fov / 2) * aspect);
    const dist = radius / Math.sin(Math.min(fov, hfov) / 2) * 1.05;
    const dir = new THREE.Vector3(1, 0.85, 1).normalize(); // from the south-east, elevated
    this.camera.position.copy(dir.multiplyScalar(dist)).add(new THREE.Vector3(cx, cy, cz));
    this.camera.near = Math.max(0.05, dist / 500);
    this.camera.far = dist * 20 + 1000;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(cx, cy, cz);
    this.controls.update();
    this.requestRender();
  }

  resize() {
    if (this._disposed) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  dispose() {
    this._disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._hoverRaf) cancelAnimationFrame(this._hoverRaf);
    if (this._ro) this._ro.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this._onPointerDown, { capture: true });
    el.removeEventListener('pointermove', this._onPointerMove, { capture: true });
    el.removeEventListener('pointerup', this._onPointerUp, { capture: true });
    el.removeEventListener('pointercancel', this._onPointerUp, { capture: true });
    el.removeEventListener('contextmenu', this._onContextMenu);
    this.controls.removeEventListener('change', this._onControlsChange);
    this.controls.dispose();
    this._disposeInstanced();
    this._clearGroup(this.overlayGroup);
    this._clearGroup(this.selGroup);
    for (const { base, hl, tex } of this.materials.values()) { base.dispose(); hl.dispose(); tex.dispose(); }
    this.materials.clear();
    for (const g of this.geos.values()) g.dispose();
    if (this.gridHelper) { this.gridHelper.geometry.dispose(); this.gridHelper.material.dispose(); }
    this.renderer.dispose();
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  /** Schedule a single render on the next animation frame. */
  requestRender() {
    if (this._raf || this._disposed) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  render() {
    if (this._disposed) return;
    this.renderer.render(this.scene, this.camera);
  }

  // ----- internals ---------------------------------------------------------

  _applyBackground() {
    const bg = cssVar(this.container, '--viewport-bg', '#1c1f24');
    try { this.scene.background = new THREE.Color(bg); }
    catch { this.scene.background = new THREE.Color('#1c1f24'); }
  }

  _bounds() {
    const g = this.grid;
    if (g && g.blocks && g.blocks.size && g.min && g.max) return { min: g.min, max: g.max };
    const d = this.design;
    if (d && d.boxes && d.boxes.length) {
      const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
      for (const b of d.boxes) {
        min.x = Math.min(min.x, b.x); min.z = Math.min(min.z, b.z); min.y = Math.min(min.y, b.baseY);
        max.x = Math.max(max.x, b.x + b.w - 1); max.z = Math.max(max.z, b.z + b.d - 1);
        max.y = Math.max(max.y, b.baseY + b.wallH + roofHeightEstimate(b));
      }
      return { min, max };
    }
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 6, z: 10 } };
  }

  _getMaterials(key, color) {
    let m = this.materials.get(key);
    if (m) return m;
    const tex = new THREE.CanvasTexture(familyTexture(key, { color, pattern: 'stone' }));
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    tex.needsUpdate = true;
    const see = FAMILIES[key] && FAMILIES[key].transparent;
    const base = new THREE.MeshLambertMaterial(see ? { map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide } : { map: tex, alphaTest: 0.5 });
    // SPEC-DEVIATION: the 35%-toward-white tint is approximated as diffuse*0.65 + emissive white*0.35 (exact lerp is not expressible in Lambert).
    // Per-instance colors are not used at all: the texture already carries the family color (SPEC textures section).
    const hl = base.clone();
    hl.color.setScalar(0.65);
    hl.emissive.set(0xffffff);
    hl.emissiveIntensity = 0.35;
    m = { base, hl, tex };
    this.materials.set(key, m);
    return m;
  }

  _disposeInstanced() {
    for (const { mesh, hl } of this.instanced) {
      this.blockGroup.remove(mesh, hl);
      mesh.dispose(); hl.dispose();
    }
    this.instanced = [];
  }

  _applySlice() {
    const y = this.sliceY;
    for (const it of this.instanced) {
      if (y === null) {
        it.mesh.count = it.total;
        it.hl.visible = false; it.hl.count = 0;
        continue;
      }
      const lo = lowerBound(it.ys, y), hi = lowerBound(it.ys, y + 1);
      it.mesh.count = lo;
      const n = hi - lo;
      if (n > 0) {
        it.hl.instanceMatrix.array.set(it.mesh.instanceMatrix.array.subarray(lo * 16, hi * 16));
        it.hl.instanceMatrix.needsUpdate = true;
        it.hl.count = n;
        it.hl.visible = true;
      } else { it.hl.visible = false; it.hl.count = 0; }
    }
  }

  _clearGroup(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose(); // shared materials: repeated dispose() is harmless
    }
  }

  _rectLine(x0, z0, x1, z1, y, material, dashed = false) {
    const pts = [
      new THREE.Vector3(x0, y, z0), new THREE.Vector3(x1, y, z0),
      new THREE.Vector3(x1, y, z1), new THREE.Vector3(x0, y, z1),
    ];
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.LineLoop(g, material);
    if (dashed) line.computeLineDistances();
    return line;
  }

  _findObject(id) {
    const d = this.design;
    if (!d || id == null) return null;
    for (const b of d.boxes || []) if (b.id === id) return { type: 'box', obj: b };
    for (const p of d.pillars || []) if (p.id === id) return { type: 'pillar', obj: p };
    for (const s of d.segments || []) if (s.id === id) return { type: 'segment', obj: s };
    return null;
  }

  _rebuildSelection() {
    this._clearGroup(this.selGroup);
    this.handles = [];
    const found = this._findObject(this.selectedId);
    if (!found) return;
    const accent = new THREE.Color(cssVar(this.container, '--accent', '#d9814a'));
    const solid = new THREE.LineBasicMaterial({ color: accent, depthTest: false, transparent: true });
    const { type, obj } = found;
    if (type === 'box') {
      const E = obj.baseY + obj.wallH;
      const oh = Math.max(0, (obj.roof && obj.roof.overhang) | 0);
      // footprint (solid) at baseY and at eave height
      const l1 = this._rectLine(obj.x, obj.z, obj.x + obj.w, obj.z + obj.d, obj.baseY + 0.02, solid); l1.renderOrder = 10;
      const l2 = this._rectLine(obj.x, obj.z, obj.x + obj.w, obj.z + obj.d, E + 0.02, solid); l2.renderOrder = 10;
      this.selGroup.add(l1, l2);
      // overhang outline (dashed) at eave height
      const dashed = new THREE.LineDashedMaterial({ color: accent, dashSize: 0.45, gapSize: 0.25, depthTest: false, transparent: true });
      const l3 = this._rectLine(obj.x - oh, obj.z - oh, obj.x + obj.w + oh, obj.z + obj.d + oh, E + 0.02, dashed, true);
      l3.renderOrder = 10;
      this.selGroup.add(l3);
      // 4 resize handles at mid-edges of the top of the footprint
      const hg = new THREE.BoxGeometry(0.5, 0.5, 0.5);
      const hm = new THREE.MeshBasicMaterial({ color: accent, depthTest: false, transparent: true, opacity: 0.95 });
      const mid = { east: [obj.x + obj.w, obj.z + obj.d / 2], west: [obj.x, obj.z + obj.d / 2], south: [obj.x + obj.w / 2, obj.z + obj.d], north: [obj.x + obj.w / 2, obj.z] };
      for (const dir of DIRS) {
        const h = new THREE.Mesh(hg, hm);
        h.position.set(mid[dir][0], E, mid[dir][1]);
        h.userData = { type: 'handle', dir, id: obj.id, y: E };
        h.renderOrder = 11;
        this.selGroup.add(h);
        this.handles.push(h);
      }
      this._addRotateHandle(obj, 'box', obj.x - oh, obj.z - oh, E, accent, solid);
    } else if (type === 'pillar') {
      const l = this._rectLine(obj.x, obj.z, obj.x + 1, obj.z + 1, obj.baseY + 0.02, solid); l.renderOrder = 10;
      const t = this._rectLine(obj.x, obj.z, obj.x + 1, obj.z + 1, obj.baseY + Math.max(1, obj.h) + 0.02, solid); t.renderOrder = 10;
      this.selGroup.add(l, t);
    } else if (type === 'segment') {
      const x0 = Math.min(obj.x0, obj.x1), x1 = Math.max(obj.x0, obj.x1) + 1;
      const z0 = Math.min(obj.z0, obj.z1), z1 = Math.max(obj.z0, obj.z1) + 1;
      const l = this._rectLine(x0, z0, x1, z1, obj.baseY + 0.02, solid); l.renderOrder = 10;
      const t = this._rectLine(x0, z0, x1, z1, obj.baseY + Math.max(1, obj.h) + 0.02, solid); t.renderOrder = 10;
      this.selGroup.add(l, t);
      this._addRotateHandle(obj, 'segment', x0, z0, obj.baseY + Math.max(1, obj.h), accent, solid);
    }
  }

  /** Round rotate knob off the north-west corner (cx0, cz0) at height y, joined by a stalk. */
  _addRotateHandle(obj, objType, cx0, cz0, y, accent, lineMat) {
    const kx = cx0 - 1.6, kz = cz0 - 1.6;
    const stalk = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(cx0, y + 0.02, cz0), new THREE.Vector3(kx, y + 0.02, kz)]);
    const ln = new THREE.Line(stalk, lineMat); ln.renderOrder = 10;
    const mat = new THREE.MeshBasicMaterial({ color: accent, depthTest: false, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
    const back = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    // A disc with a three-quarter ring and arrowhead on it: reads as "rotate".
    const knob = new THREE.Group();
    knob.position.set(kx, y + 0.03, kz);
    knob.rotation.x = -Math.PI / 2;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.8, 32), back);
    const a0 = 0.5, sweep = Math.PI * 1.45;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.6, 32, 1, a0, sweep), mat);
    const tri = new THREE.Shape([new THREE.Vector2(0.28, 0), new THREE.Vector2(0.74, 0), new THREE.Vector2(0.51, -0.3)]);
    const tip = new THREE.Mesh(new THREE.ShapeGeometry(tri), mat);
    tip.rotation.z = a0; // arrowhead at the start of the arc, pointing clockwise as seen from above
    disc.renderOrder = 11; ring.renderOrder = tip.renderOrder = 12;
    knob.add(disc, ring, tip);
    // Invisible, generous hit target.
    const hit = new THREE.Mesh(new THREE.SphereGeometry(0.85, 12, 8), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
    hit.position.set(kx, y, kz);
    hit.userData = { type: 'rotate', id: obj.id, y, objType };
    this.selGroup.add(ln, knob, hit);
    this.handles.push(hit);
  }

  _setNDC(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this._ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this._ndc, this.camera);
  }

  _pick(e) {
    this._setNDC(e);
    if (this.handles.length) {
      const hits = this.raycaster.intersectObjects(this.handles, false);
      if (hits.length) return hits[0].object.userData;
    }
    if (this.proxies.length) {
      const hits = this.raycaster.intersectObjects(this.proxies, false);
      if (hits.length) return hits[0].object.userData;
    }
    return null;
  }

  _planePoint(e, y) {
    this._setNDC(e);
    this._plane.constant = -y;
    const p = this.raycaster.ray.intersectPlane(this._plane, this._tmpV);
    return p ? { x: p.x, z: p.z } : null;
  }

  _onPointerDown(e) {
    if (this._disposed) return;
    if (e.button !== 0) { this._down = null; return; }
    if (this.tool !== 'select') {
      this._down = { x: e.clientX, y: e.clientY, hit: null, tool: true };
      // Shift+drag paints a stroke instead of orbiting.
      if (e.shiftKey) {
        e.stopImmediatePropagation();
        e.preventDefault();
        this.controls.enabled = false;
        try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        this._stroke = { id: Date.now(), done: new Set(), pointerId: e.pointerId };
        this._strokeAt(e);
      }
      return;
    }
    const hit = this._pick(e);
    this._down = { x: e.clientX, y: e.clientY, hit };
    if (!hit) return; // let OrbitControls orbit

    e.stopImmediatePropagation();
    e.preventDefault();
    this.controls.enabled = false;
    try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    // SPEC-DEVIATION: resize drags raycast against the plane at the handle height E (not baseY) so the pointer tracks the handle it grabbed; move drags use baseY as specified.
    const planeY = hit.type === 'handle' || hit.type === 'rotate' ? hit.y : hit.baseY;
    const p0 = this._planePoint(e, planeY);
    const found = this._findObject(hit.id);
    if (!p0 || !found) { this.controls.enabled = true; this._down = null; return; }

    this._drag = {
      mode: hit.type === 'handle' ? 'resize' : hit.type === 'rotate' ? 'rotate' : 'move',
      dir: hit.dir, id: hit.id, objType: found.type,
      start: { ...found.obj }, planeY, p0, lastDx: 0, lastDz: 0, changed: false, pointerId: e.pointerId,
    };
    if (hit.type === 'rotate') {
      const o = found.obj;
      this._drag.center = found.type === 'box'
        ? { x: o.x + o.w / 2, z: o.z + o.d / 2 }
        : { x: (Math.min(o.x0, o.x1) + Math.max(o.x0, o.x1) + 1) / 2, z: (Math.min(o.z0, o.z1) + Math.max(o.z0, o.z1) + 1) / 2 };
      this._drag.a0 = Math.atan2(p0.z - this._drag.center.z, p0.x - this._drag.center.x);
      this._drag.lastQ = 0;
      this._drag.start = JSON.parse(JSON.stringify(o)); // roof is nested; keep the original intact
      this.renderer.domElement.style.cursor = 'grabbing';
    }
    if (hit.type !== 'handle' && hit.type !== 'rotate') {
      if (this.selectedId !== hit.id) {
        this.selectedId = hit.id;
        this._rebuildSelection();
        this.requestRender();
      }
      if (this.cb.onSelect) this.cb.onSelect(hit.id);
    }
  }

  _strokeAt(e) {
    const info = this.pickBlock(e);
    if (!info) return;
    const target = this.tool === 'place' ? info.place : info.cell;
    if (!target) return;
    const k = target.join(',');
    if (this._stroke.done.has(k)) return;
    this._stroke.done.add(k);
    if (this.cb.onBlockClick) this.cb.onBlockClick(info, { alt: e.altKey, shift: true, stroke: this._stroke.id });
  }

  _onPointerMove(e) {
    if (this.tool !== 'select') {
      if (this._stroke) { e.stopImmediatePropagation(); this._strokeAt(e); return; }
      this._hoverEvt = e;
      if (!e.buttons && !this._hoverRaf) {
        // Hover preview, at most once per frame.
        this._hoverRaf = requestAnimationFrame(() => {
          this._hoverRaf = 0;
          if (this.tool !== 'select' && this._hoverEvt) this._setHover(this.pickBlock(this._hoverEvt));
        });
      }
      return;
    }
    const d = this._drag;
    if (!d) return;
    e.stopImmediatePropagation();
    const p = this._planePoint(e, d.planeY);
    if (!p) return;
    if (d.mode === 'rotate') {
      // Snap to quarter turns; screen-clockwise from above is +angle in x/z (z points south).
      let da = Math.atan2(p.z - d.center.z, p.x - d.center.x) - d.a0;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      const q = (Math.round(da / (Math.PI / 2)) + 4) % 4;
      if (q === d.lastQ) return;
      d.lastQ = q;
      d.changed = true;
      if (this.cb.onRotate) this.cb.onRotate(d.id, { ...d.start, ...rotatePatch(d.objType, d.start, q) });
      return;
    }
    const dx = Math.round(p.x - d.p0.x), dz = Math.round(p.z - d.p0.z);
    if (dx === d.lastDx && dz === d.lastDz) return;
    d.lastDx = dx; d.lastDz = dz;
    d.changed = true;
    const s = d.start;
    if (d.mode === 'move') {
      let patch;
      if (d.objType === 'segment') patch = { x0: s.x0 + dx, z0: s.z0 + dz, x1: s.x1 + dx, z1: s.z1 + dz };
      else patch = { x: s.x + dx, z: s.z + dz };
      if (this.cb.onMove) this.cb.onMove(d.id, patch);
    } else {
      let { x, z, w, d: dd } = s;
      switch (d.dir) {
        case 'east': w = Math.max(1, s.w + dx); break;
        case 'west': { const nx = Math.min(s.x + dx, s.x + s.w - 1); w = s.x + s.w - nx; x = nx; break; }
        case 'south': dd = Math.max(1, s.d + dz); break;
        case 'north': { const nz = Math.min(s.z + dz, s.z + s.d - 1); dd = s.z + s.d - nz; z = nz; break; }
      }
      if (this.cb.onResize) this.cb.onResize(d.id, { x, z, w, d: dd });
    }
  }

  _onPointerUp(e) {
    if (this._stroke) {
      e.stopImmediatePropagation();
      try { this.renderer.domElement.releasePointerCapture(this._stroke.pointerId); } catch { /* ignore */ }
      this._stroke = null;
      this.controls.enabled = true;
      this._down = null;
      if (this.cb.onStrokeEnd) this.cb.onStrokeEnd();
      return;
    }
    if (this._down && this._down.tool) {
      const dn = this._down;
      this._down = null;
      if (e.type === 'pointerup' && Math.hypot(e.clientX - dn.x, e.clientY - dn.y) < 4) {
        const info = this.pickBlock(e);
        if (info && this.cb.onBlockClick) this.cb.onBlockClick(info, { alt: e.altKey, shift: false });
      }
      return;
    }
    const d = this._drag;
    if (d) {
      e.stopImmediatePropagation();
      try { this.renderer.domElement.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
      this.controls.enabled = true;
      this.renderer.domElement.style.cursor = '';
      this._drag = null;
      this._down = null;
      if (d.changed && this.cb.onCommit) this.cb.onCommit();
      return;
    }
    const dn = this._down;
    this._down = null;
    if (dn && !dn.hit && e.type === 'pointerup') {
      const dist = Math.hypot(e.clientX - dn.x, e.clientY - dn.y);
      if (dist < 4) {
        if (this.selectedId !== null) { this.selectedId = null; this._rebuildSelection(); this.requestRender(); }
        if (this.cb.onSelect) this.cb.onSelect(null);
      }
    }
  }
}

export default Viewer;
