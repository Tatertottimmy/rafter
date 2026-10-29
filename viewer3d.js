// viewer3d.js — Three.js renderer + mouse interaction for Rafter.
// One face-culled mesh per block family, pick proxies, outlines,
// resize handles, move/resize drags, layer slicing.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { familyTexture } from './textures.js';
import { FAMILIES } from './blocks.js';
import { rotatePatch } from './engine.js';
import { DIRS, STAIR_SHAPES, STAIR_HALVES, stairBoxes, WALL_BOXES, uvForVertex, roofHeightEstimate, lowerBound, shapeBoxes, rayBox, meshGrid } from './mesher.js';

export * from './mesher.js';

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

/** A second geometry over the same buffers (its own draw range). */
function shareGeometry(g) {
  const h = new THREE.BufferGeometry();
  for (const k of Object.keys(g.attributes)) h.setAttribute(k, g.attributes[k]);
  h.setIndex(g.index);
  h.boundingSphere = g.boundingSphere;
  return h;
}

// ---------------------------------------------------------------------------
// 3D bounds and resizing of objects (pure)
// ---------------------------------------------------------------------------

/** World-cell bounds of an object: x0..x1, y0..y1, z0..z1 (max exclusive). */
export function objBounds(type, o) {
  if (type === 'box' || type === 'fill') return { x0: o.x, x1: o.x + o.w, y0: o.baseY, y1: o.baseY + (type === 'fill' ? o.h : o.wallH), z0: o.z, z1: o.z + o.d };
  if (type === 'pillar') { const n = o.size || 1; return { x0: o.x, x1: o.x + n, y0: o.baseY, y1: o.baseY + Math.max(1, o.h), z0: o.z, z1: o.z + n }; }
  return { x0: Math.min(o.x0, o.x1), x1: Math.max(o.x0, o.x1) + 1, y0: o.baseY, y1: o.baseY + Math.max(1, o.h), z0: Math.min(o.z0, o.z1), z1: Math.max(o.z0, o.z1) + 1 };
}

// Largest size per axis (matches validateDesign).
const SIZE_MAX = { box: { xz: 512, y: 128 }, fill: { xz: 256, y: 128 }, pillar: { xz: 5, y: 256 }, segment: { xz: 8192, y: 256 } };

/** Which sides of an object can be dragged: a segment only lengthens along its own line. */
export function resizableSides(type, o) {
  if (type !== 'segment') return { x: true, y: true, z: true };
  const alongZ = o.x0 === o.x1 && o.z0 !== o.z1;
  return { x: !alongZ, y: true, z: alongZ || o.x0 === o.x1 };
}

/**
 * Patch for an object after dragging the sides in `sides` ({x,y,z}: -1 min side, 1 max side,
 * 0/undefined untouched) by `delta` ({x,y,z} blocks). Sizes stay within 1 and the type's
 * maximum; pillars stay square; `square` (Shift) keeps a box or fill footprint square.
 */
export function resizePatch(type, o, sides, delta, square = false) {
  const b = objBounds(type, o), L = SIZE_MAX[type] || SIZE_MAX.box;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  for (const a of ['x', 'y', 'z']) {
    const sd = sides[a];
    if (!sd) continue;
    const max = a === 'y' ? L.y : L.xz, dv = delta[a] || 0;
    if (sd > 0) b[a + '1'] = clamp(b[a + '1'] + dv, b[a + '0'] + 1, b[a + '0'] + max);
    else b[a + '0'] = clamp(b[a + '0'] + dv, b[a + '1'] - max, b[a + '1'] - 1);
  }
  // Square footprints: the dragged side sets the size; the other side grows from its north /
  // west edge (or toward the dragged corner).
  if (type === 'pillar' || (square && (type === 'box' || type === 'fill'))) {
    const w = b.x1 - b.x0, d = b.z1 - b.z0;
    const n = sides.x && sides.z ? Math.max(w, d) : sides.x ? w : sides.z ? d : null;
    if (n !== null) {
      if (sides.x < 0) b.x0 = b.x1 - n; else b.x1 = b.x0 + n;
      if (sides.z < 0) b.z0 = b.z1 - n; else b.z1 = b.z0 + n;
    }
  }
  const W = b.x1 - b.x0, D = b.z1 - b.z0, H = b.y1 - b.y0;
  if (type === 'box') return { x: b.x0, z: b.z0, w: W, d: D, baseY: b.y0, wallH: H };
  if (type === 'fill') return { x: b.x0, z: b.z0, w: W, d: D, baseY: b.y0, h: H };
  if (type === 'pillar') return { x: b.x0, z: b.z0, size: W, baseY: b.y0, h: H };
  // segment: keep the direction it was drawn in
  const fx = o.x0 <= o.x1, fz = o.z0 <= o.z1;
  return {
    x0: fx ? b.x0 : b.x1 - 1, x1: fx ? b.x1 - 1 : b.x0,
    z0: fz ? b.z0 : b.z1 - 1, z1: fz ? b.z1 - 1 : b.z0,
    baseY: b.y0, h: H,
  };
}

