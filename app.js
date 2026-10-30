// app.js — Rafter UI: state, panels, wiring, persistence, downloads. (UI owns)
import { FAMILIES, roofFamilies, fullFamilies, GROUP_ORDER } from './blocks.js';
import { buildGrid, decodeGrid, scaleDesign, stampCells, MIX_KEYS, MIX_MAX, defaultDesign, materialTotals, newId, inOutline, validateDesign, rotatePatch, suggestVariants, blockKey, DETAIL_DEFAULTS, VARIATION_DEFAULTS, UPTURN_TYPES } from './engine.js';
import { encodeLitematic, encodeSchem } from './export.js';
import { swatchDataURL, familyIcon } from './textures.js';
import { drawLayer, layerLegend, layerRange } from './plans.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'rafter.design';
const PRESET_KEY = 'rafter.presets';
const HISTORY_MAX = 50;
const DEFAULT_DATA_VERSION = 5023; // Minecraft 26.3

const RISE_OPTIONS = [
  [0.5, '1:2 — slabs (0.5)'],
  [1, '1:1 — stairs (1)'],
  [1.5, '3:2 (1.5)'],
  [2, '2:1 — block + stair (2)'],
  [3, '3:1 steep (3)'],
];
const ROOF_TYPES = [
  ['flat', 'Flat'], ['shed', 'Shed (single slope)'], ['gable', 'Gable'], ['hip', 'Hip'],
  ['halfhip', 'Half-hip (clipped gable)'], ['irimoya', 'Irimoya (Japanese hip-and-gable)'], ['gambrel', 'Gambrel (barn)'], ['mansard', 'Mansard'],
  ['round', 'Round (dome / cone / spire)'],
];
const PROFILE_OPTIONS = [
  ['straight', 'Straight'], ['rounded', 'Rounded (barrel / dome)'], ['flared', 'Flared (pagoda)'], ['bell', 'Bell (flared eave, round top)'],
];
const ROOF_HINT = 'Any block works. Blocks without slabs or stairs build a stepped roof from full blocks.';
const DIR_OPTIONS = [['north', 'North'], ['south', 'South'], ['east', 'East'], ['west', 'West']];
const KIND_LABEL = { full: 'block', slab: 'slab', stair: 'stairs', wall: 'wall', pane: 'pane' };
// Tip jar link (Ko-fi, Buy Me a Coffee, ...). Empty = the support line stays hidden.
const SUPPORT_URL = 'https://ko-fi.com/tatertottimmy';

// ------------------------------------------------------------------ state
const state = {
  design: null,
  grid: null,
  selectedId: null,
  currentLayer: 0,
  layerAtTop: true,
  sliceOn: true,
  past: [],
  future: [],
  dragging: false,
  tab: 'plans',
  lastChange: { key: null, t: 0 },
  propsFor: null, // "kind:id" the editor DOM was built for
  tool: 'select',   // select | paint | place | erase
  selectedBlocks: [], // world cells [x,y,z] of selected hand-placed blocks (Select tool)
  brush: 'stone_bricks',
  paintScope: 'part', // part = the whole wall/roof/trim the block belongs to; block = one block
  shape: 'full',
  area: false,         // Place / Erase / Paint: drag a rectangle instead of single blocks
  circle: false,       // ...and with this, the circle (ellipse) that fits the rectangle
  clone: { n: 1, dir: 'east', gap: 1 },
  planFacing: 'north', // stair facing for clicks on the layer plan (R turns it while placing stairs)
  rotAnchor: null, // { id, start, q, sig }: repeated rotations restart from `start` so odd sizes don't drift
  stampAsset: null, // asset the Asset tool places
};
let viewer = null;

// ------------------------------------------------------------------ tiny DOM helper
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = (n) => Number(n).toLocaleString();

// ------------------------------------------------------------------ family helpers
function famName(key) { return (FAMILIES[key] && FAMILIES[key].name) || key || '?'; }
function famColor(key) { return (FAMILIES[key] && FAMILIES[key].color) || '#888888'; }
function pickFamily(candidates, needRoof) {
  const pool = needRoof ? roofFamilies() : fullFamilies();
  for (const c of candidates) if (pool.includes(c)) return c;
  return pool[0];
}

// Icons: familyIcon() may return a cached canvas; render to a data URL so the
// same icon can appear in several places at once.
const iconCache = new Map();
function iconURL(key, size) {
  const ck = key + '@' + size;
  if (iconCache.has(ck)) return iconCache.get(ck);
  let url;
  try {
    url = familyIcon(key, size).toDataURL();
  } catch (e) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = famColor(key);
    ctx.fillRect(0, 0, size, size);
    url = c.toDataURL();
  }
  iconCache.set(ck, url);
  return url;
}
function iconEl(key, size = 22) {
  return h('img', { src: iconURL(key, size), alt: '', width: size, height: size, 'aria-hidden': 'true' });
}
function swatchURL(key) {
  try { return swatchDataURL(key); } catch (e) { return iconURL(key, 64); }
}

// ------------------------------------------------------------------ design helpers
function findObject(id) {
  if (!id || !state.design) return null;
  const d = state.design;
  let i = d.boxes.findIndex((o) => o.id === id);
  if (i >= 0) return { kind: 'box', obj: d.boxes[i], list: d.boxes, index: i };
  i = d.pillars.findIndex((o) => o.id === id);
  if (i >= 0) return { kind: 'pillar', obj: d.pillars[i], list: d.pillars, index: i };
  i = d.segments.findIndex((o) => o.id === id);
  if (i >= 0) return { kind: 'segment', obj: d.segments[i], list: d.segments, index: i };
  i = d.fills.findIndex((o) => o.id === id);
  if (i >= 0) return { kind: 'fill', obj: d.fills[i], list: d.fills, index: i };
  i = (d.stamps || []).findIndex((o) => o.id === id);
  if (i >= 0) return { kind: 'stamp', obj: d.stamps[i], list: d.stamps, index: i };
  return null;
}
function objectLabel(f) {
  if (!f) return '';
  if (f.kind === 'box') return f.obj.name || f.obj.id;
  if (f.kind === 'pillar') return 'Pillar ' + f.obj.id;
  if (f.kind === 'fill') return 'Fill ' + f.obj.id;
  if (f.kind === 'stamp') { const a = assetById(f.obj.asset); return (a ? a.name : 'Asset') + ' ' + f.obj.id; }
  return 'Wall ' + f.obj.id;
}
function objectMaterial(f) {
  if (f.kind === 'stamp') return assetMaterial(assetById(f.obj.asset));
  return f.kind === 'box' ? f.obj.roof.material : f.obj.material;
}
function safeValidate(design) {
  try { return validateDesign(design) || design; } catch (e) { console.warn('validateDesign failed', e); return design; }
}
function normalizeDesign(design) {
  const d = safeValidate(design);
  d.boxes = d.boxes || []; d.pillars = d.pillars || []; d.segments = d.segments || []; d.fills = d.fills || [];
  d.assets = d.assets || []; d.stamps = d.stamps || [];
  if (typeof d.name !== 'string') d.name = 'Untitled';
  if (typeof d.author !== 'string') d.author = '';
  if (!Number.isFinite(d.dataVersion)) d.dataVersion = DEFAULT_DATA_VERSION;
  return d;
}

function loadInitial() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.boxes)) return normalizeDesign(parsed);
    }
  } catch (e) { /* ignore: storage blocked or corrupt */ }
  const d = normalizeDesign(defaultDesign());
  d.dataVersion = DEFAULT_DATA_VERSION;
  return d;
}
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.design)); } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------------ history
function beginChange(key) {
  const now = Date.now();
  if (key && key === state.lastChange.key && now - state.lastChange.t < 800) {
    state.lastChange.t = now;
    return;
  }
  state.past.push(JSON.stringify(state.design));
  if (state.past.length > HISTORY_MAX) state.past.shift();
  state.future.length = 0;
  state.lastChange = { key, t: now };
  updateHistoryButtons();
}
function afterChange({ structural = true } = {}) {
  state.design = normalizeDesign(state.design);
  persist();
  scheduleRebuild(structural);
}
function updateHistoryButtons() {
  $('btnUndo').disabled = state.past.length === 0;
  $('btnRedo').disabled = state.future.length === 0;
}
function restoreSnapshot(json) {
  state.design = normalizeDesign(JSON.parse(json));
  state.lastChange = { key: null, t: 0 };
  state.dragging = false;
  if (!findObject(state.selectedId)) state.selectedId = null;
  persist();
  pendingStructural = true;
  rebuildAsync();
  renderHeaderFields();
  renderProps(true);
  if (viewer) viewer.setSelection(state.selectedId);
  updateHistoryButtons();
  if (studio.open) { if (!assetById(studio.assetId)) studio.assetId = state.design.assets[0] ? state.design.assets[0].id : null; renderStudio(); }
}
function undo() {
  if (!state.past.length) return;
  state.future.push(JSON.stringify(state.design));
  restoreSnapshot(state.past.pop());
  toast('Undo');
}
function redo() {
  if (!state.future.length) return;
  state.past.push(JSON.stringify(state.design));
  restoreSnapshot(state.future.pop());
  toast('Redo');
}

// ------------------------------------------------------------------ rebuild pipeline
// Builds run in a worker (engine-worker.js) so a huge design never freezes the page. Every
// request gets a sequence number; a result older than the last one applied is dropped, and
// while the worker is busy only the newest request waits. Without a worker (it failed to
// start) everything builds on the page, as before.
let rebuildTimer = 0;
let pendingStructural = false;
let worker = null, workerReq = null, workerQueued = null, buildSeq = 0, appliedSeq = 0;
function scheduleRebuild(structural = true) {
  pendingStructural = pendingStructural || structural;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuildAsync(), 30);
}
/** Start any waiting rebuild now (in the background). */
function flushRebuild() {
  if (rebuildTimer) rebuildAsync();
}
/** Make sure state.grid matches the design right now (exports). */
function flushRebuildSync() {
  if (rebuildTimer || workerReq || workerQueued) rebuildNow();
}
function startWorker() {
  try {
    worker = window.__RAFTER_WORKER_SRC // the single-file offline build inlines the worker
      ? new Worker(URL.createObjectURL(new Blob([window.__RAFTER_WORKER_SRC], { type: 'text/javascript' })))
      : new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
  } catch (e) {
    worker = null;
    return;
  }
  worker.onmessage = (e) => {
    const m = e.data, req = workerReq;
    workerReq = null;
    if (m.error) {
      console.error(m.error);
      toast('Could not build the design: ' + m.error, true);
    } else if (m.seq > appliedSeq) {
      state.buildMs = performance.now() - req.t0;
      applyGrid(decodeGrid(m), req.structural, m.seq);
    }
    if (workerQueued) { const q = workerQueued; workerQueued = null; postBuild(q); }
    else renderBusy();
  };
  worker.onerror = (e) => {
    // Couldn't load (or crashed): build on the page from now on.
    if (e && e.preventDefault) e.preventDefault();
    console.warn('Engine worker unavailable; building on the page.', e && e.message);
    const pending = workerReq || workerQueued;
    worker = null; workerReq = workerQueued = null;
    if (pending) rebuildNow(pending.structural);
    renderBusy();
  };
}
function postBuild(req) {
  workerReq = req;
  req.t0 = performance.now();
  try {
    worker.postMessage({ seq: req.seq, design: state.design }); // cloned now: later edits don't leak in
  } catch (e) {
    workerReq = null;
    worker = null;
    rebuildNow(req.structural);
    return;
  }
  renderBusy();
}
function rebuildAsync() {
  if (!worker) { rebuildNow(); return; }
  clearTimeout(rebuildTimer);
  rebuildTimer = 0;
  const req = { seq: ++buildSeq, structural: pendingStructural };
  pendingStructural = false;
  if (workerReq) {
    if (workerQueued) req.structural = req.structural || workerQueued.structural;
    workerQueued = req;
    return;
  }
  postBuild(req);
}
/** Build on the page, right now. */
function rebuildNow(structural) {
  clearTimeout(rebuildTimer);
  rebuildTimer = 0;
  const doStructural = structural === true || pendingStructural || !!(workerQueued && workerQueued.structural);
  pendingStructural = false;
  workerQueued = null;
  let grid;
  try {
    const t0 = performance.now();
    grid = buildGrid(state.design);
    state.buildMs = performance.now() - t0;
  } catch (e) {
    console.error(e);
    toast('Could not build the design: ' + (e.message || e), true);
    return;
  }
  applyGrid(grid, doStructural, ++buildSeq);
}
/** A slow background build shows "Building…" in the status line. */
let busyTimer = 0;
function renderBusy() {
  clearTimeout(busyTimer);
  const busy = !!workerReq;
  if (!busy) { $('status').classList.remove('busy'); renderStatus(); return; }
  busyTimer = setTimeout(() => { if (workerReq) { $('status').classList.add('busy'); $('status').textContent = 'Building…'; } }, 250);
}
function applyGrid(grid, doStructural, seq) {
  appliedSeq = seq;
  state.grid = grid;
  updateToolbar();
  const { minY, maxY } = layerRange(state.grid);
  if (state.layerAtTop) state.currentLayer = maxY;
  state.currentLayer = clamp(state.currentLayer, minY, maxY);
  state.layerAtTop = state.currentLayer === maxY;

  if (viewer) {
    if (doStructural && !state.dragging) viewer.setDesign(state.design);
    viewer.setGrid(state.grid);
    applySlice();
    syncBlockSelection();
  }
  renderSliceControls();
  renderPlan();
  renderLegend();
  renderMaterials();
  renderPalette();
  renderObjectList();
  if (!workerReq) renderStatus();
}

// ------------------------------------------------------------------ viewer
async function initViewer() {
  const el = $('viewport');
  try {
    const mod = await import('./viewer3d.js');
    viewer = new mod.Viewer(el, {
      onSelect: (id) => select(id, { fromViewer: true }),
      onMove: (id, patch) => liveEdit(id, patch),
      onResize: (id, patch) => liveEdit(id, patch),
      onRotate: (id, patch) => { state.rotAnchor = null; liveEdit(id, patch); },
      onBlockClick: (info, mods) => blockAction(info, mods),
      onArea: (rect, info) => areaAction(rect, info),
      onSelectBlock: (cell, mods) => selectBlock(cell, mods),
      onMarquee: (cells, mods) => selectBlocks(cells, mods),
      onMoveBlocks: (dx, dz) => dragBlocks(dx, dz),
      onMoveBlocksEnd: () => endBlockDrag(),
      onStrokeEnd: () => flushRebuild(),
      onHoverInfo: (info) => { if (state.tool === 'stamp') stampGhost(info); },
      onCommit: () => {
        state.dragging = false;
        flushRebuild();
        state.design = normalizeDesign(state.design);
        persist();
        viewer.setDesign(state.design);
        renderProps(true);
        renderObjectList();
      },
    });
    viewer.setDesign(state.design);
    viewer.setGrid(state.grid);
    viewer.setTool(state.tool, toolOpts());
    viewer.setSnap($('snapToggle').checked);
    viewer.setSelection(state.selectedId);
    applySlice();
    viewer.frameAll();
  } catch (e) {
    console.error('viewer failed', e);
    viewer = null;
    $('viewportError').hidden = false;
    $('viewportErrorMsg').textContent = e && e.message ? '(' + e.message + ')' : '';
  }
}
function liveEdit(id, patch) {
  const f = findObject(id);
  if (!f) return;
  if (!state.dragging) {
    beginChange(null);
    state.dragging = true;
  }
  Object.assign(f.obj, patch);
  persist();
  if (state.buildMs > 150 && viewer) {
    // A big build: the outline follows the pointer now, the blocks catch up when it rests
    // (or on release).
    viewer.refreshSelection();
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => rebuildAsync(), 450);
  } else scheduleRebuild(false);
  syncPropValues();
}
function applySlice() {
  if (!viewer) return;
  // At the top layer nothing is hidden, so skip the slice entirely: otherwise the
  // whole ridge row would sit in the highlight tint and read as a snow-capped roof.
  const atTop = !state.grid || state.currentLayer >= layerRange(state.grid).maxY;
  viewer.setSliceY(state.sliceOn && !atTop ? state.currentLayer : null);
}

// ------------------------------------------------------------------ selection
function select(id, opts = {}) {
  if (id && !findObject(id)) id = null;
  if (!opts.keepBlocks && state.selectedBlocks.length) { state.selectedBlocks = []; if (viewer) viewer.setSelectedBlocks([]); }
  const changed = id !== state.selectedId || opts.keepBlocks;
  state.selectedId = id;
  if ((id && changed) || (opts.keepBlocks && state.selectedBlocks.length)) showProps();
  if (viewer && !opts.fromViewer) viewer.setSelection(id);
  renderObjectList();
  renderProps(!changed);
  renderPaletteWin();
}

// ------------------------------------------------------------------ header
function renderHeaderFields() {
  const d = state.design;
  if (document.activeElement !== $('designName')) $('designName').value = d.name || '';
  if (document.activeElement !== $('authorName')) $('authorName').value = d.author || '';
  if (document.activeElement !== $('dataVersion')) $('dataVersion').value = d.dataVersion;
  try { document.title = d.name ? 'Rafter — ' + d.name : 'Rafter'; } catch (e) { /* ignore */ }
}

function renderPalette() {
  const bar = $('paletteBar');
  const usage = new Map(); // key -> { count, roof }
  const touch = (key, roof, core = true) => {
    if (!key) return;
    let u = usage.get(key);
    if (!u) { u = { count: 0, roof: false, core: false }; usage.set(key, u); }
    if (roof) u.roof = true;
    if (core) u.core = true;
    return u;
  };
  for (const b of state.design.boxes) {
    touch(b.roof.material, true); touch(b.wallMaterial, false);
    for (const [flag, mk] of DETAIL_MATS) if (flagOn(b, flag)) touch(b.details[mk], false, false);
  }
  for (const p of state.design.pillars) touch(p.material, false);
  for (const s of state.design.segments) touch(s.material, false);
  for (const f of state.design.fills) touch(f.material, false);
  if (state.grid) for (const b of state.grid.blocks.values()) { const u = touch(b.mat, false, false); if (u) u.count++; }

  const entries = [...usage.entries()].filter(([k, u]) => u.count > 0 || u.core).sort((a, b) => b[1].count - a[1].count || famName(a[0]).localeCompare(famName(b[0])));
  bar.replaceChildren();
  for (const [key, u] of entries) {
    const chip = h('button', {
      class: 'chip', id: 'chip-' + key, type: 'button', 'aria-haspopup': 'dialog',
      title: `${famName(key)}: change it in the palette manager`,
    }, iconEl(key, 22), h('span', { text: famName(key) }), h('span', { class: 'count', text: fmt(u.count) }));
    chip.addEventListener('click', () => openPaletteWin(key));
    bar.append(chip);
  }
  if (!entries.length) bar.append(h('p', { class: 'empty', text: 'No blocks yet.' }));
  renderPaletteWin();
  renderAssetsPane();
}

/** The Assets tab: this project's assets, each one click from placing or editing. */
function renderAssetsPane() {
  const ul = $('assetPaneList');
  if (!ul) return;
  const d = state.design;
  ul.replaceChildren();
  for (const a of d.assets) {
    const uses = (d.stamps || []).filter((t) => t.asset === a.id).length;
    const place = h('button', { class: 'btn small primary', type: 'button', text: 'Place', title: 'Click walls to place ' + a.name });
    place.addEventListener('click', () => { state.stampAsset = a.id; setTool('stamp'); renderStampPick(); });
    const edit = h('button', { class: 'btn small', type: 'button', text: 'Edit', title: 'Open ' + a.name + ' in the Asset Studio' });
    edit.addEventListener('click', () => openStudio(a.id));
    ul.append(h('li', { class: 'asset-row' + (state.tool === 'stamp' && state.stampAsset === a.id ? ' active' : '') },
      iconEl(assetMaterial(a), 22),
      h('span', {}, h('span', { class: 'asset-name', text: a.name }), h('span', { class: 'asset-size', text: assetSize(a) + (uses ? ' · placed ' + uses + '×' : '') })),
      h('span', { class: 'asset-btns' }, place, edit)));
  }
  if (!d.assets.length) ul.append(h('li', { class: 'empty', text: 'No assets yet. Open the Asset Studio to make one or add a starter window, door or balcony.' }));
}

