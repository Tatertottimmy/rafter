// textures.js — procedural 64x64 Minecraft-like block textures per family.
// Shared by viewer3d.js (CanvasTexture maps) and the UI (swatches / palette icons).
// No three.js import. Only DOM use: document.createElement('canvas').
import { FAMILIES } from './blocks.js';

export const SIZE = 64;

/** Every pattern value allowed by SPEC (blocks.js FAMILIES[key].pattern). */
export const patternNames = [
  'planks', 'bricks', 'stone_bricks', 'cobble', 'stone', 'smooth', 'log', 'tiles',
  'copper', 'prismarine', 'wool', 'concrete', 'terracotta', 'quartz', 'purpur', 'mud', 'sandstone',
  'glass', 'ore', 'leaves', 'glazed', 'grainy', 'metal', 'chiseled', 'grate',
];

// ---------------------------------------------------------------------------
// Pure helpers (no DOM) — exported so node tests can exercise them.
// ---------------------------------------------------------------------------

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 seeded PRNG -> function returning [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hexToRgb(hex) {
  if (typeof hex !== 'string') return [128, 128, 128];
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [128, 128, 128];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t) => t * t * (3 - 2 * t);

/** Smooth value noise in [0,1], lattice of `cells` cells across S pixels (tileable). */
function valueNoise(rng, S, cells) {
  const lat = new Float32Array(cells * cells);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();
  const out = new Float32Array(S * S);
  const step = S / cells;
  for (let y = 0; y < S; y++) {
    const fy = y / step, iy = Math.floor(fy), ty = smooth(fy - iy);
    const y0 = iy % cells, y1 = (iy + 1) % cells;
    for (let x = 0; x < S; x++) {
      const fx = x / step, ix = Math.floor(fx), tx = smooth(fx - ix);
      const x0 = ix % cells, x1 = (ix + 1) % cells;
      const a = lat[y0 * cells + x0], b = lat[y0 * cells + x1];
      const c = lat[y1 * cells + x0], d = lat[y1 * cells + x1];
      out[y * S + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

function addSmooth(f, rng, S, cells, amp) {
  const n = valueNoise(rng, S, cells);
  for (let i = 0; i < f.length; i++) f[i] *= 1 + (n[i] * 2 - 1) * amp;
}
function addFine(f, rng, amp) {
  for (let i = 0; i < f.length; i++) f[i] *= 1 + (rng() * 2 - 1) * amp;
}
function mul(f, S, x, y, v) {
  x = ((x % S) + S) % S; y = ((y % S) + S) % S;
  f[y * S + x] *= v;
}
function rect(f, S, x0, y0, x1, y1, v) { // multiply a rect [x0,x1)×[y0,y1)
  for (let y = Math.max(0, y0); y < Math.min(S, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(S, x1); x++) f[y * S + x] *= v;
}

/** Voronoi helper: nearest/second-nearest seed (toroidal) for every pixel. */
function voronoi(S, pts) {
  const near = new Int32Array(S * S), d1 = new Float32Array(S * S), d2 = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let b1 = Infinity, b2 = Infinity, bi = 0;
    for (let i = 0; i < pts.length; i++) {
      let dx = Math.abs(x - pts[i][0]); if (dx > S / 2) dx = S - dx;
      let dz = Math.abs(y - pts[i][1]); if (dz > S / 2) dz = S - dz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < b1) { b2 = b1; b1 = d; bi = i; } else if (d < b2) b2 = d;
    }
    const k = y * S + x; near[k] = bi; d1[k] = b1; d2[k] = b2;
  }
  return { near, d1, d2 };
}

const SEAM = 0.75;   // ~25% darker
const HI = 1.10;     // ~10% lighter

const PATTERNS = {
  planks(f, S, rng) {
    const bh = S / 4;
    for (let b = 0; b < 4; b++) {
      const y0 = b * bh;
      const tone = 1 + (rng() - 0.5) * 0.12;
      rect(f, S, 0, y0, S, y0 + bh, tone);
      rect(f, S, 0, y0, S, y0 + 1, SEAM);        // dark seam between boards
      rect(f, S, 0, y0 + 1, S, y0 + 2, HI);      // light edge below the seam
      rect(f, S, 0, y0 + bh - 1, S, y0 + bh, 0.92);
      const ex = Math.floor(8 + rng() * (S - 16)); // board end
      rect(f, S, ex, y0 + 1, ex + 1, y0 + bh, SEAM);
      rect(f, S, ex + 1, y0 + 1, ex + 2, y0 + bh, 1.06);
      // grain: 1D noise along x, slowly drifting per row
      const g = valueNoise(rng, S, 8);
      for (let y = y0 + 2; y < y0 + bh - 1; y++) for (let x = 0; x < S; x++) {
        const gx = (x + Math.floor((y - y0) * 0.5)) % S;
        f[y * S + x] *= 1 + (g[((y - y0) % 4) * S + gx] * 2 - 1) * 0.05;
      }
    }
    addFine(f, rng, 0.03);
  },

  bricks(f, S, rng) {
    const bh = 8, bw = 16;
    for (let r = 0; r < S / bh; r++) {
      const off = (r % 2) * (bw / 2);
      for (let c = -1; c < S / bw + 1; c++) {
        const x0 = c * bw + off;
        rect(f, S, x0, r * bh, x0 + bw, r * bh + bh, 1 + (rng() - 0.5) * 0.16);
        rect(f, S, x0 + bw - 1, r * bh, x0 + bw, r * bh + bh, SEAM);  // vertical mortar
        rect(f, S, x0, r * bh, x0 + 1, r * bh + 1, HI);               // highlight corner
      }
      rect(f, S, 0, r * bh + bh - 1, S, r * bh + bh, SEAM);          // horizontal mortar
    }
    addFine(f, rng, 0.04);
  },

  stone_bricks(f, S, rng) {
    const b = S / 2;
    for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
      const x0 = c * b, y0 = r * b;
      rect(f, S, x0, y0, x0 + b, y0 + b, 1 + (rng() - 0.5) * 0.1);
      rect(f, S, x0, y0, x0 + b, y0 + 1, SEAM);          // top mortar
      rect(f, S, x0, y0, x0 + 1, y0 + b, SEAM);          // left mortar
      rect(f, S, x0 + 1, y0 + 1, x0 + b, y0 + 2, HI);    // bevel highlight
      rect(f, S, x0 + 1, y0 + 1, x0 + 2, y0 + b, HI);
      rect(f, S, x0 + 1, y0 + b - 1, x0 + b, y0 + b, 0.9);
      rect(f, S, x0 + b - 1, y0 + 1, x0 + b, y0 + b, 0.9);
    }
    addSmooth(f, rng, S, 8, 0.06);
    addFine(f, rng, 0.035);
  },

  cobble(f, S, rng) {
    const pts = [];
    for (let i = 0; i < 14; i++) pts.push([rng() * S, rng() * S]);
    const tone = pts.map(() => 1 + (rng() - 0.5) * 0.3);
    const { near, d1, d2 } = voronoi(S, pts);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const k = y * S + x, i = near[k];
      let v = tone[i];
      // light from top-left: shade by position relative to the stone centre
      let dx = x - pts[i][0]; if (dx > S / 2) dx -= S; if (dx < -S / 2) dx += S;
      let dy = y - pts[i][1]; if (dy > S / 2) dy -= S; if (dy < -S / 2) dy += S;
      v *= 1 - (dx + dy) * 0.006;
      if (d2[k] - d1[k] < 1.8) v *= 0.6;          // dark gap between stones
      else if (d2[k] - d1[k] < 3.2) v *= 0.85;
      f[k] *= v;
    }
    addSmooth(f, rng, S, 8, 0.05);
    addFine(f, rng, 0.04);
  },

  stone(f, S, rng) {
    addSmooth(f, rng, S, 4, 0.08);
    addSmooth(f, rng, S, 10, 0.08);
    addFine(f, rng, 0.04);
  },

  smooth(f, S, rng) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) f[y * S + x] *= 1.03 - (y / S) * 0.06;
    addFine(f, rng, 0.012);
  },

  log(f, S, rng) {
    const col = valueNoise(rng, S, 16); // use first row as 1D column noise
    for (let x = 0; x < S; x++) {
      const v = 1 + (col[x] * 2 - 1) * 0.12;
      rect(f, S, x, 0, x + 1, S, v);
    }
    for (let i = 0; i < 26; i++) {  // vertical bark streaks
      const x = Math.floor(rng() * S), y0 = Math.floor(rng() * S), len = 6 + Math.floor(rng() * 26);
      const v = rng() < 0.6 ? 0.76 : 1.12;
      for (let y = y0; y < y0 + len; y++) mul(f, S, x, y, v);
    }
    addFine(f, rng, 0.03);
  },

  tiles(f, S, rng) {
    const t = 16;
    for (let r = 0; r < S / t; r++) {
      const off = (r * 6) % t; // stepped offset per row
      for (let c = -1; c < S / t + 1; c++) {
        const x0 = c * t + off, y0 = r * t;
        rect(f, S, x0, y0, x0 + t, y0 + t, 1 + (rng() - 0.5) * 0.14);
        rect(f, S, x0, y0, x0 + t, y0 + 1, SEAM);
        rect(f, S, x0, y0, x0 + 1, y0 + t, SEAM);
        rect(f, S, x0 + 1, y0 + 1, x0 + t, y0 + 2, HI);
        rect(f, S, x0 + 1, y0 + 1, x0 + 2, y0 + t, HI);
      }
    }
    addSmooth(f, rng, S, 8, 0.05);
    addFine(f, rng, 0.03);
  },

  copper(f, S, rng) {
    const p = S / 2;
    for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
      const x0 = c * p, y0 = r * p;
      rect(f, S, x0, y0, x0 + p, y0 + p, 1 + (rng() - 0.5) * 0.08);
      rect(f, S, x0, y0, x0 + p, y0 + 1, SEAM);
      rect(f, S, x0, y0, x0 + 1, y0 + p, SEAM);
      rect(f, S, x0 + 1, y0 + 1, x0 + p, y0 + 2, HI);
      rect(f, S, x0 + 1, y0 + 1, x0 + 2, y0 + p, HI);
      rect(f, S, x0 + 1, y0 + p - 1, x0 + p, y0 + p, 0.9);
      rect(f, S, x0 + p - 1, y0 + 1, x0 + p, y0 + p, 0.9);
      for (const [rx, ry] of [[4, 4], [p - 6, 4], [4, p - 6], [p - 6, p - 6]]) { // rivets
        rect(f, S, x0 + rx, y0 + ry, x0 + rx + 2, y0 + ry + 2, 0.72);
        mul(f, S, x0 + rx, y0 + ry, 1.6);
      }
    }
    addSmooth(f, rng, S, 8, 0.04);
    addFine(f, rng, 0.02);
  },

  prismarine(f, S, rng) {
    const pts = [];
    const n = 8, cell = S / n;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++)
      pts.push([(i + 0.5) * cell + (rng() - 0.5) * 4, (j + 0.5) * cell + (rng() - 0.5) * 4]);
    const tone = pts.map(() => 1 + (rng() - 0.5) * 0.26);
    const { near, d1, d2 } = voronoi(S, pts);
    for (let k = 0; k < S * S; k++) {
      let v = tone[near[k]];
      if (d2[k] - d1[k] < 1.6) v *= 1.18; // light grout (prismarine has pale seams)
      f[k] *= v;
    }
    addFine(f, rng, 0.03);
  },

  wool(f, S, rng) {
    addSmooth(f, rng, S, 16, 0.07);
    addFine(f, rng, 0.08);
    for (let i = 0; i < 40; i++) { // fluffy strands
      let x = Math.floor(rng() * S), y = Math.floor(rng() * S);
      const v = rng() < 0.5 ? 0.9 : 1.1;
      for (let s = 0; s < 5; s++) { mul(f, S, x, y, v); x += rng() < 0.5 ? 1 : 0; y += rng() < 0.7 ? 1 : -1; }
    }
  },

  concrete(f, S, rng) {
    addFine(f, rng, 0.02);
  },

  terracotta(f, S, rng) {
    addSmooth(f, rng, S, 6, 0.07);
    addSmooth(f, rng, S, 16, 0.03);
    addFine(f, rng, 0.02);
  },

  quartz(f, S, rng) {
    rect(f, S, 0, 0, S, 1, 0.92);
    rect(f, S, 0, 0, 1, S, 0.92);
    rect(f, S, 0, S - 1, S, S, 0.95);
    rect(f, S, S - 1, 0, S, S, 0.95);
    rect(f, S, 1, 1, S - 1, 2, 1.04);
    rect(f, S, 1, 1, 2, S - 1, 1.04);
    addSmooth(f, rng, S, 4, 0.025);
    addFine(f, rng, 0.012);
  },

  purpur(f, S, rng) {
    const c = 16;
    for (let r = 0; r < S / c; r++) for (let q = 0; q < S / c; q++) {
      const x0 = q * c, y0 = r * c, tone = 1 + (rng() - 0.5) * 0.08;
      for (let y = 0; y < c; y++) for (let x = 0; x < c; x++) {
        const dx = x - c / 2 + 0.5, dy = y - c / 2 + 0.5;
        const d = Math.sqrt(dx * dx + dy * dy) / (c / 2);
        let v = tone * (1 + 0.1 * clamp01(1 - d)) * (1 - (dx + dy) * 0.007);
        if (x === 0 || y === 0) v *= 0.82;
        f[(y0 + y) * S + x0 + x] *= v;
      }
    }
    addFine(f, rng, 0.03);
  },

  mud(f, S, rng) {
    const bh = 8;
    for (let r = 0; r < S / bh; r++) {
      const y0 = r * bh;
      let x = -Math.floor(rng() * 10);
      while (x < S) {
        const w = 10 + Math.floor(rng() * 11);
        rect(f, S, x, y0, x + w, y0 + bh, 1 + (rng() - 0.5) * 0.18);
        rect(f, S, x + w - 1, y0, x + w, y0 + bh, 0.7);
        // rounded corners: darken corner pixels
        mul(f, S, x, y0, 0.8); mul(f, S, x + w - 2, y0, 0.8);
        mul(f, S, x, y0 + bh - 2, 0.8); mul(f, S, x + w - 2, y0 + bh - 2, 0.8);
        x += w;
      }
      rect(f, S, 0, y0 + bh - 1, S, y0 + bh, 0.7);
    }
    addSmooth(f, rng, S, 8, 0.05);
    addFine(f, rng, 0.03);
  },

  // Patterns below may also write `m` (0..1 mix toward the family's color2) and `a` (alpha 0..1).
  glass(f, S, rng, m, a) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const k = y * S + x;
      const edge = x < 3 || y < 3 || x >= S - 3 || y >= S - 3;
      if (edge) { f[k] *= x < 3 || y < 3 ? 1.12 : 0.85; a[k] = 0.95; }
      else a[k] = 0.28;
    }
    for (let i = 0; i < 3; i++) { // diagonal glints
      const o = 10 + Math.floor(rng() * (S - 30));
      for (let t = 0; t < 10; t++) { const k = (o + t) * S + (o - t + 12); if (k >= 0 && k < f.length) { f[k] *= 1.25; a[k] = 0.7; } }
    }
  },
  ore(f, S, rng, m) {
    PATTERNS.stone(f, S, rng);
    for (let i = 0; i < 7; i++) { // flecks: little blobs of 3..8 px
      let x = Math.floor(rng() * S), y = Math.floor(rng() * S);
      const n = 3 + Math.floor(rng() * 6);
      for (let j = 0; j < n; j++) {
        const xx = ((x % S) + S) % S, yy = ((y % S) + S) % S, k = yy * S + xx;
        m[k] = 1; f[k] = j === 0 ? 1.15 : 1 - rng() * 0.2;
        if (rng() < 0.5) x += rng() < 0.5 ? 1 : -1; else y += rng() < 0.5 ? 1 : -1;
      }
    }
  },
  leaves(f, S, rng) {
    addSmooth(f, rng, S, 16, 0.18);
    for (let i = 0; i < f.length; i++) { const r = rng(); if (r < 0.12) f[i] *= 0.45; else if (r < 0.2) f[i] *= 1.2; }
  },
  glazed(f, S, rng, m) {
    // Four rotated quarter motifs: concentric arcs mixing into color2.
    const h = S / 2;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const qx = x < h ? x : S - 1 - x, qy = y < h ? y : S - 1 - y;
      const d = Math.sqrt(qx * qx + qy * qy);
      const band = Math.floor(d / 6) % 2;
      const k = y * S + x;
      m[k] = band ? 0.85 : 0;
      if (Math.abs((d % 6) - 0) < 1) f[k] *= 0.82;
    }
    addFine(f, rng, 0.02);
  },
  grainy(f, S, rng) {
    addSmooth(f, rng, S, 8, 0.05);
    for (let i = 0; i < f.length; i++) { const r = rng(); f[i] *= r < 0.15 ? 0.85 : r > 0.9 ? 1.1 : 1 + (rng() - 0.5) * 0.06; }
  },
  metal(f, S, rng) {
    const c = S / 2;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const lx = x % c, ly = y % c, k = y * S + x;
      f[k] *= 1.04 - (lx + ly) / (2 * c) * 0.1;
      if (lx === 0 || ly === 0) f[k] *= 1.12;
      if (lx === c - 1 || ly === c - 1) f[k] *= 0.8;
    }
    addFine(f, rng, 0.015);
  },
  chiseled(f, S, rng) {
    PATTERNS.smooth(f, S, rng);
    rect(f, S, 0, 0, S, 2, SEAM); rect(f, S, 0, S - 2, S, S, SEAM);
    rect(f, S, 0, 0, 2, S, SEAM); rect(f, S, S - 2, 0, S, S, SEAM);
    const o = 14, w = S - 2 * o; // carved frame + centre ring
    rect(f, S, o, o, o + w, o + 2, 0.8); rect(f, S, o, o + w - 2, o + w, o + w, 1.12);
    rect(f, S, o, o, o + 2, o + w, 0.8); rect(f, S, o + w - 2, o, o + w, o + w, 1.12);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - S / 2 + 0.5, y - S / 2 + 0.5);
      if (d > 8 && d < 11) f[y * S + x] *= d < 9.5 ? 0.8 : 1.1;
    }
    addFine(f, rng, 0.03);
  },
  grate(f, S, rng, m, a) {
    PATTERNS.copper(f, S, rng);
    const c = 16;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const lx = x % c, ly = y % c;
      if (lx > 3 && lx < c - 3 && ly > 3 && ly < c - 3) a[y * S + x] = 0;
    }
  },

  sandstone(f, S, rng) {
    let y = 0;
    while (y < S) {
      const h = 3 + Math.floor(rng() * 7);
      rect(f, S, 0, y, S, y + h, 1 + (rng() - 0.5) * 0.14);
      const line = rng();
      rect(f, S, 0, y + h - 1, S, y + h, line < 0.3 ? 0.8 : 0.9);
      y += h;
    }
    const g = valueNoise(rng, S, 8);
    for (let yy = 0; yy < S; yy++) for (let x = 0; x < S; x++) f[yy * S + x] *= 1 + (g[(yy % 2) * S + x] * 2 - 1) * 0.04;
    addFine(f, rng, 0.03);
  },
};

