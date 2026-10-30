// test/engine.test.mjs — ENGINE tests. Run with Node 18+:
//   node --test test/engine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAMILIES, FAMILY_KEYS, roofFamilies, fullFamilies } from '../blocks.js';
import {
  buildGrid, blockKey, parseKey, stateString, defaultDesign, materialTotals, newId, validateDesign, rotatePatch, suggestVariants,
  encodeGrid, decodeGrid, scaleDesign,
} from '../engine.js';

// ---------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------
function box(over = {}) {
  const roof = Object.assign({ type: 'gable', axis: 'x', rise: 1, overhang: 0, ridgeCap: 'block', soffit: false, material: 'spruce' }, over.roof || {});
  return Object.assign({ id: 'b1', name: 'Box', x: 0, z: 0, w: 7, d: 5, baseY: 0, wallH: 4, walls: true, floor: false, wallMaterial: 'oak_planks' }, over, { roof });
}
function design(boxes, extra = {}) {
  return Object.assign({ version: 1, name: 'T', boxes, pillars: [], segments: [] }, extra);
}
const get = (grid, x, y, z) => grid.blocks.get(blockKey(x, y, z));

/** Highest occupied layer in a column, or -Infinity. */
function topLayer(grid, x, z) {
  let top = -Infinity;
  for (let y = grid.min.y; y <= grid.max.y; y++) if (get(grid, x, y, z)) top = y;
  return top;
}

/** Generic "no see-through" check: a vertical ray at every footprint column must hit a
 *  block whose top face is at or above the eave height E (layer >= E - 1). */
function assertNoLightLeaks(grid, b) {
  const E = b.baseY + b.wallH;
  for (let z = b.z; z < b.z + b.d; z++) for (let x = b.x; x < b.x + b.w; x++) {
    const t = topLayer(grid, x, z);
    assert.ok(t >= E - 1, `column (${x},${z}) is open to the sky: top layer ${t} < ${E - 1}`);
  }
}

