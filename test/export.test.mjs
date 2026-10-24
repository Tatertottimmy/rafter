// test/export.test.mjs — tests for export.js (run: node --test test/export.test.mjs)
// Builds synthetic grids by hand (does NOT import engine.js) and round-trips the
// encoders through the independent decoder in test/nbt-read.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';

import {
  TAG as W, writeNBT, tagInt, tagLong, tagShort, tagString, tagList, tagCompound,
  tagLongArray, tagByteArray, tagIntArray, encodeLitematic, encodeSchem, stateString,
} from '../export.js';
import { TAG, readNBT, get, val } from './nbt-read.mjs';

// ---------------------------------------------------------------------------
// Synthetic grid helpers (mirror the SPEC Grid/Block shape without engine.js)
// ---------------------------------------------------------------------------
const key = (x, y, z) => `${x},${y},${z}`;

function newGrid() {
  return { blocks: new Map(), min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, surface: new Map() };
}
function put(grid, x, y, z, block) { grid.blocks.set(key(x, y, z), block); }
function finalize(grid) {
  if (!grid.blocks.size) { grid.min = { x: 0, y: 0, z: 0 }; grid.max = { x: 0, y: 0, z: 0 }; return grid; }
  const mn = { x: Infinity, y: Infinity, z: Infinity }, mx = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const k of grid.blocks.keys()) {
    const [x, y, z] = k.split(',').map(Number);
    mn.x = Math.min(mn.x, x); mn.y = Math.min(mn.y, y); mn.z = Math.min(mn.z, z);
    mx.x = Math.max(mx.x, x); mx.y = Math.max(mx.y, y); mx.z = Math.max(mx.z, z);
  }
  grid.min = mn; grid.max = mx;
  return grid;
}

const FULL  = (id, mat) => ({ id, props: {}, kind: 'full', mat, role: 'wall', color: '#888888' });
const SLAB  = (id, mat, type) => ({ id, props: { type, waterlogged: 'false' }, kind: 'slab', mat, role: 'roof', color: '#888888' });
const STAIR = (id, mat, facing, half, shape) => ({ id, props: { waterlogged: 'false', shape, half, facing }, kind: 'stair', mat, role: 'roof', color: '#888888' });
const WALL  = (id, mat) => ({ id, props: { up: 'true', north: 'low', south: 'low', east: 'none', west: 'none', waterlogged: 'false' }, kind: 'wall', mat, role: 'wall', color: '#888888' });

/**
 * Grid A: bounds x -3..6 (10), y 2..5 (4), z 4..12 (9) => volume 360, a few hundred blocks,
 * 6 distinct states (palette 7 -> bits 3; 360*3 = 1080 bits, not a multiple of 64).
 */
function buildGridA() {
  const g = newGrid();
  const states = [
    FULL('minecraft:oak_planks', 'oak'),
    SLAB('minecraft:spruce_slab', 'spruce', 'bottom'),
    SLAB('minecraft:spruce_slab', 'spruce', 'top'),
    STAIR('minecraft:spruce_stairs', 'spruce', 'north', 'bottom', 'straight'),
    STAIR('minecraft:spruce_stairs', 'spruce', 'east', 'bottom', 'inner_left'),
    WALL('minecraft:stone_brick_wall', 'stone_bricks'),
  ];
  // Corner anchors so the bounds are exactly as intended.
  put(g, -3, 2, 4, states[0]);
  put(g, 6, 5, 12, states[0]);
  // Deterministic pseudo-random fill of ~70% of the cells.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 2; y <= 5; y++) for (let z = 4; z <= 12; z++) for (let x = -3; x <= 6; x++) {
    if (rnd() < 0.7) put(g, x, y, z, states[Math.floor(rnd() * states.length)]);
  }
  return finalize(g);
}

/** Grid B: 20 distinct states (palette 21 -> bits 5), bounds 7x3x5 = 105 cells => 525 bits => 9 longs (525 % 64 != 0). */
function buildGridB() {
  const g = newGrid();
  const states = [];
  for (const facing of ['north', 'south', 'east', 'west']) for (const shape of ['straight', 'outer_left', 'outer_right', 'inner_left', 'inner_right']) {
    states.push(STAIR('minecraft:stone_brick_stairs', 'stone_bricks', facing, 'bottom', shape));
  }
  assert.equal(states.length, 20);
  let i = 0;
  for (let y = 10; y <= 12; y++) for (let z = -2; z <= 2; z++) for (let x = 100; x <= 106; x++) {
    if ((x + y + z) % 4 === 0) continue; // leave some air
    put(g, x, y, z, states[i++ % states.length]);
  }
  return finalize(g);
}

