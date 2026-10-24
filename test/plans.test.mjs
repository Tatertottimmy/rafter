// Node unit tests for plans.js (layerLegend / layerRange) with a hand-made grid.
// Run: node test/plans.test.mjs
import assert from 'node:assert/strict';
import { layerLegend, layerRange, drawLayer } from '../plans.js';

const blockKey = (x, y, z) => `${x},${y},${z}`;
function mk(id, kind, mat, color, props = {}) {
  return { id, kind, mat, color, role: 'roof', props };
}

const blocks = new Map();
// layer 0: 3 spruce planks + 1 oak log pillar
blocks.set(blockKey(0, 0, 0), mk('minecraft:spruce_planks', 'full', 'spruce', '#6b4a2b'));
blocks.set(blockKey(1, 0, 0), mk('minecraft:spruce_planks', 'full', 'spruce', '#6b4a2b'));
blocks.set(blockKey(2, 0, 0), mk('minecraft:spruce_planks', 'full', 'spruce', '#6b4a2b'));
blocks.set(blockKey(5, 0, 3), mk('minecraft:oak_log', 'full', 'oak_log', '#6e5a35'));
// layer 1: 2 stairs, 1 bottom slab, 1 top slab (slabs share an id -> one legend row of 2)
blocks.set(blockKey(0, 1, 0), mk('minecraft:spruce_stairs', 'stair', 'spruce', '#6b4a2b', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' }));
blocks.set(blockKey(1, 1, 0), mk('minecraft:spruce_stairs', 'stair', 'spruce', '#6b4a2b', { facing: 'east', half: 'bottom', shape: 'outer_left', waterlogged: 'false' }));
blocks.set(blockKey(2, 1, 0), mk('minecraft:spruce_slab', 'slab', 'spruce', '#6b4a2b', { type: 'bottom', waterlogged: 'false' }));
blocks.set(blockKey(2, 1, 1), mk('minecraft:spruce_slab', 'slab', 'spruce', '#6b4a2b', { type: 'top', waterlogged: 'false' }));
// layer 3 (layer 2 intentionally empty): a wall block
blocks.set(blockKey(1, 3, 1), mk('minecraft:stone_brick_wall', 'wall', 'stone_bricks', '#7a7a7a', { up: 'true' }));

const grid = { blocks, min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 3, z: 3 }, surface: new Map() };

// layerRange
assert.deepEqual(layerRange(grid), { minY: 0, maxY: 3 });
assert.deepEqual(layerRange({ blocks: new Map(), min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }), { minY: 0, maxY: 0 });
assert.deepEqual(layerRange(null), { minY: 0, maxY: 0 });

// layerLegend layer 0: sorted by count desc
let rows = layerLegend(grid, 0);
assert.equal(rows.length, 2);
assert.equal(rows[0].id, 'minecraft:spruce_planks');
assert.equal(rows[0].count, 3);
assert.equal(rows[0].kind, 'full');
assert.equal(rows[0].mat, 'spruce');
assert.equal(rows[0].color, '#6b4a2b');
assert.equal(rows[0].name, 'Spruce planks');
assert.equal(rows[1].id, 'minecraft:oak_log');
assert.equal(rows[1].count, 1);
assert.equal(rows[1].name, 'Oak log');

// layer 1: group by id only (both slab halves in one row), ties broken by name
rows = layerLegend(grid, 1);
assert.equal(rows.length, 2);
const slab = rows.find((r) => r.id === 'minecraft:spruce_slab');
const stairs = rows.find((r) => r.id === 'minecraft:spruce_stairs');
assert.equal(slab.count, 2);
assert.equal(slab.kind, 'slab');
assert.equal(stairs.count, 2);
assert.equal(stairs.kind, 'stair');
assert.equal(rows[0].name.localeCompare(rows[1].name) <= 0, true, 'equal counts sort by name');

// empty layer
assert.deepEqual(layerLegend(grid, 2), []);
// layer with a wall
rows = layerLegend(grid, 3);
assert.equal(rows.length, 1);
assert.equal(rows[0].kind, 'wall');
assert.equal(rows[0].name, 'Stone brick wall');
// out of range / bad input
assert.deepEqual(layerLegend(grid, 99), []);
assert.deepEqual(layerLegend(null, 0), []);

// drawLayer smoke test with a fake 2D context (records calls; checks sizing + no throw)
function fakeCanvas() {
  const calls = [];
  const ctx = new Proxy({}, {
    get(_, prop) {
      if (prop === 'calls') return calls;
      return (...args) => { calls.push([prop, args]); };
    },
    set() { return true; },
  });
  return { width: 0, height: 0, style: {}, getContext: () => ctx, _ctx: ctx };
}
const c = fakeCanvas();
drawLayer(c, grid, 1, { cell: 20 });
// 6 columns x 4 rows at 20px plus margins (30 left, 20 top, 8 right, 8 bottom)
assert.equal(c.style.width, `${30 + 6 * 20 + 8}px`);
assert.equal(c.style.height, `${20 + 4 * 20 + 8}px`);
assert.equal(c.width, 30 + 6 * 20 + 8);
const names = c._ctx.calls.map((k) => k[0]);
assert.ok(names.includes('fillRect'), 'fills blocks');
assert.ok(names.includes('fillText'), 'labels drawn');
assert.ok(names.includes('arc'), 'corner dot drawn for outer_left stair');
assert.ok(names.includes('clip'), 'hatch clip for slabs');
// custom bounds
const c2 = fakeCanvas();
drawLayer(c2, grid, 0, { cell: 10, bounds: { minX: 0, maxX: 2, minZ: 0, maxZ: 0 }, ghostBelow: false, showGrid: false });
assert.equal(c2.style.width, `${30 + 3 * 10 + 8}px`);
// empty grid does not throw
drawLayer(fakeCanvas(), { blocks: new Map(), min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, 0);

console.log('plans.test.mjs: all assertions passed');