// ------------------------------------------------------------------ assets
// Assets are small templates (windows, doors, balconies, ...) made in the Asset Studio and
// stamped onto walls. Cells: x across (right when you face it), y up, z = 0 the wall layer,
// +z out in front, -z inside; 'erase' cells cut holes in the wall they are placed on.
const P = (x, y, z, mat, axis = 'x') => ({ x, y, z, shape: 'pane', mat, axis });
const F = (x, y, z, mat, axis) => (axis ? { x, y, z, shape: 'full', mat, axis } : { x, y, z, shape: 'full', mat });
const ST = (x, y, z, mat, facing, half = 'bottom') => ({ x, y, z, shape: 'stair', mat, facing, half });
const SL = (x, y, z, mat, half = 'bottom') => ({ x, y, z, shape: 'slab', mat, half });
const CUT = (x, y, z = 0) => ({ x, y, z, shape: 'erase' });
const DOOR = (x, y, z, mat, hinge = 'left') => ({ x, y, z, shape: 'door', mat, facing: 'north', hinge });
const TD = (x, y, z, mat, facing, open = true, half = 'bottom') => ({ x, y, z, shape: 'trapdoor', mat, facing, half, ...(open ? { open: true } : {}) });
const range = (a, b) => { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; };
const STARTER_ASSETS = [
  { name: 'Window with sill', cells: [P(0, 1, 0, 'glass'), P(0, 2, 0, 'glass'), ST(0, 0, 1, 'spruce', 'north', 'top')] },
  { name: 'Framed window 2×2', cells: [
    ...range(0, 1).flatMap((x) => [P(x, 1, 0, 'glass'), P(x, 2, 0, 'glass'), F(x, 0, 0, 'stripped_spruce_log', 'x'), F(x, 3, 0, 'stripped_spruce_log', 'x')]),
    ...range(0, 3).flatMap((y) => [F(-1, y, 0, 'stripped_spruce_log', 'y'), F(2, y, 0, 'stripped_spruce_log', 'y')]),
    ...range(-1, 2).map((x) => SL(x, 0, 1, 'spruce', 'top')),
  ] },
  { name: 'Shuttered window', cells: [P(0, 1, 0, 'glass'), P(0, 2, 0, 'glass'), ST(0, 0, 1, 'dark_oak', 'north', 'top'),
    TD(-1, 1, 1, 'dark_oak', 'south'), TD(-1, 2, 1, 'dark_oak', 'south'), TD(1, 1, 1, 'dark_oak', 'south'), TD(1, 2, 1, 'dark_oak', 'south')] },
  { name: 'Arched window', cells: [
    ...range(-1, 1).flatMap((x) => [P(x, 1, 0, 'glass'), P(x, 2, 0, 'glass'), P(x, 3, 0, 'glass')]),
    P(0, 4, 0, 'glass'), ST(-1, 4, 0, 'stone_bricks', 'west', 'top'), ST(1, 4, 0, 'stone_bricks', 'east', 'top'),
    F(0, 5, 0, 'chiseled_stone_bricks'), ...range(-1, 1).map((x) => SL(x, 0, 1, 'stone_bricks', 'top')),
  ] },
  { name: 'Round window', cells: [
    ...range(-1, 1).flatMap((x) => [P(x, 1, 0, 'glass'), P(x, 2, 0, 'glass'), P(x, 3, 0, 'glass')]),
    P(0, 0, 0, 'glass'), P(0, 4, 0, 'glass'), P(-2, 2, 0, 'glass'), P(2, 2, 0, 'glass'),
  ] },
  { name: 'Doorway with awning', cells: [DOOR(0, 0, 0, 'spruce'),
    ...range(0, 2).flatMap((y) => [F(-1, y, 0, 'stripped_spruce_log', 'y'), F(1, y, 0, 'stripped_spruce_log', 'y')]), F(0, 2, 0, 'stripped_spruce_log', 'x'),
    ...range(-1, 1).map((x) => ST(x, 3, 1, 'spruce', 'north')),
  ] },
  { name: 'Double door', cells: [DOOR(0, 0, 0, 'dark_oak', 'left'), DOOR(1, 0, 0, 'dark_oak', 'right'),
    ...range(0, 2).flatMap((y) => [F(-1, y, 0, 'stripped_dark_oak_log', 'y'), F(2, y, 0, 'stripped_dark_oak_log', 'y')]),
    ...range(-1, 2).map((x) => F(x, 2, 0, 'stripped_dark_oak_log', 'x')).filter((c) => c.x === 0 || c.x === 1),
    ...range(-1, 2).map((x) => SL(x, 3, 1, 'dark_oak', 'bottom')),
  ] },
  { name: 'Balcony', cells: [CUT(0, 1), CUT(0, 2),
    ...range(-2, 2).flatMap((x) => [SL(x, 0, 1, 'spruce', 'top'), SL(x, 0, 2, 'spruce', 'top'), P(x, 1, 2, 'glass', 'x')]),
    P(-2, 1, 1, 'glass', 'z'), P(2, 1, 1, 'glass', 'z'),
    ...range(-2, 2).map((x) => ST(x, -1, 1, 'spruce', 'north', 'top')).filter((c) => c.x === -2 || c.x === 2),
  ] },
  { name: 'Flower box', cells: [...range(-1, 1).flatMap((x) => [SL(x, 0, 1, 'spruce', 'top'), F(x, 1, 1, 'flowering_azalea_leaves')])] },
  { name: 'Wall lamp', cells: [F(0, 0, 1, 'shroomlight'), ST(0, 1, 1, 'dark_oak', 'north', 'top')] },
  { name: 'Buttress', cells: [...range(0, 3).map((y) => F(0, y, 1, 'stone_bricks')), F(0, 0, 2, 'stone_bricks'), F(0, 1, 2, 'stone_bricks'),
    ST(0, 2, 2, 'stone_bricks', 'north'), ST(0, 4, 1, 'stone_bricks', 'north')] },
];

function assetById(id) { return (state.design && state.design.assets.find((a) => a.id === id)) || null; }
/** The block an asset is mostly made of (its icon). */
function assetMaterial(a) {
  const n = new Map();
  for (const c of (a && a.cells) || []) if (c.mat) n.set(c.mat, (n.get(c.mat) || 0) + 1);
  return [...n.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || 'glass';
}
function assetSize(a) {
  const c = (a && a.cells) || [];
  if (!c.length) return 'empty';
  const ext = (k) => Math.max(...c.map((v) => v[k])) - Math.min(...c.map((v) => v[k])) + 1;
  return `${ext('x')}×${ext('y')}×${ext('z')}`;
}
function addAsset(template) {
  const d = state.design;
  const a = { id: newId(d, 'a'), name: template ? template.name : 'Asset ' + (d.assets.length + 1), cells: template ? JSON.parse(JSON.stringify(template.cells)) : [] };
  let name = a.name, i = 2;
  while (d.assets.some((o) => o.name === name)) name = a.name + ' ' + i++;
  a.name = name;
  beginChange(null);
  d.assets.push(a);
  afterChange();
  return a.id;
}

// ---- placing on the building
/** The asset placement for a hover on a wall face, or null (not a wall face). */
function stampAt(info) {
  if (!info || !info.cell || info.ground) return null;
  const n = info.normal || [0, 1, 0];
  if (n[1] !== 0) return null;
  const facing = n[0] > 0 ? 'east' : n[0] < 0 ? 'west' : n[2] > 0 ? 'south' : 'north';
  return { asset: state.stampAsset, x: info.cell[0], baseY: info.cell[1], z: info.cell[2], facing };
}
function stampGhost(info) {
  if (!viewer) return;
  const a = assetById(state.stampAsset);
  const st = a && stampAt(info);
  if (!st) { viewer.setGhost(null); return; }
  viewer.setGhost(stampCells(a, st).map((c) => ({ x: c.x, y: c.y, z: c.z, cut: c.shape === 'erase', color: c.mat ? famColor(c.mat) : null })));
}
function placeStamp(info) {
  const a = assetById(state.stampAsset);
  if (!a) return;
  const st = stampAt(info);
  if (!st) { toast('Point at the side of a wall to place ' + a.name); return; }
  const d = state.design;
  beginChange(null);
  d.stamps.push({ id: newId(d, 't'), ...st });
  afterChange();
  toast(`Placed ${a.name} facing ${st.facing}`, false, { label: 'Undo', run: undo });
}
function renderStampPick() {
  const sel = $('stampPick');
  const d = state.design;
  sel.replaceChildren(...d.assets.map((a) => h('option', { value: a.id, text: a.name })), h('option', { value: '__studio', text: 'Assets… (make or edit)' }));
  sel.value = assetById(state.stampAsset) ? state.stampAsset : '';
}

// ---- the Asset Studio: its own 3D builder
const studio = { open: false, assetId: null, tool: 'place', shape: 'full', brush: 'glass', wallMat: 'stone_bricks', showWall: true, viewer: null, W: 5, Y0: -3, Y1: 7 };
async function openStudio(assetId = null) {
  const d = state.design;
  if (assetId) studio.assetId = assetId;
  if (!assetById(studio.assetId)) studio.assetId = d.assets[0] ? d.assets[0].id : null;
  // The sample wall takes the selected box's wall block, so assets are made against the real look.
  const sel = findObject(state.selectedId);
  if (sel && sel.kind === 'box') studio.wallMat = sel.obj.wallMaterial;
  studio.open = true;
  $('studio').hidden = false;
  if (!studio.viewer) {
    try {
      const mod = await import('./viewer3d.js');
      studio.viewer = new mod.Viewer($('studioView'), {
        onBlockClick: (info, mods) => studioAction(info, mods),
        onSelect: () => {},
      });
    } catch (e) { console.error(e); toast('Could not start the 3D view for the studio', true); return; }
  }
  studio.viewer.setTool(studio.tool, { shape: studio.shape });
  renderStudio(true);
}
function closeStudio() {
  studio.open = false;
  $('studio').hidden = true;
  renderAssetsPane();
}
function studioCellIndex(a, x, y, z) { return a.cells.findIndex((c) => c.x === x && c.y === y && c.z === z); }
function inSampleWall(x, y, z) { return studio.showWall && z === 0 && x >= -studio.W && x <= studio.W && y >= studio.Y0 && y <= studio.Y1; }
/** Build what the studio shows: the sample wall, with the asset's cuts and blocks applied. */
function studioGrid() {
  const a = assetById(studio.assetId);
  const cells = a ? a.cells : [];
  const taken = new Set(cells.map((c) => c.x + ',' + c.y + ',' + c.z));
  const edits = [];
  if (studio.showWall) for (let y = studio.Y0; y <= studio.Y1; y++) for (let x = -studio.W; x <= studio.W; x++) if (!taken.has(x + ',' + y + ',0')) edits.push({ x, y, z: 0, shape: 'full', mat: studio.wallMat });
  const cut = [];
  for (const c of cells) { if (c.shape === 'erase') cut.push([c.x, c.y, c.z]); else edits.push({ ...c }); }
  return { grid: buildGrid({ boxes: [], edits }), cut };
}
function renderStudio(frame = false) {
  if (!studio.open) return;
  const d = state.design;
  const a = assetById(studio.assetId);
  // gallery
  const list = $('assetList');
  list.replaceChildren();
  if (!d.assets.length) list.append(h('li', { class: 'empty', text: 'No assets yet. Make one, or add a starter.' }));
  for (const as of d.assets) {
    const placed = d.stamps.filter((t) => t.asset === as.id).length;
    const btn = h('button', { class: 'obj', type: 'button', 'aria-pressed': String(as.id === studio.assetId) },
      iconEl(assetMaterial(as), 22), h('span', { class: 'obj-name', text: as.name }), h('span', { class: 'obj-meta', text: assetSize(as) + (placed ? ` · ${placed} placed` : '') }));
    btn.addEventListener('click', () => { studio.assetId = as.id; renderStudio(true); });
    list.append(h('li', {}, btn));
  }
  // header
  $('assetName').disabled = !a;
  if (document.activeElement !== $('assetName')) $('assetName').value = a ? a.name : '';
  for (const id of ['assetDup', 'assetDel', 'studioPlace']) $(id).disabled = !a;
  for (const b of $('studioTools').querySelectorAll('[data-stool]')) b.setAttribute('aria-pressed', String(b.dataset.stool === studio.tool));
  for (const b of $('studioShapes').querySelectorAll('[data-sshape]')) b.setAttribute('aria-pressed', String(b.dataset.sshape === studio.shape));
  $('studioShapes').hidden = studio.tool !== 'place';
  const setIcon = (btn, key) => { const img = btn.querySelector('img'); if (img.dataset.key !== key) { img.src = iconURL(key, 28); img.dataset.key = key; } btn.querySelector('.mat-name').textContent = famName(key); };
  setIcon($('studioBrush'), studio.brush);
  setIcon($('studioWallMat'), studio.wallMat);
  $('studioBrush').hidden = studio.tool === 'erase';
  $('studioWallToggle').checked = studio.showWall;
  $('studioEmpty').hidden = !!a;
  // 3D
  if (studio.viewer) {
    const { grid, cut } = studioGrid();
    studio.viewer.setGrid(grid);
    studio.viewer.setHighlightCells(cut, '#c0392b');
    if (frame) {
      // Face the front of the asset, a little from above and to the right.
      const v = studio.viewer;
      v.frameAll();
      const t = v.controls.target, r = v.camera.position.distanceTo(t) * 0.9;
      v.camera.position.set(t.x + r * 0.35, t.y + r * 0.3, t.z + r * 0.89);
      v.controls.update();
      v.requestRender();
    }
  }
}
/** A click in the studio: place, paint or erase one cell of the asset. */
function studioAction(info, mods = {}) {
  const a = assetById(studio.assetId);
  if (!a || !info) return;
  const { grid } = studioGrid();
  const at = info.cell && grid.blocks.get(blockKey(...info.cell));
  if (mods.alt) { if (at) { studio.brush = at.mat; renderStudio(); } return; }
  let run = null;
  if (studio.tool === 'place') {
    const t = info.place;
    if (!t || grid.blocks.has(blockKey(...t))) return;
    const c = { x: t[0], y: t[1], z: t[2], shape: studio.shape, mat: studio.brush };
    if (studio.shape === 'slab' || studio.shape === 'stair') c.half = info.half || 'bottom';
    if (studio.shape === 'stair') c.facing = info.facing;
    if (studio.shape === 'full' && FAMILIES[studio.brush].axis) c.axis = info.normal[0] ? 'x' : info.normal[2] ? 'z' : 'y';
    if (studio.shape === 'pane') c.axis = paneAxis(info);
    if (studio.shape === 'door' || studio.shape === 'trapdoor') Object.assign(c, doorState(info));
    run = () => { const i = studioCellIndex(a, ...t); if (i >= 0) a.cells.splice(i, 1); a.cells.push(c); };
  } else if (studio.tool === 'paint') {
    if (!at) return;
    const [x, y, z] = info.cell;
    const i = studioCellIndex(a, x, y, z);
    if (i >= 0 && a.cells[i].shape !== 'erase') run = () => { a.cells[i].mat = studio.brush; };
    else run = () => a.cells.push({ x, y, z, shape: 'full', mat: studio.brush });
  } else if (studio.tool === 'erase') {
    if (!at) return;
    const [x, y, z] = info.cell;
    const i = studioCellIndex(a, x, y, z);
    // Erase what you clicked: an asset block goes; a block of the sample wall gets cut out.
    if (i >= 0) run = () => a.cells.splice(i, 1);
    else if (inSampleWall(x, y, z)) run = () => a.cells.push({ x, y, z, shape: 'erase' });
  }
  if (!run) return;
  beginChange(mods.stroke ? 'studio:' + mods.stroke : null);
  run();
  afterChange();
  renderStudio();
}
function wireStudio() {
  $('btnAssets').addEventListener('click', () => openStudio());
  $('studioClose').addEventListener('click', closeStudio);
  $('studio').addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('popover').hidden) { e.stopPropagation(); closeStudio(); } });
  $('assetNew').addEventListener('click', () => { studio.assetId = addAsset(null); renderStudio(true); $('assetName').focus(); $('assetName').select(); });
  $('assetDup').addEventListener('click', () => { const a = assetById(studio.assetId); if (a) { studio.assetId = addAsset({ name: a.name + ' copy', cells: a.cells }); renderStudio(true); } });
  $('assetDel').addEventListener('click', () => {
    const a = assetById(studio.assetId);
    if (!a) return;
    const d = state.design, placed = d.stamps.filter((t) => t.asset === a.id).length;
    beginChange(null);
    d.assets = d.assets.filter((o) => o.id !== a.id);
    d.stamps = d.stamps.filter((t) => t.asset !== a.id);
    afterChange();
    studio.assetId = d.assets[0] ? d.assets[0].id : null;
    renderStudio(true);
    toast(`Deleted ${a.name}` + (placed ? ` and its ${placed} placed ${placed === 1 ? 'copy' : 'copies'}` : ''), false, { label: 'Undo', run: () => { undo(); renderStudio(true); } });
  });
  $('assetName').addEventListener('input', () => {
    const a = assetById(studio.assetId);
    if (!a) return;
    beginChange('assetname:' + a.id);
    a.name = $('assetName').value.slice(0, 60) || 'Asset';
    persist();
    renderObjectList();
    for (const btn of $('assetList').querySelectorAll('[aria-pressed=true] .obj-name')) btn.textContent = a.name;
  });
  $('assetName').addEventListener('change', () => afterChange());
  const starters = $('assetStarter');
  starters.replaceChildren(h('option', { value: '', text: 'Add a starter…' }), ...STARTER_ASSETS.map((t, i) => h('option', { value: String(i), text: t.name })), h('option', { value: 'all', text: 'All starters' }));
  starters.addEventListener('change', () => {
    const v = starters.value;
    starters.value = '';
    if (v === '') return;
    const list = v === 'all' ? STARTER_ASSETS : [STARTER_ASSETS[+v]];
    let last = null;
    for (const t of list) last = addAsset(t);
    studio.assetId = last;
    renderStudio(true);
  });
  for (const b of $('studioTools').querySelectorAll('[data-stool]')) b.addEventListener('click', () => { studio.tool = b.dataset.stool; if (studio.viewer) studio.viewer.setTool(studio.tool, { shape: studio.shape }); renderStudio(); });
  for (const b of $('studioShapes').querySelectorAll('[data-sshape]')) b.addEventListener('click', () => { studio.shape = b.dataset.sshape; if (studio.viewer) studio.viewer.setTool(studio.tool, { shape: studio.shape }); renderStudio(); });
  $('studioBrush').addEventListener('click', () => openPicker($('studioBrush'), { title: 'Block to build with', keys: fullFamilies(), current: studio.brush, onPick: (k) => { studio.brush = k; renderStudio(); } }));
  $('studioWallMat').addEventListener('click', () => openPicker($('studioWallMat'), { title: 'Sample wall block', keys: fullFamilies(), current: studio.wallMat, onPick: (k) => { studio.wallMat = k; renderStudio(); } }));
  $('studioWallToggle').addEventListener('change', (e) => { studio.showWall = e.target.checked; renderStudio(); });
  $('studioFrame').addEventListener('click', () => studio.viewer && studio.viewer.frameAll());
  $('studioPlace').addEventListener('click', () => {
    const a = assetById(studio.assetId);
    if (!a) return;
    if (!a.cells.length) { toast('This asset is empty: build something first'); return; }
    state.stampAsset = a.id;
    closeStudio();
    setTool('stamp');
  });
  $('stampPick').addEventListener('change', (e) => {
    if (e.target.value === '__studio') { renderStampPick(); openStudio(state.stampAsset); return; }
    state.stampAsset = e.target.value;
  });
}