// ---------------------------------------------------------------------------
// Independent reader-side helpers
// ---------------------------------------------------------------------------
/** Reader-side LitematicaBitArray: BigInt based, independent from the writer's 32-bit word packing. */
function unpackBitArray(longs, bits, count) {
  const out = new Array(count);
  const mask = (1n << BigInt(bits)) - 1n;
  const B = BigInt(bits);
  for (let i = 0; i < count; i++) {
    const start = BigInt(i) * B;
    const li = Number(start >> 6n);
    const off = start & 63n;
    let v = BigInt.asUintN(64, longs[li]) >> off;
    if (off + B > 64n) v |= BigInt.asUintN(64, longs[li + 1]) << (64n - off);
    out[i] = Number(v & mask);
  }
  return out;
}

function decodeVarints(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    let v = 0, shift = 0, b;
    do { b = bytes[i++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    out.push(v >>> 0);
  }
  return out;
}

function expectedPalette(grid) {
  const pal = ['minecraft:air'];
  for (const b of grid.blocks.values()) { const s = stateString(b); if (!pal.includes(s)) pal.push(s); }
  return pal;
}

function litematicPaletteStrings(paletteList) {
  return paletteList.value.items.map((c) => {
    const name = val(c, 'Name');
    const props = get(c, 'Properties');
    if (!props) return name;
    const keys = [...props.value.keys()].sort();
    return name + '[' + keys.map((k) => `${k}=${props.value.get(k).value}`).join(',') + ']';
  });
}

// ---------------------------------------------------------------------------
// writeNBT basics
// ---------------------------------------------------------------------------
test('writeNBT produces the canonical "hello world" bytes', () => {
  const bytes = writeNBT('hello world', tagCompound({ name: tagString('Bananrama') }));
  const hex = Buffer.from(bytes).toString('hex');
  // 0a | 000b "hello world" | 08 0004 "name" 0009 "Bananrama" | 00
  assert.equal(hex, '0a000b68656c6c6f20776f726c640800046e616d65000942616e616e72616d6100');
  const { name, tag } = readNBT(bytes);
  assert.equal(name, 'hello world');
  assert.equal(val(tag, 'name'), 'Bananrama');
});

test('tag helpers round-trip every tag type big-endian', () => {
  const root = tagCompound({
    s: tagShort(-2), i: tagInt(-123456), l: tagLong(-5n), lbig: tagLong(0x7fffffffffffffffn), lnum: tagLong(1700000000000),
    str: tagString('héllo ✓'),
    ia: tagIntArray([1, -1, 0x7fffffff]),
    ba: tagByteArray([0, 127, 255]),
    la1: tagLongArray([1n, -1n, 0x8000000000000000n]),
    la2: tagLongArray(new Uint32Array([0x00000001, 0x00000000, 0xffffffff, 0xffffffff, 0x00000000, 0x80000000])),
    emptyList: tagList([]),
    ints: tagList([tagInt(1), tagInt(2)]),
    comps: tagList([tagCompound({ a: tagInt(1) }), tagCompound({})]),
    nested: tagCompound({ deep: tagCompound({ x: tagInt(7) }) }),
  });
  const bytes = writeNBT('', root);
  const { name, tag, bytesRead } = readNBT(bytes);
  assert.equal(name, '');
  assert.equal(bytesRead, bytes.length);
  assert.equal(val(tag, 's'), -2);
  assert.equal(val(tag, 'i'), -123456);
  assert.equal(val(tag, 'l'), -5n);
  assert.equal(val(tag, 'lbig'), 0x7fffffffffffffffn);
  assert.equal(val(tag, 'lnum'), 1700000000000n);
  assert.equal(val(tag, 'str'), 'héllo ✓');
  assert.deepEqual([...val(tag, 'ia')], [1, -1, 0x7fffffff]);
  assert.deepEqual([...val(tag, 'ba')], [0, 127, 255]);
  assert.deepEqual([...val(tag, 'la1')], [1n, -1n, -0x8000000000000000n]);
  // words path: (lo,hi) pairs -> same longs as BigInt path
  assert.deepEqual([...val(tag, 'la2')], [1n, -1n, -0x8000000000000000n]);
  assert.equal(get(tag, 'emptyList').value.elemType, TAG.End);
  assert.equal(get(tag, 'emptyList').value.items.length, 0);
  assert.deepEqual(get(tag, 'ints').value.items.map((t) => t.value), [1, 2]);
  assert.equal(get(tag, 'comps').value.elemType, TAG.Compound);
  assert.equal(val(tag, 'comps', 0, 'a'), 1);
  assert.equal(val(tag, 'nested', 'deep', 'x'), 7);
  // Byte-level: first bytes are TAG_Compound, name len 0, then TAG_Short 's'
  assert.deepEqual([...bytes.subarray(0, 7)], [0x0a, 0x00, 0x00, 0x02, 0x00, 0x01, 0x73]);
});

test('stateString sorts props and omits brackets when empty', () => {
  assert.equal(stateString(FULL('minecraft:oak_planks', 'oak')), 'minecraft:oak_planks');
  assert.equal(stateString(STAIR('minecraft:spruce_stairs', 'spruce', 'north', 'bottom', 'straight')),
    'minecraft:spruce_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]');
});

// ---------------------------------------------------------------------------
// Litematic
// ---------------------------------------------------------------------------
function checkLitematic(grid, opts, expectBits) {
  const t0 = Date.now();
  const bytes = encodeLitematic(grid, opts);
  const t1 = Date.now();
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes[0], 0x0a, 'root is TAG_Compound');
  assert.deepEqual([...bytes.subarray(1, 3)], [0, 0], 'root name is empty');

  const { name, tag, bytesRead } = readNBT(bytes);
  assert.equal(name, '');
  assert.equal(bytesRead, bytes.length, 'no trailing bytes');

  const sx = grid.max.x - grid.min.x + 1, sy = grid.max.y - grid.min.y + 1, sz = grid.max.z - grid.min.z + 1;
  const volume = sx * sy * sz;

  // Root structure
  assert.deepEqual([...tag.value.keys()], ['Version', 'SubVersion', 'MinecraftDataVersion', 'Metadata', 'Regions']);
  assert.equal(get(tag, 'Version').type, TAG.Int); assert.equal(val(tag, 'Version'), 6);
  assert.equal(val(tag, 'SubVersion'), 1);
  assert.equal(val(tag, 'MinecraftDataVersion'), opts.dataVersion);

  // Metadata
  const md = get(tag, 'Metadata');
  assert.deepEqual([...md.value.keys()], ['Name', 'Author', 'Description', 'RegionCount', 'TotalVolume', 'TotalBlocks', 'TimeCreated', 'TimeModified', 'EnclosingSize']);
  assert.equal(val(md, 'Name'), opts.name);
  assert.equal(val(md, 'Author'), opts.author);
  assert.equal(val(md, 'Description'), opts.description);
  assert.equal(val(md, 'RegionCount'), 1);
  assert.equal(val(md, 'TotalVolume'), volume);
  assert.equal(val(md, 'TotalBlocks'), grid.blocks.size);
  assert.equal(get(md, 'TimeCreated').type, TAG.Long);
  assert.equal(get(md, 'TimeModified').type, TAG.Long);
  const tc = val(md, 'TimeCreated');
  assert.ok(tc >= BigInt(t0) && tc <= BigInt(t1), 'TimeCreated is ms since epoch');
  assert.equal(val(md, 'TimeModified'), tc);
  assert.deepEqual({ x: val(md, 'EnclosingSize', 'x'), y: val(md, 'EnclosingSize', 'y'), z: val(md, 'EnclosingSize', 'z') }, { x: sx, y: sy, z: sz });

  // Region
  const regions = get(tag, 'Regions');
  assert.equal(regions.type, TAG.Compound);
  assert.deepEqual([...regions.value.keys()], [opts.name], 'single region keyed by design name');
  const region = get(regions, opts.name);
  assert.deepEqual([...region.value.keys()], ['Position', 'Size', 'BlockStatePalette', 'BlockStates', 'Entities', 'TileEntities', 'PendingBlockTicks', 'PendingFluidTicks']);
  assert.deepEqual([val(region, 'Position', 'x'), val(region, 'Position', 'y'), val(region, 'Position', 'z')], [0, 0, 0]);
  assert.deepEqual([val(region, 'Size', 'x'), val(region, 'Size', 'y'), val(region, 'Size', 'z')], [sx, sy, sz]);
  for (const k of ['Entities', 'TileEntities', 'PendingBlockTicks', 'PendingFluidTicks']) {
    const l = get(region, k);
    assert.equal(l.type, TAG.List);
    assert.equal(l.value.elemType, TAG.End);
    assert.equal(l.value.items.length, 0);
  }

  // Palette
  const palList = get(region, 'BlockStatePalette');
  assert.equal(palList.type, TAG.List);
  if (palList.value.items.length) assert.equal(palList.value.elemType, TAG.Compound);
  const pal = litematicPaletteStrings(palList);
  const expPal = expectedPalette(grid);
  assert.deepEqual(pal, expPal, 'palette: air first, then first-seen order');
  assert.equal(val(palList, 0, 'Name'), 'minecraft:air');
  assert.equal(get(palList, 0, 'Properties'), undefined, 'air has no Properties');
  for (const c of palList.value.items) {
    const p = get(c, 'Properties');
    if (p) {
      assert.ok(p.value.size > 0, 'Properties omitted when empty');
      for (const v of p.value.values()) assert.equal(v.type, TAG.String);
    }
  }

  // BlockStates
  const bits = Math.max(2, Math.ceil(Math.log2(pal.length)));
  assert.equal(bits, expectBits);
  const bs = get(region, 'BlockStates');
  assert.equal(bs.type, TAG.LongArray);
  assert.equal(bs.value.length, Math.ceil((volume * bits) / 64), 'long array length');
  const idx = unpackBitArray(bs.value, bits, volume);
  const palIndex = new Map(pal.map((s, i) => [s, i]));
  let nonAir = 0;
  for (let ly = 0; ly < sy; ly++) for (let lz = 0; lz < sz; lz++) for (let lx = 0; lx < sx; lx++) {
    const i = (ly * sz + lz) * sx + lx;
    const b = grid.blocks.get(key(lx + grid.min.x, ly + grid.min.y, lz + grid.min.z));
    const want = b ? palIndex.get(stateString(b)) : 0;
    if (idx[i] !== want) assert.fail(`BlockStates mismatch at local (${lx},${ly},${lz}) index ${i}: got ${idx[i]} want ${want}`);
    if (want) nonAir++;
  }
  assert.equal(nonAir, grid.blocks.size);
  // Any bits beyond volume*bits must be zero.
  const totalBits = BigInt(volume * bits);
  const lastLong = BigInt.asUintN(64, bs.value[bs.value.length - 1]);
  const usedInLast = totalBits - BigInt(bs.value.length - 1) * 64n;
  if (usedInLast < 64n) assert.equal(lastLong >> usedInLast, 0n, 'padding bits are zero');
  return { bytes, tag, bits };
}

