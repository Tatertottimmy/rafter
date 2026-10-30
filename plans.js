// plans.js — 2D layer plan drawing + per-layer legend (UI owns).
// Deliberately import-free so it can be unit-tested in Node without a DOM or the
// other modules. Names in the legend are derived from the block id; app.js
// upgrades them to FAMILIES[mat].name when blocks.js is available.

const KIND_LABEL = { full: 'block', slab: 'slab', stair: 'stairs', wall: 'wall', pane: 'pane', door: 'door', trapdoor: 'trapdoor' };

function parseKey(key) {
  const p = key.split(',');
  return [Number(p[0]), Number(p[1]), Number(p[2])];
}

// Blocks of one grid by layer: [x, z, block] per y. Built once per grid (grids are never
// changed in place), so plans and legends don't scan every block each time.
const layerCache = new WeakMap();
function layerBlocks(grid, y) {
  let idx = layerCache.get(grid);
  if (!idx) {
    idx = new Map();
    for (const [key, b] of grid.blocks) {
      const [x, by, z] = b.y !== undefined ? [b.x, b.y, b.z] : parseKey(key);
      let l = idx.get(by);
      if (!l) { l = []; idx.set(by, l); }
      l.push([x, z, b]);
    }
    layerCache.set(grid, idx);
  }
  return idx.get(y) || [];
}