// ------------------------------------------------------------------ palette manager
// Every place a material is used, as roles ("Roof", "Trim & ridge", "Wall mix", ...), each with
// setters, so a material can be replaced everywhere, in one role only, or in one object only.
// Roles that make roof shapes (stairs and slabs) are marked, so a block without them is flagged.
function paletteUses(scopeId = null) {
  const uses = new Map(); // mat -> { count, roles: Map(label -> { shape, items: [{ id, set }] }) }
  const entry = (mat) => {
    let u = uses.get(mat);
    if (!u) { u = { count: 0, roles: new Map() }; uses.set(mat, u); }
    return u;
  };
  const add = (mat, label, shape, id, set) => {
    if (!mat || !FAMILIES[mat]) return;
    const u = entry(mat);
    let r = u.roles.get(label);
    if (!r) { r = { shape, items: [] }; u.roles.set(label, r); }
    r.items.push({ id, set });
  };
  const inScope = (o) => !scopeId || o.id === scopeId;
  const d = state.design;
  const editSet = (e) => (to) => {
    e.mat = to;
    // Keep the edit buildable: a shape the new block doesn't have becomes a full block.
    const f = FAMILIES[to];
    if ((e.shape === 'stair' && !f.stairs) || (e.shape === 'slab' && !f.slab) || (e.shape === 'pane' && !f.pane)
      || (e.shape === 'door' && !f.door) || (e.shape === 'trapdoor' && !f.trapdoor)) { e.shape = 'full'; delete e.half; delete e.facing; delete e.axis; delete e.hinge; delete e.open; }
  };
  for (const b of d.boxes) {
    if (!inScope(b)) continue;
    const det = b.details || {}, r = b.roof, va = texOf(b);
    add(r.material, 'Roof', 'stairs', b.id, (t) => { r.material = t; });
    add(b.wallMaterial, 'Walls', null, b.id, (t) => { b.wallMaterial = t; });
    if (det.trim || det.ridge) add(det.trimMat, 'Trim & ridge', 'stairs', b.id, (t) => { det.trimMat = t; });
    if (det.corners) add(det.cornerMat, 'Corners', null, b.id, (t) => { det.cornerMat = t; });
    if (det.base) add(det.baseMat, 'Base course', null, b.id, (t) => { det.baseMat = t; });
    if (det.beams || det.studs) add(det.beamMat, 'Beams & studs', null, b.id, (t) => { det.beamMat = t; });
    if (det.windows) add(det.windowMat, 'Windows', det.winStyle === 'pane' ? 'pane' : null, b.id, (t) => { det.windowMat = t; });
    if (det.frame && (det.windows || det.door)) add(det.frameMat, 'Frames', null, b.id, (t) => { det.frameMat = t; });
    if (det.sills && det.windows) add(det.sillMat, 'Sills', 'stairs', b.id, (t) => { det.sillMat = t; });
    if (r.cut > 0 && r.capMat) add(r.capMat, 'Roof cap', null, b.id, (t) => { r.capMat = t; });
    for (const surface of ['wall', 'roof']) {
      if (!va[surface]) continue;
      const keys = MIX_KEYS[surface].slice(0, va[surface + 'MixCount'] || 2);
      const label = surface === 'wall' ? 'Wall mix' : 'Roof mix';
      keys.forEach((key, i) => {
        const chosen = va[key] && FAMILIES[va[key]] ? va[key] : null;
        const mat = chosen || autoMix(surface, surface === 'wall' ? ['wallMaterial'] : ['roof', 'material'], i)(b);
        add(mat, chosen ? label : label + ' (auto)', surface === 'roof' ? 'stairs' : null, b.id, (t) => { va[key] = t; });
      });
    }
    for (const e of b.edits || []) if (e.mat) add(e.mat, 'Hand-placed', null, b.id, editSet(e));
  }
  for (const p of d.pillars) {
    if (!inScope(p)) continue;
    add(p.material, 'Pillars', p.shape === 'wall' ? 'wall' : null, p.id, (t) => { p.material = t; });
    if (p.base && p.base !== 'none') add(p.baseMat, 'Pillar bases', p.base === 'block' ? null : p.base === 'slab' ? 'slab' : 'stairs', p.id, (t) => { p.baseMat = t; });
    if (p.cap && p.cap !== 'none') add(p.capMat, 'Pillar caps', p.cap === 'block' ? null : p.cap === 'slab' ? 'slab' : 'stairs', p.id, (t) => { p.capMat = t; });
  }
  for (const g of d.segments) if (inScope(g)) add(g.material, 'Wall segments', null, g.id, (t) => { g.material = t; });
  for (const f of d.fills) if (inScope(f)) add(f.material, 'Fills', f.shape === 'stair' ? 'stairs' : f.shape === 'slab' ? 'slab' : f.shape === 'pane' ? 'pane' : null, f.id, (t) => { f.material = t; });
  if (!scopeId) for (const e of d.edits || []) if (e.mat) add(e.mat, 'Hand-placed', null, null, editSet(e));
  // Assets: their blocks (changing one changes every placed copy).
  for (const a of d.assets || []) {
    if (scopeId && !d.stamps.some((t) => t.id === scopeId && t.asset === a.id)) continue;
    for (const c of a.cells) if (c.mat) add(c.mat, 'Assets', c.shape === 'stair' ? 'stairs' : ['slab', 'pane', 'door', 'trapdoor'].includes(c.shape) ? c.shape : null, a.id, editSet(c));
  }
  if (state.grid) for (const blk of state.grid.blocks.values()) {
    if (scopeId && blk.src !== scopeId) continue;
    if (blk.mat && FAMILIES[blk.mat]) entry(blk.mat).count++;
  }
  return uses;
}
/** Why a material falls short in a role ("no stairs: stepped roof"), or ''. */
function shapeWarning(mat, shape) {
  const f = FAMILIES[mat];
  if (!f || !shape) return '';
  if (shape === 'stairs' && !f.stairs) return 'no stairs: builds as a stepped roof of full blocks';
  if (shape === 'slab' && !f.slab) return 'no slabs: uses full blocks';
  if (shape === 'pane' && !f.pane) return 'no pane: windows become full blocks';
  if (shape === 'wall' && !f.wall) return 'no wall block: uses full blocks';
  if (shape === 'door' && !f.door) return 'no door: uses full blocks';
  if (shape === 'trapdoor' && !f.trapdoor) return 'no trapdoor: uses slabs';
  return '';
}

/** Replace `from` with `to` in every use (or only `role`), within the palette window's scope. */
function paletteReplace(from, to, role = null) {
  if (!to || from === to) return;
  const u = paletteUses(palWin.scope).get(from);
  if (!u) return;
  beginChange(null);
  let n = 0;
  for (const [label, r] of u.roles) if (!role || label === role) for (const it of r.items) { it.set(to); n++; }
  afterChange();
  renderProps(true);
  const where = role ? ` in ${role.toLowerCase()}` : '';
  toast(`${famName(from)} → ${famName(to)}${where} (${n} ${n === 1 ? 'place' : 'places'})`, false, { label: 'Undo', run: undo });
}
/** Swap two materials both ways, within the window's scope. */
function paletteSwap(a, b) {
  if (!b || a === b) return;
  const uses = paletteUses(palWin.scope);
  const ia = [...(uses.get(a)?.roles.values() || [])].flatMap((r) => r.items);
  const ib = [...(uses.get(b)?.roles.values() || [])].flatMap((r) => r.items);
  beginChange(null);
  for (const it of ia) it.set(b);
  for (const it of ib) it.set(a);
  afterChange();
  renderProps(true);
  toast(`Swapped ${famName(a)} ⇄ ${famName(b)}`, false, { label: 'Undo', run: undo });
}

const palWin = { open: false, scope: null, x: null, y: null, focus: null };
function openPaletteWin(focusKey = null) {
  palWin.open = true;
  palWin.focus = focusKey;
  $('palWin').hidden = false;
  renderPaletteWin();
  if (focusKey) {
    const row = $('pal-' + focusKey);
    if (row) { row.scrollIntoView({ block: 'nearest' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 900); }
  }
}
function closePaletteWin() {
  palWin.open = false;
  $('palWin').hidden = true;
  if (viewer) viewer.setHighlightCells(null);
}
function renderPaletteWin() {
  const win = $('palWin');
  if (!win || !palWin.open) return;
  // Scope: whole design, or the selected object.
  if (palWin.scope && !findObject(palWin.scope)) palWin.scope = null;
  const sel = state.selectedId && findObject(state.selectedId);
  const scopeSel = $('palScope');
  scopeSel.replaceChildren(h('option', { value: '', text: 'Whole design' }), ...(sel || palWin.scope ? [h('option', { value: (palWin.scope || state.selectedId), text: 'Only ' + objectLabel(findObject(palWin.scope || state.selectedId)) })] : []));
  scopeSel.value = palWin.scope || '';
  const uses = paletteUses(palWin.scope);
  const rows = [...uses.entries()].filter(([, u]) => u.count > 0 || u.roles.size).sort((a, b) => b[1].count - a[1].count || famName(a[0]).localeCompare(famName(b[0])));
  const total = rows.reduce((t, [, u]) => t + u.count, 0) || 1;
  $('palSum').textContent = `${rows.length} ${rows.length === 1 ? 'block' : 'blocks'} · ${fmt(total)} placed`;
  const body = $('palBody');
  const scrollTop = body.scrollTop;
  body.replaceChildren();
  if (!rows.length) body.append(h('p', { class: 'empty', text: 'Nothing here yet.' }));
  for (const [mat, u] of rows) {
    const pct = Math.round((u.count / total) * 1000) / 10;
    const roleChips = [...u.roles.entries()].map(([label, r]) => {
      const warn = shapeWarning(mat, r.shape);
      const objs = new Set(r.items.map((it) => it.id)).size;
      const chip = h('button', { class: 'pal-role' + (warn ? ' warn' : ''), type: 'button', title: (warn ? famName(mat) + ' has ' + warn + '. ' : '') + `Change ${famName(mat)} in ${label.toLowerCase()} only` },
        (warn ? '⚠ ' : '') + label + (objs > 1 ? ' ·' + objs : ''));
      chip.addEventListener('click', () => openPicker(chip, {
        title: `${famName(mat)} in ${label.toLowerCase()} →`, keys: fullFamilies(), current: mat, hint: r.shape === 'stairs' ? ROOF_HINT : null,
        onPick: (to) => paletteReplace(mat, to, label),
      }));
      return chip;
    });
    const replace = h('button', { class: 'btn small', type: 'button', title: `Replace ${famName(mat)} everywhere it is used${palWin.scope ? ' in this object' : ''}` }, 'Replace…');
    replace.addEventListener('click', () => openPicker(replace, {
      title: `Replace ${famName(mat)} everywhere`, keys: fullFamilies(), current: mat,
      hint: [...u.roles.values()].some((r) => r.shape === 'stairs') ? ROOF_HINT : null,
      onPick: (to) => paletteReplace(mat, to),
    }));
    const swap = h('button', { class: 'btn small', type: 'button', title: `Swap ${famName(mat)} with another block both ways` }, 'Swap ⇄');
    swap.addEventListener('click', () => openPicker(swap, {
      title: `Swap ${famName(mat)} with…`, keys: rows.map(([k]) => k).filter((k) => k !== mat).concat(fullFamilies().filter((k) => !uses.has(k))), current: null,
      onPick: (to) => paletteSwap(mat, to),
    }));
    const row = h('div', { class: 'pal-row', id: 'pal-' + mat },
      h('div', { class: 'pal-main' },
        iconEl(mat, 28),
        h('div', { class: 'pal-name' }, h('span', { text: famName(mat) }), h('span', { class: 'muted mono', text: FAMILIES[mat].group || '' })),
        h('div', { class: 'pal-count mono' }, h('span', { text: fmt(u.count) }), h('span', { class: 'muted', text: pct + '%' })),
        h('div', { class: 'pal-acts' }, replace, swap)),
      h('div', { class: 'pal-bar' }, h('span', { style: `width:${Math.max(1, pct)}%;background:${FAMILIES[mat].color}` })),
      h('div', { class: 'pal-roles' }, ...(roleChips.length ? roleChips : [h('span', { class: 'muted', text: 'Placed by the build itself' })])));
    // Hover: show where it is in the 3D view.
    row.addEventListener('pointerenter', () => {
      if (!viewer || !state.grid) return;
      const cells = [];
      for (const blk of state.grid.blocks.values()) if (blk.mat === mat && (!palWin.scope || blk.src === palWin.scope)) cells.push([blk.x, blk.y, blk.z]);
      viewer.setHighlightCells(cells);
    });
    row.addEventListener('pointerleave', () => viewer && viewer.setHighlightCells(null));
    body.append(row);
  }
  body.scrollTop = scrollTop;
}
function wirePaletteWin() {
  const win = $('palWin');
  $('palClose').addEventListener('click', closePaletteWin);
  $('palScope').addEventListener('change', (e) => { palWin.scope = e.target.value || null; renderPaletteWin(); });
  win.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('popover').hidden) closePaletteWin(); });
  // Drag the window by its title bar; it stays inside the page.
  const head = $('palHead');
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, select')) return;
    const r = win.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const x = Math.min(Math.max(0, ev.clientX - ox), innerWidth - r.width), y = Math.min(Math.max(0, ev.clientY - oy), innerHeight - 40);
      win.style.left = x + 'px'; win.style.top = y + 'px'; win.style.right = 'auto';
    };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
}
// [detail flag(s), material key]: a material only counts as "used" while its detail is on.
const DETAIL_MATS = [[['trim', 'ridge'], 'trimMat'], [['corners'], 'cornerMat'], [['base'], 'baseMat'], [['beams'], 'beamMat'], [['windows'], 'windowMat']];
const flagOn = (b, flags) => !!b.details && flags.some((k) => b.details[k]);

// ------------------------------------------------------------------ object list
function renderObjectList() {
  const ul = $('objectList');
  const focusedId = document.activeElement && ul.contains(document.activeElement) ? document.activeElement.id : null;
  ul.replaceChildren();
  const d = state.design;
  $('objectCount').textContent = String(d.boxes.length + d.pillars.length + d.segments.length + d.fills.length + (d.stamps || []).length);
  const groups = [
    ['Boxes', d.boxes, 'box'],
    ['Pillars', d.pillars, 'pillar'],
    ['Wall segments', d.segments, 'segment'],
    ['Fills', d.fills, 'fill'],
    ['Placed assets', d.stamps || [], 'stamp'],
  ];
  for (const [label, arr, kind] of groups) {
    if (!arr.length) continue;
    ul.append(h('li', { class: 'obj-group', text: label }));
    for (const o of arr) {
      const f = { kind, obj: o };
      let meta;
      if (kind === 'box') meta = `${o.w}×${o.d} ${o.roof.type}`;
      else if (kind === 'pillar') meta = `(${o.x},${o.z}) h${o.h}`;
      else if (kind === 'fill') meta = `${o.outline === 'circle' ? '○ ' : ''}${o.w}×${o.d}×${o.h}`;
      else if (kind === 'stamp') meta = `(${o.x},${o.baseY},${o.z}) ${o.facing}`;
      else meta = `(${o.x0},${o.z0})→(${o.x1},${o.z1})`;
      const btn = h('button', {
        class: 'obj', id: 'obj-' + o.id, type: 'button',
        'aria-pressed': String(o.id === state.selectedId),
      }, iconEl(objectMaterial(f), 22), h('span', { class: 'obj-name', text: objectLabel(f) }), h('span', { class: 'obj-meta', text: meta }));
      btn.addEventListener('click', () => select(o.id));
      const lock = h('button', {
        class: 'obj-lock' + (o.locked ? ' on' : ''), id: 'lock-' + o.id, type: 'button',
        'aria-pressed': String(!!o.locked), 'aria-label': (o.locked ? 'Unlock ' : 'Lock ') + objectLabel(f),
        title: o.locked ? 'Locked: it can\'t be moved, resized, turned or deleted. Click to unlock.' : 'Lock in place',
        html: o.locked ? LOCK_SVG : UNLOCK_SVG,
      });
      lock.addEventListener('click', () => toggleLock(o.id));
      ul.append(h('li', { class: 'obj-row' }, btn, lock));
    }
  }
  if (!ul.children.length) ul.append(h('li', { class: 'empty', text: 'No objects yet. Add a box to start.' }));
  if (focusedId) { const el = $(focusedId); if (el) el.focus(); }
}