const ARROW = { north: '^', south: 'v', east: '>', west: '<' };
/** ASCII plan of one layer. North up. */
function ascii(grid, y) {
  const lines = [];
  for (let z = grid.min.z; z <= grid.max.z; z++) {
    let row = '';
    for (let x = grid.min.x; x <= grid.max.x; x++) {
      const b = get(grid, x, y, z);
      if (!b) row += '.';
      else if (b.role === 'wall') row += 'W';
      else if (b.kind === 'full') row += '#';
      else if (b.kind === 'slab') row += '_';
      else if (b.kind === 'stair') row += b.props.half === 'top' ? 'T' : ARROW[b.props.facing];
      else row += 'w';
    }
    lines.push(row);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------
// blocks.js
// ---------------------------------------------------------------------------------
test('blocks catalog: ids, groups, helpers', () => {
  assert.ok(FAMILY_KEYS.length > 100, `expected a big catalog, got ${FAMILY_KEYS.length}`);
  for (const k of FAMILY_KEYS) {
    const f = FAMILIES[k];
    assert.match(f.full, /^minecraft:[a-z0-9_]+$/, k);
    for (const v of ['slab', 'stairs', 'wall']) if (f[v] !== null) assert.match(f[v], /^minecraft:[a-z0-9_]+$/, `${k}.${v}`);
    assert.match(f.color, /^#[0-9a-f]{6}$/, `${k}.color`);
    assert.equal(typeof f.group, 'string');
    assert.equal(typeof f.pattern, 'string');
  }
  assert.equal(FAMILIES.spruce.slab, 'minecraft:spruce_slab');
  assert.equal(FAMILIES.stone_bricks.wall, 'minecraft:stone_brick_wall');
  assert.equal(FAMILIES.quartz.full, 'minecraft:quartz_block');
  assert.equal(FAMILIES.nether_bricks.stairs, 'minecraft:nether_brick_stairs');
  assert.equal(FAMILIES.purpur.full, 'minecraft:purpur_block');
  assert.equal(FAMILIES.deepslate_tiles.slab, 'minecraft:deepslate_tile_slab');
  assert.equal(FAMILIES.smooth_stone.stairs, null);
  assert.equal(FAMILIES.crimson_stem.full, 'minecraft:crimson_stem');
  assert.equal(FAMILIES.red_terracotta.full, 'minecraft:red_terracotta');
  const rf = roofFamilies();
  assert.ok(rf.includes('spruce') && rf.includes('deepslate_tiles'));
  assert.ok(!rf.includes('smooth_stone') && !rf.includes('oak_log') && !rf.includes('white_wool'));
  assert.deepEqual(fullFamilies(), FAMILY_KEYS);
  assert.ok(FAMILY_KEYS.filter((k) => k.endsWith('_wool')).length === 16);
  assert.ok(FAMILY_KEYS.filter((k) => k.endsWith('_concrete')).length === 16);
  assert.ok(FAMILY_KEYS.filter((k) => k.endsWith('terracotta') && !k.endsWith('glazed_terracotta')).length === 17);
  assert.ok(FAMILY_KEYS.filter((k) => k.endsWith('_glazed_terracotta')).length === 16);
  assert.ok(FAMILY_KEYS.length > 300);
});

// ---------------------------------------------------------------------------------
// (a) simple 1:1 gable
// ---------------------------------------------------------------------------------
test('(a) 1:1 gable 7 long x 5 wide, no overhang', () => {
  const b = box({ w: 7, d: 5 });
  const grid = buildGrid(design([b]));
  const E = 4;
  // eave rows: stairs at layer E-1 facing uphill
  for (let x = 0; x < 7; x++) {
    const n = get(grid, x, E - 1, 0), s = get(grid, x, E - 1, 4);
    assert.equal(n.kind, 'stair'); assert.equal(n.props.facing, 'south'); assert.equal(n.props.shape, 'straight');
    assert.equal(s.kind, 'stair'); assert.equal(s.props.facing, 'north'); assert.equal(s.props.shape, 'straight');
    // second row: stairs at E
    assert.equal(get(grid, x, E, 1).props.facing, 'south');
    assert.equal(get(grid, x, E, 3).props.facing, 'north');
    // odd width -> single ridge row of full blocks at E+1
    const r = get(grid, x, E + 1, 2);
    assert.equal(r.kind, 'full'); assert.equal(r.role, 'roof');
    assert.equal(get(grid, x, E + 2, 2), undefined);
  }
  // walls fill the gable ends up to the roof
  for (let y = 0; y <= E; y++) {
    assert.equal(get(grid, 0, y, 2)?.role, 'wall', `gable end (0,${y},2)`);
    assert.equal(get(grid, 6, y, 2)?.role, 'wall');
  }
  assert.equal(get(grid, 0, E - 1, 1)?.role, 'wall');
  assert.equal(get(grid, 0, E - 2, 0)?.role, 'wall'); // eave column walls stop under the stair
  assert.equal(get(grid, 3, 0, 2), undefined); // interior empty (no floor)
  assertNoLightLeaks(grid, b);
  assert.equal(grid.surface.get('3,2').s, E + 2);
  assert.equal(grid.surface.get('3,2').boxId, 'b1');

  console.log(`\n  (a) gable plan, layer ${E - 1} (eave stairs + walls):\n` + ascii(grid, E - 1).replace(/^/gm, '    '));
  console.log(`  (a) gable plan, layer ${E + 1} (ridge):\n` + ascii(grid, E + 1).replace(/^/gm, '    ') + '\n');

  // even width -> two ridge rows of stairs facing each other, no full ridge
  const g2 = buildGrid(design([box({ w: 7, d: 4 })]));
  for (let x = 0; x < 7; x++) {
    const a = get(g2, x, E, 1), c = get(g2, x, E, 2);
    assert.equal(a.kind, 'stair'); assert.equal(a.props.facing, 'south');
    assert.equal(c.kind, 'stair'); assert.equal(c.props.facing, 'north');
    assert.equal(get(g2, x, E + 1, 1), undefined);
  }
});

// ---------------------------------------------------------------------------------
// (b) 1:2 roof (rise 0.5): slab / full alternation, no light leaks
// ---------------------------------------------------------------------------------
test('(b) rise 0.5 roof alternates slab / full and has no light leaks', () => {
  const b = box({ w: 7, d: 5, roof: { rise: 0.5 } });
  const grid = buildGrid(design([b]));
  const E = 4;
  for (let x = 0; x < 7; x++) {
    assert.equal(get(grid, x, E - 1, 0).kind, 'full');  // eave: s=E, lower by 0.5 -> full
    assert.equal(get(grid, x, E, 1).kind, 'slab');      // s=E+0.5 -> bottom slab
    assert.equal(get(grid, x, E, 1).props.type, 'bottom');
    assert.equal(get(grid, x, E, 2).kind, 'full');      // ridge s=E+1 -> full
    assert.equal(get(grid, x, E, 3).kind, 'slab');
    assert.equal(get(grid, x, E - 1, 4).kind, 'full');
  }
  assertNoLightLeaks(grid, b);
  // also check a wider 1:2 roof and a 1.5 roof
  const b2 = box({ w: 5, d: 9, roof: { rise: 0.5 } });
  assertNoLightLeaks(buildGrid(design([b2])), b2);
  const b3 = box({ w: 5, d: 9, roof: { rise: 1.5 } });
  assertNoLightLeaks(buildGrid(design([b3])), b3);
  const b4 = box({ w: 9, d: 9, roof: { type: 'hip', rise: 0.5, overhang: 1 } });
  assertNoLightLeaks(buildGrid(design([b4])), b4);
});

// ---------------------------------------------------------------------------------
// (c) hip roof: outer corners, full apex
// ---------------------------------------------------------------------------------
test('(c) hip roof rise 1 overhang 1: outer_* corner stairs, full apex', () => {
  const b = box({ w: 5, d: 5, roof: { type: 'hip', rise: 1, overhang: 1 } });
  const grid = buildGrid(design([b]));
  const E = 4;
  // region -1..5 ; corners
  const nw = get(grid, -1, E - 1, -1), ne = get(grid, 5, E - 1, -1), sw = get(grid, -1, E - 1, 5), se = get(grid, 5, E - 1, 5);
  assert.equal(nw.props.facing, 'south'); assert.equal(nw.props.shape, 'outer_left');
  assert.equal(ne.props.facing, 'south'); assert.equal(ne.props.shape, 'outer_right');
  assert.equal(sw.props.facing, 'north'); assert.equal(sw.props.shape, 'outer_right');
  assert.equal(se.props.facing, 'west'); assert.equal(se.props.shape, 'outer_right');
  // every diagonal column (dX == dZ, not the apex) is an outer_* stair
  for (let cz = -1; cz <= 5; cz++) for (let cx = -1; cx <= 5; cx++) {
    const dX = Math.min(cx + 1, 5 - cx), dZ = Math.min(cz + 1, 5 - cz);
    if (dX !== dZ) continue;
    const s = E + dX;
    if (cx === 2 && cz === 2) {
      const apex = get(grid, 2, s - 1, 2);
      assert.equal(apex.kind, 'full', 'apex is a full block (ridge)');
      continue;
    }
    const st = get(grid, cx, s - 1, cz);
    assert.equal(st.kind, 'stair', `diagonal (${cx},${cz})`);
    assert.match(st.props.shape, /^outer_(left|right)$/, `diagonal (${cx},${cz}) got ${st.props.shape}`);
  }
  // mid-edge columns are straight stairs facing inward
  assert.equal(get(grid, 2, E - 1, -1).props.shape, 'straight');
  assert.equal(get(grid, 2, E - 1, -1).props.facing, 'south');
  assert.equal(get(grid, -1, E - 1, 2).props.facing, 'east');
  assertNoLightLeaks(grid, b);

  // rectangular hip: ridge line of full blocks
  const g2 = buildGrid(design([box({ w: 9, d: 5, roof: { type: 'hip', rise: 1, overhang: 1 } })]));
  for (let x = 2; x <= 6; x++) assert.equal(get(g2, x, E + 2, 2).kind, 'full', `ridge (${x},2)`);
  assert.match(get(g2, 1, E + 1, 1).props.shape, /^outer_/); // hip diagonal next to the ridge end
  assert.equal(get(g2, 1, E + 1, 2).props.facing, 'east');     // hip-end slope cell climbs toward the ridge
  assert.equal(get(g2, 1, E + 1, 2).props.shape, 'straight');
  console.log(`\n  (c) hip plan, layer ${E - 1}:\n` + ascii(grid, E - 1).replace(/^/gm, '    ') + '\n');
});

// ---------------------------------------------------------------------------------
// (d) crossing gables -> valleys with inner_* stairs
// ---------------------------------------------------------------------------------
test('(d) two crossing gables of equal eave produce inner_* stairs in the valleys', () => {
  const main = box({ id: 'b1', x: 0, z: 0, w: 11, d: 7, roof: { axis: 'x', rise: 1, overhang: 0 } });
  const wing = box({ id: 'b2', x: 3, z: 2, w: 5, d: 9, roof: { axis: 'z', rise: 1, overhang: 0 } });
  const grid = buildGrid(design([main, wing]));
  const E = 4;
  // valley line x + z = 9 (west side) and x - z = 1 (east side)
  const v1 = get(grid, 4, E, 5);   // s = E+1
  const v0 = get(grid, 3, E - 1, 6); // s = E
  assert.equal(v1.kind, 'stair'); assert.equal(v1.props.shape, 'inner_right'); assert.equal(v1.props.facing, 'north');
  assert.equal(v0.kind, 'stair'); assert.equal(v0.props.shape, 'inner_right');
  const e1 = get(grid, 6, E, 5), e0 = get(grid, 7, E - 1, 6);
  assert.equal(e1.props.shape, 'inner_left'); assert.equal(e0.props.shape, 'inner_left');
  const shapes = new Set([...grid.blocks.values()].filter((b) => b.kind === 'stair').map((b) => b.props.shape));
  assert.ok(shapes.has('inner_left') && shapes.has('inner_right'));
  // the wing ridge wins the crossing: full blocks along x=5 inside the main footprint
  assert.equal(get(grid, 5, E + 1, 5).kind, 'full');
  assertNoLightLeaks(grid, main);
  assertNoLightLeaks(grid, wing);
  console.log(`\n  (d) crossing gables, layer ${E}:\n` + ascii(grid, E).replace(/^/gm, '    ') + '\n');
});

// ---------------------------------------------------------------------------------
// (e) rise 2
// ---------------------------------------------------------------------------------
test('(e) rise 2: every non-ridge column is a stair on top of a full block', () => {
  const b = box({ w: 7, d: 5, roof: { rise: 2 } });
  const grid = buildGrid(design([b]));
  const E = 4;
  for (let x = 0; x < 7; x++) {
    for (const [z, s] of [[0, E], [1, E + 2], [3, E + 2], [4, E]]) {
      const top = get(grid, x, s - 1, z), under = get(grid, x, s - 2, z);
      assert.equal(top.kind, 'stair', `(${x},${z}) top`);
      assert.equal(under.kind, 'full', `(${x},${z}) under`);
      assert.equal(under.role, 'roof');
    }
    assert.equal(get(grid, x, E + 3, 2).kind, 'full'); // ridge
    assert.equal(get(grid, x, E + 2, 2).kind, 'full'); // ridge fill
  }
  assertNoLightLeaks(grid, b);
});

// ---------------------------------------------------------------------------------
// (f) stateString
// ---------------------------------------------------------------------------------
test('(f) stateString sorts props; no brackets without props; keys round-trip', () => {
  const st = { id: 'minecraft:spruce_stairs', props: { waterlogged: 'false', shape: 'straight', half: 'bottom', facing: 'north' } };
  assert.equal(stateString(st), 'minecraft:spruce_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]');
  assert.equal(stateString({ id: 'minecraft:oak_planks', props: {} }), 'minecraft:oak_planks');
  assert.equal(stateString({ id: 'minecraft:oak_planks' }), 'minecraft:oak_planks');
  assert.equal(blockKey(-3, 5, 12), '-3,5,12');
  assert.deepEqual(parseKey('-3,5,12'), [-3, 5, 12]);
});

// ---------------------------------------------------------------------------------
// (g) dormer
// ---------------------------------------------------------------------------------
test('(g) dormer with baseY above the main roof: walls stop at the main roof', () => {
  const main = box({ id: 'b1', x: 0, z: 0, w: 11, d: 11, wallH: 4, roof: { axis: 'x', rise: 1, overhang: 0 } });
  const dormer = box({ id: 'b2', name: 'Dormer', x: 4, z: 0, w: 3, d: 3, baseY: 6, wallH: 2, wallMaterial: 'stone_bricks', roof: { axis: 'z', rise: 1, overhang: 0 } });
  const grid = buildGrid(design([main, dormer]));
  const E = 4;
  const sMain = (x, z) => E + Math.min(z, 10 - z);
  const dormerWalls = [...grid.blocks.entries()].filter(([, b]) => b.role === 'wall' && b.mat === 'stone_bricks');
  assert.ok(dormerWalls.length > 0, 'dormer has wall blocks');
  for (const [key, b] of dormerWalls) {
    const [x, y, z] = parseKey(key);
    assert.ok(x >= 4 && x <= 6 && z >= 0 && z <= 2, `dormer wall inside footprint ${key}`);
    assert.ok(y >= dormer.baseY, `dormer wall not below baseY ${key}`);
    assert.ok(y >= sMain(x, z), `dormer wall ${key} is below the main roof surface ${sMain(x, z)}`);
  }
  // Nothing of the dormer sits inside the house below the main roof surface.
  for (const [key, b] of grid.blocks) {
    const [x, y, z] = parseKey(key);
    if (b.role !== 'roof' && b.role !== 'wall') continue;
    if (x < 4 || x > 6 || z < 0 || z > 2) continue;
    if (b.role === 'wall' && b.mat !== 'stone_bricks') continue; // main-hall walls (perimeter row z=0) are allowed
    assert.ok(y + 1 > sMain(x, z) - 1, `dormer block ${key} buried below the main roof`);
  }
  // dormer ridge (full) is above the main roof; dormer gable face is closed
  assert.equal(get(grid, 5, 8, 0).kind, 'full');
  assertNoLightLeaks(grid, main);
  assert.equal(grid.surface.get('5,1').boxId, 'b2');
  assert.equal(grid.surface.get('2,1').boxId, 'b1');
});

// ---------------------------------------------------------------------------------
// (h) default design
// ---------------------------------------------------------------------------------
test('(h) defaultDesign builds, bounds are sane, totals + ids + validation work', () => {
  const d = defaultDesign();
  assert.equal(d.dataVersion, 5023);
  assert.equal(d.boxes.length, 4);
  assert.equal(d.pillars.length, 2);
  const grid = buildGrid(d);
  assert.ok(grid.blocks.size > 300, `blocks: ${grid.blocks.size}`);
  assert.ok(grid.min.x <= 0 && grid.max.x >= 10);
  assert.ok(grid.min.y === 0 && grid.max.y >= 7 && grid.max.y < 20, `y range ${grid.min.y}..${grid.max.y}`);
  assert.ok(grid.min.z <= 0 && grid.max.z >= 13);
  const roles = new Set([...grid.blocks.values()].map((b) => b.role));
  for (const r of ['roof', 'wall', 'pillar', 'floor']) assert.ok(roles.has(r), r);
  for (const b of d.boxes) if (b.walls) assertNoLightLeaks(grid, b);
  // every block's id belongs to its own family (catches alias / fallback mistakes)
  for (const b of grid.blocks.values()) {
    const f = FAMILIES[b.mat];
    assert.ok(f, `unknown family ${b.mat}`);
    assert.ok([f.full, f.slab, f.stairs, f.wall].includes(b.id), `${b.id} is not a ${b.mat} block`);
    assert.equal(b.color, f.color);
    assert.match(b.color, /^#[0-9a-f]{6}$/);
    if (b.kind === 'stair') assert.match(b.props.shape, /^(straight|inner_left|inner_right|outer_left|outer_right)$/);
  }
  const totals = materialTotals(grid);
  assert.ok(totals.length >= 4);
  assert.equal(totals.reduce((a, t) => a + t.count, 0), grid.blocks.size);
  for (let i = 1; i < totals.length; i++) assert.ok(totals[i - 1].count >= totals[i].count);
  assert.ok(totals.some((t) => t.id === 'minecraft:spruce_stairs' && /Spruce planks stairs/.test(t.name)));

  assert.equal(newId(d, 'b'), 'b5');
  assert.equal(newId(d, 'p'), 'p3');
  assert.equal(newId(d, 's'), 's1');

  const v = validateDesign({ boxes: [{ w: 0, roof: { rise: 1.2, type: 'dome', material: 'oak_log' } }], pillars: [{ h: -2 }] });
  assert.equal(v.dataVersion, 5023);
  assert.equal(v.boxes[0].w, 1);
  assert.equal(v.boxes[0].roof.rise, 1);
  assert.equal(v.boxes[0].roof.type, 'gable');
  assert.equal(v.boxes[0].roof.material, 'oak_log'); // any block may roof (full-block fallback)
  assert.equal(v.boxes[0].roof.profile, 'straight');
  assert.equal(v.boxes[0].details.trim, false);
  assert.equal(v.boxes[0].id, 'b1');
  assert.equal(v.pillars[0].h, 1);
  assert.equal(v.pillars[0].id, 'p1');
  assert.deepEqual(v.segments, []);
  // empty design -> empty grid with zero bounds
  const g0 = buildGrid({ boxes: [] });
  assert.equal(g0.blocks.size, 0);
  assert.deepEqual(g0.min, { x: 0, y: 0, z: 0 });
  // buildGrid does not mutate the caller's design
  const raw = { boxes: [{ id: 'b1', w: 3, d: 3 }] };
  buildGrid(raw);
  assert.equal(raw.boxes[0].roof, undefined);
});

// ---------------------------------------------------------------------------------
// (i) soffit
// ---------------------------------------------------------------------------------
test('(i) soffit places half=top stairs under the outer overhang ring facing outward', () => {
  const b = box({ w: 7, d: 5, roof: { rise: 1, overhang: 1, soffit: true } });
  const grid = buildGrid(design([b]));
  const E = 4;
  for (let x = -1; x <= 7; x++) {
    const n = get(grid, x, E - 2, -1), s = get(grid, x, E - 2, 5);
    assert.equal(n?.kind, 'stair', `soffit (${x},-1)`); assert.equal(n.props.half, 'top'); assert.equal(n.props.facing, 'north'); assert.equal(n.role, 'roof');
    assert.equal(s?.kind, 'stair'); assert.equal(s.props.half, 'top'); assert.equal(s.props.facing, 'south');
    // the TOP stair above it is unchanged
    assert.equal(get(grid, x, E - 1, -1).props.half, 'bottom');
  }
  // gable-end ring columns: soffit faces out through the gable end
  // (-1,0) has s=E+1 -> TOP stair at E facing south; its soffit sits at E-1 and faces west
  assert.equal(get(grid, -1, E, 0).props.facing, 'south');
  assert.equal(get(grid, -1, E - 1, 0).props.facing, 'west');
  assert.equal(get(grid, -1, E - 1, 0).props.half, 'top');
  // without soffit nothing is there
  const g2 = buildGrid(design([box({ w: 7, d: 5, roof: { rise: 1, overhang: 1 } })]));
  assert.equal(get(g2, 3, E - 2, -1), undefined);
  // soffit needs overhang >= 1
  const g3 = buildGrid(design([box({ w: 7, d: 5, roof: { rise: 1, overhang: 0, soffit: true } })]));
  assert.ok(![...g3.blocks.values()].some((b) => b.kind === 'stair' && b.props.half === 'top'));
});

// ---------------------------------------------------------------------------------
// extra: other roof types, ridge caps, pillars, segments, floors, flat
// ---------------------------------------------------------------------------------
test('other roof types build and stay closed', () => {
  const E = 4;
  for (const roof of [
    { type: 'flat' }, { type: 'shed', shedLow: 'west', rise: 1 }, { type: 'shed', shedLow: 'north', rise: 0.5 },
    { type: 'halfhip', axis: 'x', rise: 1, clip: 2, overhang: 1 }, { type: 'gambrel', axis: 'z', rise: 2, rise2: 0.5, breakAt: 2 },
    { type: 'mansard', rise: 2, rise2: 0.5, breakAt: 2, overhang: 1 }, { type: 'hip', rise: 3 }, { type: 'gable', rise: 1.5, overhang: 2 },
  ]) {
    const b = box({ w: 9, d: 7, roof });
    const grid = buildGrid(design([b]));
    assert.ok(grid.blocks.size > 0, roof.type);
    assertNoLightLeaks(grid, b);
  }
  // flat roof: full blocks at E-1 everywhere, no stairs (slope 0 at the edge)
  const flat = buildGrid(design([box({ w: 5, d: 5, roof: { type: 'flat' } })]));
  for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) assert.equal(get(flat, x, E - 1, z).kind, 'full');
  // shed: low eave stairs face uphill
  const shed = buildGrid(design([box({ w: 5, d: 5, roof: { type: 'shed', shedLow: 'south', rise: 1 } })]));
  assert.equal(get(shed, 2, E - 1, 4).props.facing, 'north');
  assert.equal(get(shed, 2, E + 3, 0).props.facing, 'north'); // high edge: still a stair climbing uphill
  assert.equal(get(shed, 0, E + 1, 2).props.shape, 'straight');  // shed side edges are not hips
  // ridge caps
  const slabCap = buildGrid(design([box({ w: 7, d: 5, roof: { ridgeCap: 'slab' } })]));
  assert.equal(get(slabCap, 3, E + 1, 2).kind, 'slab');
  const wallCap = buildGrid(design([box({ w: 7, d: 5, roof: { ridgeCap: 'wall', material: 'stone_bricks' } })]));
  const wc = get(wallCap, 3, E + 1, 2);
  assert.equal(wc.kind, 'wall'); assert.equal(wc.id, 'minecraft:stone_brick_wall');
  assert.equal(wc.props.east, 'low'); assert.equal(wc.props.west, 'low'); assert.equal(wc.props.north, 'none'); assert.equal(wc.props.up, 'true');
  assert.equal(get(wallCap, 0, E + 1, 2).props.west, 'none');
  const wallCapNoWall = buildGrid(design([box({ w: 7, d: 5, roof: { ridgeCap: 'wall', material: 'spruce' } })]));
  assert.equal(get(wallCapNoWall, 3, E + 1, 2).kind, 'full');
});

test('floors, pillars, segments only fill empty cells; order roofs->walls->floors->pillars->segments', () => {
  const b = box({ w: 5, d: 5, floor: true, wallMaterial: 'cobblestone' });
  const grid = buildGrid(design([b], {
    pillars: [{ id: 'p1', x: 2, z: 2, baseY: 0, h: 10, material: 'oak_log' }, { id: 'p2', x: 0, z: 0, baseY: 0, h: 2, material: 'oak_log' }],
    segments: [{ id: 's1', x0: -3, z0: 2, x1: 8, z1: 2, baseY: 0, h: 1, material: 'stone_bricks' }, { id: 's2', x0: 10, z0: 10, x1: 12, z1: 13, baseY: 0, h: 1, material: 'bricks' }],
  }));
  assert.equal(get(grid, 2, 0, 2).role, 'floor');        // floors are placed before pillars (step 8 order)
  assert.equal(get(grid, 2, 1, 2).role, 'pillar');
  assert.equal(get(grid, 1, 0, 1).role, 'floor');
  assert.equal(get(grid, 1, 0, 1).id, 'minecraft:cobblestone');
  assert.equal(get(grid, 0, 0, 0).role, 'wall');          // wall placed before pillar
  assert.equal(get(grid, 2, 4, 2).role, 'pillar');        // pillar goes up through the open attic
  assert.equal(get(grid, 2, 5, 2).role, 'roof');          // ridge block (s = E+2 = 6 -> layer 5) stays roof
  assert.equal(get(grid, 2, 6, 2).role, 'pillar');        // pillar continues above the ridge
  assert.equal(get(grid, -3, 0, 2).role, 'segment');
  assert.equal(get(grid, 8, 0, 2).role, 'segment');
  assert.equal(get(grid, 0, 0, 2).role, 'wall');          // segment does not overwrite the wall
  assert.equal(get(grid, 11, 0, 10).role, 'segment');     // non-axis-aligned: x0..x1 at z0
  assert.equal(get(grid, 11, 0, 13), undefined);
});

// ---------------------------------------------------------------------------------
// shared rooms: no interior walls / floors inside another box's room
// ---------------------------------------------------------------------------------
test('walls and floors stop inside another box\'s room (default farmhouse has no interior walls)', () => {
  const d = defaultDesign();
  const grid = buildGrid(d);
  const strictlyInside = (b, x, z) => x > b.x && x < b.x + b.w - 1 && z > b.z && z < b.z + b.d - 1;
  const eave = (b) => b.baseY + b.wallH;
  for (const [key, blk] of grid.blocks) {
    if (blk.role !== 'wall' && blk.role !== 'floor') continue;
    const [x, y, z] = parseKey(key);
    for (const b of d.boxes) {
      if (blk.role === 'floor' && b.floor && y === b.baseY && blk.mat === b.wallMaterial) continue; // b's own floor
      if (strictlyInside(b, x, z) && y < eave(b) && (blk.role === 'wall' || y >= b.baseY)) {
        assert.fail(`${blk.role} block ${key} sits inside ${b.name}'s room`);
      }
    }
  }
  const main = d.boxes[0], wing = d.boxes[1], dormer = d.boxes[3];
  // wing perimeter columns inside the main hall: no wall below the main eave (y < 4)
  for (let y = 0; y < 4; y++) {
    assert.equal(get(grid, 3, y, 3), undefined, `wing wall inside main hall at y=${y}`);
    assert.equal(get(grid, 5, y, 6), undefined, `main south wall inside wing at y=${y}`);
  }
  // still real walls where rooms do not overlap
  assert.equal(get(grid, 0, 2, 3)?.role, 'wall');   // main west wall
  assert.equal(get(grid, 3, 2, 9)?.role, 'wall');   // wing west wall south of the main hall
  assert.equal(get(grid, 5, 2, 10)?.role, 'wall');  // wing south wall
  // dormer walls (baseY 5 >= main eave 4) are untouched
  const dormerWalls = [...grid.blocks.entries()].filter(([k, b]) => {
    const [x, y, z] = parseKey(k);
    return b.role === 'wall' && x >= dormer.x && x < dormer.x + dormer.w && z >= dormer.z && z < dormer.z + dormer.d && y >= dormer.baseY;
  });
  assert.ok(dormerWalls.length > 0, 'dormer walls exist');
  assert.ok(eave(main) === 4 && eave(wing) === 4);
  // floor rule: a floored box overlapping another room skips the shared cells but floors the rest
  const a = box({ id: 'b1', x: 0, z: 0, w: 7, d: 7, floor: true, wallMaterial: 'stone_bricks' });
  const b2 = box({ id: 'b2', x: 4, z: 2, w: 7, d: 3 });
  const g2 = buildGrid(design([a, b2]));
  assert.equal(get(g2, 5, 0, 3), undefined);      // strictly inside b2 -> no floor from a
  assert.equal(get(g2, 2, 0, 3)?.role, 'floor');  // elsewhere a's floor is placed
  for (let y = 0; y < 4; y++) assert.notEqual(get(g2, 5, y, 2)?.role, 'wall', `b2 wall inside a's room at y=${y}`);
  assert.equal(get(g2, 5, 0, 2)?.role, 'floor');  // a's floor fills the cell where b2's wall was dropped
  assert.equal(get(g2, 8, 0, 2)?.role, 'wall');   // b2's wall outside a is intact
});

// ---------------------------------------------------------------------------------
// Curved roofs, round roofs, any-block roofs, details
// ---------------------------------------------------------------------------------
function oneBox(roof, extra = {}) {
  return { boxes: [{ id: 'b1', x: 0, z: 0, w: 11, d: 7, baseY: 0, wallH: 4, walls: true, roof: { type: 'gable', axis: 'x', rise: 1, overhang: 0, material: 'spruce', ...roof }, ...extra }] };
}
function colTop(grid, x, z) {
  let top = -Infinity;
  for (const k of grid.blocks.keys()) { const [bx, by, bz] = k.split(',').map(Number); if (bx === x && bz === z && by > top) top = by; }
  return top;
}

test('curved profiles keep total height and bend the slope', () => {
  const straight = buildGrid(oneBox({ profile: 'straight' }));
  const rounded = buildGrid(oneBox({ profile: 'rounded' }));
  const flared = buildGrid(oneBox({ profile: 'flared' }));
  // same ridge height (rise × half-run), z = 3 is the ridge row of a 7-deep gable
  assert.equal(rounded.surface.get('5,3').s, straight.surface.get('5,3').s);
  assert.equal(flared.surface.get('5,3').s, straight.surface.get('5,3').s);
  // one block in from the eave: rounded is higher than straight, flared lower
  const s1 = (g) => g.surface.get('5,1').s;
  assert.ok(s1(rounded) > s1(straight), `rounded ${s1(rounded)} vs ${s1(straight)}`);
  assert.ok(s1(flared) < s1(straight), `flared ${s1(flared)} vs ${s1(straight)}`);
  for (const g of [rounded, flared]) for (const v of g.surface.values()) assert.equal(v.s * 2, Math.round(v.s * 2));
});

test('round roof: highest at the centre, symmetric, corners at eave height', () => {
  const g = buildGrid({ boxes: [{ id: 'b1', x: 0, z: 0, w: 9, d: 9, baseY: 0, wallH: 3, roof: { type: 'round', rise: 1, overhang: 0, profile: 'rounded', material: 'stone_bricks' } }] });
  const c = g.surface.get('4,4').s;
  for (const v of g.surface.values()) assert.ok(v.s <= c);
  assert.equal(g.surface.get('0,0').s, 3);
  assert.equal(g.surface.get('2,4').s, g.surface.get('6,4').s);
  assert.equal(g.surface.get('4,2').s, g.surface.get('4,6').s);
  assert.ok(c > 6);
});

test('full-only roof material builds with full blocks', () => {
  const g = buildGrid(oneBox({ material: 'oak_leaves' }));
  const roof = [...g.blocks.values()].filter((b) => b.role === 'roof');
  assert.ok(roof.length > 0);
  for (const b of roof) { assert.equal(b.kind, 'full'); assert.equal(b.id, 'minecraft:oak_leaves'); assert.equal(b.props.persistent, 'true'); }
});

test('details: trim ring, ridge, corner posts, base course, beams, windows', () => {
  const details = { trim: true, ridge: true, corners: true, base: true, beams: true, windows: true, trimMat: 'dark_oak', cornerMat: 'spruce_log', baseMat: 'cobblestone', beamMat: 'stripped_oak_log', windowMat: 'glass' };
  const g = buildGrid(oneBox({ overhang: 1 }, { details }));
  const at = (x, y, z) => g.blocks.get(`${x},${y},${z}`);
  // trim on the overhang ring (x = -1 .. 11, z = -1 .. 7)
  assert.equal(at(5, colTop(g, 5, -1), -1).mat, 'dark_oak');
  assert.equal(at(-1, colTop(g, -1, 3), 3).mat, 'dark_oak');
  assert.equal(at(5, colTop(g, 5, 1), 1).mat, 'spruce');
  // ridge row (z = 3) in trim
  assert.equal(at(5, colTop(g, 5, 3), 3).mat, 'dark_oak');
  // corner post upright, base course, beam lying along the wall
  assert.equal(at(0, 2, 0).mat, 'spruce_log');
  assert.equal(at(0, 2, 0).props.axis, 'y');
  assert.equal(at(3, 0, 0).mat, 'cobblestone');
  assert.equal(at(0, 0, 0).mat, 'cobblestone');
  assert.equal(at(1, 3, 0).mat, 'stripped_oak_log');
  assert.equal(at(1, 3, 0).props.axis, 'x');
  assert.equal(at(0, 3, 2).props.axis, 'z');
  // windows: centre column of the 11-long north wall, rows 1..2, panes running along x
  const w = at(5, 1, 0);
  assert.equal(w.kind, 'pane');
  assert.equal(w.id, 'minecraft:glass_pane');
  assert.equal(w.props.east, 'true');
  assert.equal(w.props.north, 'false');
  assert.equal(at(5, 2, 0).kind, 'pane');
  assert.equal(at(2, 1, 0).kind, 'pane');
  assert.equal(at(8, 1, 0).kind, 'pane');
  assert.notEqual(at(1, 1, 0).kind, 'pane');
  assert.notEqual(at(4, 1, 0).kind, 'pane');
});

// ---------------------------------------------------------------------------------
// rotation
// ---------------------------------------------------------------------------------
test('rotatePatch: quarter turns swap size and turn the roof, half turns keep the footprint', () => {
  const b = box({ x: 0, z: 0, w: 7, d: 4, roof: { type: 'shed', axis: 'x', shedLow: 'south' } });
  const r1 = { ...b, ...rotatePatch('box', b, 1) };
  assert.equal(r1.w, 4); assert.equal(r1.d, 7);
  assert.equal(r1.roof.axis, 'z'); assert.equal(r1.roof.shedLow, 'west');
  assert.equal(b.roof.shedLow, 'south', 'input not mutated');
  const r2 = { ...b, ...rotatePatch('box', b, 2) };
  assert.deepEqual([r2.x, r2.z, r2.w, r2.d, r2.roof.axis, r2.roof.shedLow], [0, 0, 7, 4, 'x', 'north']);
  assert.deepEqual(rotatePatch('box', b, 4), {});
  assert.equal({ ...b, ...rotatePatch('box', b, -1) }.roof.shedLow, 'east');
  // Even-sized boxes rotate exactly about their centre.
  const e = box({ x: 2, z: 3, w: 6, d: 4 });
  const e1 = rotatePatch('box', e, 1);
  assert.equal(e1.x + e1.w / 2, e.x + e.w / 2); assert.equal(e1.z + e1.d / 2, e.z + e.d / 2);
});

test('rotatePatch: rotated box builds the same block count, transposed', () => {
  for (const type of ['gable', 'hip', 'shed', 'gambrel', 'round']) {
    const b = box({ x: 0, z: 0, w: 9, d: 6, roof: { type, axis: 'x', shedLow: 'south', overhang: 1 } });
    const g0 = buildGrid(design([b]));
    const g1 = buildGrid(design([{ ...b, ...rotatePatch('box', b, 1) }]));
    assert.equal(g1.blocks.size, g0.blocks.size, type);
  }
});

test('rotatePatch: segments turn about their centre', () => {
  assert.deepEqual(rotatePatch('segment', { x0: 0, z0: 0, x1: 4, z1: 0 }, 1), { x0: 2, z0: -2, x1: 2, z1: 2 });
  const s2 = rotatePatch('segment', { x0: 0, z0: 0, x1: 4, z1: 0 }, 2);
  assert.deepEqual([Math.min(s2.x0, s2.x1), Math.max(s2.x0, s2.x1), s2.z0, s2.z1], [0, 4, 0, 0]);
});

// ---------------------------------------------------------------------------------
// hand edits + texture variation
// ---------------------------------------------------------------------------------
test('edits: erase, paint keeps shape, place adds; box edits follow the box', () => {
  const b = box({ x: 0, z: 0, w: 7, d: 5 });
  const g0 = buildGrid(design([b]));
  const wallKey = blockKey(0, 1, 2);
  assert.equal(g0.blocks.get(wallKey).role, 'wall');
  const stairKey = [...g0.blocks].find(([, v]) => v.kind === 'stair')[0];
  const [sx, sy, sz] = parseKey(stairKey);
  const b2 = { ...b, edits: [
    { x: 0, y: 1, z: 2, shape: 'erase' },
    { x: sx, y: sy, z: sz, shape: 'paint', mat: 'bricks' },
    { x: 3, y: 0, z: -3, shape: 'stair', mat: 'oak', facing: 'east', half: 'top' },
  ] };
  const g1 = buildGrid(design([b2]));
  assert.equal(g1.blocks.has(wallKey), false);
  const painted = g1.blocks.get(stairKey);
  assert.equal(painted.kind, 'stair'); assert.equal(painted.mat, 'bricks'); assert.equal(painted.props.facing, g0.blocks.get(stairKey).props.facing);
  const placed = g1.blocks.get(blockKey(3, 0, -3));
  assert.equal(placed.id, 'minecraft:oak_stairs'); assert.equal(placed.props.facing, 'east'); assert.equal(placed.props.half, 'top');
  // Moving the box carries its edits.
  const g2 = buildGrid(design([{ ...b2, x: 10 }]));
  assert.equal(g2.blocks.has(blockKey(10, 1, 2)), false);
  assert.ok(g2.blocks.get(blockKey(13, 0, -3)));
  // Design-level edits are world cells; paint on an empty cell does nothing.
  const g3 = buildGrid(design([b], { edits: [{ x: 50, y: 0, z: 50, shape: 'full', mat: 'stone' }, { x: 60, y: 0, z: 60, shape: 'paint', mat: 'stone' }] }));
  assert.equal(g3.blocks.get(blockKey(50, 0, 50)).mat, 'stone');
  assert.equal(g3.blocks.has(blockKey(60, 0, 60)), false);
});

test('edits: invalid entries are dropped, one edit per cell', () => {
  const d = validateDesign({ boxes: [], edits: [{ x: 0, y: 0, z: 0, shape: 'full', mat: 'nope' }, { x: 1, y: 0, z: 0, shape: 'bogus' }, { x: 2, y: 0, z: 0, shape: 'full', mat: 'stone' }, { x: 2, y: 0, z: 0, shape: 'erase' }] });
  assert.deepEqual(d.edits, [{ x: 2, y: 0, z: 0, shape: 'erase' }]);
});

test('rotatePatch turns box edits with the box', () => {
  const b = box({ x: 0, z: 0, w: 6, d: 4, edits: [{ x: 0, y: 1, z: 0, shape: 'stair', mat: 'oak', facing: 'north', half: 'bottom' }] });
  const r = rotatePatch('box', b, 1);
  assert.deepEqual([r.edits[0].x, r.edits[0].z, r.edits[0].facing], [3, 0, 'east']); // NW corner -> NE corner
  const r4 = [1, 1, 1, 1].reduce((o) => ({ ...o, ...rotatePatch('box', o, 1) }), b);
  assert.deepEqual(r4.edits, b.edits);
});

test('variation: deterministic, roughly tracks the amount, only main materials', () => {
  const b = box({ x: 0, z: 0, w: 15, d: 11, wallH: 6, wallMaterial: 'stone_bricks', roof: { type: 'hip', material: 'deepslate_tiles' },
    details: { base: true, baseMat: 'cobblestone' }, variation: { wall: 30, roof: 0, style: 'scatter', seed: 4 } });
  const g1 = buildGrid(design([b])), g2 = buildGrid(design([b]));
  let wall = 0, mixed = 0;
  for (const [k, v] of g1.blocks) {
    assert.equal(v.id, g2.blocks.get(k).id);
    if (v.path === 'details.baseMat') assert.equal(v.mat, 'cobblestone');
    if (v.path === 'roof.material') assert.equal(v.mat, 'deepslate_tiles');
    if (v.path === 'wallMaterial') { wall++; if (v.mat !== 'stone_bricks') { mixed++; assert.ok(['mossy_stone_bricks', 'cracked_stone_bricks'].includes(v.mat)); } }
  }
  assert.ok(mixed / wall > 0.15 && mixed / wall < 0.45, `${mixed}/${wall}`);
  assert.equal(g1.blocks.size, buildGrid(design([{ ...b, variation: { wall: 0 } }])).blocks.size, 'variation never adds or removes blocks');
  assert.deepEqual(suggestVariants('cobblestone'), ['mossy_cobblestone']);
});

test('upturned corners lift the eave toward each corner; irimoya is hip below, gable above', () => {
  const top = (g) => { const t = new Map(); for (const [k, b] of g.blocks) { if (b.role !== 'roof') continue; const [x, y, z] = k.split(',').map(Number); t.set(x + ',' + z, Math.max(t.get(x + ',' + z) ?? -99, y)); } return t; };
  const roof = { type: 'hip', rise: 1, overhang: 0 };
  const flat = top(buildGrid(design([box({ w: 13, d: 9, roof })])));
  const up = top(buildGrid(design([box({ w: 13, d: 9, roof: { ...roof, upturn: 3, upturnReach: 4 } })])));
  assert.equal(up.get('0,0') - flat.get('0,0'), 3, 'corner rises by the full lift');
  assert.ok(up.get('0,0') > up.get('1,0') && up.get('1,0') >= up.get('3,0'), 'eave climbs toward the corner');
  assert.equal(up.get('6,0'), flat.get('6,0'), 'middle of the eave is untouched');
  assert.equal(up.get('6,4'), flat.get('6,4'), 'ridge is untouched');
  // flat and round roofs ignore it
  const fl = buildGrid(design([box({ w: 7, d: 7, roof: { type: 'flat', upturn: 3 } })]));
  assert.equal(fl.blocks.size, buildGrid(design([box({ w: 7, d: 7, roof: { type: 'flat' } })])).blocks.size);
  // irimoya: ends rise as a hip for `clip` rows, then a gable face stands on the skirt
  const iri = top(buildGrid(design([box({ w: 13, d: 9, roof: { type: 'irimoya', axis: 'x', rise: 1, clip: 3, overhang: 0 } })])));
  const gab = top(buildGrid(design([box({ w: 13, d: 9, roof: { type: 'gable', axis: 'x', rise: 1, overhang: 0 } })])));
  assert.ok(iri.get('0,4') < gab.get('0,4'), 'end of the ridge is hipped');
  assert.equal(iri.get('3,4'), gab.get('3,4'), 'past the skirt it is a full gable');
  assert.equal(validateDesign({ boxes: [{ roof: { type: 'irimoya', upturn: 99 } }] }).boxes[0].roof.upturn, 16);
});

test('a tower rising out of a lower roof keeps its walls (no roof curtain down to the other roof)', () => {
  const main = box({ id: 'b1', w: 15, d: 15, roof: { type: 'gable', axis: 'x', rise: 1, overhang: 1 } });
  const tower = box({ id: 'b2', x: 5, z: 5, w: 5, d: 5, wallH: 16, wallMaterial: 'oak_planks', roof: { type: 'round', rise: 2, overhang: 1, material: 'spruce' } });
  const g = buildGrid(design([main, tower]));
  // the tower's overhang ring hangs a couple of blocks below its eave, never down to the main roof
  for (let y = 0; y < tower.baseY + tower.wallH - 3; y++) {
    const b = get(g, 4, y, 7);
    assert.ok(!b || b.src !== 'b2', `tower roof block at y=${y} in the overhang column`);
  }
  assert.equal(get(g, 5, 15, 7).role, 'wall', 'tower wall shows above the main roof');
});

test('wall openings: windows, door, frames, sills, studs; stacked floors keep their own walls', () => {
  const det = { windows: true, windowMat: 'glass', winWidth: 3, winHeight: 2, winSill: 1, winGap: 1, door: true, doorSide: 'south', doorWidth: 2, doorHeight: 2, frame: true, frameMat: 'spruce_log', sills: true, sillMat: 'spruce' };
  const b = box({ w: 13, d: 7, wallH: 6, details: det });
  const g = buildGrid(design([b]));
  const north = [];
  for (let x = 0; x < 13; x++) north.push(get(g, x, 1, 0).kind === 'pane' ? 'G' : get(g, x, 1, 0).mat === 'spruce_log' ? 'F' : '.');
  assert.ok(north.join('').includes('FGGGF'), north.join(''));
  assert.ok(!north.join('').slice(0, 2).includes('G') && !north.join('').slice(-2).includes('G'), 'no glass next to the corners');
  // door: a 2-wide, 2-high opening in the south wall, centred
  const doorCols = [];
  for (let x = 1; x < 12; x++) if (!get(g, x, 1, 6) && !get(g, x, 2, 6)) doorCols.push(x);
  assert.deepEqual(doorCols, [5, 6]);
  // sills sit outside the north wall under the windows
  assert.ok([...g.blocks.entries()].some(([k, v]) => v.path === 'details.sillMat' && k.endsWith(',-1')));
  // studs
  const st = buildGrid(design([box({ w: 9, d: 5, wallH: 5, details: { studs: true, studGap: 2, beamMat: 'oak_log' } })]));
  assert.equal(get(st, 2, 2, 0).mat, 'oak_log');
  assert.notEqual(get(st, 3, 2, 0).mat, 'oak_log');
  // a copy stacked on top gets its own windows
  const up = box({ id: 'b2', baseY: 6, w: 13, d: 7, wallH: 6, details: det });
  const two = buildGrid(design([{ ...b, roof: { ...b.roof, type: 'flat' } }, up]));
  assert.equal(get(two, 6, 7, 0).kind, 'pane', 'upper floor has windows');
  assert.equal(get(two, 6, 7, 0).src, 'b2');
});

test('pillars: thickness, wall posts, base and capital rings; pane edits', () => {
  const g = buildGrid({ boxes: [], pillars: [{ id: 'p1', x: 0, z: 0, baseY: 0, h: 4, material: 'stone_bricks', size: 2, base: 'stairs', baseMat: 'stone_bricks', cap: 'slab', capMat: 'stone_bricks' }], edits: [{ x: 9, y: 0, z: 9, shape: 'pane', mat: 'glass', axis: 'z' }] });
  assert.equal(get(g, 1, 3, 1).mat, 'stone_bricks');
  assert.equal(get(g, -1, 0, 0).kind, 'stair');
  assert.equal(get(g, -1, 0, 0).props.facing, 'east');
  assert.match(get(g, -1, 0, -1).props.shape, /outer/);
  assert.equal(get(g, 2, 3, 2).kind, 'slab');
  assert.equal(get(g, 2, 3, 2).props.type, 'top');
  assert.equal(get(g, 9, 0, 9).kind, 'pane');
  assert.equal(get(g, 9, 0, 9).props.north, 'true');
  const w = buildGrid({ boxes: [], pillars: [{ id: 'p1', x: 0, z: 0, h: 3, material: 'cobblestone', shape: 'wall' }] });
  assert.equal(get(w, 0, 1, 0).kind, 'wall');
});

test('fills: solid rectangles of one block that never overwrite what is built', () => {
  const b = box({ roof: { type: 'flat' } });
  const g = buildGrid(design([b], { fills: [{ id: 'f1', x: -2, z: 0, w: 12, d: 5, baseY: 0, h: 1, material: 'stone_bricks' }] }));
  assert.equal(get(g, -2, 0, 0).mat, 'stone_bricks');
  assert.equal(get(g, -2, 0, 0).src, 'f1');
  assert.equal(get(g, 3, 0, 2).src, 'f1', 'fills the inside of the box');
  assert.equal(get(g, 0, 0, 0).src, 'b1', 'box walls win');
  assert.equal(get(g, 9, 0, 4).mat, 'stone_bricks');
  assert.equal(get(g, 10, 0, 0), undefined);
  // stairs and panes, validation defaults, rotation
  const s = buildGrid(design([], { fills: [{ x: 0, z: 0, w: 3, d: 1, h: 2, material: 'oak', shape: 'stair', facing: 'south', half: 'top' }] }));
  assert.equal(get(s, 2, 1, 0).kind, 'stair');
  assert.equal(get(s, 2, 1, 0).props.facing, 'south');
  assert.equal(get(s, 2, 1, 0).props.half, 'top');
  const v = validateDesign(design([], { fills: [{ shape: 'pane', axis: 'y', w: 999 }] }));
  assert.equal(v.fills[0].id, 'f1');
  assert.equal(v.fills[0].axis, 'x');
  assert.equal(v.fills[0].w, 256);
  const p = rotatePatch('fill', { x: 0, z: 0, w: 4, d: 2, facing: 'north', axis: 'x' }, 1);
  assert.deepEqual(p, { x: 1, z: -1, w: 2, d: 4, facing: 'east', axis: 'z' });
  assert.equal(newId({ boxes: [], fills: [{ id: 'f1' }] }, 'f'), 'f2');
});

test('round and hollow fills; chopped roof tops', () => {
  const g = buildGrid(design([], { fills: [{ id: 'f1', x: 0, z: 0, w: 9, d: 9, h: 2, material: 'stone_bricks', outline: 'circle', hollow: true }] }));
  assert.equal(get(g, 4, 0, 0).src, 'f1', 'rim at the middle of each side');
  assert.equal(get(g, 0, 0, 0), undefined, 'corner cut off');
  assert.equal(get(g, 4, 1, 4), undefined, 'hollow inside');
  const solid = buildGrid(design([], { fills: [{ x: 0, z: 0, w: 9, d: 9, material: 'stone', outline: 'circle' }] }));
  assert.ok(get(solid, 4, 0, 4));
  assert.ok(solid.blocks.size > 50 && solid.blocks.size < 81);
  const roof = (cut) => buildGrid(design([box({ w: 9, d: 11, wallH: 3, roof: { type: 'gable', axis: 'x', cut } })]));
  const c = roof(2);
  assert.ok(c.max.y < roof(0).max.y && c.max.y <= 5);
  for (let z = 3; z <= 7; z++) assert.ok(get(c, 4, c.max.y, z), 'flat top at z=' + z);
});

test('a box on another roof keeps that roof whole up to its walls; caps on chopped tops', () => {
  const main = box({ w: 11, d: 9, wallH: 4, roof: { type: 'gable', axis: 'x', overhang: 1 } });
  const tower = box({ id: 'b2', x: 4, z: 3, w: 3, d: 3, baseY: 6, wallH: 4, wallMaterial: 'stone_bricks', roof: { type: 'hip', overhang: 1, material: 'dark_oak' } });
  const g = buildGrid(design([main, tower]));
  // under the tower's eave overhang the main roof carries on (it used to be cut away)
  const col = (x, z, src) => [...g.blocks].filter(([k, b]) => b.src === src && k.startsWith(x + ',') && k.endsWith(',' + z)).length;
  assert.ok(col(5, 2, 'b1') > 0, 'main roof under the overhang');
  assert.ok(col(5, 6, 'b1') > 0, 'main roof under the overhang (south)');
  assert.equal(get(g, 4, 9, 3).src, 'b2', 'tower wall');
  // forced merge gives the old single height map back
  const m = buildGrid(design([main, { ...tower, stack: 'merge' }]));
  assert.equal(col.call(null, 5, 2, 'b1'), col(5, 2, 'b1'));
  assert.ok([...m.blocks].filter(([k, b]) => b.src === 'b1' && k.startsWith('5,') && k.endsWith(',2')).length < col(5, 2, 'b1'));
  // chopped tops: slab cap, open rim
  const chop = (cap) => buildGrid(design([box({ w: 9, d: 11, wallH: 3, roof: { type: 'hip', cut: 2, cap, capMat: 'stone_bricks' } })]));
  const sl = chop('slab'), op = chop('open');
  const top = sl.max.y;
  assert.equal(get(sl, 4, top, 5).kind, 'slab');
  assert.equal(get(sl, 4, top, 5).mat, 'stone_bricks');
  assert.equal(get(op, 4, top, 5), undefined, 'open middle');
  assert.ok([...op.blocks].some(([k, b]) => b.mat === 'stone_bricks'), 'rim kept');
});

test('towers from the ground and set-back storeys meet the roof below without a gap', () => {
  const colOf = (g, x, z, src) => [...g.blocks].filter(([k, b]) => b.src === src && k.startsWith(x + ',') && k.endsWith(',' + z));
  // a tall tower at the gable end of a house, both standing on the ground
  const house = box({ w: 13, d: 9, wallH: 4, roof: { type: 'gable', axis: 'x', overhang: 1 } });
  const tower = box({ id: 'b2', x: 8, z: 2, w: 5, d: 5, wallH: 10, wallMaterial: 'stone_bricks', roof: { type: 'hip', overhang: 1, material: 'dark_oak' } });
  const g = buildGrid(design([house, tower]));
  assert.ok(colOf(g, 7, 4, 'b1').length > 0, 'house roof runs under the tower eave');
  for (let y = 0; y < 10; y++) assert.equal(get(g, 12, y, 4)?.src, 'b2', 'shared gable wall is the tower\'s at y=' + y);
  assert.equal(colOf(g, 13, 4, 'b1').filter(([k]) => +k.split(',')[1] >= 0).length, 0, 'no house eave ledge across the tower face');
  assert.equal(colOf(g, 10, 4, 'b1').length, 0, 'tower room is open');
  // a smaller storey set in from the walls of a hip-roofed floor
  const low = box({ w: 13, d: 13, wallH: 4, roof: { type: 'hip', overhang: 1 } });
  const up = box({ id: 'b2', x: 3, z: 3, w: 7, d: 7, baseY: 4, wallH: 4, roof: { type: 'gable', overhang: 1, material: 'dark_oak' } });
  const s = buildGrid(design([low, up]));
  assert.ok(colOf(s, 2, 6, 'b1').some(([k]) => +k.split(',')[1] === 6), 'lower roof reaches the upper wall');
  for (let y = 4; y < 8; y++) assert.equal(get(s, 3, y, 6)?.src, 'b2');
  // a dormer on the wall line still merges (the sample house is unchanged)
  const sample = buildGrid(defaultDesign());
  assert.ok(sample.blocks.size > 300);
});

test('encodeGrid / decodeGrid round-trip a grid', () => {
  const g = buildGrid(defaultDesign());
  const enc = encodeGrid(g);
  assert.ok(enc.palette.length < g.blocks.size / 2, 'blocks share templates');
  const back = decodeGrid(structuredClone(enc));
  assert.equal(back.blocks.size, g.blocks.size);
  assert.deepEqual(back.min, g.min);
  assert.deepEqual(back.max, g.max);
  for (const [k, b] of g.blocks) assert.deepEqual(back.blocks.get(k), b, k);
});

test('scaleDesign grows the whole build in proportion, keeping relative placement', () => {
  const d = defaultDesign();
  const { design: big } = scaleDesign(d, 2);
  assert.equal(big.boxes.length, d.boxes.length);
  // every box doubles; boxes that touched still touch; ground stays at the same level
  for (let i = 0; i < d.boxes.length; i++) {
    const a = d.boxes[i], b = big.boxes[i];
    assert.equal(b.w, a.w * 2); assert.equal(b.d, a.d * 2); assert.equal(b.wallH, a.wallH * 2);
    assert.equal(b.roof.rise, a.roof.rise, 'pitch kept');
  }
  const minY = (x) => Math.min(...x.boxes.map((b) => b.baseY));
  assert.equal(minY(big), minY(d));
  // relative offsets double too
  const dx = (x) => x.boxes[1].x - x.boxes[0].x;
  assert.equal(dx(big), dx(d) * 2);
  // the build roughly doubles in each direction, and builds cleanly
  const g0 = buildGrid(d), g1 = buildGrid(big);
  const ext = (g) => [g.max.x - g.min.x + 1, g.max.y - g.min.y + 1, g.max.z - g.min.z + 1];
  ext(g1).forEach((v, i) => assert.ok(v >= ext(g0)[i] * 1.7 && v <= ext(g0)[i] * 2.3, `axis ${i}: ${ext(g0)[i]} -> ${v}`));
  // hand-placed blocks become 2x2x2
  const withEdit = { ...d, edits: [{ x: 30, y: 0, z: 30, shape: 'full', mat: 'stone' }] };
  assert.equal(scaleDesign(withEdit, 2).design.edits.length, 8);
  // scaling down never makes anything smaller than a block; only= scales one object
  const tiny = scaleDesign(d, 0.1).design;
  assert.ok(tiny.boxes.every((b) => b.w >= 1 && b.d >= 1 && b.wallH >= 1));
  const one = scaleDesign(d, 2, { only: d.boxes[0].id }).design;
  assert.equal(one.boxes[0].w, d.boxes[0].w * 2);
  assert.deepEqual(one.boxes[1], d.boxes[1]);
});

test('texture variation mixes in up to six chosen (or auto) blocks', () => {
  const b = box({ w: 15, d: 15, wallH: 8, wallMaterial: 'stone_bricks', variation: { wall: 60, style: 'scatter', wallMixCount: 4, wallMix: 'mossy_stone_bricks', wallMix2: 'cracked_stone_bricks', wallMix3: 'andesite', wallMix4: 'tuff_bricks' } });
  const g = buildGrid(design([b]));
  const mats = new Set([...g.blocks.values()].filter((k) => k.path === 'wallMaterial').map((k) => k.mat));
  for (const m of ['stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'andesite', 'tuff_bricks']) assert.ok(mats.has(m), m);
  // left on Auto, a bigger mix still finds different look-alikes
  const auto = box({ w: 15, d: 15, wallH: 8, wallMaterial: 'oak', variation: { wall: 60, style: 'scatter', wallMixCount: 5 } });
  const am = new Set([...buildGrid(design([auto])).blocks.values()].filter((k) => k.path === 'wallMaterial').map((k) => k.mat));
  assert.ok(am.size >= 4, [...am].join(','));
});

test('texture settings are shared by all boxes unless a box keeps its own', () => {
  const mats = (g, src) => new Set([...g.blocks.values()].filter((k) => k.src === src && k.path === 'wallMaterial').map((k) => k.mat));
  const a = box({ id: 'b1', w: 9, d: 9, wallH: 6, wallMaterial: 'stone_bricks' });
  const b = box({ id: 'b2', x: 20, w: 9, d: 9, wallH: 6, wallMaterial: 'stone_bricks' });
  const shared = { wall: 60, style: 'scatter', wallMixCount: 1, wallMix: 'andesite' };
  // shared settings reach every box
  let g = buildGrid({ ...design([a, b]), variation: shared });
  assert.ok(mats(g, 'b1').has('andesite') && mats(g, 'b2').has('andesite'));
  // a box with its own texture ignores the shared one
  g = buildGrid({ ...design([a, { ...b, ownTexture: true, variation: { wall: 60, style: 'scatter', wallMixCount: 1, wallMix: 'tuff_bricks' } }]), variation: shared });
  assert.ok(mats(g, 'b1').has('andesite') && !mats(g, 'b1').has('tuff_bricks'));
  assert.ok(mats(g, 'b2').has('tuff_bricks') && !mats(g, 'b2').has('andesite'));
  // an older design with per-box settings keeps its look: the odd box keeps its own
  const v = validateDesign(design([{ ...a, variation: shared }, { ...b, variation: shared }, box({ id: 'b3', x: 40, variation: { wall: 10 } })]));
  assert.equal(v.variation.wall, 60);
  assert.deepEqual(v.boxes.map((x) => x.ownTexture), [false, false, true]);
});

test('assets: placed on a wall facing out, cutting holes and adding blocks; templates update', () => {
  // A window: a 1x2 hole in the wall layer with a pane, and a sill stair sticking out in front.
  const asset = { id: 'a1', name: 'Window', cells: [
    { x: 0, y: 1, z: 0, shape: 'pane', mat: 'glass', axis: 'x' },
    { x: 0, y: 2, z: 0, shape: 'erase' },
    { x: 0, y: 0, z: 1, shape: 'stair', mat: 'spruce', facing: 'north', half: 'top' },
  ] };
  const house = box({ w: 9, d: 7, wallH: 4 });
  // south wall is z = 6; east wall is x = 8
  const d = { ...design([house]), assets: [asset], stamps: [{ id: 't1', asset: 'a1', x: 4, baseY: 1, z: 6, facing: 'south' }, { id: 't2', asset: 'a1', x: 8, baseY: 1, z: 3, facing: 'east' }] };
  const g = buildGrid(d);
  assert.equal(get(g, 4, 2, 6).kind, 'pane', 'glass in the south wall');
  assert.equal(get(g, 4, 3, 6), undefined, 'hole above it');
  const sill = get(g, 4, 1, 7);
  assert.equal(sill.kind, 'stair'); assert.equal(sill.props.facing, 'north', 'sill tucks back into the south wall');
  assert.equal(get(g, 8, 2, 3).kind, 'pane', 'glass in the east wall');
  assert.equal(get(g, 8, 2, 3).props.north, 'true', 'pane turned to run along the east wall');
  assert.equal(get(g, 9, 1, 3).props.facing, 'west', 'east sill tucks back west');
  assert.equal(get(g, 4, 2, 6).src, 't1');
  // editing the template changes every placement
  const d2 = { ...d, assets: [{ ...asset, cells: asset.cells.map((c) => (c.mat === 'glass' ? { ...c, mat: 'red_stained_glass' } : c)) }] };
  const g2 = buildGrid(d2);
  assert.equal(get(g2, 4, 2, 6).mat, 'red_stained_glass');
  assert.equal(get(g2, 8, 2, 3).mat, 'red_stained_glass');
  // stamps of a deleted asset are dropped; rotatePatch turns a stamp
  assert.equal(validateDesign({ ...d, assets: [] }).stamps.length, 0);
  assert.deepEqual(rotatePatch('stamp', { facing: 'south' }, 1), { facing: 'west' });
});

test('doors and trapdoors: two-block doors, trapdoor states, fallbacks, one item per door', () => {
  const edits = [
    { x: 0, y: 0, z: -3, shape: 'door', mat: 'oak', facing: 'north', hinge: 'right', open: true },
    { x: 2, y: 0, z: -3, shape: 'trapdoor', mat: 'iron_block', facing: 'east', half: 'top' },
    { x: 4, y: 0, z: -3, shape: 'door', mat: 'stone' },
  ];
  const g = buildGrid(design([box()], { edits }));
  const lo = get(g, 0, 0, -3), hi = get(g, 0, 1, -3);
  assert.equal(lo.id, 'minecraft:oak_door');
  assert.deepEqual([lo.props.half, hi.props.half, lo.props.hinge, lo.props.open], ['lower', 'upper', 'right', 'true']);
  const td = get(g, 2, 0, -3);
  assert.equal(td.id, 'minecraft:iron_trapdoor');
  assert.deepEqual([td.props.facing, td.props.half, td.props.open], ['east', 'top', 'false']);
  assert.equal(get(g, 4, 0, -3).kind, 'full', 'stone has no door');
  assert.equal(materialTotals(g).find((t) => t.id === 'minecraft:oak_door').count, 1);
});

test('a lower roof that would bury an upper storey stops under its eave', () => {
  const hall = box({ x: -16, z: -12, w: 45, d: 33, baseY: 3, wallH: 12, roof: { type: 'hip', axis: 'x', overhang: 6, profile: 'flared' } });
  const up = box({ id: 'b2', x: -4, z: -3, w: 21, d: 15, baseY: 15, wallH: 12, roof: { type: 'irimoya', axis: 'x', overhang: 6, profile: 'flared', material: 'dark_oak' } });
  const g = buildGrid(design([hall, up]));
  // Under the upper eave the hall roof never comes within a block of it.
  let worst = -Infinity;
  for (const b of g.blocks.values()) if (b.src === 'b1' && b.role === 'roof' && b.x >= -10 && b.x <= 22 && b.z >= -9 && b.z <= 17) worst = Math.max(worst, b.y);
  let eave = Infinity;
  for (const b of g.blocks.values()) if (b.src === 'b2' && b.role === 'roof') eave = Math.min(eave, b.y);
  assert.ok(worst < eave - 1, `hall roof top ${worst} under upper eave ${eave}`);
});

test('doors: erasing or painting one half takes the other half with it', () => {
  const edits = [
    { x: 0, y: 0, z: -3, shape: 'door', mat: 'oak', facing: 'north' },
    { x: 0, y: 1, z: -3, shape: 'erase' },
    { x: 2, y: 0, z: -3, shape: 'door', mat: 'oak', facing: 'north' },
    { x: 2, y: 1, z: -3, shape: 'paint', mat: 'spruce' },
  ];
  const g = buildGrid(design([box()], { edits }));
  assert.equal(get(g, 0, 0, -3), undefined, 'no lone lower half');
  assert.equal(get(g, 0, 1, -3), undefined);
  assert.deepEqual([get(g, 2, 0, -3).id, get(g, 2, 1, -3).id], ['minecraft:spruce_door', 'minecraft:spruce_door']);
});

test('a box one block deep still gets a south door', () => {
  const det = { door: true, doorSide: 'south', doorWidth: 1, doorHeight: 2 };
  const g = buildGrid(design([box({ w: 7, d: 1, details: det })]));
  const open = [];
  for (let x = 1; x < 6; x++) if (!get(g, x, 1, 0) && !get(g, x, 2, 0)) open.push(x);
  assert.deepEqual(open, [3]);
});

test('depth: posts stand proud, windows sit back, ledges, hoods and shutters', () => {
  const det = { windows: true, winWidth: 2, winHeight: 2, winGap: 3, winSill: 2, corners: true, trimMat: 'dark_oak', cornerMat: 'spruce_log', baseMat: 'cobblestone',
    pilasters: true, pilasterGap: 0, recess: true, plinth: true, cornice: true, hoods: true, shutters: true };
  const g = buildGrid(design([box({ w: 17, d: 7, wallH: 7, roof: { overhang: 0 }, details: det })]));
  // Corner post wraps the outside corner (south-east).
  for (const [x, z] of [[17, 6], [16, 7], [17, 7]]) assert.equal(get(g, x, 3, z).path, 'details.cornerMat', `post at ${x},${z}`);
  // South windows: glass moved one cell in, the face cell is open.
  assert.equal(get(g, 3, 2, 6), undefined);
  assert.equal(get(g, 3, 2, 5).kind, 'pane');
  // Hood above, shutters either side, plinth at the foot facing the wall, cornice under the eave.
  assert.deepEqual([get(g, 3, 4, 7).kind, get(g, 3, 4, 7).props.half], ['stair', 'bottom']);
  assert.equal(get(g, 1, 2, 7).kind, 'trapdoor');
  assert.equal(get(g, 1, 2, 7).props.open, 'true');
  assert.deepEqual([get(g, 8, 0, 7).kind, get(g, 8, 0, 7).props.facing], ['stair', 'north']);
  assert.deepEqual([get(g, 8, 6, 7).kind, get(g, 8, 6, 7).props.half], ['stair', 'top']);
  // Off by default: nothing outside the wall.
  const flat = buildGrid(design([box({ w: 17, d: 7, wallH: 7, roof: { overhang: 0 }, details: { windows: true } })]));
  assert.equal(get(flat, 8, 0, 7), undefined);
});
