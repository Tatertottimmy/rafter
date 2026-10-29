// app.js — Rafter UI: state, panels, wiring, persistence, downloads. (UI owns)
import { FAMILIES, roofFamilies, fullFamilies, GROUP_ORDER } from './blocks.js';
import { buildGrid, defaultDesign, materialTotals, newId, inOutline, validateDesign, rotatePatch, suggestVariants, blockKey, DETAIL_DEFAULTS, VARIATION_DEFAULTS, UPTURN_TYPES } from './engine.js';
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
  return null;
}
function objectLabel(f) {
  if (!f) return '';
  if (f.kind === 'box') return f.obj.name || f.obj.id;
  if (f.kind === 'pillar') return 'Pillar ' + f.obj.id;
  if (f.kind === 'fill') return 'Fill ' + f.obj.id;
  return 'Wall ' + f.obj.id;
}
function objectMaterial(f) {
  return f.kind === 'box' ? f.obj.roof.material : f.obj.material;
}
function safeValidate(design) {
  try { return validateDesign(design) || design; } catch (e) { console.warn('validateDesign failed', e); return design; }
}
function normalizeDesign(design) {
  const d = safeValidate(design);
  d.boxes = d.boxes || []; d.pillars = d.pillars || []; d.segments = d.segments || []; d.fills = d.fills || [];
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
  rebuildNow(true);
  renderHeaderFields();
  renderProps(true);
  if (viewer) viewer.setSelection(state.selectedId);
  updateHistoryButtons();
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
let rebuildTimer = 0;
let pendingStructural = false;
function scheduleRebuild(structural = true) {
  pendingStructural = pendingStructural || structural;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuildNow(), 30);
}
function flushRebuild() {
  if (rebuildTimer) rebuildNow();
}
function rebuildNow(structural) {
  clearTimeout(rebuildTimer);
  rebuildTimer = 0;
  const doStructural = structural === true || pendingStructural;
  pendingStructural = false;
  try {
    state.grid = buildGrid(state.design);
  } catch (e) {
    console.error(e);
    toast('Could not build the design: ' + (e.message || e), true);
    return;
  }
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
  renderStatus();
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
  scheduleRebuild(false);
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
  if (viewer && !opts.fromViewer) viewer.setSelection(id);
  renderObjectList();
  renderProps(!changed);
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
  bar.replaceChildren(h('span', { class: 'palette-label' }, 'Palette'));
  for (const [key, u] of entries) {
    const chip = h('button', {
      class: 'chip', id: 'chip-' + key, type: 'button', 'aria-haspopup': 'dialog',
      title: `Replace ${famName(key)} everywhere in the design`,
    }, iconEl(key, 22), h('span', { text: famName(key) }), h('span', { class: 'count', text: fmt(u.count) }));
    chip.addEventListener('click', () => openPicker(chip, {
      title: `Replace ${famName(key)} everywhere`,
      keys: fullFamilies(),
      current: key,
      hint: u.roof ? ROOF_HINT : null,
      onPick: (to) => swapFamily(key, to),
    }));
    bar.append(chip);
  }
}
// [detail flag(s), material key]: a material only counts as "used" while its detail is on.
const DETAIL_MATS = [[['trim', 'ridge'], 'trimMat'], [['corners'], 'cornerMat'], [['base'], 'baseMat'], [['beams'], 'beamMat'], [['windows'], 'windowMat']];
const flagOn = (b, flags) => !!b.details && flags.some((k) => b.details[k]);
function swapFamily(from, to) {
  if (from === to) return;
  beginChange(null);
  for (const b of state.design.boxes) {
    if (b.roof.material === from) b.roof.material = to;
    if (b.wallMaterial === from) b.wallMaterial = to;
    for (const [flag, mk] of DETAIL_MATS) if (flagOn(b, flag) && b.details[mk] === from) b.details[mk] = to;
  }
  for (const p of state.design.pillars) if (p.material === from) p.material = to;
  for (const s of state.design.segments) if (s.material === from) s.material = to;
  for (const f of state.design.fills) if (f.material === from) f.material = to;
  afterChange();
  renderProps(true);
  toast(`${famName(from)} → ${famName(to)}`);
}