function nameFromId(id, kind) {
  const base = String(id || '').replace(/^minecraft:/, '').replace(/_/g, ' ').trim();
  if (!base) return KIND_LABEL[kind] || 'block';
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function layerRange(grid) {
  if (!grid || !grid.min || !grid.max) return { minY: 0, maxY: 0 };
  return { minY: grid.min.y, maxY: grid.max.y };
}

export function layerLegend(grid, y) {
  const rows = new Map();
  if (!grid || !grid.blocks) return [];
  for (const [, , b] of layerBlocks(grid, y)) {
    let r = rows.get(b.id);
    if (!r) {
      r = { id: b.id, kind: b.kind, mat: b.mat, name: nameFromId(b.id, b.kind), count: 0, color: b.color };
      rows.set(b.id, r);
    }
    r.count++;
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ---------- colour helpers ----------

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function shade(hex, f) {
  // f < 0 darkens, f > 0 lightens (toward white)
  const [r, g, b] = hexToRgb(hex);
  const mix = (c) => Math.round(f < 0 ? c * (1 + f) : c + (255 - c) * f);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function glyphColor(hex) {
  return luminance(hex) > 0.45 ? 'rgba(20,16,12,0.72)' : 'rgba(255,250,240,0.88)';
}

function readTheme(canvas, opts) {
  const t = { bg: '#ffffff', grid: '#d9d4ca', text: '#6d675d', fg: '#1f1d1a' };
  try {
    if (typeof getComputedStyle === 'function' && canvas) {
      const cs = getComputedStyle(canvas);
      const v = (name) => cs.getPropertyValue(name).trim();
      if (v('--panel')) t.bg = v('--panel');
      if (v('--line')) t.grid = v('--line');
      if (v('--muted')) t.text = v('--muted');
      if (v('--fg')) t.fg = v('--fg');
    }
  } catch (e) { /* non-DOM environment */ }
  return Object.assign(t, (opts && opts.colors) || {});
}

// Local frame: facing north == (0,-1) on the canvas (up). Rotate a local (lx,lz)
// offset so that the local "north" lands on `facing`.
function rot(facing, lx, lz) {
  switch (facing) {
    case 'east': return [-lz, lx];
    case 'south': return [-lx, -lz];
    case 'west': return [lz, -lx];
    default: return [lx, lz];
  }
}

// Arrow polygon in local units (cell = 1), pointing "north" (up), centred on 0,0.
const ARROW = [
  [-0.09, 0.32], [-0.09, -0.06], [-0.30, -0.06], [0, -0.36], [0.30, -0.06], [0.09, -0.06], [0.09, 0.32],
];

// Quarter (centre offsets) that gets the corner dot, by stair shape, facing north.
const CORNER = {
  outer_left: [-0.25, -0.25],  // NW: the only tall quarter
  outer_right: [0.25, -0.25],  // NE
  inner_left: [0.25, 0.25],    // SE: the only low quarter
  inner_right: [-0.25, 0.25],  // SW
};

function hatch(ctx, px, py, c, color) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(px, py, c, c);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const step = Math.max(3, Math.round(c / 5));
  ctx.beginPath();
  for (let k = -c; k < c * 2; k += step) {
    ctx.moveTo(px + k, py + c);
    ctx.lineTo(px + k + c, py);
  }
  ctx.stroke();
  ctx.restore();
}

const SIDE_OPP = { north: 'south', south: 'north', east: 'west', west: 'east' };
const SIDE_CW = { north: 'east', east: 'south', south: 'west', west: 'north' };
const SIDE_CCW = { north: 'west', west: 'south', south: 'east', east: 'north' };
/** Which side of its cell a door or open trapdoor's panel stands on (null: lying flat). */
function panelSide(b) {
  const p = b.props || {}, f = SIDE_OPP[p.facing] ? p.facing : 'north';
  if (b.kind === 'trapdoor') return p.open === 'true' ? SIDE_OPP[f] : null;
  return p.open !== 'true' ? SIDE_OPP[f] : p.hinge === 'right' ? SIDE_CW[f] : SIDE_CCW[f];
}

function drawBlock(ctx, b, px, py, c) {
  const color = b.color || '#888888';
  const gc = glyphColor(color);
  const border = shade(color, -0.35);

  if (b.kind === 'pane') {
    const p = b.props || {};
    const t = Math.max(2, Math.round(c * 0.18)), m = (c - t) / 2;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(px, py, c, c);
    ctx.globalAlpha = 1;
    ctx.fillStyle = border;
    const ew = p.east === 'true' || p.west === 'true', ns = p.north === 'true' || p.south === 'true';
    if (ew || !ns) ctx.fillRect(px + (p.west === 'true' ? 0 : m), py + m, (p.west === 'true' ? m : 0) + t + (p.east === 'true' ? m : 0), t);
    if (ns) ctx.fillRect(px + m, py + (p.north === 'true' ? 0 : m), t, (p.north === 'true' ? m : 0) + t + (p.south === 'true' ? m : 0));
    return;
  }

  if (b.kind === 'door' || b.kind === 'trapdoor') {
    // Faint cell with the panel drawn where it stands; a closed trapdoor is a faint full square.
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(px, py, c, c);
    ctx.globalAlpha = 1;
    ctx.fillStyle = b.kind === 'door' ? border : color;
    const side = panelSide(b), t = Math.max(2, Math.round(c * 0.19));
    if (side === 'north') ctx.fillRect(px, py, c, t);
    else if (side === 'south') ctx.fillRect(px, py + c - t, c, t);
    else if (side === 'west') ctx.fillRect(px, py, t, c);
    else if (side === 'east') ctx.fillRect(px + c - t, py, t, c);
    if (b.kind === 'trapdoor' && b.props && b.props.open !== 'true') { ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.strokeRect(px + 0.5, py + 0.5, c - 1, c - 1); }
    return;
  }

  if (b.kind === 'wall') {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(px, py, c, c);
    ctx.globalAlpha = 1;
    const s = c * 0.5;
    ctx.fillStyle = color;
    ctx.fillRect(px + (c - s) / 2, py + (c - s) / 2, s, s);
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.strokeRect(px + (c - s) / 2 + 0.5, py + (c - s) / 2 + 0.5, s - 1, s - 1);
    return;
  }

  ctx.fillStyle = color;
  ctx.fillRect(px, py, c, c);
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 0.5, py + 0.5, c - 1, c - 1);

  if (b.kind === 'slab') {
    hatch(ctx, px + 1, py + 1, c - 2, gc);
    const top = b.props && b.props.type === 'top';
    if (top) {
      ctx.fillStyle = gc;
      ctx.fillRect(px + 1, py + 1, c - 2, Math.max(2, Math.round(c * 0.2)));
    }
    return;
  }

  if (b.kind === 'stair') {
    const facing = (b.props && b.props.facing) || 'north';
    const half = (b.props && b.props.half) || 'bottom';
    const shape = (b.props && b.props.shape) || 'straight';
    const cx = px + c / 2, cy = py + c / 2;
    ctx.beginPath();
    ARROW.forEach(([lx, lz], i) => {
      const [rx, rz] = rot(facing, lx, lz);
      if (i === 0) ctx.moveTo(cx + rx * c, cy + rz * c);
      else ctx.lineTo(cx + rx * c, cy + rz * c);
    });
    ctx.closePath();
    if (half === 'top') {
      ctx.strokeStyle = gc;
      ctx.lineWidth = Math.max(1.25, c / 14);
      ctx.lineJoin = 'round';
      ctx.stroke();
    } else {
      ctx.fillStyle = gc;
      ctx.fill();
    }
    const q = CORNER[shape];
    if (q) {
      const [rx, rz] = rot(facing, q[0], q[1]);
      const r = Math.max(1.5, c * 0.09);
      ctx.beginPath();
      ctx.arc(cx + rx * c, cy + rz * c, r, 0, Math.PI * 2);
      if (shape.startsWith('outer')) {
        ctx.fillStyle = gc;
        ctx.fill();
      } else {
        ctx.strokeStyle = gc;
        ctx.lineWidth = Math.max(1, c / 18);
        ctx.stroke();
      }
    }
  }
}

export function drawLayer(canvas, grid, y, opts = {}) {
  const cell = Math.max(4, opts.cell || 22);
  const gb = grid && grid.min && grid.max ? grid : { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, blocks: new Map() };
  const bounds = opts.bounds || { minX: gb.min.x, maxX: gb.max.x, minZ: gb.min.z, maxZ: gb.max.z };
  const ghostBelow = opts.ghostBelow !== false;
  const showGrid = opts.showGrid !== false;
  const cols = Math.max(1, bounds.maxX - bounds.minX + 1);
  const rows = Math.max(1, bounds.maxZ - bounds.minZ + 1);

  const ML = 30, MT = 20, MR = 8, MB = 8;
  const cssW = ML + cols * cell + MR;
  const cssH = MT + rows * cell + MB;
  const dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const theme = readTheme(canvas, opts);

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  const toPx = (x) => ML + (x - bounds.minX) * cell;
  const toPy = (z) => MT + (z - bounds.minZ) * cell;
  const inBounds = (x, z) => x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;

  // grid lines
  if (showGrid) {
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= cols; i++) {
      const px = ML + i * cell + 0.5;
      ctx.moveTo(px, MT); ctx.lineTo(px, MT + rows * cell);
    }
    for (let j = 0; j <= rows; j++) {
      const py = MT + j * cell + 0.5;
      ctx.moveTo(ML, py); ctx.lineTo(ML + cols * cell, py);
    }
    ctx.stroke();
  }

  // ghost of the layer below
  if (ghostBelow && gb.blocks) {
    ctx.globalAlpha = 0.22;
    for (const [x, z, b] of layerBlocks(gb, y - 1)) {
      if (!inBounds(x, z)) continue;
      ctx.fillStyle = b.color || '#888888';
      ctx.fillRect(toPx(x) + 1, toPy(z) + 1, cell - 2, cell - 2);
    }
    ctx.globalAlpha = 1;
  }

  // blocks on this layer
  if (gb.blocks) {
    for (const [x, z, b] of layerBlocks(gb, y)) {
      if (!inBounds(x, z)) continue;
      drawBlock(ctx, b, toPx(x), toPy(z), cell);
    }
  }

  // labels every 5th absolute column / row
  ctx.fillStyle = theme.text;
  ctx.font = `${Math.max(9, Math.min(11, Math.round(cell * 0.5)))}px "IBM Plex Mono", ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    if (x % 5 !== 0) continue;
    ctx.fillText(String(x), toPx(x) + cell / 2, MT / 2);
  }
  ctx.textAlign = 'right';
  for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
    if (z % 5 !== 0) continue;
    ctx.fillText(String(z), ML - 4, toPy(z) + cell / 2);
  }
  // north indicator in the corner
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.fg;
  ctx.font = `bold 9px "IBM Plex Sans", system-ui, sans-serif`;
  ctx.fillText('N↑', 3, MT / 2);
}
