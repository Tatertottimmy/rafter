// Half-block voxel flood fill: finds see-through holes that partial blocks (stairs/slabs) leave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid } from '../engine.js';
const TALL_N = { straight: [[0,0],[1,0]], outer_left: [[0,0]], outer_right: [[1,0]], inner_left: [[0,0],[1,0],[0,1]], inner_right: [[0,0],[1,0],[1,1]] };
const rot = { north: (u, v) => [u, v], east: (u, v) => [-v, u], south: (u, v) => [-u, -v], west: (u, v) => [v, -u] };
function subcells(b) { // list of [sx,sy,sz] in {0,1}
  const all = []; for (const sy of [0, 1]) for (const sx of [0, 1]) for (const sz of [0, 1]) all.push([sx, sy, sz]);
  if (b.kind === 'slab') return all.filter(([, sy]) => (b.props.type === 'top' ? sy === 1 : sy === 0));
  if (b.kind === 'stair') {
    const base = b.props.half === 'top' ? 1 : 0, upper = 1 - base;
    const out = all.filter(([, sy]) => sy === base);
    for (const [qx, qz] of TALL_N[b.props.shape]) { const [u, v] = rot[b.props.facing](qx - 0.5, qz - 0.5); out.push([u + 0.5, upper, v + 0.5]); }
    return out;
  }
  if (b.kind === 'full') return all;
  return [];
}
function holes(des) {
  const g = buildGrid(des);
  const solid = new Set();
  for (const [k, b] of g.blocks) { const [x, y, z] = k.split(',').map(Number); for (const [sx, sy, sz] of subcells(b)) solid.add(`${2 * x + sx},${2 * y + sy},${2 * z + sz}`); }
  const X0 = 2 * g.min.x - 2, X1 = 2 * g.max.x + 3, Y0 = 2 * g.min.y, Y1 = 2 * g.max.y + 3, Z0 = 2 * g.min.z - 2, Z1 = 2 * g.max.z + 3;
  const seen = new Set([`${X0},${Y1},${Z0}`]); const q = [[X0, Y1, Z0]];
  while (q.length) {
    const [x, y, z] = q.pop();
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
      const nx = x + dx, ny = y + dy, nz = z + dz, k = `${nx},${ny},${nz}`;
      if (nx < X0 || nx > X1 || ny < Y0 || ny > Y1 || nz < Z0 || nz > Z1 || seen.has(k) || solid.has(k)) continue;
      seen.add(k); q.push([nx, ny, nz]);
    }
  }
  const b = des.boxes[0], out = [];
  for (let x = 2 * (b.x + 1); x < 2 * (b.x + b.w - 1); x++) for (let z = 2 * (b.z + 1); z < 2 * (b.z + b.d - 1); z++) for (let y = 2 * b.baseY + 2; y < 2 * (b.baseY + b.wallH); y++)
    if (seen.has(`${x},${y},${z}`)) out.push(`${x / 2},${y / 2},${z / 2}`);
  return out;
}
const box = (roof, w = 11, d = 11) => ({ boxes: [{ id: 'b1', x: 0, z: 0, w, d, baseY: 0, wallH: 4, walls: true, wallMaterial: 'quartz', roof: { overhang: 0, material: 'spruce', ...roof } }] });

// Every roof type x curve x pitch on a few footprints must keep the room sealed: no outside
// air (at half-block resolution, so stair/slab gaps count) reaches the space under the roof.
test('roofs are sealed: no see-through gaps for any type, curve or pitch', () => {
  for (const type of ['gable', 'hip', 'halfhip', 'shed', 'round', 'gambrel', 'mansard'])
    for (const profile of ['straight', 'rounded', 'flared', 'bell'])
      for (const rise of [0.5, 1, 2, 3])
        for (const [w, d] of [[7, 5], [9, 9], [12, 7]])
          for (const overhang of [0, 1]) {
            const des = box({ type, profile, rise, overhang, axis: w >= d ? 'x' : 'z' }, w, d);
            assert.deepEqual(holes(des).slice(0, 3), [], `${type}/${profile}/r${rise}/${w}x${d}/oh${overhang}`);
          }
});