// ------------------------------------------------------------------ properties editor
// Field schema. `path` is the key path within the object; `show(obj)` toggles visibility.
const ROOF_SHOW = {
  axis: (o) => ['gable', 'halfhip', 'irimoya', 'gambrel'].includes(o.roof.type),
  shedLow: (o) => o.roof.type === 'shed',
  rise: (o) => o.roof.type !== 'flat',
  rise2: (o) => ['gambrel', 'mansard'].includes(o.roof.type),
  breakAt: (o) => ['gambrel', 'mansard'].includes(o.roof.type),
  clip: (o) => o.roof.type === 'halfhip',
  skirt: (o) => o.roof.type === 'irimoya',
  upturn: (o) => UPTURN_TYPES.includes(o.roof.type),
  upturnReach: (o) => UPTURN_TYPES.includes(o.roof.type) && o.roof.upturn > 0,
  ridgeCap: (o) => !['flat', 'shed'].includes(o.roof.type),
  cut: (o) => o.roof.type !== 'flat',
  cap: (o) => o.roof.type !== 'flat' && o.roof.cut > 0,
  soffit: (o) => o.roof.type !== 'flat' && o.roof.overhang >= 1,
  profile: (o) => !['flat', 'gambrel', 'mansard'].includes(o.roof.type),
};
const DET = (k) => (o) => !!(o.details && o.details[k]);
const FILL_SHAPE_OPTIONS = [['full', 'Full blocks'], ['slab', 'Slabs'], ['stair', 'Stairs'], ['pane', 'Panes / bars']];
const PILLAR_TRIM = [['none', 'None'], ['block', 'Block ring'], ['stairs', 'Stair ring'], ['slab', 'Slab ring']];
/** The texture settings a box follows: the design's shared ones, or its own. */
function texOf(o) {
  if (o && o.roof && !o.ownTexture && state.design && state.design.variation) return state.design.variation;
  return (o && o.variation) || {};
}
const VAR = (k) => (o) => texOf(o)[k] > 0;
// With Grime the mixes are layered by height: say which end is which.
const mixLabel = (surface, i) => (o) => {
  const va = texOf(o), n = va[surface + 'MixCount'] || 2;
  const base = (surface === 'wall' ? 'Wall mix ' : 'Roof mix ') + (i + 1);
  if (va.style !== 'grime' || n < 2) return base;
  return base + (i === 0 ? ' (Top)' : i === n - 1 ? ' (Bottom)' : '');
};
const STYLE_OPTIONS = [['patches', 'Patches'], ['scatter', 'Scatter'], ['grime', 'Grime (heavier low down; mix 1 highest, last mix lowest)'], ['streaks', 'Streaks (drip marks)']];
// What an Auto mix slot will use: the same pick as the engine (chosen slots first, then the
// next look-alikes in order).
const autoMix = (surface, from, i) => (o) => {
  const va = texOf(o), base = getPath(o, from);
  const keys = MIX_KEYS[surface].slice(0, va[surface + 'MixCount'] || 2);
  const v = suggestVariants(base, Math.max(2, keys.length)).filter((k) => !keys.some((key) => va[key] === k));
  let n = 0;
  for (let j = 0; j < i; j++) if (!(va[keys[j]] && FAMILIES[va[keys[j]]] && va[keys[j]] !== base)) n++;
  return v[n] || null;
};
const SCHEMA = {
  box: [
    { group: 'Footprint', fields: [
      { path: ['name'], label: 'Name', type: 'text', wide: true },
      { path: ['x'], label: 'x (west edge)', type: 'int' },
      { path: ['z'], label: 'z (north edge)', type: 'int' },
      { path: ['w'], label: 'Width (x)', type: 'int', min: 1 },
      { path: ['d'], label: 'Depth (z)', type: 'int', min: 1 },
      { path: ['baseY'], label: 'Base y', type: 'int' },
      { path: ['wallH'], label: 'Wall height', type: 'int', min: 0 },
      { path: ['stack'], label: 'Meets roofs below', type: 'select', wide: true, options: [['auto', 'Auto'], ['stack', 'Sits on top (roof below runs to my walls)'], ['merge', 'Merges into them (dormers, wings)']] },
    ] },
    { group: 'Walls', fields: [
      { path: ['walls'], label: 'Perimeter walls', type: 'check' },
      { path: ['floor'], label: 'Fill floor', type: 'check' },
      { path: ['wallMaterial'], label: 'Wall material', type: 'material', roof: false, wide: true },
    ] },
    { group: 'Roof', fields: [
      { path: ['roof', 'type'], label: 'Type', type: 'select', options: ROOF_TYPES, wide: true },
      { path: ['roof', 'axis'], label: 'Ridge axis', type: 'select', options: [['x', 'x (east–west)'], ['z', 'z (north–south)']], show: ROOF_SHOW.axis },
      { path: ['roof', 'shedLow'], label: 'Low eave side', type: 'select', options: DIR_OPTIONS, show: ROOF_SHOW.shedLow },
      { path: ['roof', 'rise'], label: 'Pitch (rise per block)', type: 'select', options: RISE_OPTIONS, numeric: true, show: ROOF_SHOW.rise, wide: true },
      { path: ['roof', 'profile'], label: 'Curve', type: 'select', options: PROFILE_OPTIONS, show: ROOF_SHOW.profile, wide: true },
      { path: ['roof', 'breakAt'], label: 'Break after (blocks of run)', type: 'int', min: 1, show: ROOF_SHOW.breakAt },
      { path: ['roof', 'rise2'], label: 'Pitch after break', type: 'select', options: RISE_OPTIONS, numeric: true, show: ROOF_SHOW.rise2 },
      { path: ['roof', 'clip'], label: 'Clip (blocks above eave)', type: 'int', min: 0, show: ROOF_SHOW.clip },
      { path: ['roof', 'clip'], key: 'roof-skirt', label: 'Hip skirt depth (blocks)', type: 'int', min: 0, show: ROOF_SHOW.skirt },
      { path: ['roof', 'upturn'], label: 'Upturned corners (blocks of lift)', type: 'int', min: 0, max: 16, show: ROOF_SHOW.upturn },
      { path: ['roof', 'upturnReach'], label: 'Corner curl length', type: 'int', min: 1, max: 64, show: ROOF_SHOW.upturnReach },
      { path: ['roof', 'cut'], label: 'Chop top (layers off the peak, 0 = off)', type: 'int', min: 0, max: 128, show: ROOF_SHOW.cut },
      { path: ['roof', 'cap'], label: 'Cap on the chopped top', type: 'select', options: [['solid', 'Solid (a flat roof)'], ['slab', 'Slabs'], ['open', 'Open (rim only)']], show: ROOF_SHOW.cap },
      { path: ['roof', 'capMat'], label: 'Cap material', type: 'material', roof: true, wide: true, auto: (o) => o.roof.material, autoHint: 'Auto uses the roof material.', show: ROOF_SHOW.cap },
      { path: ['roof', 'overhang'], label: 'Overhang', type: 'int', min: 0 },
      { path: ['roof', 'ridgeCap'], label: 'Ridge cap', type: 'select', options: [['block', 'Full block'], ['slab', 'Slab'], ['wall', 'Wall (if the family has one)']], show: ROOF_SHOW.ridgeCap },
      { path: ['roof', 'soffit'], label: 'Soffit (upside-down stairs under the eave)', type: 'check', show: ROOF_SHOW.soffit, wide: true },
      { path: ['roof', 'material'], label: 'Roof material', type: 'material', roof: true, wide: true },
    ] },
    { group: 'Details', fields: [
      { path: ['details', 'auto'], label: 'Auto details', type: 'action', wide: true, hint: 'Turns every detail on and picks matching materials.', run: (id) => autoDetails([id]) },
      { path: ['details', 'trim'], label: 'Roof edge trim', type: 'check' },
      { path: ['details', 'ridge'], label: 'Ridge in trim', type: 'check' },
      { path: ['details', 'trimMat'], label: 'Trim material', type: 'material', roof: true, wide: true, show: (o) => DET('trim')(o) || DET('ridge')(o) },
      { path: ['details', 'corners'], label: 'Corner posts', type: 'check' },
      { path: ['details', 'beams'], label: 'Eave beams', type: 'check' },
      { path: ['details', 'cornerMat'], label: 'Post material', type: 'material', wide: true, show: DET('corners') },
      { path: ['details', 'beamMat'], label: 'Beam material', type: 'material', wide: true, show: DET('beams') },
      { path: ['details', 'base'], label: 'Foundation course', type: 'check' },
      { path: ['details', 'windows'], label: 'Windows', type: 'check' },
      { path: ['details', 'baseMat'], label: 'Foundation material', type: 'material', wide: true, show: DET('base') },
      { path: ['details', 'windowMat'], label: 'Window glass', type: 'material', wide: true, show: DET('windows') },
      { path: ['details', 'door'], label: 'Doorway', type: 'check' },
      { path: ['details', 'studs'], label: 'Wall studs', type: 'check' },
    ] },
    { group: 'Windows & doors', show: (o) => DET('windows')(o) || DET('door')(o) || DET('studs')(o), fields: [
      { path: ['details', 'winStyle'], label: 'Glass', type: 'select', options: [['pane', 'Glass panes'], ['block', 'Glass blocks']], show: DET('windows') },
      { path: ['details', 'winTop'], label: 'Top', type: 'select', options: [['flat', 'Flat'], ['arch', 'Arched (3+ wide)']], show: DET('windows') },
      { path: ['details', 'winWidth'], label: 'Window width', type: 'int', min: 1, max: 16, show: DET('windows') },
      { path: ['details', 'winHeight'], label: 'Window height', type: 'int', min: 1, max: 16, show: DET('windows') },
      { path: ['details', 'winSill'], label: 'Sill height (above base)', type: 'int', min: 0, max: 16, show: DET('windows') },
      { path: ['details', 'winGap'], label: 'Gap between windows', type: 'int', min: 0, max: 16, show: DET('windows') },
      { path: ['details', 'winNorth'], label: 'North wall', type: 'check', show: DET('windows') },
      { path: ['details', 'winSouth'], label: 'South wall', type: 'check', show: DET('windows') },
      { path: ['details', 'winWest'], label: 'West wall', type: 'check', show: DET('windows') },
      { path: ['details', 'winEast'], label: 'East wall', type: 'check', show: DET('windows') },
      { path: ['details', 'frame'], label: 'Frames', type: 'check', show: (o) => DET('windows')(o) || DET('door')(o) },
      { path: ['details', 'sills'], label: 'Sills', type: 'check', show: DET('windows') },
      { path: ['details', 'frameMat'], label: 'Frame material', type: 'material', wide: true, show: (o) => DET('frame')(o) && (DET('windows')(o) || DET('door')(o)) },
      { path: ['details', 'sillMat'], label: 'Sill material', type: 'material', roof: true, wide: true, show: (o) => DET('sills')(o) && DET('windows')(o) },
      { path: ['details', 'doorSide'], label: 'Door side', type: 'select', options: DIR_OPTIONS, show: DET('door') },
      { path: ['details', 'doorWidth'], label: 'Door width', type: 'int', min: 1, max: 8, show: DET('door') },
      { path: ['details', 'doorHeight'], label: 'Door height', type: 'int', min: 1, max: 16, show: DET('door') },
      { path: ['details', 'studGap'], label: 'Stud spacing', type: 'int', min: 2, max: 16, show: DET('studs'), hint: 'Studs use the beam material.' },
    ] },
    { group: 'Texture', fields: [
      { path: ['ownTexture'], label: 'Own texture (not shared)', type: 'check', wide: true, hint: 'Texture settings are shared by every box: change them here and all boxes follow. Tick this to give this box its own.' },
      { path: ['variation', 'wall'], label: 'Wall variation', type: 'range', min: 0, max: 80, step: 5, unit: '%', wide: true },
      { path: ['variation', 'roof'], label: 'Roof variation', type: 'range', min: 0, max: 80, step: 5, unit: '%', wide: true },
      { path: ['variation', 'style'], label: 'Pattern', type: 'select', options: STYLE_OPTIONS, wide: true, show: (o) => VAR('wall')(o) || VAR('roof')(o) },
      { path: ['variation', 'wallMixCount'], label: 'Wall mix blocks', type: 'int', min: 1, max: MIX_MAX, show: VAR('wall'), hint: 'How many different blocks the walls mix in. Pick each one below, or leave it on Auto for a look-alike.' },
      ...MIX_KEYS.wall.map((k, i) => ({ path: ['variation', k], label: 'Wall mix ' + (i + 1), labelFn: mixLabel('wall', i), type: 'material', auto: autoMix('wall', ['wallMaterial'], i), wide: true,
        show: (o) => VAR('wall')(o) && i < (texOf(o).wallMixCount || 2) })),
      { path: ['variation', 'roofMixCount'], label: 'Roof mix blocks', type: 'int', min: 1, max: MIX_MAX, show: VAR('roof'), hint: 'How many different blocks the roof mixes in. Pick each one below, or leave it on Auto for a look-alike.' },
      ...MIX_KEYS.roof.map((k, i) => ({ path: ['variation', k], label: 'Roof mix ' + (i + 1), labelFn: mixLabel('roof', i), type: 'material', auto: autoMix('roof', ['roof', 'material'], i), roof: true, wide: true,
        show: (o) => VAR('roof')(o) && i < (texOf(o).roofMixCount || 2) })),
      { path: ['variation', 'reroll'], label: 'Reshuffle', type: 'action', wide: true, hint: 'Same mix, new random layout.', show: (o) => VAR('wall')(o) || VAR('roof')(o), run: (id) => rerollVariation(id) },
    ] },
  ],
  pillar: [
    { group: 'Pillar', fields: [
      { path: ['x'], label: 'x', type: 'int' },
      { path: ['z'], label: 'z', type: 'int' },
      { path: ['baseY'], label: 'Base y', type: 'int' },
      { path: ['h'], label: 'Height', type: 'int', min: 1 },
      { path: ['material'], label: 'Material', type: 'material', roof: false, wide: true },
      { path: ['size'], label: 'Thickness', type: 'int', min: 1, max: 5 },
      { path: ['shape'], label: 'Shape', type: 'select', options: [['block', 'Full blocks'], ['wall', 'Wall post (thin)']] },
      { path: ['base'], label: 'Base', type: 'select', options: PILLAR_TRIM },
      { path: ['cap'], label: 'Capital (top)', type: 'select', options: PILLAR_TRIM },
      { path: ['baseMat'], label: 'Base material', type: 'material', roof: true, wide: true, show: (o) => o.base !== 'none' },
      { path: ['capMat'], label: 'Capital material', type: 'material', roof: true, wide: true, show: (o) => o.cap !== 'none' },
    ] },
  ],
  stamp: [
    { group: 'Placed asset', fields: [
      { path: ['asset'], label: 'Asset', type: 'select', wide: true, options: () => state.design.assets.map((a) => [a.id, a.name]) },
      { path: ['facing'], label: 'Faces', type: 'select', options: DIR_OPTIONS, hint: 'The way its front points out of the wall.' },
      { path: ['x'], label: 'x', type: 'int' },
      { path: ['baseY'], label: 'y', type: 'int' },
      { path: ['z'], label: 'z', type: 'int' },
      { path: ['edit'], label: 'Edit this asset', type: 'action', wide: true, hint: 'Every copy on the building changes with it.', run: (id) => { const f = findObject(id); if (f) openStudio(f.obj.asset); } },
    ] },
  ],
  fill: [
    { group: 'Fill', fields: [
      { path: ['x'], label: 'x (west edge)', type: 'int' },
      { path: ['z'], label: 'z (north edge)', type: 'int' },
      { path: ['w'], label: 'Width (x)', type: 'int', min: 1, max: 256 },
      { path: ['d'], label: 'Depth (z)', type: 'int', min: 1, max: 256 },
      { path: ['baseY'], label: 'Base y', type: 'int' },
      { path: ['h'], label: 'Height', type: 'int', min: 1, max: 128 },
      { path: ['material'], label: 'Material', type: 'material', roof: true, wide: true },
      { path: ['outline'], label: 'Outline', type: 'select', options: [['rect', 'Rectangle'], ['circle', 'Circle / oval']] },
      { path: ['hollow'], label: 'Hollow (rim only: walls, rings, towers)', type: 'check', wide: true },
      { path: ['shape'], label: 'Shape', type: 'select', options: FILL_SHAPE_OPTIONS },
      { path: ['half'], label: 'Half', type: 'select', options: [['bottom', 'Bottom'], ['top', 'Top (upside down)']], show: (o) => o.shape === 'slab' || o.shape === 'stair' },
      { path: ['facing'], label: 'Stairs face', type: 'select', options: DIR_OPTIONS, show: (o) => o.shape === 'stair' },
      { path: ['axis'], key: 'fill-pane-axis', label: 'Runs along', type: 'select', options: [['x', 'x (east–west)'], ['z', 'z (north–south)']], show: (o) => o.shape === 'pane' },
      { path: ['axis'], key: 'fill-log-axis', label: 'Grain', type: 'select', options: [['y', 'Up'], ['x', 'East–west'], ['z', 'North–south']], show: (o) => o.shape === 'full' && !!(FAMILIES[o.material] || {}).axis },
    ] },
  ],
  segment: [
    { group: 'Wall segment', fields: [
      { path: ['x0'], label: 'From x', type: 'int' },
      { path: ['z0'], label: 'From z', type: 'int' },
      { path: ['x1'], label: 'To x', type: 'int' },
      { path: ['z1'], label: 'To z', type: 'int' },
      { path: ['baseY'], label: 'Base y', type: 'int' },
      { path: ['h'], label: 'Height', type: 'int', min: 1 },
      { path: ['material'], label: 'Material', type: 'material', roof: false, wide: true },
    ] },
  ],
};
const LOCKED_KEYS = new Set(['x', 'z', 'w', 'd', 'baseY', 'wallH', 'h', 'x0', 'z0', 'x1', 'z1', 'facing', 'r', 'radius', 'size']);
const getPath0 = (o, path) => path.reduce((a, k) => (a == null ? undefined : a[k]), o);
// A box's texture fields ('variation', ...) live in the design's shared settings unless the box
// keeps its own; getPath / setPath send them to the right place.
const getPath = (o, path) => (path[0] === 'variation' ? getPath0(texOf(o), path.slice(1)) : getPath0(o, path));
const setPath = (o, path, v) => {
  if (path[0] === 'variation') { const t = texOf(o); setPath0(t, path.slice(1), v); return; }
  // Opting out starts from the shared settings, so the look doesn't jump.
  if (path.length === 1 && path[0] === 'ownTexture' && v && !o.ownTexture && state.design.variation) o.variation = JSON.parse(JSON.stringify(state.design.variation));
  setPath0(o, path, v);
};
function setPath0(o, path, v) { let a = o; for (let i = 0; i < path.length - 1; i++) a = a[path[i]]; a[path[path.length - 1]] = v; }
const fieldId = (field) => 'prop-' + (field.key || field.path.join('-')); // key: two fields sharing one path

function renderProps(valuesOnly = false) {
  const f = findObject(state.selectedId);
  const body = $('propsBody');
  if (!f && state.selectedBlocks.length) { renderBlockProps(); return; }
  if (!f) {
    body.replaceChildren();
    body.hidden = true;
    $('propsEmpty').hidden = false;
    $('propsTitle').textContent = 'Properties';
    $('propsId').textContent = '';
    state.propsFor = null;
    return;
  }
  $('propsEmpty').hidden = true;
  body.hidden = false;
  const key = f.kind + ':' + f.obj.id;
  if (valuesOnly && state.propsFor === key) { syncPropValues(); return; }
  state.propsFor = key;
  $('propsTitle').textContent = { box: 'Box', pillar: 'Pillar', segment: 'Wall segment', fill: 'Fill', stamp: 'Placed asset' }[f.kind];
  $('propsId').textContent = f.obj.id;
  body.replaceChildren();

  for (const group of SCHEMA[f.kind]) {
    const fs = h('fieldset', { class: 'group', id: 'group-' + group.group.replace(/\W+/g, '-').toLowerCase() }, h('legend', { text: group.group }));
    const grid = h('div', { class: 'fields' });
    for (const field of group.fields) grid.append(buildField(f, field));
    fs.append(grid);
    body.append(fs);
  }
  if (f.obj.locked) {
    // Where it is and how big stay as they are; looks (materials, roof, details) still change.
    for (const group of SCHEMA[f.kind]) for (const field of group.fields) {
      if (field.path.length !== 1 || !LOCKED_KEYS.has(field.path[0])) continue;
      const el = $(fieldId(field));
      if (el) { el.disabled = true; el.title = 'Locked'; }
    }
    body.prepend(h('p', { class: 'hint', id: 'prop-locked-note', text: 'Locked in place. Unlock it with the lock in the objects list to move or resize it.' }));
  }
  if (f.kind === 'segment') {
    body.append(h('p', { class: 'hint', id: 'prop-segment-note', hidden: true, text: 'Not axis-aligned: the engine builds x0…x1 along z0.' }));
  }
  body.append(h('div', { class: 'props-actions' },
    h('button', { class: 'btn small', id: 'prop-lock', type: 'button', text: f.obj.locked ? 'Unlock' : 'Lock', title: 'Lock in place', onclick: () => toggleLock(f.obj.id) }),
    f.kind === 'pillar' || f.obj.locked ? null : h('button', { class: 'btn small', id: 'prop-rotate', type: 'button', text: 'Rotate 90°', title: 'Rotate clockwise (R, Shift+R for counter-clockwise). Or drag the round handle in the 3D view.', onclick: () => rotateSelected(1) }),
    h('button', { class: 'btn danger small', id: 'prop-delete', type: 'button', text: 'Delete', disabled: !!f.obj.locked, onclick: () => requestDelete(f.obj.id) })));
  body.append(clonePanel(() => cloneObject(f.obj.id)));
  syncPropValues();
}

// ------------------------------------------------------------------ clone
// Copies of the selected object or placed blocks: n copies in a direction, gap blocks apart.
const CLONE_DIRS = { east: [1, 0, 0], west: [-1, 0, 0], south: [0, 0, 1], north: [0, 0, -1], up: [0, 1, 0], down: [0, -1, 0] };
function clonePanel(run) {
  const c = state.clone;
  const num = (key, label, min, max) => {
    const input = h('input', { type: 'number', id: 'clone-' + key, min, max, step: 1, value: String(c[key]) });
    input.addEventListener('input', () => { const v = Math.round(Number(input.value)); if (Number.isFinite(v)) c[key] = Math.max(min, Math.min(max, v)); });
    return h('div', { class: 'field' }, h('label', { for: input.id, text: label }), input);
  };
  const dir = h('select', { id: 'clone-dir' }, Object.keys(CLONE_DIRS).map((d) => h('option', { value: d, text: d[0].toUpperCase() + d.slice(1) })));
  dir.value = c.dir;
  dir.addEventListener('change', () => { c.dir = dir.value; });
  return h('fieldset', { class: 'group' }, h('legend', { text: 'Clone' }),
    h('div', { class: 'fields' },
      num('n', 'Copies', 1, 64),
      h('div', { class: 'field' }, h('label', { for: 'clone-dir', text: 'Direction' }), dir),
      num('gap', 'Gap (blocks)', 0, 64),
      h('div', { class: 'field action' }, h('button', { class: 'btn small', type: 'button', id: 'clone-run', text: 'Clone', title: 'Make the copies (Ctrl+D makes one)', onclick: run }))));
}
/** Extent of an object along x / y / z, so copies line up side by side. */
function objectSize(kind, o) {
  if (kind === 'box') return [o.w, o.wallH, o.d];
  if (kind === 'pillar') return [o.size || 1, o.h, o.size || 1];
  if (kind === 'fill') return [o.w, o.h, o.d];
  if (kind === 'stamp') { const a = assetById(o.asset); const c = a ? stampCells(a, o) : []; if (!c.length) return [1, 1, 1]; const ext = (k) => Math.max(...c.map((v) => v[k])) - Math.min(...c.map((v) => v[k])) + 1; return [ext('x'), ext('y'), ext('z')]; }
  return [Math.abs(o.x1 - o.x0) + 1, o.h, Math.abs(o.z1 - o.z0) + 1];
}
function cloneObject(id, n = state.clone.n, dirName = state.clone.dir, gap = state.clone.gap) {
  const f = findObject(id);
  if (!f) return;
  const d = state.design;
  const dir = CLONE_DIRS[dirName];
  const size = objectSize(f.kind, f.obj);
  const step = dir.map((v, i) => v * (size[i] + gap));
  beginChange(null);
  const made = [];
  for (let k = 1; k <= n; k++) {
    const c = JSON.parse(JSON.stringify(f.obj));
    c.id = newId(d, { box: 'b', pillar: 'p', segment: 's', fill: 'f', stamp: 't' }[f.kind], new Set(made));
    if (f.kind === 'box') c.name = 'Box ' + c.id.replace(/^b/, '');
    if (f.kind === 'box' && step[1] > 0 && c.details) c.details.door = false; // upper floors: no doorway into thin air
    if (f.kind === 'segment') { c.x0 += step[0] * k; c.x1 += step[0] * k; c.z0 += step[2] * k; c.z1 += step[2] * k; }
    else { c.x += step[0] * k; c.z += step[2] * k; }
    c.baseY += step[1] * k;
    f.list.push(c);
    made.push(c.id);
  }
  afterChange();
  toast('Made ' + n + (n === 1 ? ' copy' : ' copies'), false, { label: 'Undo', run: undo });
}
function cloneBlocks(n = state.clone.n, dirName = state.clone.dir, gap = state.clone.gap) {
  const cells = state.selectedBlocks;
  const exs = cells.map(placedEdit);
  if (!cells.length || exs.some((ex) => !ex)) return;
  const dir = CLONE_DIRS[dirName];
  const span = [0, 1, 2].map((i) => Math.max(...cells.map((c) => c[i])) - Math.min(...cells.map((c) => c[i])) + 1);
  const step = dir.map((v, i) => v * (span[i] + gap));
  const sel = [];
  beginChange(null);
  for (let k = 1; k <= n; k++) {
    cells.forEach((c, j) => {
      const t = [c[0] + step[0] * k, c[1] + step[1] * k, c[2] + step[2] * k];
      if (t[1] < -64 || t[1] > 319) return;
      removeEditAt(...t);
      exs[j].list.push({ ...exs[j].edit, x: exs[j].edit.x + t[0] - c[0], y: exs[j].edit.y + t[1] - c[1], z: exs[j].edit.z + t[2] - c[2] });
      sel.push(t);
    });
  }
  afterChange();
  // The copies become the selection, so Ctrl+D again keeps extending the run.
  state.selectedBlocks = sel.slice(-cells.length);
  if (viewer) viewer.setSelectedBlocks(state.selectedBlocks);
  renderBlockProps();
  toast('Copied ' + cells.length + (cells.length === 1 ? ' block ' : ' blocks ') + n + '×', false, { label: 'Undo', run: undo });
}