/** A three.js geometry over mesher arrays. Its bounding sphere comes from the grid bounds. */
function toGeometry(a, grid) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(a.nor, 3, true));
  g.setAttribute('uv', new THREE.BufferAttribute(a.uv, 2));
  g.setIndex(new THREE.BufferAttribute(a.index, 1));
  const { min, max } = grid;
  const c = new THREE.Vector3((min.x + max.x + 1) / 2, (min.y + max.y + 1) / 2, (min.z + max.z + 1) / 2);
  g.boundingSphere = new THREE.Sphere(c, c.distanceTo(new THREE.Vector3(min.x, min.y, min.z)) + 1);
  return g;
}

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
    this._blockSelGroup = new THREE.Group(); // outlines of selected hand-placed blocks
    this.scene.add(this._hoverGroup, this._blockSelGroup);
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
    // Right-drag orbits, middle-drag pans, wheel zooms. Left-drag on empty space orbits too,
    // except in Area mode where it draws.
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    // Stop the browser's middle-click autoscroll over the canvas.
    el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
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
      const n = p.size || 1;
      addProxy(p.x, p.baseY, p.z, p.x + n, p.baseY + Math.max(1, p.h), p.z + n, { type: 'pillar', id: p.id, baseY: p.baseY });
    }
    for (const s of design.segments || []) {
      const x0 = Math.min(s.x0, s.x1), x1 = Math.max(s.x0, s.x1) + 1;
      const z0 = Math.min(s.z0, s.z1), z1 = Math.max(s.z0, s.z1) + 1;
      addProxy(x0, s.baseY, z0, x1, s.baseY + Math.max(1, s.h), z1, { type: 'segment', id: s.id, baseY: s.baseY });
    }
    for (const f of design.fills || []) {
      addProxy(f.x, f.baseY, f.z, f.x + f.w, f.baseY + f.h, f.z + f.d, { type: 'fill', id: f.id, baseY: f.baseY });
    }
    this._rebuildSelection();
    this.requestRender();
  }

  setGrid(grid) {
    this.grid = grid;
    this._applyBackground();
    this._disposeInstanced();

    // Meshes come ready-made from the engine worker; otherwise build them here.
    const meshes = (grid && grid.meshes) || meshGrid(grid);
    for (const { mat, color, faces, caps, ys, start, capStart, total } of meshes) {
      const { base, hl } = this._getMaterials(mat, color);
      const geo = toGeometry(faces, grid);
      const mesh = new THREE.Mesh(geo, base);
      const hlMesh = new THREE.Mesh(shareGeometry(geo), hl);
      const capMesh = new THREE.Mesh(caps.index.length ? toGeometry(caps, grid) : new THREE.BufferGeometry(), hl);
      for (const m of [mesh, hlMesh, capMesh]) m.frustumCulled = false;
      hlMesh.visible = capMesh.visible = false;
      this.blockGroup.add(mesh, hlMesh, capMesh);
      this.instanced.push({ mesh, hl: hlMesh, cap: capMesh, ys, start, capStart, total });
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
    this._hoverKey = '';  // differs from every real key, so the old preview is always cleared
    this._setHover(this._hoverEvt && this.tool !== 'select' ? this.pickBlock(this._hoverEvt) : null);
  }

  /**
   * Block under the pointer: { cell, place, normal, half, facing } in world cells.
   * `place` is the empty neighbour on the hit face; with nothing hit, the ground (or the
   * sliced layer) under the pointer, so you can build from nothing.
   */
  pickBlock(e) {
    this._setNDC(e);
    const dir = this.raycaster.ray.direction;
    // Stairs face the way you look (like Minecraft), on the dominant horizontal axis.
    const facing = Math.abs(dir.x) > Math.abs(dir.z) ? (dir.x > 0 ? 'east' : 'west') : (dir.z > 0 ? 'south' : 'north');
    const hit = this._castBlocks();
    if (hit) {
      const { cell, t, axis, sign } = hit;
      const o = this.raycaster.ray.origin;
      const p = { x: o.x + dir.x * t, y: o.y + dir.y * t, z: o.z + dir.z * t };
      const nr = [0, 0, 0]; nr[axis] = sign;
      const place = [Math.floor(p.x + nr[0] * 0.5), Math.floor(p.y + nr[1] * 0.5), Math.floor(p.z + nr[2] * 0.5)];
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

  /**
   * Walk the pointer ray cell by cell through the block grid (only up to the sliced layer)
   * and return the first block shape it enters: {cell, t, axis, sign}, or null.
   */
  _castBlocks() {
    const g = this.grid;
    if (!g || !g.blocks || !g.blocks.size) return null;
    const ray = this.raycaster.ray;
    const o = [ray.origin.x, ray.origin.y, ray.origin.z], d = [ray.direction.x, ray.direction.y, ray.direction.z];
    const top = this.sliceY === null || this.sliceY === undefined ? g.max.y : Math.min(g.max.y, this.sliceY);
    if (top < g.min.y) return null;
    const span = rayBox(o, d, [g.min.x, g.min.y, g.min.z, g.max.x + 1, top + 1, g.max.z + 1]);
    let t = span ? span.t : 0;
    const inside = !span && o[0] >= g.min.x && o[0] <= g.max.x + 1 && o[1] >= g.min.y && o[1] <= top + 1 && o[2] >= g.min.z && o[2] <= g.max.z + 1;
    if (!span && !inside) return null;
    const c = [0, 1, 2].map((a) => Math.floor(o[a] + d[a] * (t + 1e-6)));
    const step = d.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0));
    const tMax = [0, 1, 2].map((a) => (step[a] ? ((c[a] + (step[a] > 0 ? 1 : 0)) - o[a]) / d[a] : Infinity));
    const tDelta = d.map((v) => (v ? Math.abs(1 / v) : Infinity));
    const lo = [g.min.x, g.min.y, g.min.z], hi = [g.max.x, top, g.max.z];
    for (let guard = 0; guard < 4096; guard++) {
      if (c[0] < lo[0] - 1 || c[0] > hi[0] + 1 || c[1] < lo[1] - 1 || c[1] > hi[1] + 1 || c[2] < lo[2] - 1 || c[2] > hi[2] + 1) return null;
      const b = c[1] <= top ? g.blocks.get(`${c[0]},${c[1]},${c[2]}`) : undefined;
      if (b) {
        let best = null;
        for (const bx of shapeBoxes(b)) {
          const h = rayBox(o, d, [c[0] + bx[0], c[1] + bx[1], c[2] + bx[2], c[0] + bx[3], c[1] + bx[4], c[2] + bx[5]]);
          if (h && (!best || h.t < best.t)) best = h;
        }
        if (best) return { cell: [c[0], c[1], c[2]], ...best };
      }
      const a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      c[a] += step[a];
      tMax[a] += tDelta[a];
    }
    return null;
  }

  /** Outline these world cells as the selected hand-placed blocks. */
  setSelectedBlocks(cells) {
    this._selCells = new Set((cells || []).map((c) => c.join(',')));
    this._clearGroup(this._blockSelGroup);
    const color = new THREE.Color(cssVar(this.container, '--accent', '#d9814a'));
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
    const fillMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false });
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.04, 1.04, 1.04));
    const box = new THREE.BoxGeometry(1.03, 1.03, 1.03);
    for (const [x, y, z] of cells || []) {
      const line = new THREE.LineSegments(edges, mat);
      line.position.set(x + 0.5, y + 0.5, z + 0.5);
      line.renderOrder = 21;
      const fill = new THREE.Mesh(box, fillMat);
      fill.position.copy(line.position);
      this._blockSelGroup.add(line, fill);
    }
    this.requestRender();
  }

  /** World cell of the hand-placed block under the pointer, or null. */
  _placedAt(e) {
    if (!this.grid || !this.grid.blocks) return null;
    const info = this.pickBlock(e);
    if (!info || !info.cell) return null;
    const blk = this.grid.blocks.get(info.cell.join(','));
    return blk && blk.role === 'placed' ? info.cell : null;
  }

  /** Screen rectangle of an Alt+drag selection (client coords), or null to hide it. */
  _drawMarquee(mq) {
    if (!mq) { if (this._marqueeEl) this._marqueeEl.hidden = true; return; }
    if (!this._marqueeEl) {
      const el = document.createElement('div');
      el.className = 'marquee';
      el.style.cssText = 'position:absolute;pointer-events:none;z-index:5;border:1.5px dashed var(--accent,#d9814a);background:color-mix(in srgb, var(--accent,#d9814a) 14%, transparent);';
      this.container.appendChild(el);
      this._marqueeEl = el;
    }
    const r = this.container.getBoundingClientRect();
    const el = this._marqueeEl;
    el.hidden = false;
    el.style.left = (Math.min(mq.x0, mq.x1) - r.left) + 'px';
    el.style.top = (Math.min(mq.y0, mq.y1) - r.top) + 'px';
    el.style.width = Math.abs(mq.x1 - mq.x0) + 'px';
    el.style.height = Math.abs(mq.y1 - mq.y0) + 'px';
  }

  /** Hand-placed blocks whose centre lands inside a screen rectangle (hidden layers left out). */
  _cellsInRect(mq) {
    const out = [];
    if (!this.grid || !this.grid.blocks) return out;
    const r = this.renderer.domElement.getBoundingClientRect();
    const xa = Math.min(mq.x0, mq.x1), xb = Math.max(mq.x0, mq.x1), ya = Math.min(mq.y0, mq.y1), yb = Math.max(mq.y0, mq.y1);
    const v = new THREE.Vector3();
    this.camera.updateMatrixWorld();
    for (const [key, blk] of this.grid.blocks) {
      if (blk.role !== 'placed') continue;
      const c = key.split(',').map(Number);
      if (this.sliceY != null && c[1] > this.sliceY) continue;
      v.set(c[0] + 0.5, c[1] + 0.5, c[2] + 0.5).project(this.camera);
      if (v.z < -1 || v.z > 1) continue; // behind the camera
      const sx = r.left + (v.x + 1) / 2 * r.width, sy = r.top + (1 - v.y) / 2 * r.height;
      if (sx >= xa && sx <= xb && sy >= ya && sy <= yb) out.push(c);
    }
    return out;
  }

  _areaMode() { return !!(this.toolOpts && this.toolOpts.area) && this.tool !== 'select'; }

  /** Translucent slab over the cells of an area drag (or nothing). */
  _setAreaPreview(a) {
    this._hoverKey = null;
    this._clearGroup(this._hoverGroup);
    if (a) {
      const x0 = Math.min(a.anchor[0], a.cur[0]), x1 = Math.max(a.anchor[0], a.cur[0]) + 1;
      const y0 = Math.min(a.anchor[1], a.cur[1]), y1 = Math.max(a.anchor[1], a.cur[1]) + 1;
      const z0 = Math.min(a.anchor[2], a.cur[2]), z1 = Math.max(a.anchor[2], a.cur[2]) + 1;
      const color = new THREE.Color(this.tool === 'erase' ? cssVar(this.container, '--danger', '#c0392b') : cssVar(this.container, '--accent', '#d9814a'));
      // Circle mode on a layer: the oval that fits the rectangle.
      const round = this.toolOpts && this.toolOpts.circle && a.wallAxis === null;
      const geo = round
        ? new THREE.CylinderGeometry(0.5, 0.5, 1, 48).scale(x1 - x0 + 0.02, y1 - y0 + 0.02, z1 - z0 + 0.02)
        : new THREE.BoxGeometry(x1 - x0 + 0.02, y1 - y0 + 0.02, z1 - z0 + 0.02);
      const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
      line.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      line.renderOrder = 20;
      const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false }));
      fill.position.copy(line.position);
      this._hoverGroup.add(line, fill);
    }
    this.requestRender();
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
    this._scaleNodes();
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
    for (const { mesh, hl, cap } of this.instanced) {
      this.blockGroup.remove(mesh, hl, cap);
      mesh.geometry.dispose(); hl.geometry.dispose(); cap.geometry.dispose(); // hl shares the mesh's buffers (a second release is a no-op)
    }
    this.instanced = [];
  }

  _applySlice() {
    const y = this.sliceY;
    for (const it of this.instanced) {
      if (y === null) {
        it.mesh.geometry.setDrawRange(0, Infinity);
        it.hl.visible = it.cap.visible = false;
        continue;
      }
      // Below the cut: the normal mesh. The cut layer: highlighted, with its covered tops.
      const lo = lowerBound(it.ys, y), hi = lowerBound(it.ys, y + 1);
      it.mesh.geometry.setDrawRange(0, it.start[lo]);
      it.hl.geometry.setDrawRange(it.start[lo], it.start[hi] - it.start[lo]);
      it.hl.visible = hi > lo;
      it.cap.geometry.setDrawRange(it.capStart[lo], it.capStart[hi] - it.capStart[lo]);
      it.cap.visible = it.capStart[hi] > it.capStart[lo];
    }
  }

  _clearGroup(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose(); // shared materials: repeated dispose() is harmless
      });
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
    for (const f of d.fills || []) if (f.id === id) return { type: 'fill', obj: f };
    return null;
  }

  /** Redraw the selection outline and handles from the (live-edited) design. */
  refreshSelection() {
    this._rebuildSelection();
    this.requestRender();
  }

  _rebuildSelection() {
    this._clearGroup(this.selGroup);
    this.handles = [];
    this._nodes = [];
    const found = this._findObject(this.selectedId);
    if (!found) return;
    const accent = new THREE.Color(cssVar(this.container, '--accent', '#d9814a'));
    const solid = new THREE.LineBasicMaterial({ color: accent, depthTest: false, transparent: true });
    const { type, obj } = found;
    const b = objBounds(type, obj);
    // The 3D frame: all twelve edges of the bounds.
    const { x0, x1, y0, y1, z0, z1 } = b;
    const P = (x, y, z) => new THREE.Vector3(x, y, z);
    const c = [P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)];
    const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7].map((k) => c[k]);
    const frame = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(edges), solid);
    frame.renderOrder = 10;
    this.selGroup.add(frame);
    if (type === 'box') {
      const oh = Math.max(0, (obj.roof && obj.roof.overhang) | 0);
      if (oh) {
        // overhang outline (dashed) at eave height
        const dashed = new THREE.LineDashedMaterial({ color: accent, dashSize: 0.45, gapSize: 0.25, depthTest: false, transparent: true });
        const l3 = this._rectLine(x0 - oh, z0 - oh, x1 + oh, z1 + oh, y1 + 0.02, dashed, true);
        l3.renderOrder = 10;
        this.selGroup.add(l3);
      }
      this._addRotateHandle(obj, type, x0 - oh, z0 - oh, y1, accent, solid);
    } else if (type === 'fill') this._addRotateHandle(obj, type, x0, z0, y1, accent, solid);
    else if (type === 'segment') this._addRotateHandle(obj, 'segment', x0, z0, y1, accent, solid);
    this._addNodes(obj, type, b, accent);
    this._addMoveGizmo(obj, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  }

  /**
   * Resize nodes on the 3D frame: a cube on each face (drags that face along its axis: the
   * top and bottom change the height) and a ball on each corner (drags two sides at once, flat).
   * Nodes keep the same size on screen however far the camera is.
   */
  _addNodes(obj, type, b, accent) {
    const ok = resizableSides(type, obj);
    const faceGeo = new THREE.BoxGeometry(1, 1, 1), cornerGeo = new THREE.SphereGeometry(0.62, 16, 10);
    const mat = new THREE.MeshBasicMaterial({ color: accent, depthTest: false, transparent: true, opacity: 0.95 });
    const rim = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.95 });
    const mid = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: (b.z0 + b.z1) / 2 };
    const add = (geo, pos, data) => {
      const g = new THREE.Group();
      g.position.set(pos[0], pos[1], pos[2]);
      const back = new THREE.Mesh(geo, rim); back.scale.setScalar(1.35); back.renderOrder = 11;
      const front = new THREE.Mesh(geo, mat); front.renderOrder = 12;
      front.userData = { ...data, id: obj.id, pos };
      g.add(back, front);
      g.userData.node = true;
      this.selGroup.add(g);
      this.handles.push(front);
      this._nodes.push(g);
    };
    this._nodes = [];
    for (const a of ['x', 'y', 'z']) {
      if (!ok[a]) continue;
      for (const sign of [-1, 1]) {
        const pos = [mid.x, mid.y, mid.z];
        pos['xyz'.indexOf(a)] = sign < 0 ? b[a + '0'] : b[a + '1'];
        add(faceGeo, pos, { type: 'face', axis: a, sides: { [a]: sign } });
      }
    }
    if (ok.x && ok.z) {
      for (const sy of [-1, 1]) for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const y = sy < 0 ? b.y0 : b.y1;
        add(cornerGeo, [sx < 0 ? b.x0 : b.x1, y, sz < 0 ? b.z0 : b.z1], { type: 'handle', y, sides: { x: sx, z: sz } });
      }
    }
    this._scaleNodes();
  }

  /** Keep resize nodes a steady size on screen. */
  _scaleNodes() {
    if (!this._nodes) return;
    for (const g of this._nodes) {
      const dist = this.camera.position.distanceTo(g.position);
      g.scale.setScalar(Math.max(0.25, dist * 0.012));
      g.updateMatrixWorld(true); // so picking matches before the next frame is drawn
    }
  }

  /**
   * KSP-style translate gizmo: red x (east), green y (up), blue z (south) arrows from the
   * object's centre. Drawn on top of everything so it shows through walls and roofs.
   */
  _addMoveGizmo(obj, cx, cy, cz) {
    const len = 2.6;
    const axes = [
      ['x', 0xe5484d, new THREE.Vector3(1, 0, 0)],
      ['y', 0x46a758, new THREE.Vector3(0, 1, 0)],
      ['z', 0x3e63dd, new THREE.Vector3(0, 0, 1)],
    ];
    const up = new THREE.Vector3(0, 1, 0);
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.95 }));
    hub.position.set(cx, cy, cz); hub.renderOrder = 13;
    this.selGroup.add(hub);
    for (const [axis, color, dir] of axes) {
      const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
      const g = new THREE.Group();
      g.position.set(cx, cy, cz);
      g.quaternion.setFromUnitVectors(up, dir);
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, len, 10), mat);
      shaft.position.y = len / 2;
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.6, 16), mat);
      head.position.y = len + 0.3;
      shaft.renderOrder = head.renderOrder = 13;
      // Invisible, generous hit target along the whole arrow.
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, len + 0.6, 8), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
      hit.position.y = (len + 0.6) / 2 + 0.2;
      hit.userData = { type: 'axis', axis, id: obj.id, origin: [cx, cy, cz] };
      g.add(shaft, head, hit);
      this.selGroup.add(g);
      this.handles.push(hit);
    }
  }

  /** Pointer position along one gizmo axis (world units), for an axis drag. */
  _axisParam(e, d) {
    this._setNDC(e);
    const [ox, oy, oz] = d.origin;
    const o = new THREE.Vector3(ox, oy, oz);
    let n;
    if (d.axis === 'y') {
      // Vertical plane through the axis, turned to face the camera.
      n = new THREE.Vector3().subVectors(this.camera.position, o); n.y = 0;
      if (n.lengthSq() < 1e-6) return null;
      n.normalize();
    } else {
      // Plane containing the axis, tilted toward the camera (horizontal unless looking flat on).
      const a = d.axis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      const view = new THREE.Vector3().subVectors(this.camera.position, o);
      n = view.sub(a.clone().multiplyScalar(view.dot(a)));
      if (n.lengthSq() < 1e-6) return null;
      n.normalize();
    }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, o);
    const p = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    return p ? p[d.axis] : null;
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
    // The block under the pointer decides: select the object that built it. The rough pick
    // boxes (footprint × estimated height) are only a fallback where the ray meets no block,
    // since they overlap (stacked storeys) and miss overhangs and odd roof shapes.
    const bh = this._castBlocks();
    if (bh) {
      const blk = this.grid.blocks.get(bh.cell.join(','));
      const found = blk && blk.src != null ? this._findObject(blk.src) : null;
      // Drag on the level where it was grabbed: tracks the pointer, and works when the
      // object's base is out of reach of the view (looking up at a high roof).
      if (found) return { type: found.type, id: blk.src, baseY: found.obj.baseY ?? 0, planeY: this.raycaster.ray.origin.y + this.raycaster.ray.direction.y * bh.t };
    }
    if (this.proxies.length) {
      const hits = this.raycaster.intersectObjects(this.proxies, false);
      // Only where nothing solid stands in front of the pick box.
      if (hits.length && (!bh || hits[0].distance <= bh.t)) return hits[0].object.userData;
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
    // Alt+drag: rubber-band select the hand-placed blocks inside a screen rectangle (any tool).
    if (e.altKey) {
      e.stopImmediatePropagation();
      e.preventDefault();
      this.controls.enabled = false;
      try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this._marquee = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, add: e.shiftKey || e.ctrlKey || e.metaKey, pointerId: e.pointerId };
      return;
    }
    if (this.tool !== 'select') {
      this._down = { x: e.clientX, y: e.clientY, hit: null, tool: true };
      // Area mode: drag a rectangle on the layer of the block you start on.
      if (this._areaMode() && !e.shiftKey) {
        const info = this.pickBlock(e);
        const anchor = info && (this.tool === 'place' ? info.place : info.cell);
        if (anchor) {
          e.stopImmediatePropagation();
          e.preventDefault();
          this.controls.enabled = false;
          try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
          // Started on a wall face: the rectangle stands in that wall's plane (draw a window).
          // Otherwise it lies on the layer: the pointer tracks the layer's top face for
          // erase / paint and its floor for place.
          const n = info.normal || [0, 1, 0];
          const vertical = !info.ground && n[1] === 0 && (n[0] !== 0 || n[2] !== 0);
          const wallAxis = vertical ? (n[0] !== 0 ? 0 : 2) : null; // the coordinate that stays fixed
          const planeY = this.tool === 'place' ? anchor[1] : anchor[1] + 1;
          this._area = { anchor, cur: anchor, y: anchor[1], planeY, wallAxis, info, alt: e.altKey, pointerId: e.pointerId };
          this._setAreaPreview(this._area);
          return;
        }
      }
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
    if (hit && (hit.type === 'axis' || hit.type === 'face')) {
      const found = this._findObject(hit.id);
      if (!found) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      const d = { mode: hit.type, axis: hit.axis, origin: hit.origin || hit.pos, sides: hit.sides, id: hit.id, objType: found.type, start: JSON.parse(JSON.stringify(found.obj)), last: 0, changed: false, pointerId: e.pointerId };
      d.t0 = this._axisParam(e, d);
      if (d.t0 == null) return;
      this._down = { x: e.clientX, y: e.clientY, hit };
      this.controls.enabled = false;
      try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.renderer.domElement.style.cursor = 'grabbing';
      this._drag = d;
      return;
    }
    if (!hit || (hit.type !== 'handle' && hit.type !== 'rotate')) {
      // A hand-placed block is picked before the object it sits on; a click selects it,
      // a drag still orbits.
      const cell = this._placedAt(e);
      if (cell) {
        e.stopImmediatePropagation();
        e.preventDefault();
        const add = e.shiftKey || e.ctrlKey || e.metaKey;
        const wasSelected = this._selCells && this._selCells.has(cell.join(','));
        if (!wasSelected && this.cb.onSelectBlock) this.cb.onSelectBlock(cell, { add });
        const planeY = cell[1] + 0.5;
        const p0 = this._planePoint(e, planeY);
        this.controls.enabled = false;
        try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        // Shift+click on an already-selected block deselects it (on release, if it didn't move).
        this._blockDrag = { x: e.clientX, y: e.clientY, cell, planeY, p0, dx: 0, dz: 0, moved: false, toggle: wasSelected && add, pointerId: e.pointerId };
        return;
      }
    }
    this._down = { x: e.clientX, y: e.clientY, hit };
    if (!hit) return; // let OrbitControls orbit

    e.stopImmediatePropagation();
    e.preventDefault();
    this.controls.enabled = false;
    try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    // SPEC-DEVIATION: resize drags raycast against the plane at the handle height E (not baseY) so the pointer tracks the handle it grabbed; move drags use baseY as specified.
    const planeY = hit.type === 'handle' || hit.type === 'rotate' ? hit.y : hit.planeY ?? hit.baseY;
    const p0 = this._planePoint(e, planeY);
    const found = this._findObject(hit.id);
    if (!p0 || !found) {
      // No plane to drag on from this angle: still select it.
      this.controls.enabled = true;
      this._down = null;
      if (found && hit.type !== 'handle' && hit.type !== 'rotate') {
        if (this.selectedId !== hit.id) { this.selectedId = hit.id; this._rebuildSelection(); this.requestRender(); }
        if (this.cb.onSelect) this.cb.onSelect(hit.id);
      }
      return;
    }

    this._drag = {
      mode: hit.type === 'handle' ? 'resize' : hit.type === 'rotate' ? 'rotate' : 'move',
      dir: hit.dir, sides: hit.sides, id: hit.id, objType: found.type,
      start: { ...found.obj }, planeY, p0, lastDx: 0, lastDz: 0, changed: false, pointerId: e.pointerId,
    };
    if (hit.type === 'rotate') {
      const o = found.obj;
      this._drag.center = found.type === 'box' || found.type === 'fill'
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
    const mq = this._marquee;
    if (mq) {
      e.stopImmediatePropagation();
      mq.x1 = e.clientX; mq.y1 = e.clientY;
      this._drawMarquee(mq);
      return;
    }
    const ar = this._area;
    if (ar) {
      e.stopImmediatePropagation();
      let cur;
      if (ar.wallAxis !== null) {
        this._setNDC(e);
        const nrm = ar.wallAxis === 0 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
        const plane = new THREE.Plane(nrm, -(ar.anchor[ar.wallAxis] + 0.5));
        const p = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
        if (!p) return;
        cur = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
        cur[ar.wallAxis] = ar.anchor[ar.wallAxis];
      } else {
        const p = this._planePoint(e, ar.planeY);
        if (!p) return;
        cur = [Math.floor(p.x), ar.y, Math.floor(p.z)];
        if (e.shiftKey) {
          // Shift: a square (or a round circle), sized by the longer side.
          const dx = cur[0] - ar.anchor[0], dz = cur[2] - ar.anchor[2], m = Math.max(Math.abs(dx), Math.abs(dz));
          cur[0] = ar.anchor[0] + (dx < 0 ? -m : m);
          cur[2] = ar.anchor[2] + (dz < 0 ? -m : m);
        }
      }
      if (cur[0] === ar.cur[0] && cur[1] === ar.cur[1] && cur[2] === ar.cur[2]) return;
      ar.cur = cur;
      this._setAreaPreview(ar);
      return;
    }
    const bd = this._blockDrag;
    if (bd) {
      e.stopImmediatePropagation();
      if (!bd.p0) return;
      const p = this._planePoint(e, bd.planeY);
      if (!p) return;
      const dx = Math.round(p.x - bd.p0.x), dz = Math.round(p.z - bd.p0.z);
      if (dx === bd.dx && dz === bd.dz) return;
      bd.dx = dx; bd.dz = dz; bd.moved = true;
      if (this.cb.onMoveBlocks) this.cb.onMoveBlocks(dx, dz);
      return;
    }
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
    if (d.mode === 'face') {
      const t = this._axisParam(e, d);
      if (t == null) return;
      const n = Math.round(t - d.t0);
      if (n === d.last && !!e.shiftKey === !!d.lastShift) return;
      d.last = n; d.lastShift = e.shiftKey;
      d.changed = true;
      const patch = resizePatch(d.objType, d.start, d.sides, { [d.axis]: n }, e.shiftKey);
      if (this.cb.onResize) this.cb.onResize(d.id, patch);
      return;
    }
    if (d.mode === 'axis') {
      const t = this._axisParam(e, d);
      if (t == null) return;
      const n = Math.round(t - d.t0);
      if (n === d.last) return;
      d.last = n;
      d.changed = true;
      const s = d.start;
      let patch;
      if (d.axis === 'y') patch = { baseY: s.baseY + n };
      else if (d.objType === 'segment') patch = d.axis === 'x' ? { x0: s.x0 + n, x1: s.x1 + n } : { z0: s.z0 + n, z1: s.z1 + n };
      else patch = d.axis === 'x' ? { x: s.x + n } : { z: s.z + n };
      if (this.cb.onMove) this.cb.onMove(d.id, patch);
      return;
    }
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
    if (dx === d.lastDx && dz === d.lastDz && !!e.shiftKey === !!d.lastShift) return;
    d.lastDx = dx; d.lastDz = dz; d.lastShift = e.shiftKey;
    d.changed = true;
    const s = d.start;
    if (d.mode === 'move') {
      let patch;
      if (d.objType === 'segment') patch = { x0: s.x0 + dx, z0: s.z0 + dz, x1: s.x1 + dx, z1: s.z1 + dz };
      else patch = { x: s.x + dx, z: s.z + dz };
      if (this.cb.onMove) this.cb.onMove(d.id, patch);
    } else {
      // Corner node: two sides at once, on the flat. Shift keeps a footprint square.
      const patch = resizePatch(d.objType, s, d.sides, { x: dx, z: dz }, e.shiftKey);
      if (this.cb.onResize) this.cb.onResize(d.id, patch);
    }
  }

  _onPointerUp(e) {
    const mq = this._marquee;
    if (mq) {
      e.stopImmediatePropagation();
      try { this.renderer.domElement.releasePointerCapture(mq.pointerId); } catch { /* ignore */ }
      this._marquee = null;
      this._down = null;
      this.controls.enabled = true;
      this._drawMarquee(null);
      if (e.type !== 'pointerup') return;
      if (Math.hypot(mq.x1 - mq.x0, mq.y1 - mq.y0) < 4) {
        // A plain Alt+click: pick up a material with a block tool, or select one placed block.
        if (this.tool !== 'select') {
          const info = this.pickBlock(e);
          if (info && this.cb.onBlockClick) this.cb.onBlockClick(info, { alt: true, shift: false });
        } else {
          const cell = this._placedAt(e);
          if (cell && this.cb.onSelectBlock) this.cb.onSelectBlock(cell, { add: mq.add });
        }
        return;
      }
      if (this.cb.onMarquee) this.cb.onMarquee(this._cellsInRect(mq), { add: mq.add });
      return;
    }
    const ar = this._area;
    if (ar) {
      e.stopImmediatePropagation();
      try { this.renderer.domElement.releasePointerCapture(ar.pointerId); } catch { /* ignore */ }
      this._area = null;
      this._down = null;
      this.controls.enabled = true;
      this._setAreaPreview(null);
      if (e.type !== 'pointerup') return;
      const same = ar.cur[0] === ar.anchor[0] && ar.cur[1] === ar.anchor[1] && ar.cur[2] === ar.anchor[2];
      if (same) { if (this.cb.onBlockClick) this.cb.onBlockClick(ar.info, { alt: ar.alt, shift: false }); }
      else if (this.cb.onArea) {
        const [ax, ay, az] = ar.anchor, [bx, by, bz] = ar.cur;
        this.cb.onArea({ x0: ax, y0: ay, z0: az, x1: bx, y1: by, z1: bz }, ar.info);
      }
      return;
    }
    const bd = this._blockDrag;
    if (bd) {
      e.stopImmediatePropagation();
      try { this.renderer.domElement.releasePointerCapture(bd.pointerId); } catch { /* ignore */ }
      this._blockDrag = null;
      this.controls.enabled = true;
      this._down = null;
      if (bd.moved) { if (this.cb.onMoveBlocksEnd) this.cb.onMoveBlocksEnd(); }
      else if (bd.toggle && this.cb.onSelectBlock) this.cb.onSelectBlock(bd.cell, { add: true });
      return;
    }
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