test('Litematic: grid A (non-zero min, 6 states, bits=3, 1080 bits spans longs)', () => {
  const grid = buildGridA();
  assert.deepEqual(grid.min, { x: -3, y: 2, z: 4 });
  assert.deepEqual(grid.max, { x: 6, y: 5, z: 12 });
  assert.ok(grid.blocks.size >= 200 && grid.blocks.size < 360, `block count ${grid.blocks.size}`);
  assert.equal(expectedPalette(grid).length, 7);
  const { bits } = checkLitematic(grid, { name: 'Farmhouse', author: 'mike', description: 'test build', dataVersion: 4440 }, 3);
  assert.equal((360 * bits) % 64 !== 0, true, 'bit count is not a multiple of 64');
});

test('Litematic: grid B (21-entry palette => bits=5, 525 bits => 9 longs)', () => {
  const grid = buildGridB();
  assert.deepEqual(grid.min, { x: 100, y: 10, z: -2 });
  assert.equal(expectedPalette(grid).length, 21);
  const { tag } = checkLitematic(grid, { name: 'Stairs Zoo', author: '', description: '', dataVersion: 3955 }, 5);
  assert.equal(val(tag, 'Regions', 'Stairs Zoo', 'BlockStates').length, 9);
});

test('Litematic: 2-entry palette uses bits=2 (minimum)', () => {
  const g = newGrid();
  for (let x = 0; x < 5; x++) put(g, x, 0, 0, FULL('minecraft:stone', 'stone'));
  finalize(g);
  checkLitematic(g, { name: 'Row', author: '', description: '', dataVersion: 4440 }, 2);
});