/**
 * Pure renderer: RGBA bytes (S*S*4) for a pattern tinted from colorHex.
 * Deterministic for (pattern, colorHex, seed).
 */
export function renderPattern(pattern, colorHex, seed = 0, S = SIZE, color2Hex = null) {
  const fn = PATTERNS[pattern] || PATTERNS.stone;
  const rng = mulberry32((hashString(String(pattern)) ^ (seed >>> 0)) >>> 0);
  const f = new Float32Array(S * S).fill(1);
  const m = new Float32Array(S * S);       // mix toward color2
  const a = new Float32Array(S * S).fill(1); // alpha
  fn(f, S, rng, m, a);
  const [r, g, b] = hexToRgb(colorHex);
  const [r2, g2, b2] = color2Hex ? hexToRgb(color2Hex) : [r, g, b];
  const out = new Uint8ClampedArray(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const v = f[i], t = m[i];
    out[i * 4] = (r + (r2 - r) * t) * v;
    out[i * 4 + 1] = (g + (g2 - g) * t) * v;
    out[i * 4 + 2] = (b + (b2 - b) * t) * v;
    out[i * 4 + 3] = 255 * a[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Canvas-backed API
// ---------------------------------------------------------------------------

const texCache = new Map();
const urlCache = new Map();
const iconCache = new Map();

function resolveFamily(familyKey, fallback) {
  const fam = FAMILIES[familyKey];
  if (fam) return { color: fam.color || '#888888', color2: fam.color2 || null, pattern: fam.pattern || 'stone', cacheKey: familyKey };
  const color = (fallback && fallback.color) || '#888888';
  const pattern = (fallback && fallback.pattern) || 'stone';
  return { color, pattern, cacheKey: `${familyKey}|${color}|${pattern}` };
}

/**
 * 64x64 canvas with the family's procedural texture. Cached per family.
 * `fallback` ({color, pattern}) is used only when familyKey is not in FAMILIES
 * (e.g. a design referencing a removed family) so the viewer never breaks.
 */
export function familyTexture(familyKey, fallback) {
  const { color, color2, pattern, cacheKey } = resolveFamily(familyKey, fallback);
  let c = texCache.get(cacheKey);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = SIZE; c.height = SIZE;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  img.data.set(renderPattern(pattern, color, hashString(String(familyKey)), SIZE, color2));
  ctx.putImageData(img, 0, 0);
  texCache.set(cacheKey, c);
  return c;
}

/** data:image/png URL of the 64x64 texture (cached). */
export function swatchDataURL(familyKey, fallback) {
  const { cacheKey } = resolveFamily(familyKey, fallback);
  let u = urlCache.get(cacheKey);
  if (u) return u;
  u = familyTexture(familyKey, fallback).toDataURL('image/png');
  urlCache.set(cacheKey, u);
  return u;
}

/**
 * Small isometric mini-cube: top face = texture, left/right faces darkened.
 * Returns a canvas of size×size (cached per family+size).
 */
export function familyIcon(familyKey, size = 28, fallback) {
  const { cacheKey } = resolveFamily(familyKey, fallback);
  const ck = `${cacheKey}@${size}`;
  let c = iconCache.get(ck);
  if (c) return c;
  const tex = familyTexture(familyKey, fallback);
  c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const pad = Math.max(1, size * 0.04);
  const hw = size / 2 - pad;          // half width of the cube silhouette
  const q = hw / 2;                   // iso rise of the top rhombus edges
  const cx = size / 2, top = pad;
  // Cube silhouette points
  const T = [cx, top], L = [cx - hw, top + q], R = [cx + hw, top + q], C = [cx, top + 2 * q];
  const BC = [cx, top + 2 * q + hw];
  const face = (o, u, v, shade) => {
    ctx.save();
    ctx.setTransform(u[0], u[1], v[0], v[1], o[0], o[1]);
    ctx.drawImage(tex, 0, 0, 1, 1);
    if (shade > 0) { ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = `rgba(0,0,0,${shade})`; ctx.fillRect(0, 0, 1, 1); }
    ctx.restore();
  };
  // top: origin L, u -> T, v -> C
  face(L, [T[0] - L[0], T[1] - L[1]], [C[0] - L[0], C[1] - L[1]], 0);
  // left: origin L, u -> C, v -> down
  face(L, [C[0] - L[0], C[1] - L[1]], [0, hw], 0.38);
  // right: origin C, u -> R, v -> down
  face(C, [R[0] - C[0], R[1] - C[1]], [0, BC[1] - C[1]], 0.2);
  iconCache.set(ck, c);
  return c;
}

/** Drop all cached canvases (useful if FAMILIES colors change at runtime / in tests). */
export function clearTextureCache() {
  texCache.clear(); urlCache.clear(); iconCache.clear();
}