function buildField(f, field) {
  const id = fieldId(field);
  const wrap = h('div', { class: 'field' + (field.wide ? ' wide' : '') + (field.type === 'check' ? ' check' : '') + (field.type === 'action' ? ' action' : ''), id: id + '-field' });
  const label = h('label', { for: id, text: field.labelFn ? field.labelFn(f.obj) : field.label });
  let input;
  const changeKey = 'prop:' + f.obj.id + ':' + field.path.join('.');
  const commit = (value) => {
    const cur = findObject(f.obj.id);
    if (!cur) return;
    if (getPath(cur.obj, field.path) === value) return;
    beginChange(changeKey);
    setPath(cur.obj, field.path, value);
    afterChange();
    syncPropValues();
  };
  switch (field.type) {
    case 'text':
      input = h('input', { type: 'text', id, autocomplete: 'off', spellcheck: 'false' });
      input.addEventListener('input', () => commit(input.value));
      break;
    case 'int':
      input = h('input', { type: 'number', id, step: 1, inputmode: 'numeric' });
      if (field.min != null) input.min = field.min;
      if (field.max != null) input.max = field.max;
      input.addEventListener('input', () => {
        if (input.value === '' || input.value === '-') return;
        let v = Math.round(Number(input.value));
        if (!Number.isFinite(v)) return;
        if (field.min != null) v = Math.max(field.min, v);
        if (field.max != null) v = Math.min(field.max, v);
        commit(v);
      });
      input.addEventListener('blur', () => syncPropValues());
      break;
    case 'range': {
      input = h('input', { type: 'range', id, min: field.min, max: field.max, step: field.step || 1 });
      const out = h('output', { for: id, class: 'range-out', id: id + '-out' });
      input.addEventListener('input', () => { out.textContent = input.value + (field.unit || ''); commit(Number(input.value)); });
      wrap.classList.add('range');
      wrap.append(h('div', { class: 'range-label' }, label, out), input);
      return wrap;
    }
    case 'select':
      input = h('select', { id }, (typeof field.options === 'function' ? field.options(f.obj) : field.options).map(([v, l]) => h('option', { value: String(v), text: l })));
      input.addEventListener('change', () => commit(field.numeric ? Number(input.value) : input.value));
      break;
    case 'action':
      input = h('button', { class: 'btn small', id, type: 'button', text: field.label, title: field.hint || '' });
      input.addEventListener('click', () => field.run(f.obj.id));
      wrap.append(input);
      if (field.hint) wrap.append(h('span', { class: 'hint', text: field.hint }));
      return wrap;
    case 'check':
      input = h('input', { type: 'checkbox', id });
      input.addEventListener('change', () => commit(input.checked));
      wrap.append(input, label);
      return wrap;
    case 'material': {
      input = h('button', { class: 'matbtn', id, type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
        h('img', { alt: '', width: 28, height: 28 }), h('span', { class: 'mat-name' }), h('span', { class: 'caret', text: '▼' }));
      input.addEventListener('click', () => {
        const cur = findObject(f.obj.id);
        if (!cur) return;
        openPicker(input, {
          title: field.label,
          keys: fullFamilies(),
          hint: field.autoHint || (field.auto ? 'Auto picks a look-alike of the main material.' : field.roof ? ROOF_HINT : null),
          current: getPath(cur.obj, field.path),
          auto: field.auto ? { key: field.auto(cur.obj) } : null,
          onPick: (k) => commit(k),
        });
      });
      break;
    }
  }
  wrap.append(label, input);
  return wrap;
}

function syncPropValues() {
  const f = findObject(state.selectedId);
  if (!f || !state.propsFor || $('propsBody').hidden) return;
  const active = document.activeElement;
  for (const group of SCHEMA[f.kind]) {
    if (group.show) { const g = $('group-' + group.group.replace(/\W+/g, '-').toLowerCase()); if (g) g.hidden = !group.show(f.obj); }
    for (const field of group.fields) {
      const id = fieldId(field);
      const el = $(id);
      const wrap = $(id + '-field');
      if (!el || !wrap) continue;
      wrap.hidden = field.show ? !field.show(f.obj) : false;
      if (field.labelFn) { const lb = wrap.querySelector('label'); const t = field.labelFn(f.obj); if (lb && lb.textContent !== t) lb.textContent = t; }
      if (field.type === 'action') continue;
      const v = getPath(f.obj, field.path);
      if (field.type === 'material') {
        const img = el.querySelector('img');
        const span = el.querySelector('.mat-name');
        const auto = !v && field.auto ? field.auto(f.obj) : null;
        const shown = v || auto;
        if (img.dataset.key !== String(shown)) { if (shown) img.src = iconURL(shown, 28); else img.removeAttribute('src'); img.dataset.key = String(shown); }
        span.textContent = v ? famName(v) : field.auto ? 'Auto' + (auto ? ' (' + famName(auto) + ')' : ' (no match, pick one)') : famName(v);
        el.title = 'Change ' + field.label.toLowerCase() + ' (' + span.textContent + ')';
      } else if (field.type === 'range') {
        if (el !== active) el.value = String(v ?? 0);
        const out = $(id + '-out');
        if (out) out.textContent = (v ?? 0) + (field.unit || '');
      } else if (field.type === 'check') {
        el.checked = !!v;
      } else if (el !== active) {
        el.value = v == null ? '' : String(v);
      }
    }
  }
  if (f.kind === 'segment') {
    const note = $('prop-segment-note');
    if (note) note.hidden = f.obj.x0 === f.obj.x1 || f.obj.z0 === f.obj.z1;
  }
}

// ------------------------------------------------------------------ add / delete / nudge
function addBox() {
  const d = state.design;
  const id = newId(d, 'b');
  let x = 0, z = 0;
  if (state.grid && d.boxes.length) { x = state.grid.max.x + 2; z = Math.min(...d.boxes.map((b) => b.z)); }
  const box = {
    id, name: 'Box ' + id.replace(/^b/, ''), x, z, w: 5, d: 5, baseY: 0, wallH: 3, walls: true, floor: false,
    wallMaterial: pickFamily(['oak_planks', 'oak', 'spruce_planks', 'spruce'], false),
    roof: {
      type: 'gable', axis: 'x', shedLow: 'south', rise: 1, rise2: 0.5, breakAt: 3, clip: 2, overhang: 1,
      ridgeCap: 'block', soffit: false, material: pickFamily(['spruce', 'spruce_planks', 'dark_oak', 'dark_oak_planks'], true),
    },
  };
  beginChange(null);
  d.boxes.push(box);
  afterChange();
  select(id);
  toast('Added ' + box.name);
}
function addPillar() {
  const d = state.design;
  const id = newId(d, 'p');
  let x = 0, z = 0;
  if (state.grid && (d.boxes.length || d.pillars.length)) { x = state.grid.min.x - 1; z = state.grid.min.z - 1; }
  beginChange(null);
  d.pillars.push({ id, x, z, baseY: 0, h: 4, material: pickFamily(['oak_log', 'spruce_log', 'stripped_oak_log'], false) });
  afterChange();
  select(id);
  toast('Added pillar ' + id);
}
function addSegment() {
  const d = state.design;
  const id = newId(d, 's');
  let x0 = 0, z0 = 0;
  if (state.grid && (d.boxes.length || d.segments.length)) { x0 = state.grid.min.x; z0 = state.grid.max.z + 2; }
  beginChange(null);
  d.segments.push({ id, x0, z0, x1: x0 + 4, z1: z0, baseY: 0, h: 2, material: pickFamily(['cobblestone', 'stone_bricks', 'stone'], false) });
  afterChange();
  select(id);
  toast('Added wall segment ' + id);
}
// ------------------------------------------------------------------ selected hand-placed blocks
const cellKey = (c) => c.join(',');
/** The place edit behind a world cell, if the block there was hand-placed. */
function placedEdit(cell) {
  const ex = findEdit(...cell);
  return ex && ex.edit.shape !== 'erase' && ex.edit.shape !== 'paint' ? ex : null;
}
function selectBlock(cell, { add = false } = {}) {
  if (!placedEdit(cell)) return;
  let list = add ? state.selectedBlocks.slice() : [];
  const i = list.findIndex((c) => cellKey(c) === cellKey(cell));
  if (i >= 0) list.splice(i, 1); else list.push(cell);
  state.selectedBlocks = list;
  if (viewer) viewer.setSelectedBlocks(list);
  select(null, { keepBlocks: true });
}
/** Drop selections whose block is gone (undo, erase, its box moved) and refresh outlines. */
function syncBlockSelection() {
  if (!state.selectedBlocks.length) return;
  const kept = state.selectedBlocks.filter((c) => placedEdit(c));
  const changed = kept.length !== state.selectedBlocks.length;
  state.selectedBlocks = kept;
  if (viewer) viewer.setSelectedBlocks(kept);
  if (changed && !state.selectedId) renderProps();
}
// Read from the edit itself, not the grid: right after a move the grid is not rebuilt yet.
function blockLabel(cell) {
  const ex = placedEdit(cell);
  if (!ex) return '?';
  const e = ex.edit;
  const shape = { slab: 'slab', stair: 'stairs', pane: 'pane', door: 'door', trapdoor: 'trapdoor' }[e.shape] || ''; // full blocks: the name alone
  if (e.shape === 'door' || e.shape === 'trapdoor') return (famName(e.mat).replace(/ planks$|^Block of /, '') + ' ' + shape + (e.open ? ' (open)' : '')).trim();
  return (famName(ex.edit.mat) + ' ' + shape).trim();
}
function renderBlockProps() {
  const body = $('propsBody');
  const cells = state.selectedBlocks;
  state.propsFor = 'blocks:' + cells.map(cellKey).join('|');
  $('propsEmpty').hidden = true;
  body.hidden = false;
  $('propsTitle').textContent = cells.length === 1 ? 'Placed block' : cells.length + ' placed blocks';
  $('propsId').textContent = '';
  const rows = cells.slice(0, 12).map((c) => h('li', {},
    iconEl((placedEdit(c) || { edit: {} }).edit.mat, 20), h('span', { text: blockLabel(c) }), h('span', { class: 'n mono', text: c.join(', ') })));
  const anyStair = cells.some((c) => { const ex = placedEdit(c); return ex && ['stair', 'pane', 'door', 'trapdoor'].includes(ex.edit.shape); });
  const doors = cells.map(placedEdit).filter((ex) => ex && (ex.edit.shape === 'door' || ex.edit.shape === 'trapdoor'));
  body.replaceChildren(
    h('ul', { class: 'legend block-list' }, rows, cells.length > 12 ? h('li', { class: 'empty', text: '+ ' + (cells.length - 12) + ' more' }) : null),
    h('p', { class: 'hint', text: 'Drag to move, or use the arrow keys (Shift = 5) and Page Up / Page Down. Shift+click adds more blocks, Alt+drag selects a rectangle. Delete removes them' + (anyStair ? ', R turns stairs.' : '.') }),
    h('div', { class: 'props-actions' },
      h('button', { class: 'btn small', type: 'button', id: 'block-up', text: 'Up ↑', title: 'Raise one block (Page Up)', onclick: () => nudgeBlocks(0, 1, 0) }),
      h('button', { class: 'btn small', type: 'button', id: 'block-down', text: 'Down ↓', title: 'Lower one block (Page Down)', onclick: () => nudgeBlocks(0, -1, 0) }),
      fillable(cells) ? h('button', { class: 'btn small', type: 'button', id: 'block-fill', text: 'Make fill', title: 'Turn these blocks into one fill you can move and resize like a box', onclick: () => blocksToFill() }) : null,
      anyStair ? h('button', { class: 'btn small', type: 'button', id: 'block-rotate', text: 'Turn', title: 'Turn stairs, panes and doors (R)', onclick: () => rotateSelectedBlocks() }) : null,
      doors.length ? h('button', { class: 'btn small', type: 'button', id: 'block-open', text: doors[0].edit.open ? 'Close' : 'Open', title: 'Open or close doors and trapdoors', onclick: () => doorToggle('open') }) : null,
      doors.some((ex) => ex.edit.shape === 'door') ? h('button', { class: 'btn small', type: 'button', id: 'block-hinge', text: 'Flip hinge', title: 'Hinge the door on its other side', onclick: () => doorToggle('hinge') }) : null,
      doors.some((ex) => ex.edit.shape === 'trapdoor') ? h('button', { class: 'btn small', type: 'button', id: 'block-tdhalf', text: 'Top / bottom', title: 'Put the trapdoor in the top or bottom of its block', onclick: () => doorToggle('half') }) : null,
      h('button', { class: 'btn danger small', type: 'button', id: 'block-delete', text: cells.length === 1 ? 'Delete' : 'Delete ' + cells.length, onclick: () => deleteSelectedBlocks() })),
    clonePanel(() => cloneBlocks()));
}
/** The fill these selected blocks would make: a solid rectangle of identical blocks, or null. */
function fillable(cells) {
  if (cells.length < 2) return null;
  const exs = cells.map(placedEdit);
  if (exs.some((ex) => !ex)) return null;
  const sig = (e) => [e.shape, e.mat, e.half || '', e.facing || '', e.shape === 'full' ? e.axis || 'y' : e.axis || ''].join('|');
  const s0 = sig(exs[0].edit);
  if (exs.some((ex) => sig(ex.edit) !== s0)) return null;
  const lo = [0, 1, 2].map((i) => Math.min(...cells.map((c) => c[i]))), hi = [0, 1, 2].map((i) => Math.max(...cells.map((c) => c[i])));
  const [w, hh, d] = [0, 1, 2].map((i) => hi[i] - lo[i] + 1);
  if (w * hh * d !== new Set(cells.map(cellKey)).size || w > 256 || d > 256 || hh > 128) return null;
  const e = exs[0].edit;
  return { x: lo[0], baseY: lo[1], z: lo[2], w, d, h: hh, material: e.mat, shape: e.shape, half: e.half || 'bottom', facing: e.facing || 'north', axis: e.axis || (e.shape === 'pane' ? 'x' : 'y') };
}
function blocksToFill() {
  const cells = state.selectedBlocks;
  const spec = fillable(cells);
  if (!spec) return;
  beginChange(null);
  for (const c of cells) { const ex = placedEdit(c); if (ex) ex.list.splice(ex.index, 1); }
  const id = newId(state.design, 'f');
  state.design.fills.push({ id, ...spec });
  state.selectedBlocks = [];
  if (viewer) viewer.setSelectedBlocks([]);
  afterChange();
  select(id);
  toast('Made fill ' + id + ' from ' + cells.length + ' blocks', false, { label: 'Undo', run: undo });
}
function deleteSelectedBlocks() {
  const cells = state.selectedBlocks.filter((c) => placedEdit(c));
  if (!cells.length) return;
  beginChange(null);
  for (const c of cells) { const ex = placedEdit(c); if (ex) ex.list.splice(ex.index, 1); }
  state.selectedBlocks = [];
  if (viewer) viewer.setSelectedBlocks([]);
  afterChange();
  renderProps();
  updateToolbar();
  toast(cells.length === 1 ? 'Deleted placed block' : 'Deleted ' + cells.length + ' placed blocks', false, { label: 'Undo', run: undo });
}
/**
 * Move the selected placed blocks by (dx, dy, dz). Refused (returns false) if a block would
 * land on another hand-placed block, which would otherwise be overwritten, or leave the world.
 */
function shiftBlocks(dx, dy, dz, dryRun = false) {
  const cells = state.selectedBlocks;
  const exs = cells.map(placedEdit);
  if (!cells.length || exs.some((ex) => !ex)) return false;
  const sel = new Set(cells.map(cellKey));
  const moved = cells.map(([x, y, z]) => [x + dx, y + dy, z + dz]);
  for (const t of moved) {
    if (t[1] < -64 || t[1] > 319) return false;
    if (!sel.has(cellKey(t)) && findEdit(...t)) return false;
  }
  if (dryRun) return true;
  for (const ex of exs) { ex.edit.x += dx; ex.edit.y += dy; ex.edit.z += dz; }
  state.selectedBlocks = moved;
  return true;
}
function nudgeBlocks(dx, dy, dz) {
  if (!state.selectedBlocks.length) return;
  if (!shiftBlocks(dx, dy, dz, true)) { toast('Something is already placed there', true); return; }
  beginChange('nudge-blocks');
  shiftBlocks(dx, dy, dz);
  afterChange();
  if (viewer) viewer.setSelectedBlocks(state.selectedBlocks);
  renderBlockProps();
}
// Drag: the viewer reports the total offset since the press; apply the change since last time.
let blockDrag = null;
function dragBlocks(dx, dz) {
  if (!blockDrag) { beginChange(null); blockDrag = { dx: 0, dz: 0 }; state.dragging = true; }
  if (!shiftBlocks(dx - blockDrag.dx, 0, dz - blockDrag.dz)) return;
  blockDrag.dx = dx; blockDrag.dz = dz;
  persist();
  scheduleRebuild(false);
  if (viewer) viewer.setSelectedBlocks(state.selectedBlocks);
}
function endBlockDrag() {
  blockDrag = null;
  state.dragging = false;
  afterChange();
  renderBlockProps();
}
function rotateSelectedBlocks() {
  const turn = { north: 'east', east: 'south', south: 'west', west: 'north' };
  const stairs = state.selectedBlocks.map(placedEdit).filter((ex) => ex && ['stair', 'pane', 'door', 'trapdoor'].includes(ex.edit.shape));
  if (!stairs.length) return;
  beginChange('turn-blocks');
  for (const ex of stairs) {
    if (ex.edit.shape === 'pane') ex.edit.axis = ex.edit.axis === 'x' ? 'z' : 'x';
    else ex.edit.facing = turn[ex.edit.facing] || 'north';
  }
  afterChange();
}

/** Open / close, flip the hinge, or move a trapdoor to the other half, on the selected doors. */
function doorToggle(what) {
  const doors = state.selectedBlocks.map(placedEdit).filter((ex) => ex && (ex.edit.shape === 'door' || ex.edit.shape === 'trapdoor'));
  if (!doors.length) return;
  beginChange(null);
  const open = !doors[0].edit.open;
  for (const { edit: e } of doors) {
    if (what === 'open') { if (open) e.open = true; else delete e.open; }
    else if (what === 'hinge' && e.shape === 'door') e.hinge = e.hinge === 'right' ? 'left' : 'right';
    else if (what === 'half' && e.shape === 'trapdoor') e.half = e.half === 'top' ? 'bottom' : 'top';
  }
  afterChange();
  renderBlockProps();
}

const LOCK_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const UNLOCK_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 7V5a3 3 0 0 1 5.8-1" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
/** Lock or unlock an object: locked ones stay put (no dragging, nudging, turning or deleting). */
function toggleLock(id) {
  const f = findObject(id);
  if (!f) return;
  beginChange(null);
  if (f.obj.locked) delete f.obj.locked; else f.obj.locked = true;
  afterChange();
  renderObjectList();
  if (state.selectedId === id) renderProps();
  if (viewer) viewer.refreshSelection();
  toast((f.obj.locked ? 'Locked ' : 'Unlocked ') + objectLabel(f));
}
/** True (and says so) when the object is locked. */
function isLocked(f) {
  if (!f || !f.obj.locked) return false;
  toast(objectLabel(f) + ' is locked: unlock it in the objects list first', true);
  return true;
}
function requestDelete(id) {
  if (isLocked(findObject(id))) return;
  deleteObject(id);
}
function deleteObject(id) {
  const f = findObject(id);
  if (!f) return;
  beginChange(null);
  f.list.splice(f.index, 1);
  if (state.selectedId === id) state.selectedId = null;
  afterChange();
  if (viewer) viewer.setSelection(null);
  renderProps();
  toast('Deleted ' + objectLabel(f), false, { label: 'Undo', run: undo });
}
// ------------------------------------------------------------------ tools: paint / place / erase
const TOOL_HINTS = {
  paint: 'Click a wall or roof to repaint it · One block repaints just that block · Shift+drag paints a stroke · Alt+click picks up a material · drag or right-drag to orbit, middle-drag to pan',
  place: 'Click a block face (or the ground) to place · Stairs face the way you look · Shift+drag places a row · Alt+click picks up a material · drag or right-drag to orbit, middle-drag to pan',
  erase: 'Click a block to remove it · Shift+drag erases a stroke · drag or right-drag to orbit, middle-drag to pan',
  stamp: 'Point at a wall: the asset turns to face out of it · click to place · Esc to stop · Assets… to make or edit one',
};
const AREA_HINTS = {
  paint: 'Drag a rectangle to repaint every block on that layer · click for one block · right-drag to orbit',
  place: 'Drag a rectangle (Shift = square) to make a fill (one object you can move and resize later); Ctrl+drag draws it out from the centre, and it snaps to the centres and corners of objects · click for one block · Alt+drag selects · right-drag to orbit',
  erase: 'Drag a rectangle to clear every block on that layer · click for one block · right-drag to orbit',
};
const AREA_MAX = 128 * 128;
const FILL_MAX = 256 * 256 * 8;
const noArea = () => state.tool === 'stamp' || state.tool === 'turn';
const toolOpts = () => ({ shape: state.shape, area: !noArea() && state.area, circle: !noArea() && state.area && state.circle });
/** on: false (one block), true / 'area' (rectangle) or 'circle'. */
function setArea(on) {
  state.area = !!on && on !== 'one';
  state.circle = on === 'circle';
  try { localStorage.setItem('rafter.area', state.circle ? 'circle' : state.area ? '1' : ''); } catch (e) { /* ignore */ }
  if (viewer) viewer.setTool(state.tool, toolOpts());
  updateToolbar();
}
/**
 * Fill / clear / repaint every cell of a rectangle on one layer as one undo step.
 * info is the block the drag started on (stair facing, half, owner box).
 */
function areaAction(r, info) {
  const g = state.grid;
  if (!g || state.tool === 'select') return;
  const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1), z0 = Math.min(r.z0, r.z1), z1 = Math.max(r.z0, r.z1);
  const y0 = Math.max(-64, Math.min(r.y0, r.y1)), y1 = Math.min(319, Math.max(r.y0, r.y1));
  const vol = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
  if (state.tool === 'place') {
    if (x1 - x0 >= 256 || z1 - z0 >= 256 || y1 - y0 >= 128 || vol > FILL_MAX) { toast('That fill is too big (256 × 256 max)', true); return; }
    placeFill({ x0, y0, z0, x1, y1, z1 }, info || {});
    return;
  }
  if (vol > AREA_MAX) { toast('That area is too big (128 × 128 max)', true); return; }
  const brush = state.brush;
  const runs = [];
  const round = state.area && state.circle;
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      if (round && !inOutline('circle', x0, z0, x1 - x0 + 1, z1 - z0 + 1, x, z)) continue;
      const at = g.blocks.get(blockKey(x, y, z));
      if (state.tool === 'erase') {
        if (!at) continue;
        const ex = findEdit(x, y, z);
        if (ex && ex.edit.shape !== 'erase' && ex.edit.shape !== 'paint') runs.push(() => { const e2 = findEdit(x, y, z); if (e2) e2.list.splice(e2.index, 1); });
        else runs.push(() => putEdit({ x, y, z, shape: 'erase' }, ownerBox(at.src)));
      } else if (state.tool === 'paint') {
        if (!at || at.mat === brush) continue;
        const ex = findEdit(x, y, z);
        if (ex && ex.edit.shape !== 'erase' && ex.edit.shape !== 'paint') runs.push(() => { ex.edit.mat = brush; });
        else runs.push(() => putEdit({ x, y, z, shape: 'paint', mat: brush }, ownerBox(at.src)));
      }
    }
  }
  if (!runs.length) return;
  beginChange(null);
  for (const run of runs) run();
  afterChange();
  syncPropValues();
  updateToolbar();
  const verb = { erase: 'Erased', paint: 'Repainted' }[state.tool];
  toast(verb + ' ' + fmt(runs.length) + ' block' + (runs.length === 1 ? '' : 's'), false, { label: 'Undo', run: undo });
}
/**
 * An Area-mode place drag becomes one fill object (a solid rectangle of the brush block) that
 * can be selected, moved, resized and repainted like a box, instead of hundreds of loose blocks.
 */