test('Litematic: empty grid => 1x1x1 air region, no throw', () => {
  const g = finalize(newGrid());
  const { tag } = checkLitematic(g, { name: 'Empty', author: '', description: '', dataVersion: 4440 }, 2);
  assert.equal(val(tag, 'Metadata', 'TotalVolume'), 1);
  assert.equal(val(tag, 'Metadata', 'TotalBlocks'), 0);
  const bs = val(tag, 'Regions', 'Empty', 'BlockStates');
  assert.equal(bs.length, 1);
  assert.equal(bs[0], 0n);
  assert.deepEqual(litematicPaletteStrings(get(tag, 'Regions', 'Empty', 'BlockStatePalette')), ['minecraft:air']);
});

test('Litematic: missing name falls back to a non-empty region key; defaults applied', () => {
  const g = finalize(newGrid());
  const { tag } = readNBT(encodeLitematic(g, {}));
  const regionKeys = [...get(tag, 'Regions').value.keys()];
  assert.equal(regionKeys.length, 1);
  assert.ok(regionKeys[0].length > 0);
  assert.equal(val(tag, 'Metadata', 'Name'), regionKeys[0]);
  assert.equal(val(tag, 'MinecraftDataVersion'), 4440);
});

// ---------------------------------------------------------------------------
// Sponge v2 .schem
// ---------------------------------------------------------------------------
function checkSchem(grid, dataVersion) {
  const bytes = encodeSchem(grid, { dataVersion });
  assert.ok(bytes instanceof Uint8Array);
  const { name, tag, bytesRead } = readNBT(bytes);
  assert.equal(name, 'Schematic');
  assert.equal(bytesRead, bytes.length);

  const sx = grid.max.x - grid.min.x + 1, sy = grid.max.y - grid.min.y + 1, sz = grid.max.z - grid.min.z + 1;
  const volume = sx * sy * sz;

  assert.deepEqual([...tag.value.keys()], ['Version', 'DataVersion', 'Width', 'Height', 'Length', 'Offset', 'PaletteMax', 'Palette', 'BlockData', 'BlockEntities', 'Metadata']);
  assert.equal(val(tag, 'Version'), 2);
  assert.equal(val(tag, 'DataVersion'), dataVersion);
  assert.equal(get(tag, 'Width').type, TAG.Short);
  assert.equal(get(tag, 'Height').type, TAG.Short);
  assert.equal(get(tag, 'Length').type, TAG.Short);
  assert.equal(val(tag, 'Width'), sx);
  assert.equal(val(tag, 'Height'), sy);
  assert.equal(val(tag, 'Length'), sz);
  assert.equal(get(tag, 'Offset').type, TAG.IntArray);
  assert.deepEqual([...val(tag, 'Offset')], [0, 0, 0]);

  const palette = get(tag, 'Palette');
  assert.equal(palette.type, TAG.Compound);
  const expPal = expectedPalette(grid);
  assert.equal(val(tag, 'PaletteMax'), expPal.length);
  assert.equal(palette.value.size, expPal.length);
  assert.equal(val(palette, 'minecraft:air'), 0);
  for (let i = 0; i < expPal.length; i++) {
    assert.equal(get(palette, expPal[i]).type, TAG.Int);
    assert.equal(val(palette, expPal[i]), i, `palette id for ${expPal[i]}`);
  }

  const bd = get(tag, 'BlockData');
  assert.equal(bd.type, TAG.ByteArray);
  const ids = decodeVarints(bd.value);
  assert.equal(ids.length, volume, 'one varint per cell');
  const palIndex = new Map(expPal.map((s, i) => [s, i]));
  for (let ly = 0; ly < sy; ly++) for (let lz = 0; lz < sz; lz++) for (let lx = 0; lx < sx; lx++) {
    const i = lx + lz * sx + ly * sx * sz;
    const b = grid.blocks.get(key(lx + grid.min.x, ly + grid.min.y, lz + grid.min.z));
    const want = b ? palIndex.get(stateString(b)) : 0;
    if (ids[i] !== want) assert.fail(`BlockData mismatch at local (${lx},${ly},${lz}): got ${ids[i]} want ${want}`);
  }

  const be = get(tag, 'BlockEntities');
  assert.equal(be.type, TAG.List); assert.equal(be.value.elemType, TAG.End); assert.equal(be.value.items.length, 0);
  const md = get(tag, 'Metadata');
  assert.equal(md.type, TAG.Compound); assert.equal(md.value.size, 0);
  return { bytes, tag };
}