// ------------------------------------------------------------------ object list
function renderObjectList() {
  const ul = $('objectList');
  const focusedId = document.activeElement && ul.contains(document.activeElement) ? document.activeElement.id : null;
  ul.replaceChildren();
  const d = state.design;
  $('objectCount').textContent = String(d.boxes.length + d.pillars.length + d.segments.length + d.fills.length);
  const groups = [
    ['Boxes', d.boxes, 'box'],
    ['Pillars', d.pillars, 'pillar'],
    ['Wall segments', d.segments, 'segment'],
    ['Fills', d.fills, 'fill'],
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
      else meta = `(${o.x0},${o.z0})→(${o.x1},${o.z1})`;
      const btn = h('button', {
        class: 'obj', id: 'obj-' + o.id, type: 'button',
        'aria-pressed': String(o.id === state.selectedId),
      }, iconEl(objectMaterial(f), 22), h('span', { class: 'obj-name', text: objectLabel(f) }), h('span', { class: 'obj-meta', text: meta }));
      btn.addEventListener('click', () => select(o.id));
      ul.append(h('li', {}, btn));
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
const VAR = (k) => (o) => !!(o.variation && o.variation[k] > 0);
const STYLE_OPTIONS = [['patches', 'Patches'], ['scatter', 'Scatter'], ['grime', 'Grime (heavier low down)'], ['streaks', 'Streaks (drip marks)']];
const autoMix = (from, i) => (o) => { const v = suggestVariants(getPath(o, from)); return v[i] || v[0] || null; };
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
      { path: ['variation', 'wall'], label: 'Wall variation', type: 'range', min: 0, max: 80, step: 5, unit: '%', wide: true },
      { path: ['variation', 'roof'], label: 'Roof variation', type: 'range', min: 0, max: 80, step: 5, unit: '%', wide: true },
      { path: ['variation', 'style'], label: 'Pattern', type: 'select', options: STYLE_OPTIONS, wide: true, show: (o) => VAR('wall')(o) || VAR('roof')(o) },
      { path: ['variation', 'wallMix'], label: 'Wall mix 1', type: 'material', auto: autoMix(['wallMaterial'], 0), wide: true, show: VAR('wall') },
      { path: ['variation', 'wallMix2'], label: 'Wall mix 2', type: 'material', auto: autoMix(['wallMaterial'], 1), wide: true, show: VAR('wall') },
      { path: ['variation', 'roofMix'], label: 'Roof mix 1', type: 'material', auto: autoMix(['roof', 'material'], 0), roof: true, wide: true, show: VAR('roof') },
      { path: ['variation', 'roofMix2'], label: 'Roof mix 2', type: 'material', auto: autoMix(['roof', 'material'], 1), roof: true, wide: true, show: VAR('roof') },
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
const getPath = (o, path) => path.reduce((a, k) => (a == null ? undefined : a[k]), o);
const setPath = (o, path, v) => { let a = o; for (let i = 0; i < path.length - 1; i++) a = a[path[i]]; a[path[path.length - 1]] = v; };
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
  $('propsTitle').textContent = { box: 'Box', pillar: 'Pillar', segment: 'Wall segment', fill: 'Fill' }[f.kind];
  $('propsId').textContent = f.obj.id;
  body.replaceChildren();

  for (const group of SCHEMA[f.kind]) {
    const fs = h('fieldset', { class: 'group', id: 'group-' + group.group.replace(/\W+/g, '-').toLowerCase() }, h('legend', { text: group.group }));
    const grid = h('div', { class: 'fields' });
    for (const field of group.fields) grid.append(buildField(f, field));
    fs.append(grid);
    body.append(fs);
  }
  if (f.kind === 'segment') {
    body.append(h('p', { class: 'hint', id: 'prop-segment-note', hidden: true, text: 'Not axis-aligned: the engine builds x0…x1 along z0.' }));
  }
  body.append(h('div', { class: 'props-actions' },
    f.kind === 'pillar' ? null : h('button', { class: 'btn small', id: 'prop-rotate', type: 'button', text: 'Rotate 90°', title: 'Rotate clockwise (R, Shift+R for counter-clockwise). Or drag the round handle in the 3D view.', onclick: () => rotateSelected(1) }),
    h('button', { class: 'btn danger small', id: 'prop-delete', type: 'button', text: 'Delete', onclick: () => requestDelete(f.obj.id) })));
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
    c.id = newId(d, { box: 'b', pillar: 'p', segment: 's', fill: 'f' }[f.kind], new Set(made));
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
  const label = h('label', { for: id, text: field.label });
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
      input = h('select', { id }, field.options.map(([v, l]) => h('option', { value: String(v), text: l })));
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
  const shape = { slab: 'slab', stair: 'stairs', pane: 'pane' }[ex.edit.shape] || ''; // full blocks: the name alone
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
  const anyStair = cells.some((c) => { const ex = placedEdit(c); return ex && (ex.edit.shape === 'stair' || ex.edit.shape === 'pane'); });
  body.replaceChildren(
    h('ul', { class: 'legend block-list' }, rows, cells.length > 12 ? h('li', { class: 'empty', text: '+ ' + (cells.length - 12) + ' more' }) : null),
    h('p', { class: 'hint', text: 'Drag to move, or use the arrow keys (Shift = 5) and Page Up / Page Down. Shift+click adds more blocks, Alt+drag selects a rectangle. Delete removes them' + (anyStair ? ', R turns stairs.' : '.') }),
    h('div', { class: 'props-actions' },
      h('button', { class: 'btn small', type: 'button', id: 'block-up', text: 'Up ↑', title: 'Raise one block (Page Up)', onclick: () => nudgeBlocks(0, 1, 0) }),
      h('button', { class: 'btn small', type: 'button', id: 'block-down', text: 'Down ↓', title: 'Lower one block (Page Down)', onclick: () => nudgeBlocks(0, -1, 0) }),
      fillable(cells) ? h('button', { class: 'btn small', type: 'button', id: 'block-fill', text: 'Make fill', title: 'Turn these blocks into one fill you can move and resize like a box', onclick: () => blocksToFill() }) : null,
      anyStair ? h('button', { class: 'btn small', type: 'button', id: 'block-rotate', text: 'Turn', title: 'Turn stairs and panes (R)', onclick: () => rotateSelectedBlocks() }) : null,
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
  const stairs = state.selectedBlocks.map(placedEdit).filter((ex) => ex && (ex.edit.shape === 'stair' || ex.edit.shape === 'pane'));
  if (!stairs.length) return;
  beginChange('turn-blocks');
  for (const ex of stairs) {
    if (ex.edit.shape === 'pane') ex.edit.axis = ex.edit.axis === 'x' ? 'z' : 'x';
    else ex.edit.facing = turn[ex.edit.facing] || 'north';
  }
  afterChange();
}

function requestDelete(id) {
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
};
const AREA_HINTS = {
  paint: 'Drag a rectangle to repaint every block on that layer · click for one block · right-drag to orbit',
  place: 'Drag a rectangle (Shift = square) to make a fill (one object you can move and resize later) · click for one block · Alt+drag selects · right-drag to orbit',
  erase: 'Drag a rectangle to clear every block on that layer · click for one block · right-drag to orbit',
};
const AREA_MAX = 128 * 128;
const FILL_MAX = 256 * 256 * 8;
const toolOpts = () => ({ shape: state.shape, area: state.area, circle: state.area && state.circle });
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
  state.tool = tool;
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
  $('areaSeg').hidden = t === 'select';
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
  $('toolHint').textContent = ((state.area ? AREA_HINTS[t] : TOOL_HINTS[t]) || '').replace(/rectangle \(Shift = square\)|rectangle/, (m) => (state.area && state.circle ? 'circle' + (m.length > 9 ? ' (Shift = round)' : '') : m));
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
  const at = info.cell && g.blocks.get(blockKey(...info.cell));
  if (mods.alt) {
    if (at) { setBrush(at.mat); toast('Brush: ' + famName(at.mat)); }
    return;
  }
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
  f.obj.variation.seed = 1 + Math.floor(Math.random() * 999998);
  afterChange();
}

function rotateSelected(q) {
  const f = findObject(state.selectedId);
  if (!f || f.kind === 'pillar') return;
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
  if (!f) return;
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
    variation: b && b.variation ? { ...b.variation } : null,
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
    for (const k of ['wallMix', 'wallMix2', 'roofMix', 'roofMix2']) if (va[k] && !FAMILIES[va[k]]) va[k] = '';
    b.variation = { ...va, seed: (b.variation && b.variation.seed) || 1 };
  }
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
  if (!state.grid || $('panePlans').hidden) return;
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
const TABS = { plans: ['tabPlans', 'panePlans'], materials: ['tabMaterials', 'paneMaterials'], export: ['tabExport', 'paneExport'] };
function setTab(name) {
  state.tab = name;
  for (const [key, [tabId, paneId]] of Object.entries(TABS)) {
    const on = key === name;
    $(tabId).setAttribute('aria-selected', String(on));
    $(tabId).tabIndex = on ? 0 : -1;
    $(paneId).hidden = !on;
  }
  if (name === 'plans') { renderPlan(); renderLegend(); }
}

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
  flushRebuild();
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
  flushRebuild();
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
  const toolKey = { v: 'select', b: 'paint', p: 'place', e: 'erase' }[k];
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
  $('btnPresets').addEventListener('click', (e) => openPresets(e.currentTarget));

  $('sliceSlider').addEventListener('input', (e) => setLayer(Number(e.target.value)));
  $('sliceToggle').addEventListener('change', (e) => { state.sliceOn = e.target.checked; applySlice(); });
  $('btnFrame').addEventListener('click', () => { if (viewer) viewer.frameAll(); });
  $('layerDown').addEventListener('click', () => setLayer(state.currentLayer - 1));
  $('layerUp').addEventListener('click', () => setLayer(state.currentLayer + 1));
  $('planZoom').addEventListener('change', renderPlan);

  for (const [name, [tabId]] of Object.entries(TABS)) $(tabId).addEventListener('click', () => setTab(name));
  $('rightPanel').querySelector('.tabs').addEventListener('keydown', (e) => {
    const order = Object.keys(TABS);
    const i = order.indexOf(state.tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
      setTab(next);
      $(TABS[next][0]).focus();
    }
  });

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
  renderProps();
  updateHistoryButtons();
  setTab('plans');
  initViewer();
  // Pre-warm swatch thumbnails in idle time so the first picker opens instantly.
  const warm = () => { try { for (const k of fullFamilies()) swatchURL(k); } catch (e) { /* ignore */ } };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 3000 }); else setTimeout(warm, 1500);
}
boot();
