// Node unit tests for the pure parts of viewer3d.js and textures.js.
// Run: node test/viewer.test.mjs
// 'three' and the addons are stubbed through a module-resolution hook because
// the real library is only available through the browser importmap.
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const haveBlocks = existsSync(path.join(here, '..', 'blocks.js'));

const stubs = {
  'three': 'export const __stub = true;',
  'three/addons/controls/OrbitControls.js': 'export class OrbitControls {}',
  'three/addons/utils/BufferGeometryUtils.js': 'export function mergeGeometries() { return null; }',
  '__blocks': `export const FAMILIES = {
    spruce: { name: 'Spruce planks', full: 'minecraft:spruce_planks', slab: 'minecraft:spruce_slab', stairs: 'minecraft:spruce_stairs', wall: null, color: '#6b4a2b', group: 'Wood', pattern: 'planks' },
    stone_bricks: { name: 'Stone bricks', full: 'minecraft:stone_bricks', slab: 'minecraft:stone_brick_slab', stairs: 'minecraft:stone_brick_stairs', wall: 'minecraft:stone_brick_wall', color: '#7a7a7a', group: 'Stone', pattern: 'stone_bricks' },
    oak_log: { name: 'Oak log', full: 'minecraft:oak_log', slab: null, stairs: null, wall: null, color: '#6e5a35', group: 'Logs', pattern: 'log' },
  }; export const FAMILY_KEYS = Object.keys(FAMILIES);`,
};
const hooks = `
const stubs = ${JSON.stringify(stubs)};
const stubBlocks = ${!haveBlocks};
const dataUrl = (src) => 'data:text/javascript,' + encodeURIComponent(src);
export async function resolve(specifier, context, nextResolve) {
  if (Object.prototype.hasOwnProperty.call(stubs, specifier)) return { url: dataUrl(stubs[specifier]), shortCircuit: true };
  if (stubBlocks && specifier.endsWith('blocks.js')) return { url: dataUrl(stubs.__blocks), shortCircuit: true };
  return nextResolve(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

// ---- tiny canvas stub (only what textures.js touches) ----------------------
class FakeCtx {
  constructor(c) { this.canvas = c; this.fillStyle = '#000'; }
  createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
  putImageData(img) { this.canvas._img = img; }
  save() {} restore() {} setTransform() {} drawImage() { this.canvas._drew = (this.canvas._drew || 0) + 1; } fillRect() {}
}
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'canvas');
    const c = { width: 0, height: 0, getContext() { return (this._ctx ||= new FakeCtx(this)); }, toDataURL() { return 'data:image/png;base64,FAKE' + this.width; } };
    return c;
  },
};

const T = await import('../textures.js');
const V = await import('../viewer3d.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   -', name); }
  catch (e) { console.log('FAIL -', name); console.log(e.stack || e); process.exitCode = 1; }
}
const mean = (px, pred) => { let s = 0, n = 0; for (let i = 0; i < px.length / 4; i++) if (!pred || pred(i)) { s += px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]; n += 3; } return s / n; };

// ---- textures ---------------------------------------------------------------
const SPEC_PATTERNS = ['planks', 'bricks', 'stone_bricks', 'cobble', 'stone', 'smooth', 'log', 'tiles', 'copper', 'prismarine', 'wool', 'concrete', 'terracotta', 'quartz', 'purpur', 'mud', 'sandstone', 'glass', 'ore', 'leaves', 'glazed', 'grainy', 'metal', 'chiseled', 'grate'];

test('patternNames covers exactly the SPEC pattern list', () => {
  assert.deepEqual([...T.patternNames].sort(), [...SPEC_PATTERNS].sort());
});

test('hexToRgb parses #rgb/#rrggbb and falls back on junk', () => {
  assert.deepEqual(T.hexToRgb('#6b4a2b'), [0x6b, 0x4a, 0x2b]);
  assert.deepEqual(T.hexToRgb('#fff'), [255, 255, 255]);
  assert.deepEqual(T.hexToRgb('nope'), [128, 128, 128]);
});

const SEE_THROUGH = ['glass', 'grate']; // these carry real alpha
test('renderPattern: every pattern yields 64x64 RGBA, opaque, deterministic, near the base color', () => {
  const S = 64;
  const seen = [];
  for (const p of SPEC_PATTERNS) {
    const a = T.renderPattern(p, '#8a6a3a', 1234);
    const b = T.renderPattern(p, '#8a6a3a', 1234);
    assert.equal(a.length, S * S * 4, p);
    assert.deepEqual(a, b, `${p} deterministic`);
    if (!SEE_THROUGH.includes(p)) for (let i = 3; i < a.length; i += 4) assert.equal(a[i], 255, `${p} alpha`);
    const m = mean(a); const base = (0x8a + 0x6a + 0x3a) / 3;
    assert.ok(Math.abs(m - base) < base * 0.25, `${p} mean ${m.toFixed(1)} vs base ${base.toFixed(1)}`);
    seen.push(a.join(','));
  }
  assert.equal(new Set(seen).size, SPEC_PATTERNS.length, 'all patterns differ');
  const c = T.renderPattern('planks', '#8a6a3a', 99);
  assert.notDeepEqual(c, T.renderPattern('planks', '#8a6a3a', 1234), 'seed changes output');
});

test('planks: board seams (rows 0,16,32,48) are ~25% darker than the boards', () => {
  const px = T.renderPattern('planks', '#a08050', 7);
  const seam = mean(px, (i) => (Math.floor(i / 64) % 16) === 0);
  const body = mean(px, (i) => { const r = Math.floor(i / 64) % 16; return r > 2 && r < 15; });
  assert.ok(seam < body * 0.85, `seam ${seam.toFixed(1)} body ${body.toFixed(1)}`);
});

test('bricks: horizontal mortar rows darker than brick rows', () => {
  const px = T.renderPattern('bricks', '#9a5a46', 3);
  const mortar = mean(px, (i) => (Math.floor(i / 64) % 8) === 7);
  const brick = mean(px, (i) => { const r = Math.floor(i / 64) % 8; return r >= 2 && r <= 5; });
  assert.ok(mortar < brick * 0.85, `mortar ${mortar.toFixed(1)} brick ${brick.toFixed(1)}`);
});

test('stone_bricks: 2x2 big bricks -> seam rows at 0 and 32 only', () => {
  const px = T.renderPattern('stone_bricks', '#7a7a7a', 5);
  const row = (y) => mean(px, (i) => Math.floor(i / 64) === y && (i % 64) > 2);
  assert.ok(row(0) < row(10) * 0.85 && row(32) < row(40) * 0.85);
  assert.ok(row(16) > row(10) * 0.9, 'no seam at 16');
});

test('concrete is flat (tiny variance), cobble/wool are busy', () => {
  const sd = (px) => { let m = 0; for (let i = 0; i < px.length; i += 4) m += px[i]; m /= px.length / 4; let s = 0; for (let i = 0; i < px.length; i += 4) s += (px[i] - m) ** 2; return Math.sqrt(s / (px.length / 4)); };
  const flat = sd(T.renderPattern('concrete', '#8080a0', 1));
  const cob = sd(T.renderPattern('cobble', '#8080a0', 1));
  const wool = sd(T.renderPattern('wool', '#8080a0', 1));
  assert.ok(flat < 4, `concrete sd ${flat}`);
  assert.ok(cob > flat * 3 && wool > flat * 2, `cobble ${cob} wool ${wool}`);
});

test('familyTexture: 64x64 canvas, cached, fallback for unknown family', () => {
  const c = T.familyTexture('spruce');
  assert.equal(c.width, 64); assert.equal(c.height, 64);
  assert.equal(c._img.data.length, 64 * 64 * 4);
  assert.equal(T.familyTexture('spruce'), c, 'cached');
  const f = T.familyTexture('nope_family', { color: '#ff0000', pattern: 'bricks' });
  assert.ok(f._img.data[0] > 100 && f._img.data[1] < 5, 'fallback tinted red');
  assert.ok(T.swatchDataURL('spruce').startsWith('data:image/png'));
  assert.equal(T.swatchDataURL('spruce'), T.swatchDataURL('spruce'));
  const icon = T.familyIcon('spruce', 28);
  assert.equal(icon.width, 28); assert.equal(icon._drew, 3, 'three faces drawn');
  assert.equal(T.familyIcon('spruce', 28), icon, 'icon cached');
});

// ---- viewer pure math ---------------------------------------------------------
test('facing rotation: (0,0,-1) rotated by FACING_ANGLE lands on the MC direction offset', () => {
  for (const d of V.DIRS) assert.deepEqual(V.facingVector(d), V.DIR_OFFSET[d], d);
  assert.equal(V.FACING_ANGLE.east, -Math.PI / 2);
  assert.equal(V.FACING_ANGLE.west, Math.PI / 2);
  assert.equal(V.FACING_ANGLE.south, Math.PI);
});

test('tall quarters per SPEC (facing north) and rotated facings', () => {
  assert.deepEqual(V.tallQuarters('straight', 'north'), ['NE', 'NW']);
  assert.deepEqual(V.tallQuarters('outer_left', 'north'), ['NW']);
  assert.deepEqual(V.tallQuarters('outer_right', 'north'), ['NE']);
  assert.deepEqual(V.tallQuarters('inner_left', 'north'), ['NE', 'NW', 'SW']);   // all but SE
  assert.deepEqual(V.tallQuarters('inner_right', 'north'), ['NE', 'NW', 'SE']);  // all but SW
  // facing east: tall side is the east half; "left" of an east-facer is north.
  assert.deepEqual(V.tallQuarters('straight', 'east'), ['NE', 'SE']);
  assert.deepEqual(V.tallQuarters('outer_left', 'east'), ['NE']);
  assert.deepEqual(V.tallQuarters('outer_right', 'east'), ['SE']);
  assert.deepEqual(V.tallQuarters('inner_left', 'east'), ['NE', 'NW', 'SE']);
  // facing south: tall side south; left of a south-facer is east.
  assert.deepEqual(V.tallQuarters('outer_left', 'south'), ['SE']);
  assert.deepEqual(V.tallQuarters('outer_right', 'south'), ['SW']);
  // facing west: left is south.
  assert.deepEqual(V.tallQuarters('outer_left', 'west'), ['SW']);
  assert.deepEqual(V.tallQuarters('outer_right', 'west'), ['NW']);
  assert.deepEqual(V.tallQuarters('straight', 'west'), ['NW', 'SW']);
});

test('stairBoxes: volumes and mirror for top half, all within the unit cube', () => {
  const vol = { straight: 0.75, outer_left: 0.625, outer_right: 0.625, inner_left: 0.875, inner_right: 0.875 };
  for (const s of V.STAIR_SHAPES) {
    for (const h of V.STAIR_HALVES) {
      const bx = V.stairBoxes(s, h);
      assert.ok(Math.abs(V.boxVolume(bx) - vol[s]) < 1e-9, `${s} ${h} volume`);
      for (const b of bx) for (const v of b) assert.ok(v >= 0 && v <= 1);
    }
    // bottom: base slab is y in [0,0.5]; top half: base slab is y in [0.5,1]
    assert.deepEqual(V.stairBoxes(s, 'bottom')[0], [0, 0, 0, 1, 0.5, 1]);
    assert.deepEqual(V.stairBoxes(s, 'top')[0], [0, 0.5, 0, 1, 1, 1]);
  }
  // the tall pieces of a north stair all lie in z in [0,0.5] except inner shapes' third quarter
  const ol = V.stairBoxes('outer_left', 'bottom')[1];
  assert.deepEqual(ol, [0, 0.5, 0, 0.5, 1, 0.5]);
  const or = V.stairBoxes('outer_right', 'bottom')[1];
  assert.deepEqual(or, [0.5, 0.5, 0, 1, 1, 0.5]);
  // top half outer_left: tall piece becomes the LOW piece hanging at y in [0,0.5]
  assert.deepEqual(V.stairBoxes('outer_left', 'top')[1], [0, 0, 0, 0.5, 0.5, 0.5]);
});

test('uvForVertex: side faces map y -> v, top face keeps north at the top of the texture', () => {
  assert.deepEqual(V.uvForVertex(0, 1, 0, 0.25, 1, 0), [0.25, 1]);
  assert.deepEqual(V.uvForVertex(0, 1, 0, 0.25, 1, 1), [0.25, 0]);
  assert.deepEqual(V.uvForVertex(1, 0, 0, 1, 0.5, 0.25), [0.75, 0.5]);
  assert.deepEqual(V.uvForVertex(0, 0, 1, 0.3, 0.75, 1), [0.3, 0.75]);
  assert.deepEqual(V.uvForVertex(0, 0, -1, 0.3, 0.75, 0), [0.7, 0.75]);
});

test('classifyBlock: kinds, rotations and wall arms', () => {
  assert.deepEqual(V.classifyBlock({ kind: 'full', props: {} }), [{ kind: 'full', angle: 0 }]);
  assert.deepEqual(V.classifyBlock({ kind: 'slab', props: { type: 'top' } }), [{ kind: 'slab_top', angle: 0 }]);
  assert.deepEqual(V.classifyBlock({ kind: 'slab', props: { type: 'bottom' } }), [{ kind: 'slab_bottom', angle: 0 }]);
  assert.deepEqual(V.classifyBlock({ kind: 'stair', props: { facing: 'east', half: 'top', shape: 'outer_left' } }),
    [{ kind: 'stair_outer_left_top', angle: -Math.PI / 2 }]);
  assert.deepEqual(V.classifyBlock({ kind: 'stair', props: { facing: 'west', half: 'bottom', shape: 'bogus' } }),
    [{ kind: 'stair_straight_bottom', angle: Math.PI / 2 }]);
  const wall = V.classifyBlock({ kind: 'wall', props: { up: 'true', north: 'low', south: 'low', east: 'none', west: 'tall' } });
  assert.deepEqual(wall.map((w) => w.kind), ['wall_post', 'wall_arm', 'wall_arm', 'wall_arm_tall']);
  assert.deepEqual(wall.map((w) => w.angle), [0, 0, Math.PI, Math.PI / 2]);
  assert.equal(V.WALL_BOXES.wall_arm[0][4], 0.875);
});

test('roofHeightEstimate and lowerBound', () => {
  const box = { w: 11, d: 7, roof: { type: 'gable', axis: 'x', rise: 1, overhang: 1 } };
  assert.equal(V.roofHeightEstimate(box), 5); // run (7+2-1)/2 = 4 -> 4 + 1
  assert.equal(V.roofHeightEstimate({ w: 5, d: 5, roof: { type: 'flat' } }), 1);
  assert.equal(V.roofHeightEstimate({ w: 5, d: 9, roof: { type: 'shed', shedLow: 'north', rise: 0.5, overhang: 0 } }), 5);
  assert.equal(V.roofHeightEstimate({ w: 9, d: 9, roof: { type: 'mansard', rise: 2, rise2: 0.5, breakAt: 2, overhang: 0 } }), 6); // g(4)=4+1=5 -> 6
  const ys = Int32Array.from([0, 0, 1, 1, 1, 3, 5]);
  assert.equal(V.lowerBound(ys, 1), 2);
  assert.equal(V.lowerBound(ys, 2), 5);
  assert.equal(V.lowerBound(ys, 6), 7);
  assert.equal(V.lowerBound(ys, -1), 0);
});

test('blockBoxes turns shapes the way they face; rayBox finds the entry face', () => {
  const stair = (facing) => ({ kind: 'stair', mat: 'spruce', props: { facing, half: 'bottom', shape: 'straight' } });
  // a stair's tall half is on the side it faces
  assert.deepEqual(V.blockBoxes(stair('north'))[1], [0, 0.5, 0, 1, 1, 0.5]);
  assert.deepEqual(V.blockBoxes(stair('east'))[1], [0.5, 0.5, 0, 1, 1, 1]);
  assert.deepEqual(V.blockBoxes(stair('south'))[1], [0, 0.5, 0.5, 1, 1, 1]);
  assert.deepEqual(V.blockBoxes(stair('west'))[1], [0, 0.5, 0, 0.5, 1, 1]);
  assert.deepEqual(V.blockBoxes({ kind: 'slab', mat: 'spruce', props: { type: 'top' } }), [[0, 0.5, 0, 1, 1, 1]]);
  assert.ok(V.isOpaqueCube({ kind: 'full', mat: 'spruce', props: {} }));
  assert.ok(!V.isOpaqueCube({ kind: 'stair', mat: 'spruce', props: {} }));
  // looking straight down onto a unit box from above enters through its top
  const h = V.rayBox([0.5, 5, 0.5], [0, -1, 0], [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(h, { t: 4, axis: 1, sign: 1 });
  assert.equal(V.rayBox([5, 5, 5], [0, -1, 0], [0, 0, 0, 1, 1, 1]), null);
  assert.equal(V.rayBox([0.5, 0.5, 0.5], [0, -1, 0], [0, 0, 0, 1, 1, 1]), null, 'starting inside');
});

test('meshGrid keeps only visible faces; covered tops become caps', () => {
  const blk = (x, y, z, mat = 'spruce', kind = 'full', props = {}) => [`${x},${y},${z}`, { id: 'x', kind, mat, props, color: '#888888', x, y, z }];
  const grid = (list) => {
    const blocks = new Map(list);
    const vs = [...blocks.values()];
    const min = { x: Math.min(...vs.map((b) => b.x)), y: Math.min(...vs.map((b) => b.y)), z: Math.min(...vs.map((b) => b.z)) };
    const max = { x: Math.max(...vs.map((b) => b.x)), y: Math.max(...vs.map((b) => b.y)), z: Math.max(...vs.map((b) => b.z)) };
    return { blocks, min, max };
  };
  const quads = (m) => m.faces.index.length / 6;
  // two cubes side by side: 12 faces minus the 2 pressed together
  const [side] = V.meshGrid(grid([blk(0, 0, 0), blk(1, 0, 0)]));
  assert.equal(quads(side), 10);
  assert.equal(side.caps.index.length, 0);
  // a stack: the lower top face is hidden but kept as a cap for slicing; layer order holds
  const [stack] = V.meshGrid(grid([blk(0, 1, 0), blk(0, 0, 0)]));
  assert.equal(quads(stack), 10);
  assert.equal(stack.caps.index.length / 6, 1);
  assert.deepEqual([...stack.ys], [0, 1]);
  // two straight stairs facing the same way side by side hide their touching sides
  const st = { facing: 'north', half: 'bottom', shape: 'straight' };
  const [stairs] = V.meshGrid(grid([blk(0, 0, 0, 'spruce', 'stair', st), blk(1, 0, 0, 'spruce', 'stair', st)]));
  assert.equal(quads(stairs), 2 * 12 - 4);
});

test('resizePatch drags any side of an object in 3D, within limits', () => {
  const box = { x: 0, z: 0, w: 5, d: 4, baseY: 2, wallH: 4 };
  assert.deepEqual(V.resizePatch('box', box, { y: 1 }, { y: 3 }), { x: 0, z: 0, w: 5, d: 4, baseY: 2, wallH: 7 }, 'top up');
  assert.deepEqual(V.resizePatch('box', box, { y: -1 }, { y: -2 }), { x: 0, z: 0, w: 5, d: 4, baseY: 0, wallH: 6 }, 'bottom down, top stays');
  assert.deepEqual(V.resizePatch('box', box, { y: -1 }, { y: 10 }), { x: 0, z: 0, w: 5, d: 4, baseY: 5, wallH: 1 }, 'never below 1 tall');
  assert.deepEqual(V.resizePatch('box', box, { x: -1, z: 1 }, { x: -2, z: 3 }), { x: -2, z: 0, w: 7, d: 7, baseY: 2, wallH: 4 }, 'corner');
  assert.deepEqual(V.resizePatch('box', box, { x: 1 }, { x: 2 }, true), { x: 0, z: 0, w: 7, d: 7, baseY: 2, wallH: 4 }, 'shift: square');
  const fill = { x: 1, z: 1, w: 3, d: 3, baseY: 0, h: 1 };
  assert.deepEqual(V.resizePatch('fill', fill, { y: 1 }, { y: 200 }), { x: 1, z: 1, w: 3, d: 3, baseY: 0, h: 128 }, 'fill height capped');
  const pillar = { x: 0, z: 0, size: 1, baseY: 0, h: 3 };
  assert.deepEqual(V.resizePatch('pillar', pillar, { x: 1 }, { x: 2 }), { x: 0, z: 0, size: 3, baseY: 0, h: 3 }, 'pillar stays square');
  assert.deepEqual(V.resizePatch('pillar', pillar, { x: 1 }, { x: 20 }), { x: 0, z: 0, size: 5, baseY: 0, h: 3 }, 'pillar max 5');
  const seg = { x0: 6, z0: 2, x1: 2, z1: 2, baseY: 0, h: 3 }; // drawn east to west
  assert.deepEqual(V.resizePatch('segment', seg, { x: 1 }, { x: 2 }), { x0: 8, x1: 2, z0: 2, z1: 2, baseY: 0, h: 3 });
  assert.deepEqual(V.resizableSides('segment', seg), { x: true, y: true, z: false });
  assert.deepEqual(V.objBounds('fill', fill), { x0: 1, x1: 4, y0: 0, y1: 1, z0: 1, z1: 4 });
});

if (haveBlocks) {
  test('blocks.js: every family pattern is a known pattern name', async () => {
    const { FAMILIES } = await import('../blocks.js');
    const bad = Object.entries(FAMILIES).filter(([, f]) => !T.patternNames.includes(f.pattern)).map(([k, f]) => `${k}:${f.pattern}`);
    assert.deepEqual(bad, []);
  });
} else {
  console.log('note - blocks.js not present yet; used stub FAMILIES');
}

console.log(`\n${passed} test group(s) passed${process.exitCode ? ', with FAILURES' : ''}`);