test('Schem: grid A', () => { checkSchem(buildGridA(), 4440); });
test('Schem: grid B', () => { checkSchem(buildGridB(), 3955); });
test('Schem: empty grid => 1x1x1, single zero varint', () => {
  const { tag } = checkSchem(finalize(newGrid()), 4440);
  assert.deepEqual([...val(tag, 'BlockData')], [0]);
  assert.equal(val(tag, 'PaletteMax'), 1);
});

test('Schem: palette > 127 entries produces multi-byte varints', () => {
  const g = newGrid();
  // 130 distinct states via a fake property value; sizes keep it small.
  let n = 0;
  for (let y = 0; y < 2; y++) for (let z = 0; z < 8; z++) for (let x = 0; x < 9; x++) {
    put(g, x, y, z, { id: 'minecraft:white_wool', props: { v: String(n++) }, kind: 'full', mat: 'wool', role: 'wall', color: '#fff' });
  }
  finalize(g);
  assert.equal(expectedPalette(g).length, 145);
  const { tag } = checkSchem(g, 4440);
  const bd = val(tag, 'BlockData');
  assert.ok(bd.length > 144, 'some varints are 2 bytes');
  assert.ok(bd.some((b) => b & 0x80), 'continuation bit present');
  // Litematic side of the same grid: palette 145 -> bits 8, volume 144 => 1152 bits => 18 longs exactly.
  checkLitematic(g, { name: 'Wool', author: '', description: '', dataVersion: 4440 }, 8);
});