function placeFill(r, info) {
  if (state.shape === 'door' || state.shape === 'trapdoor') { toast('Doors and trapdoors go one at a time: click instead of dragging', true); return; }
  const g = state.grid;
  const round = state.area && state.circle;
  let empty = 0;
  for (let y = r.y0; y <= r.y1; y++) for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) {
    if (round && !inOutline('circle', r.x0, r.z0, r.x1 - r.x0 + 1, r.z1 - r.z0 + 1, x, z)) continue;
    if (!g.blocks.has(blockKey(x, y, z))) empty++;
  }
  if (!empty) { toast('That area is already full', true); return; }
  const d = state.design;
  const fill = {
    id: newId(d, 'f'), x: r.x0, z: r.z0, w: r.x1 - r.x0 + 1, d: r.z1 - r.z0 + 1, baseY: r.y0, h: r.y1 - r.y0 + 1,
    material: state.brush, shape: state.shape, half: info.half || 'bottom',
    facing: !info.fromPlan && info.facing ? info.facing : state.planFacing,
    axis: state.shape === 'pane' ? paneAxis(info) : 'y',
    outline: round ? 'circle' : 'rect', hollow: false,
  };
  beginChange(null);
  d.fills.push(fill);
  afterChange();
  updateToolbar();
  toast(`Made fill ${fill.id} (${fill.w}×${fill.d}${fill.h > 1 ? '×' + fill.h : ''})`, false, { label: 'Adjust', run: () => { setTool('select'); select(fill.id); } });
}
/** Alt+drag in the 3D view: select the hand-placed blocks inside the rectangle. */
function selectBlocks(cells, { add = false } = {}) {
  cells = cells.filter((c) => placedEdit(c));
  if (state.tool !== 'select') setTool('select');
  const list = add ? state.selectedBlocks.slice() : [];
  const have = new Set(list.map(cellKey));
  for (const c of cells) if (!have.has(cellKey(c))) { list.push(c); have.add(cellKey(c)); }
  state.selectedBlocks = list;
  if (viewer) viewer.setSelectedBlocks(list);
  select(null, { keepBlocks: true });
  if (!list.length) toast('No placed blocks in that rectangle');
}
const STAIR_ARROWS = { north: '↑', east: '→', south: '↓', west: '←' };
function setTool(tool) {
  if (tool === 'stamp' && !assetById(state.stampAsset)) {
    // Nothing to place yet: pick (or make) one in the Asset Studio.
    if (state.design.assets.length) state.stampAsset = state.design.assets[0].id;
    else { openStudio(); return; }
  }
  state.tool = tool;
  renderAssetsPane();
  if (viewer && tool !== 'stamp') viewer.setGhost(null);
  if (tool !== 'select' && state.selectedBlocks.length) select(null);
  if (viewer) viewer.setTool(tool, toolOpts());
  updateToolbar();
  $('planCanvas').classList.toggle('tool', tool !== 'select');
  renderPlan();
}
function setBrush(key) {
  if (!FAMILIES[key]) return;
  state.brush = key;
  try { localStorage.setItem('rafter.brush', key); } catch (e) { /* ignore */ }
  updateToolbar();
}
function countEdits() {
  const d = state.design;
  return d.edits.length + d.boxes.reduce((n, b) => n + (b.edits ? b.edits.length : 0), 0);
}
function updateToolbar() {
  for (const b of $('toolSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.tool === state.tool));
  for (const b of $('scopeSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.scope === state.paintScope));
  for (const b of $('shapeSeg').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.shape === state.shape));
    if (b.dataset.shape === 'stair') b.textContent = state.shape === 'stair' ? 'Stairs ' + STAIR_ARROWS[state.planFacing] : 'Stairs';
  }
  const t = state.tool;
  $('brushBtn').hidden = t !== 'paint' && t !== 'place';
  $('scopeSeg').hidden = t !== 'paint';
  $('areaSeg').hidden = t === 'select' || t === 'stamp' || t === 'turn';
  $('stampPick').hidden = t !== 'stamp';
  if (t === 'stamp') renderStampPick();
  for (const b of $('areaSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.area === (!state.area ? 'one' : state.circle ? 'circle' : 'area')));
  $('shapeSeg').hidden = t !== 'place';
  const n = state.design ? countEdits() : 0;
  $('btnClearEdits').hidden = n === 0;
  $('btnClearEdits').textContent = 'Clear edits (' + fmt(n) + ')';
  const img = $('brushBtn').querySelector('img');
  if (img.dataset.key !== state.brush) { img.src = iconURL(state.brush, 28); img.dataset.key = state.brush; }
  $('brushBtn').querySelector('.mat-name').textContent = famName(state.brush);
  $('brushBtn').title = 'Brush material: ' + famName(state.brush);
  $('toolHint').hidden = t === 'select';
  $('toolHint').textContent = ((state.area && t !== 'stamp' ? AREA_HINTS[t] : TOOL_HINTS[t]) || '').replace(/rectangle \(Shift = square\)|rectangle/, (m) => (state.area && state.circle ? 'circle' + (m.length > 9 ? ' (Shift = round)' : '') : m));
}
/** Every edit list with the cell offset that turns its coordinates into world cells. */
function editLists() {
  const d = state.design;
  return [{ list: d.edits, ox: 0, oy: 0, oz: 0, box: null }, ...d.boxes.map((b) => ({ list: b.edits, ox: b.x, oy: b.baseY, oz: b.z, box: b }))];
}
function findEdit(x, y, z) {
  for (const L of editLists()) {
    const i = L.list.findIndex((e) => e.x + L.ox === x && e.y + L.oy === y && e.z + L.oz === z);
    if (i >= 0) return { ...L, index: i, edit: L.list[i] };
  }
  // The top half of a door belongs to the edit in the cell below.
  for (const L of editLists()) {
    const i = L.list.findIndex((e) => e.shape === 'door' && e.x + L.ox === x && e.y + L.oy === y - 1 && e.z + L.oz === z);
    if (i >= 0) return { ...L, index: i, edit: L.list[i] };
  }
  return null;
}
function removeEditAt(x, y, z) {
  for (const L of editLists()) {
    const i = L.list.findIndex((e) => e.x + L.ox === x && e.y + L.oy === y && e.z + L.oz === z);
    if (i >= 0) L.list.splice(i, 1);
  }
}
/** Store a world-cell edit, relative to `box` when given so it moves with that box. */
function putEdit(edit, box) {
  removeEditAt(edit.x, edit.y, edit.z);
  if (box) {
    if (!Array.isArray(box.edits)) box.edits = [];
    box.edits.push({ ...edit, x: edit.x - box.x, y: edit.y - box.baseY, z: edit.z - box.z });
  } else state.design.edits.push(edit);
}
function ownerBox(srcId) {
  const f = srcId ? findObject(srcId) : null;
  return f && f.kind === 'box' ? f.obj : null;
}
const PART_NAMES = { wallMaterial: 'walls', 'roof.material': 'roof', 'details.trimMat': 'trim', 'details.cornerMat': 'corner posts', 'details.beamMat': 'beams', 'details.baseMat': 'foundation', 'details.windowMat': 'windows', 'details.frameMat': 'frames', 'details.sillMat': 'sills', 'roof.capMat': 'roof cap', baseMat: 'base', capMat: 'capital', material: '' };
function blockAction(info, mods = {}) {
  const g = state.grid;
  if (!g || !info) return;
  if (state.tool === 'stamp') { placeStamp(info); return; }
  const at = info.cell && g.blocks.get(blockKey(...info.cell));
  if (mods.alt) {
    if (at) { setBrush(at.mat); toast('Brush: ' + famName(at.mat)); }
    return;
  }
  if (state.tool === 'turn') { turnBlockAt(info, mods); return; }
  let run = null, msg = null;
  if (state.tool === 'paint') {
    if (!at) return;
    const brush = state.brush;
    if (state.paintScope === 'part' && at.src && at.path && !at.edited) {
      const f = findObject(at.src);
      const path = at.path.split('.');
      if (!f || getPath(f.obj, path) === brush) return;
      run = () => setPath(f.obj, path, brush);
      const part = PART_NAMES[at.path];
      msg = 'Painted ' + (f.obj.name || f.obj.id) + (part ? ' ' + part : '') + ' ' + famName(brush);
    } else {
      if (at.mat === brush) return;
      const [x, y, z] = info.cell;
      const ex = findEdit(x, y, z);
      if (ex && ex.edit.shape !== 'erase' && ex.edit.shape !== 'paint') run = () => { ex.edit.mat = brush; };
      else run = () => putEdit({ x, y, z, shape: 'paint', mat: brush }, ownerBox(at.src));
    }
  } else if (state.tool === 'place') {
    const t = info.place;
    if (!t || g.blocks.has(blockKey(...t)) || t[1] < -64 || t[1] > 319) return;
    const edit = { x: t[0], y: t[1], z: t[2], shape: state.shape, mat: state.brush };
    if (state.shape === 'slab' || state.shape === 'stair') edit.half = info.half || 'bottom';
    if (state.shape === 'stair') edit.facing = info.fromPlan ? state.planFacing : info.facing;
    if (state.shape === 'full' && FAMILIES[state.brush].axis) edit.axis = info.normal[0] ? 'x' : info.normal[2] ? 'z' : 'y';
    if (state.shape === 'pane') edit.axis = paneAxis(info);
    if (state.shape === 'door' || state.shape === 'trapdoor') Object.assign(edit, doorState(info));
    if (state.shape === 'door' && (g.blocks.has(blockKey(t[0], t[1] + 1, t[2])) || !FAMILIES[state.brush].door)) {
      toast(FAMILIES[state.brush].door ? 'A door needs two free blocks' : famName(state.brush) + ' has no door: pick a wood, iron or copper block', true);
      return;
    }
    run = () => putEdit(edit, ownerBox(at ? at.src : null));
  } else if (state.tool === 'erase') {
    if (!at) return;
    const [x, y, z] = info.cell;
    const ex = findEdit(x, y, z);
    // A hand-placed block just loses its edit; anything generated gets an erase edit.
    if (ex && ex.edit.shape !== 'erase' && ex.edit.shape !== 'paint') run = () => ex.list.splice(ex.index, 1);
    else run = () => putEdit({ x, y, z, shape: 'erase' }, ownerBox(at.src));
  }
  if (!run) return;
  beginChange(mods.stroke ? 'stroke:' + mods.stroke : null);
  run();
  afterChange();
  syncPropValues();
  updateToolbar();
  if (msg && !mods.stroke) toast(msg, false, { label: 'Undo', run: undo });
}
const TURN_CW = { north: 'east', east: 'south', south: 'west', west: 'north' };
const TURN_CCW = { north: 'west', west: 'south', south: 'east', east: 'north' };
/**
 * Turn tool: click any block that has a direction (stairs, doors, trapdoors, panes, logs) to turn
 * it a quarter clockwise; Shift turns it back. Hand-placed blocks change their edit; anything the
 * building or an asset made gets an edit of its own in that cell.
 */
function turnBlockAt(info, mods = {}) {
  const g = state.grid;
  if (!info.cell) return;
  let [x, y, z] = info.cell;
  let at = g.blocks.get(blockKey(x, y, z));
  if (!at) return;
  if (at.kind === 'door' && at.props.half === 'upper') { y--; at = g.blocks.get(blockKey(x, y, z)) || at; }
  const back = !!(mods.shift || mods.stroke);
  const turn = (f) => (back ? TURN_CCW : TURN_CW)[f] || 'north';
  const p = at.props || {};
  const ex = placedEdit([x, y, z]);
  // The edit this block would have if it were hand-placed, then turned.
  let next;
  if (at.kind === 'stair') next = { shape: 'stair', facing: turn(p.facing), half: p.half || 'bottom' };
  else if (at.kind === 'door') next = { shape: 'door', facing: turn(p.facing), hinge: p.hinge === 'right' ? 'right' : 'left', ...(p.open === 'true' ? { open: true } : {}) };
  else if (at.kind === 'trapdoor') next = { shape: 'trapdoor', facing: turn(p.facing), half: p.half || 'bottom', ...(p.open === 'true' ? { open: true } : {}) };
  else if (at.kind === 'pane') next = { shape: 'pane', axis: p.east === 'true' || p.west === 'true' ? 'z' : 'x' };
  else if (at.kind === 'full' && p.axis) next = { shape: 'full', axis: ({ y: 'x', x: 'z', z: 'y' })[p.axis] };
  if (!next) { if (!mods.stroke) toast(famName(at.mat) + (at.kind === 'slab' ? ' slab' : '') + ' has no direction to turn', true); return; }
  beginChange(mods.stroke ? 'stroke:' + mods.stroke : null);
  if (ex && ex.edit.shape === next.shape) {
    for (const k of ['facing', 'half', 'hinge', 'axis']) if (next[k] !== undefined) ex.edit[k] = next[k];
  } else putEdit({ x, y, z, mat: at.mat, ...next }, ownerBox(at.src));
  afterChange();
  syncPropValues();
}
/**
 * Door: faces the way you look, so you walk in through it. Trapdoor: hinged on the block you
 * click (top or bottom half from where you click it), or flat facing you on a floor or ceiling.
 */
function doorState(info) {
  const look = info.fromPlan || !info.facing ? state.planFacing : info.facing;
  const shape = studio.open ? studio.shape : state.shape;
  if (shape === 'door') return { facing: look, hinge: 'left' };
  const n = info.normal || [0, 1, 0];
  const side = n[0] > 0 ? 'east' : n[0] < 0 ? 'west' : n[2] > 0 ? 'south' : n[2] < 0 ? 'north' : null;
  const opp = { north: 'south', south: 'north', east: 'west', west: 'east' };
  return { facing: side || opp[look], half: side ? info.half || 'bottom' : n[1] < 0 ? 'top' : 'bottom', open: !!side };
}
/** A pane runs along the wall you click, or across your view when placed on the ground. */
function paneAxis(info) {
  const n = info.normal || [0, 1, 0];
  if (n[0]) return 'z';
  if (n[2]) return 'x';
  const f = info.fromPlan || !info.facing ? state.planFacing : info.facing;
  return f === 'north' || f === 'south' ? 'x' : 'z';
}
function clearEdits() {
  const n = countEdits();
  if (!n) return;
  beginChange(null);
  state.design.edits = [];
  for (const b of state.design.boxes) b.edits = [];
  afterChange();
  updateToolbar();
  toast('Cleared ' + fmt(n) + ' block edits', false, { label: 'Undo', run: undo });
}
function planCellAt(e) {
  const r = $('planCanvas').getBoundingClientRect();
  const b = planBounds();
  const cell = planCellSize();
  const x = b.minX + Math.floor((e.clientX - r.left - 30) / cell);
  const z = b.minZ + Math.floor((e.clientY - r.top - 20) / cell);
  return { x, z, inside: x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ };
}
// Layer plan: click acts on one cell, drag acts on the rectangle (any block tool).
let planDrag = null;
function onPlanDown(e) {
  if (state.tool === 'select' || !state.grid || e.button !== 0) return;
  const c = planCellAt(e);
  if (!c.inside) return;
  planDrag = { a: c, b: c, alt: e.altKey };
  try { $('planCanvas').setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
}
function onPlanMove(e) {
  if (!planDrag) return;
  const b = planBounds();
  const c = planCellAt(e);
  c.x = Math.max(b.minX, Math.min(b.maxX, c.x)); c.z = Math.max(b.minZ, Math.min(b.maxZ, c.z));
  if (c.x === planDrag.b.x && c.z === planDrag.b.z) return;
  planDrag.b = c;
  renderPlan();
  const ctx = $('planCanvas').getContext('2d'); // drawLayer leaves the DPR transform in place
  const cell = planCellSize();
  const x0 = Math.min(planDrag.a.x, c.x), x1 = Math.max(planDrag.a.x, c.x) + 1, z0 = Math.min(planDrag.a.z, c.z), z1 = Math.max(planDrag.a.z, c.z) + 1;
  ctx.save();
  ctx.fillStyle = state.tool === 'erase' ? 'rgba(192,57,43,0.25)' : 'rgba(217,129,74,0.3)';
  ctx.strokeStyle = state.tool === 'erase' ? '#c0392b' : '#d9814a';
  ctx.lineWidth = 2;
  const px = 30 + (x0 - b.minX) * cell, pz = 20 + (z0 - b.minZ) * cell;
  if (state.area && state.circle) {
    ctx.beginPath();
    ctx.ellipse(px + (x1 - x0) * cell / 2, pz + (z1 - z0) * cell / 2, (x1 - x0) * cell / 2, (z1 - z0) * cell / 2, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  } else {
    ctx.fillRect(px, pz, (x1 - x0) * cell, (z1 - z0) * cell);
    ctx.strokeRect(px, pz, (x1 - x0) * cell, (z1 - z0) * cell);
  }
  ctx.restore();
}
function onPlanUp(e) {
  const d = planDrag;
  planDrag = null;
  if (!d) return;
  if (d.a.x === d.b.x && d.a.z === d.b.z) { onPlanClick(e, d.a, d.alt); return; }
  renderPlan();
  areaAction({ x0: d.a.x, z0: d.a.z, x1: d.b.x, z1: d.b.z, y0: state.currentLayer, y1: state.currentLayer }, { fromPlan: true, half: 'bottom' });
}
function onPlanClick(e, c, alt) {
  const { x, z } = c;
  const y = state.currentLayer;
  const has = state.grid.blocks.has(blockKey(x, y, z));
  blockAction({ cell: has ? [x, y, z] : null, place: has ? null : [x, y, z], normal: [0, 1, 0], half: 'bottom', fromPlan: true }, { alt });
}
/** Plan bounds: the build, padded while a block tool is active so you can build outward. */
function planBounds() {
  const g = state.grid;
  const pad = state.tool === 'select' ? 0 : 3;
  return { minX: g.min.x - pad, maxX: g.max.x + pad, minZ: g.min.z - pad, maxZ: g.max.z + pad };
}

function rerollVariation(id) {
  const f = findObject(id);
  if (!f) return;
  beginChange(null);
  texOf(f.obj).seed = 1 + Math.floor(Math.random() * 999998);
  afterChange();
}

function rotateSelected(q) {
  const f = findObject(state.selectedId);
  if (!f || f.kind === 'pillar' || isLocked(f)) return;
  const sig = JSON.stringify(f.obj);
  let a = state.rotAnchor;
  if (!a || a.id !== f.obj.id || a.sig !== sig) a = { id: f.obj.id, start: JSON.parse(sig), q: 0 };
  a.q = (a.q + q + 4) % 4;
  beginChange('rotate:' + f.obj.id);
  Object.assign(f.obj, a.start, rotatePatch(f.kind, a.start, a.q));
  afterChange();
  a.sig = JSON.stringify(f.obj);
  state.rotAnchor = a;
  syncPropValues();
  renderProps(true);
}

function nudge(dx, dz, dy = 0) {
  const f = findObject(state.selectedId);
  if (!f || isLocked(f)) return;
  beginChange('nudge:' + f.obj.id);
  if (f.kind === 'segment') { f.obj.x0 += dx; f.obj.x1 += dx; f.obj.z0 += dz; f.obj.z1 += dz; }
  else { f.obj.x += dx; f.obj.z += dz; }
  f.obj.baseY += dy;
  afterChange();
  syncPropValues();
}

// ------------------------------------------------------------------ auto details
function lum(key) {
  const hex = famColor(key).replace('#', '');
  const n = parseInt(hex, 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
/**
 * Candidate that stands out from every key in `against` by about `gap` in luminance
 * (score = smallest gap, capped so it never jumps to an extreme); prefers the first key's group.
 */
function contrastPick(candidates, against, gap = 0.28, exclude = []) {
  const ref = [].concat(against);
  let best = null, bestScore = -Infinity;
  const g0 = FAMILIES[ref[0]] && FAMILIES[ref[0]].group;
  for (const k of candidates) {
    if (!FAMILIES[k] || ref.includes(k) || exclude.includes(k)) continue;
    const near = Math.min(...ref.map((r) => Math.abs(lum(k) - lum(r))));
    const score = Math.min(near, gap) - (FAMILIES[k].group === g0 ? 0 : 0.06);
    if (score > bestScore) { bestScore = score; best = k; }
  }
  return best || candidates[0];
}
const TRIM_CANDIDATES = ['dark_oak', 'spruce', 'oak', 'birch', 'pale_oak', 'mangrove', 'stone_bricks', 'deepslate_tiles', 'polished_blackstone_bricks', 'smooth_quartz', 'smooth_sandstone', 'bricks', 'mud_bricks', 'polished_andesite', 'nether_bricks'];
const POST_CANDIDATES = ['dark_oak_log', 'spruce_log', 'oak_log', 'birch_log', 'pale_oak_log', 'jungle_log', 'mangrove_log', 'cherry_log'];
const BASE_CANDIDATES = ['cobblestone', 'stone_bricks', 'cobbled_deepslate', 'polished_andesite', 'mossy_cobblestone', 'polished_blackstone_bricks', 'smooth_stone', 'deepslate_bricks'];
function suggestDetails(b) {
  const trimMat = contrastPick(TRIM_CANDIDATES, [b.roof.material, b.wallMaterial], 0.12);
  const cornerMat = contrastPick(POST_CANDIDATES, b.wallMaterial, 0.25);
  const stripped = 'stripped_' + cornerMat;
  const beamMat = FAMILIES[stripped] ? stripped : cornerMat;
  const baseMat = contrastPick(BASE_CANDIDATES, b.wallMaterial, 0.15, [cornerMat]);
  return { trim: true, ridge: true, corners: true, base: true, beams: true, windows: true, trimMat, cornerMat, baseMat, beamMat, windowMat: 'glass' };
}
function autoDetails(ids) {
  const boxes = state.design.boxes.filter((b) => !ids || ids.includes(b.id));
  if (!boxes.length) { toast('Add a box first'); return; }
  beginChange(null);
  for (const b of boxes) b.details = suggestDetails(b);
  afterChange();
  renderProps(true);
  toast(boxes.length === 1 ? 'Details added to ' + (boxes[0].name || boxes[0].id) : `Details added to ${boxes.length} boxes`, false, { label: 'Undo', run: undo });
}

// ------------------------------------------------------------------ presets
// A preset is a style: materials for every role, which details are on, and the roof curve.
const D = (o) => ({ ...DETAIL_DEFAULTS, ...o });
const BUILTIN_PRESETS = [
  { name: 'Farmhouse', roof: 'spruce', wall: 'oak', pillar: 'oak_log', segment: 'cobblestone', profile: 'straight', variation: { wall: 15, roof: 15, style: 'patches' },
    details: D({ trim: true, corners: true, base: true, windows: true, trimMat: 'dark_oak', cornerMat: 'spruce_log', baseMat: 'cobblestone', windowMat: 'glass' }) },
  { name: 'Tudor', roof: 'dark_oak', wall: 'calcite', pillar: 'dark_oak_log', segment: 'cobblestone', profile: 'straight',
    details: D({ trim: true, ridge: true, corners: true, beams: true, base: true, windows: true, trimMat: 'spruce', cornerMat: 'dark_oak_log', beamMat: 'stripped_dark_oak_log', baseMat: 'cobblestone', windowMat: 'glass' }) },
  { name: 'Japanese', roof: 'deepslate_tiles', wall: 'white_terracotta', pillar: 'dark_oak_log', segment: 'polished_andesite', profile: 'flared', upturn: 2, upturnReach: 6, variation: { roof: 15, style: 'scatter' },
    details: D({ trim: true, ridge: true, corners: true, beams: true, base: true, windows: true, trimMat: 'dark_oak', cornerMat: 'dark_oak_log', beamMat: 'stripped_dark_oak_log', baseMat: 'polished_andesite', windowMat: 'white_stained_glass' }) },
  { name: 'Desert', roof: 'smooth_sandstone', wall: 'sandstone', pillar: 'chiseled_sandstone', segment: 'smooth_sandstone', profile: 'straight', variation: { wall: 20, style: 'streaks' },
    details: D({ trim: true, corners: true, base: true, windows: true, trimMat: 'smooth_red_sandstone', cornerMat: 'chiseled_sandstone', baseMat: 'smooth_sandstone', windowMat: 'orange_stained_glass' }) },
  { name: 'Cherry cottage', roof: 'cherry', wall: 'birch', pillar: 'cherry_log', segment: 'mossy_cobblestone', profile: 'rounded', variation: { roof: 10, style: 'patches' },
    details: D({ trim: true, corners: true, beams: true, base: true, windows: true, trimMat: 'pale_oak', cornerMat: 'cherry_log', beamMat: 'stripped_cherry_log', baseMat: 'mossy_cobblestone', windowMat: 'pink_stained_glass' }) },
  { name: 'Stone keep', roof: 'deepslate_tiles', wall: 'stone_bricks', pillar: 'polished_andesite', segment: 'stone_bricks', profile: 'straight', variation: { wall: 30, roof: 20, style: 'grime' },
    details: D({ trim: true, ridge: true, corners: true, base: true, windows: true, trimMat: 'polished_blackstone_bricks', cornerMat: 'chiseled_stone_bricks', baseMat: 'cobbled_deepslate', windowMat: 'glass' }) },
  { name: 'Copper & brick', roof: 'waxed_oxidized_cut_copper', wall: 'bricks', pillar: 'stone_bricks', segment: 'bricks', profile: 'straight',
    details: D({ trim: true, ridge: true, corners: true, base: true, windows: true, trimMat: 'waxed_cut_copper', cornerMat: 'stone_bricks', baseMat: 'polished_andesite', windowMat: 'glass' }) },
  { name: 'Nether', roof: 'nether_bricks', wall: 'red_nether_bricks', pillar: 'crimson_stem', segment: 'blackstone', profile: 'bell',
    details: D({ trim: true, ridge: true, corners: true, beams: true, base: true, windows: true, trimMat: 'polished_blackstone_bricks', cornerMat: 'crimson_stem', beamMat: 'stripped_crimson_stem', baseMat: 'blackstone', windowMat: 'red_stained_glass' }) },
  { name: 'Modern', roof: 'polished_andesite', wall: 'white_concrete', pillar: 'light_gray_concrete', segment: 'polished_deepslate', profile: 'straight',
    details: D({ trim: true, corners: true, base: true, windows: true, trimMat: 'polished_deepslate', cornerMat: 'gray_concrete', baseMat: 'polished_deepslate', windowMat: 'glass' }) },
];
function loadUserPresets() {
  try {
    const arr = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((p) => p && typeof p.name === 'string') : [];
  } catch (e) { return []; }
}
function saveUserPresets(list) {
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
}
function presetFromDesign(name) {
  const d = state.design;
  const sel = findObject(state.selectedId);
  const b = sel && sel.kind === 'box' ? sel.obj : d.boxes[0];
  return {
    name,
    roof: b ? b.roof.material : 'spruce',
    wall: b ? b.wallMaterial : 'oak',
    pillar: d.pillars[0] ? d.pillars[0].material : 'oak_log',
    segment: d.segments[0] ? d.segments[0].material : 'cobblestone',
    profile: b ? b.roof.profile : 'straight',
    upturn: b ? b.roof.upturn : 0,
    upturnReach: b ? b.roof.upturnReach : 6,
    details: D(b ? b.details : {}),
    variation: b ? { ...texOf(b) } : null,
  };
}
function applyPreset(p) {
  const d = state.design;
  beginChange(null);
  const ok = (k, fallback) => (FAMILIES[k] ? k : fallback);
  for (const b of d.boxes) {
    b.roof.material = ok(p.roof, b.roof.material);
    b.wallMaterial = ok(p.wall, b.wallMaterial);
    if (p.profile) b.roof.profile = p.profile;
    b.roof.upturn = p.upturn || 0; // like variation: presets without it switch it off
    if (p.upturnReach) b.roof.upturnReach = p.upturnReach;
    const det = D(p.details);
    for (const [k, v] of Object.entries(DETAIL_DEFAULTS)) if (typeof v === 'string') det[k] = ok(det[k], v);
    b.details = det;
    // Presets without texture settings switch variation off, so styles don't leak across.
    const va = { ...VARIATION_DEFAULTS, ...(p.variation || {}) };
    for (const k of [...MIX_KEYS.wall, ...MIX_KEYS.roof]) if (va[k] && !FAMILIES[va[k]]) va[k] = '';
    if (b.ownTexture) b.variation = { ...va, seed: (b.variation && b.variation.seed) || 1 };
  }
  // The shared texture (every box that doesn't keep its own).
  const va = { ...VARIATION_DEFAULTS, ...(p.variation || {}) };
  for (const k of [...MIX_KEYS.wall, ...MIX_KEYS.roof]) if (va[k] && !FAMILIES[va[k]]) va[k] = '';
  d.variation = { ...va, seed: (d.variation && d.variation.seed) || 1 };
  for (const pl of d.pillars) pl.material = ok(p.pillar, pl.material);
  for (const sg of d.segments) sg.material = ok(p.segment, sg.material);
  afterChange();
  renderProps(true);
  toast('Applied preset ' + p.name, false, { label: 'Undo', run: undo });
}
function presetRow(p, userIndex) {
  const mats = [p.roof, p.wall, p.details && p.details.trimMat, p.details && p.details.cornerMat, p.details && p.details.baseMat].filter((k) => FAMILIES[k]);
  const on = Object.entries(p.details || {}).filter(([, v]) => v === true).map(([k]) => k);
  const meta = (p.profile && p.profile !== 'straight' ? p.profile + ' roof · ' : '') + (p.upturn ? 'upturned corners · ' : '') + (on.length ? on.join(', ') : 'no details');
  const apply = h('button', { class: 'preset', type: 'button', id: 'preset-' + (userIndex == null ? 'b-' : 'u-') + slug(p.name), title: 'Apply ' + p.name + ' to the whole design' },
    h('span', { class: 'preset-icons' }, mats.map((k) => iconEl(k, 22))),
    h('span', { class: 'preset-text' }, h('span', { class: 'preset-name', text: p.name }), h('span', { class: 'preset-meta', text: meta })));
  apply.addEventListener('click', () => { closePicker(); applyPreset(p); });
  const row = h('div', { class: 'preset-row' }, apply);
  if (userIndex != null) {
    const del = h('button', { class: 'btn icon small', type: 'button', 'aria-label': 'Delete preset ' + p.name, title: 'Delete preset', text: '✕' });
    del.addEventListener('click', () => {
      const list = loadUserPresets();
      const [gone] = list.splice(userIndex, 1);
      saveUserPresets(list);
      renderPresetBody();
      toast('Deleted preset ' + p.name, false, { label: 'Undo', run: () => { const l = loadUserPresets(); l.splice(userIndex, 0, gone); saveUserPresets(l); if (picker.mode === 'presets') renderPresetBody(); toast('Preset restored'); } });
    });
    row.append(del);
  }
  return row;
}
function renderPresetBody() {
  const body = $('popoverBody');
  body.replaceChildren();
  const user = loadUserPresets();
  const nameIn = h('input', { type: 'text', id: 'presetName', placeholder: 'Preset name', autocomplete: 'off', spellcheck: 'false', maxlength: 40 });
  const saveBtn = h('button', { class: 'btn small primary', type: 'button', id: 'presetSave', text: 'Save current style' });
  const save = () => {
    const name = nameIn.value.trim() || (state.design.name || 'My preset');
    const list = loadUserPresets().filter((p) => p.name !== name);
    list.unshift(presetFromDesign(name));
    if (!saveUserPresets(list)) { toast('Could not save: browser storage is blocked', true); return; }
    renderPresetBody();
    toast('Saved preset ' + name);
  };
  saveBtn.addEventListener('click', save);
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  body.append(
    h('p', { class: 'note', text: 'A preset is a style: roof, wall, trim, post, foundation and window materials, which details are on, and the roof curve. Applying one restyles every object; undo puts it back.' }),
    h('div', { class: 'preset-save' }, h('label', { for: 'presetName', class: 'sr-only', text: 'Preset name' }), nameIn, saveBtn),
    h('p', { class: 'hint', text: 'Saves the selected box (or the first box) as a preset in this browser.' }));
  if (user.length) {
    body.append(h('div', { class: 'swatch-group-title', text: 'Your presets' }));
    user.forEach((p, i) => body.append(presetRow(p, i)));
  }
  body.append(h('div', { class: 'swatch-group-title', text: 'Built-in' }));
  for (const p of BUILTIN_PRESETS) body.append(presetRow(p, null));
}
function openPresets(anchor) {
  closePicker();
  picker.anchor = anchor; picker.onPick = null; picker.groups = []; picker.mode = 'presets';
  $('popoverTitle').textContent = 'Style presets';
  $('popoverSearch').hidden = true;
  renderPresetBody();
  $('popover').hidden = false;
  anchor.setAttribute('aria-expanded', 'true');
  positionPopover(anchor);
  const first = $('popoverBody').querySelector('.preset');
  if (first) first.focus();
}

// ------------------------------------------------------------------ swatch picker popover
const picker = { anchor: null, onPick: null, keys: [], current: null, groups: [] };
function openPicker(anchor, { title, keys, current, onPick, hint, auto }) {
  closePicker();
  const pop = $('popover');
  picker.anchor = anchor; picker.onPick = onPick; picker.keys = keys; picker.current = current; picker.mode = 'materials';
  $('popoverTitle').textContent = title || 'Choose material';
  const body = $('popoverBody');
  body.replaceChildren();
  if (hint) body.append(h('p', { class: 'note', text: hint }));
  if (auto) {
    const btn = h('button', { class: 'swatch auto', type: 'button', id: 'swatch-auto', 'aria-pressed': String(!current), title: 'Auto' },
      auto.key ? h('img', { src: swatchURL(auto.key), alt: '', width: 48, height: 48 }) : h('span', { class: 'auto-blank', text: '?' }),
      h('span', { text: 'Auto' + (auto.key ? ' (' + famName(auto.key) + ')' : '') }));
    btn.addEventListener('click', () => { const fn = picker.onPick; closePicker(); if (fn) fn(''); });
    body.append(h('div', { class: 'swatch-grid' }, btn));
  }
  picker.groups = [];
  const byGroup = new Map();
  for (const k of keys) {
    const g = (FAMILIES[k] && FAMILIES[k].group) || 'Other';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(k);
  }
  const rank = (g) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? 99 : i; };
  for (const [g, ks] of [...byGroup].sort((a, b) => rank(a[0]) - rank(b[0]))) {
    const titleEl = h('div', { class: 'swatch-group-title', text: g });
    const grid = h('div', { class: 'swatch-grid', role: 'group', 'aria-label': g });
    const items = [];
    for (const k of ks) {
      const name = famName(k);
      const btn = h('button', {
        class: 'swatch', type: 'button', id: 'swatch-' + k, 'aria-pressed': String(k === current), title: name,
        'data-search': (name + ' ' + k + ' ' + g).toLowerCase(),
      }, h('img', { src: swatchURL(k), alt: '', width: 48, height: 48 }), h('span', { text: name }));
      btn.addEventListener('click', () => { const fn = picker.onPick; closePicker(); if (fn) fn(k); });
      grid.append(btn);
      items.push(btn);
    }
    body.append(titleEl, grid);
    picker.groups.push({ titleEl, grid, items });
  }
  body.append(h('p', { class: 'popover-empty', id: 'popoverEmpty', text: 'No materials match.', hidden: true }));
  const search = $('popoverSearch');
  search.value = '';
  search.hidden = false;
  pop.hidden = false;
  anchor.setAttribute('aria-expanded', 'true');
  positionPopover(anchor);
  search.focus();
  const pressed = body.querySelector('[aria-pressed="true"]');
  if (pressed) pressed.scrollIntoView({ block: 'nearest' });
}
function filterPicker() {
  const q = $('popoverSearch').value.trim().toLowerCase();
  let any = false;
  for (const g of picker.groups) {
    let shown = 0;
    for (const btn of g.items) {
      const ok = !q || btn.dataset.search.includes(q);
      btn.hidden = !ok;
      if (ok) shown++;
    }
    g.titleEl.hidden = shown === 0;
    g.grid.hidden = shown === 0;
    if (shown) any = true;
  }
  $('popoverEmpty').hidden = any;
}
function positionPopover(anchor) {
  const pop = $('popover');
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = clamp(r.left, 8, Math.max(8, vw - pw - 8));
  let top = r.bottom + 6;
  if (top + ph > vh - 8) top = Math.max(8, r.top - ph - 6);
  if (top + ph > vh - 8) top = Math.max(8, vh - ph - 8);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}
function closePicker() {
  const pop = $('popover');
  if (pop.hidden) return;
  pop.hidden = true;
  const a = picker.anchor;
  picker.anchor = null; picker.onPick = null; picker.groups = []; picker.mode = null;
  if (a) {
    a.setAttribute('aria-expanded', 'false');
    if (a.isConnected) a.focus();
  }
}

// ------------------------------------------------------------------ confirm + toast
let confirmCb = null;
let confirmReturnFocus = null;
function confirmAction(message, onYes, { yesLabel = 'Confirm' } = {}) {
  confirmCb = onYes;
  confirmReturnFocus = document.activeElement;
  $('confirmText').textContent = message;
  $('confirmYes').textContent = yesLabel;
  $('confirmBar').hidden = false;
  $('confirmYes').focus();
}
function closeConfirm() {
  $('confirmBar').hidden = true;
  confirmCb = null;
  if (confirmReturnFocus && confirmReturnFocus.isConnected) confirmReturnFocus.focus();
  confirmReturnFocus = null;
}
let toastTimer = 0;
function toast(msg, isError = false, action = null) {
  const t = $('toast');
  t.replaceChildren(h('span', { text: msg }));
  if (action) {
    t.append(h('button', { class: 'toast-action', type: 'button', id: 'toastAction', text: action.label,
      onclick: () => { t.hidden = true; action.run(); } }));
  }
  t.classList.toggle('error', !!isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : action ? 6000 : 2500);
}

// ------------------------------------------------------------------ layer / slice / plan
function renderSliceControls() {
  if (!state.grid) return;
  const { minY, maxY } = layerRange(state.grid);
  const s = $('sliceSlider');
  s.min = minY; s.max = maxY; s.value = state.currentLayer;
  s.disabled = minY === maxY;
  $('sliceValue').textContent = String(state.currentLayer);
  $('layerValue').textContent = String(state.currentLayer);
  $('layerOf').textContent = `(${minY}…${maxY})`;
  $('layerDown').disabled = state.currentLayer <= minY;
  $('layerUp').disabled = state.currentLayer >= maxY;
}
function setLayer(y) {
  if (!state.grid) return;
  const { minY, maxY } = layerRange(state.grid);
  y = clamp(Math.round(y), minY, maxY);
  state.currentLayer = y;
  state.layerAtTop = y === maxY;
  renderSliceControls();
  applySlice();
  renderPlan();
  renderLegend();
}
function planCellSize() {
  const zoom = $('planZoom').value;
  if (zoom !== 'auto') return Number(zoom);
  const wrap = $('planScroll');
  const pb = planBounds();
  const cols = pb.maxX - pb.minX + 1;
  const avail = Math.max(120, (wrap.clientWidth || 320) - 40);
  return clamp(Math.floor(avail / cols), 10, 26);
}
function renderPlan() {
  if (!state.grid || $('pane-plans').hidden || rails.rightClosed) return;
  try {
    drawLayer($('planCanvas'), state.grid, state.currentLayer, { cell: planCellSize(), bounds: planBounds() });
  } catch (e) { console.error('plan draw failed', e); }
}
function renderLegend() {
  if (!state.grid) return;
  const ul = $('planLegend');
  ul.replaceChildren();
  const rows = layerLegend(state.grid, state.currentLayer);
  if (!rows.length) { ul.append(h('li', { class: 'empty', text: 'Nothing on this layer.' })); return; }
  for (const r of rows) {
    const name = FAMILIES[r.mat] ? famName(r.mat) + ' ' + (KIND_LABEL[r.kind] || r.kind) : r.name;
    ul.append(h('li', {},
      iconEl(r.mat, 20),
      h('span', { class: 'sw', style: 'background:' + (r.color || '#888') }),
      h('span', { text: name }),
      h('span', { class: 'n', text: fmt(r.count) })));
  }
}
function renderMaterials() {
  if (!state.grid) return;
  const tbody = $('materialsBody');
  tbody.replaceChildren();
  let rows = [];
  try { rows = materialTotals(state.grid) || []; } catch (e) { console.error(e); }
  let total = 0;
  // Map block id -> family key for icons (materialTotals only carries id/name/count).
  const idToMat = new Map();
  for (const b of state.grid.blocks.values()) if (!idToMat.has(b.id)) idToMat.set(b.id, b.mat);
  for (const r of rows) {
    total += r.count;
    const mat = idToMat.get(r.id);
    const stacks = r.count >= 64 ? ` (${Math.floor(r.count / 64)}×64 + ${r.count % 64})` : '';
    tbody.append(h('tr', {},
      h('td', {}, mat ? iconEl(mat, 20) : ''),
      h('td', {}, h('div', { text: r.name }), h('div', { class: 'id', text: r.id })),
      h('td', { class: 'num', text: fmt(r.count) + stacks })));
  }
  if (!rows.length) tbody.append(h('tr', {}, h('td', { colspan: 3, class: 'empty', text: 'No blocks.' })));
  $('materialsTotal').textContent = fmt(total);
}
function renderStatus() {
  if (!state.grid) return;
  const g = state.grid;
  const n = g.blocks.size;
  const sx = g.max.x - g.min.x + 1, sy = g.max.y - g.min.y + 1, sz = g.max.z - g.min.z + 1;
  $('status').textContent = n ? `${fmt(n)} blocks · ${sx}×${sy}×${sz} (x×y×z) · origin ${g.min.x},${g.min.y},${g.min.z}` : 'No blocks';
}

// ------------------------------------------------------------------ tabs
// Vertical tabs down each side. Clicking the open tab folds its panel away for a bigger 3D view.
const RAILS = { left: ['objects', 'palette', 'assets'], right: ['props', 'plans', 'materials', 'export'] };
const rails = { left: 'objects', right: 'plans', leftClosed: false, rightClosed: false };
function setRail(side, name, { toggle = false, open = true } = {}) {
  const closedKey = side + 'Closed';
  if (toggle && rails[side] === name && !rails[closedKey]) rails[closedKey] = true;
  else if (open) rails[closedKey] = false;
  rails[side] = name;
  for (const key of RAILS[side]) {
    const on = key === name;
    const tab = $('tab-' + key);
    tab.setAttribute('aria-selected', String(on && !rails[closedKey]));
    tab.tabIndex = on ? 0 : -1;
    $('pane-' + key).hidden = !on;
  }
  $('work').classList.toggle(side + '-closed', rails[closedKey]);
  if (name === 'props') $('tab-props').classList.remove('badge');
  try { localStorage.setItem('rafter.rails', JSON.stringify(rails)); } catch (e) { /* ignore */ }
  if (name === 'plans' && !rails[closedKey]) { renderPlan(); renderLegend(); }
}
/** Something got selected: show its properties (marking the tab when its panel is folded away). */
function showProps() {
  if (rails.right !== 'props') setRail('right', 'props', { open: false });
  if (rails.rightClosed) $('tab-props').classList.add('badge');
}
const setTab = (name) => setRail('right', name);

// ------------------------------------------------------------------ downloads
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new TextEncoder().encode(String(data));
}
// Single-entry STORED zip (method 0, no compression), UTF-8 names (flag 0x0800).
function zipStored(entryName, data) {
  const bytes = toBytes(data);
  const name = new TextEncoder().encode(entryName);
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const crc = crc32(bytes);
  const localLen = 30 + name.length, centralLen = 46 + name.length, eocdLen = 22;
  const out = new Uint8Array(localLen + bytes.length + centralLen + eocdLen);
  const dv = new DataView(out.buffer);
  let p = 0;
  const u16 = (v) => { dv.setUint16(p, v & 0xFFFF, true); p += 2; };
  const u32 = (v) => { dv.setUint32(p, v >>> 0, true); p += 4; };
  // local file header
  u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(dosTime); u16(dosDate);
  u32(crc); u32(bytes.length); u32(bytes.length); u16(name.length); u16(0);
  out.set(name, p); p += name.length;
  out.set(bytes, p); p += bytes.length;
  // central directory
  const cdStart = p;
  u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(dosTime); u16(dosDate);
  u32(crc); u32(bytes.length); u32(bytes.length); u16(name.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(0);
  out.set(name, p); p += name.length;
  const cdSize = p - cdStart;
  // end of central directory
  u32(0x06054b50); u16(0); u16(0); u16(1); u16(1); u32(cdSize); u32(cdStart); u16(0);
  return out;
}
const CLAUDE_DL_EXT = new Set(['gif', 'png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm', 'mov', 'txt', 'json', 'md', 'docx', 'pptx', 'epub', 'csv', 'ttf', 'html', 'svg', 'pdf', 'xlsx', 'zip']);
let claudeDownloadsPromise = null;
function claudeDownloads() {
  if (!(window.claude && typeof window.claude.use === 'function')) return Promise.resolve(null);
  if (!claudeDownloadsPromise) {
    claudeDownloadsPromise = Promise.resolve().then(() => window.claude.use('downloads')).catch(() => null);
  }
  return claudeDownloadsPromise;
}
const MIME = { json: 'application/json', litematic: 'application/octet-stream', schem: 'application/octet-stream', zip: 'application/zip' };
async function saveFile(filename, bytesOrString) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const dl = await claudeDownloads();
  if (dl) {
    // Sandboxed claude.ai artifact viewer: only a fixed set of extensions is allowed.
    let name = filename, data = bytesOrString, zipped = false;
    if (!CLAUDE_DL_EXT.has(ext)) {
      data = zipStored(filename, bytesOrString);
      name = filename + '.zip';
      zipped = true;
    }
    try {
      await dl.save({ filename: name, data });
      toast(zipped ? 'Saved as a zip; unzip it into .minecraft/schematics' : 'Saved ' + name);
    } catch (e) {
      if (e && e.code === 'declined') return;
      toast('Download failed: ' + ((e && e.message) || e), true);
    }
    return;
  }
  const blob = bytesOrString instanceof Blob ? bytesOrString : new Blob([bytesOrString], { type: MIME[ext] || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function slug(name) {
  return (String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')) || 'rafter';
}
function setExportStatus(msg, isError = false) {
  const el = $('exportStatus');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}
function gzipBytes(bytes) {
  if (!(window.pako && typeof window.pako.gzip === 'function')) throw new Error('pako (gzip) did not load; check your connection and reload');
  return window.pako.gzip(bytes);
}
async function exportLitematic() {
  flushRebuildSync();
  try {
    const d = state.design;
    const bytes = encodeLitematic(state.grid, { name: d.name || 'Rafter', author: d.author || '', description: 'Made with Rafter', dataVersion: d.dataVersion });
    const gz = gzipBytes(bytes);
    const fname = slug(d.name) + '.litematic';
    setExportStatus(`${fname} · ${fmt(gz.length)} bytes gzipped`);
    await saveFile(fname, gz);
  } catch (e) {
    console.error(e);
    setExportStatus('Export failed: ' + ((e && e.message) || e), true);
  }
}
async function exportSchem() {
  flushRebuildSync();
  try {
    const d = state.design;
    const bytes = encodeSchem(state.grid, { dataVersion: d.dataVersion });
    const gz = gzipBytes(bytes);
    const fname = slug(d.name) + '.schem';
    setExportStatus(`${fname} · ${fmt(gz.length)} bytes gzipped`);
    await saveFile(fname, gz);
  } catch (e) {
    console.error(e);
    setExportStatus('Export failed: ' + ((e && e.message) || e), true);
  }
}
async function saveJSON() {
  await saveFile(slug(state.design.name) + '.rafter.json', JSON.stringify(state.design, null, 2));
}
async function loadJSONFile(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.boxes)) throw new Error('not a Rafter design (no boxes array)');
    beginChange(null);
    state.design = normalizeDesign(parsed);
    state.selectedId = null;
    state.layerAtTop = true;
    afterChange();
    renderHeaderFields();
    renderProps();
    if (viewer) { viewer.setSelection(null); setTimeout(() => viewer && viewer.frameAll(), 60); }
    toast('Loaded ' + file.name);
  } catch (e) {
    toast('Could not load: ' + ((e && e.message) || e), true);
  }
}
function resetToSample() {
  confirmAction('Replace the current design with the sample? You can undo this.', () => {
    beginChange(null);
    state.design = normalizeDesign(defaultDesign());
    state.design.dataVersion = DEFAULT_DATA_VERSION;
    state.selectedId = null;
    state.layerAtTop = true;
    afterChange();
    renderHeaderFields();
    renderProps();
    if (viewer) { viewer.setSelection(null); setTimeout(() => viewer && viewer.frameAll(), 60); }
    toast('Sample design restored');
  }, { yesLabel: 'Reset' });
}

// ------------------------------------------------------------------ keyboard
function isTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
function onKeyDown(e) {
  if (e.key === 'Escape') {
    if (!$('popover').hidden) { e.preventDefault(); closePicker(); return; }
    if (!$('confirmBar').hidden) { e.preventDefault(); closeConfirm(); return; }
  }
  // The Asset Studio covers the building: only its own keys (Esc, undo / redo) apply.
  if (studio.open) {
    if (e.key === 'Escape') { e.preventDefault(); closeStudio(); return; }
    if (isTyping(e.target)) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) { e.preventDefault(); if (k === 'y' || e.shiftKey) redo(); else undo(); }
    return;
  }
  if (isTyping(e.target)) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (k === 'd' && mod && (state.selectedBlocks.length || state.selectedId)) {
    // Ctrl+D: one copy in the clone panel's direction (Firefox's bookmark shortcut is overridden).
    e.preventDefault();
    if (state.selectedBlocks.length) cloneBlocks(1); else if (state.selectedId) cloneObject(state.selectedId, 1);
    return;
  }
  if (mod) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedBlocks.length && !state.selectedId) { e.preventDefault(); deleteSelectedBlocks(); return; }
  if (k === 'r' && state.selectedBlocks.length && !state.selectedId && state.tool === 'select') { e.preventDefault(); rotateSelectedBlocks(); return; }
  if (state.selectedBlocks.length && !state.selectedId) {
    const step = e.shiftKey ? 5 : 1;
    const mv = { ArrowUp: [0, 0, -step], ArrowDown: [0, 0, step], ArrowLeft: [-step, 0, 0], ArrowRight: [step, 0, 0], PageUp: [0, 1, 0], PageDown: [0, -1, 0] }[e.key];
    if (mv) { e.preventDefault(); nudgeBlocks(...mv); return; }
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) { e.preventDefault(); requestDelete(state.selectedId); return; }
  if (k === 'r' && state.tool === 'place' && state.shape === 'stair') {
    e.preventDefault();
    const order = ['north', 'east', 'south', 'west'];
    state.planFacing = order[(order.indexOf(state.planFacing) + (e.shiftKey ? 3 : 1)) % 4];
    updateToolbar();
    return;
  }
  if (k === 'r' && state.selectedId) { e.preventDefault(); rotateSelected(e.shiftKey ? -1 : 1); return; }
  if (k === 'a' && state.tool !== 'select' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); setArea(!state.area); return; }
  const toolKey = { v: 'select', b: 'paint', p: 'place', e: 'erase', t: 'turn' }[k];
  if (toolKey && !e.altKey) { e.preventDefault(); setTool(toolKey); return; }
  if (e.key.startsWith('Arrow') && state.selectedId) {
    e.preventDefault();
    const step = e.shiftKey ? 5 : 1;
    if (e.key === 'ArrowUp') nudge(0, -step);
    else if (e.key === 'ArrowDown') nudge(0, step);
    else if (e.key === 'ArrowLeft') nudge(-step, 0);
    else if (e.key === 'ArrowRight') nudge(step, 0);
    return;
  }
  if ((e.key === 'PageUp' || e.key === 'PageDown') && state.selectedId) {
    e.preventDefault();
    nudge(0, 0, (e.key === 'PageUp' ? 1 : -1) * (e.shiftKey ? 5 : 1));
    return;
  }
  if (e.key === 'Escape' && state.tool !== 'select') { setTool('select'); return; }
  if (e.key === 'Escape' && (state.selectedId || state.selectedBlocks.length)) select(null);
}

// ------------------------------------------------------------------ wiring
function wire() {
  $('designName').addEventListener('input', (e) => {
    beginChange('name');
    state.design.name = e.target.value;
    persist();
    try { document.title = state.design.name ? 'Rafter — ' + state.design.name : 'Rafter'; } catch (err) { /* ignore */ }
  });
  $('authorName').addEventListener('input', (e) => { beginChange('author'); state.design.author = e.target.value; persist(); });
  $('dataVersion').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v) || v < 100) return;
    beginChange('dataVersion');
    state.design.dataVersion = v;
    persist();
  });
  $('dataVersion').addEventListener('blur', () => { $('dataVersion').value = state.design.dataVersion; });

  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  $('btnSave').addEventListener('click', saveJSON);
  $('btnLoad').addEventListener('click', () => $('fileLoad').click());
  $('fileLoad').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) loadJSONFile(file);
    e.target.value = '';
  });
  $('btnReset').addEventListener('click', resetToSample);

  $('btnAddBox').addEventListener('click', addBox);
  $('btnAddPillar').addEventListener('click', addPillar);
  $('btnAddSegment').addEventListener('click', addSegment);
  $('btnAutoDetails').addEventListener('click', () => autoDetails(null));
  wirePaletteWin();
  wireStudio();
  // Scale: the whole build, or the selected object, by a factor.
  const scaleEst = () => {
    const k = +$('scaleFactor').value || 1;
    const one = $('scaleScope').value === 'one';
    const n = state.grid ? state.grid.blocks.size : 0;
    $('scaleEst').textContent = one ? '' : n ? `about ${fmt(Math.round(n * k * k))} blocks` : '';
  };
  const openScale = (open) => {
    $('scaleBox').hidden = !open;
    $('btnScale').setAttribute('aria-expanded', String(open));
    if (open) {
      const sel = state.selectedId && findObject(state.selectedId);
      $('scaleScope').querySelector('[value=one]').disabled = !sel;
      if (!sel) $('scaleScope').value = 'all';
      scaleEst();
      $('scaleFactor').focus();
    }
  };
  $('btnScale').addEventListener('click', () => openScale($('scaleBox').hidden));
  $('scaleCancel').addEventListener('click', () => openScale(false));
  $('scaleFactor').addEventListener('input', scaleEst);
  $('scaleScope').addEventListener('change', scaleEst);
  for (const b of $('scaleBox').querySelectorAll('[data-scale]')) b.addEventListener('click', () => { $('scaleFactor').value = b.dataset.scale; scaleEst(); });
  $('scaleFactor').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('scaleApply').click(); if (e.key === 'Escape') openScale(false); });
  $('scaleApply').addEventListener('click', () => {
    const k = Math.min(8, Math.max(0.25, +$('scaleFactor').value || 1));
    if (k === 1) { openScale(false); return; }
    const one = $('scaleScope').value === 'one' && state.selectedId && findObject(state.selectedId) ? state.selectedId : null;
    if (one && isLocked(findObject(one))) return;
    beginChange(null);
    const { design, dropped } = scaleDesign(state.design, k, { only: one });
    state.design = design;
    afterChange();
    renderProps(true);
    openScale(false);
    if (viewer && !one) setTimeout(() => viewer && viewer.frameAll(), 400);
    const what = one ? (objectLabel(findObject(one)) || 'Object') : 'Build';
    toast(`${what} scaled ×${k}` + (dropped ? ` (${fmt(dropped)} hand-placed blocks over the limit were left out)` : ''), !!dropped, { label: 'Undo', run: undo });
  });
  $('btnPresets').addEventListener('click', (e) => openPresets(e.currentTarget));

  $('sliceSlider').addEventListener('input', (e) => setLayer(Number(e.target.value)));
  $('sliceToggle').addEventListener('change', (e) => { state.sliceOn = e.target.checked; applySlice(); });
  $('snapToggle').addEventListener('change', (e) => {
    try { localStorage.setItem('rafter.snap', e.target.checked ? '1' : '0'); } catch (err) { /* ignore */ }
    if (viewer) viewer.setSnap(e.target.checked);
  });
  $('btnFrame').addEventListener('click', () => { if (viewer) viewer.frameAll(); });
  $('layerDown').addEventListener('click', () => setLayer(state.currentLayer - 1));
  $('layerUp').addEventListener('click', () => setLayer(state.currentLayer + 1));
  $('planZoom').addEventListener('change', renderPlan);

  for (const side of ['left', 'right']) {
    for (const key of RAILS[side]) $('tab-' + key).addEventListener('click', () => setRail(side, key, { toggle: true }));
    $(side === 'left' ? 'railLeft' : 'railRight').addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const order = RAILS[side], i = order.indexOf(rails[side]);
      const next = order[(i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
      setRail(side, next);
      $('tab-' + next).focus();
    });
  }
  $('btnExportQuick').addEventListener('click', () => setRail('right', 'export'));
  $('btnPalWin').addEventListener('click', () => openPaletteWin());

  for (const b of $('toolSeg').querySelectorAll('button')) b.addEventListener('click', () => setTool(b.dataset.tool));
  for (const b of $('scopeSeg').querySelectorAll('button')) b.addEventListener('click', () => { state.paintScope = b.dataset.scope; updateToolbar(); });
  for (const b of $('shapeSeg').querySelectorAll('button')) b.addEventListener('click', () => {
    if (b.dataset.shape === 'stair' && state.shape === 'stair') { // second click turns plan stairs
      const order = ['north', 'east', 'south', 'west'];
      state.planFacing = order[(order.indexOf(state.planFacing) + 1) % 4];
    }
    state.shape = b.dataset.shape;
    if (viewer) viewer.setTool(state.tool, toolOpts());
    updateToolbar();
  });
  $('brushBtn').addEventListener('click', () => openPicker($('brushBtn'), { title: 'Brush material', keys: fullFamilies(), current: state.brush, onPick: setBrush }));
  $('btnClearEdits').addEventListener('click', clearEdits);
  // The single-file copy is already offline; only the hosted site offers the download.
  if (location.protocol === 'file:') $('offlineNote').hidden = true;
  if (SUPPORT_URL) { $('supportLink').href = SUPPORT_URL; $('supportNote').hidden = false; }
  $('planCanvas').addEventListener('pointerdown', onPlanDown);
  $('planCanvas').addEventListener('pointermove', onPlanMove);
  $('planCanvas').addEventListener('pointerup', onPlanUp);
  $('planCanvas').addEventListener('pointercancel', () => { planDrag = null; renderPlan(); });
  for (const b of $('areaSeg').querySelectorAll('button')) b.addEventListener('click', () => setArea(b.dataset.area));
  try { if (localStorage.getItem('rafter.snap') === '0') $('snapToggle').checked = false; } catch (e) { /* ignore */ }
  try { const a = localStorage.getItem('rafter.area'); state.area = a === '1' || a === 'circle'; state.circle = a === 'circle'; } catch (e) { /* ignore */ }
  try { const b = localStorage.getItem('rafter.brush'); if (b && FAMILIES[b]) state.brush = b; } catch (e) { /* ignore */ }
  updateToolbar();

  $('btnLitematic').addEventListener('click', exportLitematic);
  $('btnSchem').addEventListener('click', exportSchem);

  $('popoverSearch').addEventListener('input', filterPicker);
  $('popoverClose').addEventListener('click', closePicker);
  document.addEventListener('pointerdown', (e) => {
    const pop = $('popover');
    if (pop.hidden) return;
    if (pop.contains(e.target) || (picker.anchor && picker.anchor.contains(e.target))) return;
    closePicker();
  });
  $('confirmYes').addEventListener('click', () => { const cb = confirmCb; closeConfirm(); if (cb) cb(); });
  $('confirmCancel').addEventListener('click', closeConfirm);

  document.addEventListener('keydown', onKeyDown);

  let resizeTimer = 0;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { renderPlan(); if (!$('popover').hidden && picker.anchor) positionPopover(picker.anchor); }, 80); };
  window.addEventListener('resize', onResize);
  if (typeof ResizeObserver === 'function') new ResizeObserver(onResize).observe($('planScroll'));
  window.addEventListener('scroll', () => { if (!$('popover').hidden) closePicker(); }, { passive: true });
}

// ------------------------------------------------------------------ boot
function boot() {
  state.design = loadInitial();
  wire();
  renderHeaderFields();
  rebuildNow(true);
  startWorker();
  renderProps();
  updateHistoryButtons();
  try { Object.assign(rails, JSON.parse(localStorage.getItem('rafter.rails') || '{}')); } catch (e) { /* ignore */ }
  if (!RAILS.left.includes(rails.left)) rails.left = 'objects';
  if (!RAILS.right.includes(rails.right)) rails.right = 'plans';
  setRail('left', rails.left, { open: false });
  setRail('right', rails.right, { open: false });
  initViewer();
  // Pre-warm swatch thumbnails in idle time so the first picker opens instantly.
  const warm = () => { try { for (const k of fullFamilies()) swatchURL(k); } catch (e) { /* ignore */ } };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 3000 }); else setTimeout(warm, 1500);
}
boot();