// ---------------------------------------------------------------------------
// Caller-side flow: gzip the uncompressed bytes
// ---------------------------------------------------------------------------
test('gzip wrapper: magic bytes and lossless round-trip for both formats', () => {
  const grid = buildGridA();
  for (const raw of [encodeLitematic(grid, { name: 'Farmhouse', author: '', description: '', dataVersion: 4440 }), encodeSchem(grid, { dataVersion: 4440 })]) {
    const gz = gzipSync(raw);
    assert.equal(gz[0], 0x1f);
    assert.equal(gz[1], 0x8b);
    assert.equal(gz[2], 0x08, 'deflate method');
    const back = new Uint8Array(gunzipSync(gz));
    assert.equal(back.length, raw.length);
    assert.deepEqual(Buffer.from(back), Buffer.from(raw));
    // and it still decodes
    readNBT(back);
  }
});

test('determinism: identical grids give identical bytes except timestamps', () => {
  const a = encodeSchem(buildGridA(), { dataVersion: 4440 });
  const b = encodeSchem(buildGridA(), { dataVersion: 4440 });
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
});

test('performance: 150k-block grid encodes quickly', () => {
  const g = newGrid();
  const st = [FULL('minecraft:stone', 'stone'), SLAB('minecraft:stone_slab', 'stone', 'bottom'), STAIR('minecraft:stone_stairs', 'stone', 'west', 'top', 'outer_right')];
  let n = 0;
  for (let y = 0; y < 15; y++) for (let z = 0; z < 100; z++) for (let x = 0; x < 100; x++) put(g, x, y, z, st[n++ % 3]);
  finalize(g);
  assert.equal(g.blocks.size, 150000);
  const t0 = performance.now();
  const lit = encodeLitematic(g, { name: 'Big', author: '', description: '', dataVersion: 4440 });
  const sch = encodeSchem(g, { dataVersion: 4440 });
  const dt = performance.now() - t0;
  assert.ok(lit.length > 150000 * 2 / 8 && sch.length > 150000, 'plausible sizes');
  assert.ok(dt < 5000, `encode took ${dt.toFixed(0)} ms`);
});
