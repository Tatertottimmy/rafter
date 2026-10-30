// export.js — Rafter EXPORT module.
// Pure ES module: no DOM, no dependencies. Produces UNcompressed NBT bytes;
// the caller gzips them (e.g. pako.gzip(bytes)) before saving .litematic / .schem.
//
// Public API:
//   writeNBT(rootName, compoundTag) -> Uint8Array
//   tag helpers: tagByte, tagShort, tagInt, tagLong, tagFloat, tagDouble, tagString,
//                tagList, tagCompound, tagByteArray, tagIntArray, tagLongArray
//   encodeLitematic(grid, {name, author, description, dataVersion}) -> Uint8Array
//   encodeSchem(grid, {dataVersion}) -> Uint8Array
//   stateString(block)  (local copy; identical contract to engine.js so export.js stays dependency-free)
//   buildPalette(grid) -> { palette: string[], index: Map<string, number>, states: Map<key, number> }

// ---------------------------------------------------------------------------
// NBT tag ids
// ---------------------------------------------------------------------------
export const TAG = Object.freeze({
  End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6,
  ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12,
});

// ---------------------------------------------------------------------------
// Tag constructors. A tag is a plain { type, value } object.
//   Compound value: plain object whose own-key insertion order is the write order,
//                   each value being a tag.
//   List value:     { elemType, items } where items are tags of that type.
// ---------------------------------------------------------------------------
export function tagByte(v)   { return { type: TAG.Byte,   value: v | 0 }; }
export function tagShort(v)  { return { type: TAG.Short,  value: v | 0 }; }
export function tagInt(v)    { return { type: TAG.Int,    value: v | 0 }; }
export function tagLong(v)   { return { type: TAG.Long,   value: BigInt.asIntN(64, typeof v === 'bigint' ? v : BigInt(Math.trunc(v))) }; }
export function tagFloat(v)  { return { type: TAG.Float,  value: +v }; }
export function tagDouble(v) { return { type: TAG.Double, value: +v }; }
export function tagString(v) { return { type: TAG.String, value: String(v ?? '') }; }
export function tagCompound(obj = {}) { return { type: TAG.Compound, value: obj }; }
export function tagByteArray(arr) { return { type: TAG.ByteArray, value: arr instanceof Uint8Array ? arr : Uint8Array.from(arr) }; }
export function tagIntArray(arr)  { return { type: TAG.IntArray,  value: arr instanceof Int32Array ? arr : Int32Array.from(arr) }; }
// LongArray accepts: BigInt64Array / BigUint64Array, an array of BigInt|number, or a
// Uint32Array of 32-bit words in (lo0, hi0, lo1, hi1, ...) order.
export function tagLongArray(arr) {
  if (arr instanceof Uint32Array) {
    if (arr.length & 1) throw new Error('tagLongArray: word array must have even length');
    return { type: TAG.LongArray, value: arr, words: true };
  }
  if (arr instanceof BigInt64Array || arr instanceof BigUint64Array) return { type: TAG.LongArray, value: arr, words: false };
  return { type: TAG.LongArray, value: BigInt64Array.from(Array.from(arr, (x) => BigInt.asIntN(64, BigInt(x)))), words: false };
}
/** tagList(items, elemType?) — elemType defaults to the first item's type, or TAG_End for an empty list. */
export function tagList(items = [], elemType) {
  const t = elemType ?? (items.length ? items[0].type : TAG.End);
  for (const it of items) if (it.type !== t) throw new Error('tagList: heterogeneous list');
  return { type: TAG.List, value: { elemType: t, items } };
}

// ---------------------------------------------------------------------------
// Byte writer (growable, big-endian)
// ---------------------------------------------------------------------------
class ByteWriter {
  constructor(initial = 1 << 16) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }
  u8(v)  { this.ensure(1); this.buf[this.pos++] = v & 0xff; }
  i8(v)  { this.ensure(1); this.view.setInt8(this.pos, v); this.pos += 1; }
  i16(v) { this.ensure(2); this.view.setInt16(this.pos, v, false); this.pos += 2; }
  u16(v) { this.ensure(2); this.view.setUint16(this.pos, v, false); this.pos += 2; }
  i32(v) { this.ensure(4); this.view.setInt32(this.pos, v, false); this.pos += 4; }
  u32(v) { this.ensure(4); this.view.setUint32(this.pos, v >>> 0, false); this.pos += 4; }
  i64(v) { this.ensure(8); this.view.setBigInt64(this.pos, v, false); this.pos += 8; }
  f32(v) { this.ensure(4); this.view.setFloat32(this.pos, v, false); this.pos += 4; }
  f64(v) { this.ensure(8); this.view.setFloat64(this.pos, v, false); this.pos += 8; }
  bytes(arr) { this.ensure(arr.length); this.buf.set(arr, this.pos); this.pos += arr.length; }
  string(s) {
    // NBT uses Java's "modified UTF-8": like UTF-8 for most text, but U+0000 is C0 80 and a
    // character outside the BMP (an emoji in a design name) is its two UTF-16 halves, 3 bytes
    // each. Java refuses ordinary 4-byte UTF-8 and the file would not load.
    const enc = /[\0\uD800-\uDFFF]/.test(s) ? modifiedUtf8(s) : new TextEncoder().encode(s);
    if (enc.length > 0xffff) throw new Error('NBT string too long');
    this.u16(enc.length);
    this.bytes(enc);
  }
  result() { return this.buf.slice(0, this.pos); }
}

function modifiedUtf8(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 1 && c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

function writePayload(w, tag) {
  switch (tag.type) {
    case TAG.Byte:   w.i8(tag.value); break;
    case TAG.Short:  w.i16(tag.value); break;
    case TAG.Int:    w.i32(tag.value); break;
    case TAG.Long:   w.i64(tag.value); break;
    case TAG.Float:  w.f32(tag.value); break;
    case TAG.Double: w.f64(tag.value); break;
    case TAG.String: w.string(tag.value); break;
    case TAG.ByteArray:
      w.i32(tag.value.length);
      w.bytes(tag.value);
      break;
    case TAG.IntArray:
      w.i32(tag.value.length);
      for (let i = 0; i < tag.value.length; i++) w.i32(tag.value[i]);
      break;
    case TAG.LongArray:
      if (tag.words) {
        const words = tag.value;
        w.i32(words.length >>> 1);
        for (let i = 0; i < words.length; i += 2) { w.u32(words[i + 1]); w.u32(words[i]); } // hi word then lo word = big-endian long
      } else {
        w.i32(tag.value.length);
        for (let i = 0; i < tag.value.length; i++) w.i64(BigInt.asIntN(64, tag.value[i]));
      }
      break;
    case TAG.List: {
      const { elemType, items } = tag.value;
      w.u8(elemType);
      w.i32(items.length);
      for (const it of items) writePayload(w, it);
      break;
    }
    case TAG.Compound:
      for (const key of Object.keys(tag.value)) {
        const t = tag.value[key];
        w.u8(t.type);
        w.string(key);
        writePayload(w, t);
      }
      w.u8(TAG.End);
      break;
    default:
      throw new Error('writeNBT: unknown tag type ' + tag.type);
  }
}

/** Serialize a named root compound to uncompressed NBT bytes. */
export function writeNBT(rootName, compoundTag) {
  if (!compoundTag || compoundTag.type !== TAG.Compound) throw new Error('writeNBT: root must be a compound tag');
  const w = new ByteWriter();
  w.u8(TAG.Compound);
  w.string(rootName ?? '');
  writePayload(w, compoundTag);
  return w.result();
}

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------
const AIR = 'minecraft:air';

/** Same contract as engine.js stateString(): props sorted by key; no brackets when no props. */
export function stateString(block) {
  const props = block.props || {};
  const keys = Object.keys(props).sort();
  if (!keys.length) return block.id;
  return block.id + '[' + keys.map((k) => k + '=' + props[k]).join(',') + ']';
}

function parseKeyLocal(key) {
  const [x, y, z] = key.split(',');
  return [x | 0, y | 0, z | 0];
}

function gridBounds(grid) {
  const min = grid.min || { x: 0, y: 0, z: 0 };
  const max = grid.max || { x: 0, y: 0, z: 0 };
  return {
    min, max,
    sx: Math.max(1, max.x - min.x + 1),
    sy: Math.max(1, max.y - min.y + 1),
    sz: Math.max(1, max.z - min.z + 1),
  };
}

/** Palette: index 0 = air; then each distinct stateString in first-seen order (grid.blocks iteration order). */
export function buildPalette(grid) {
  const palette = [AIR];
  const index = new Map([[AIR, 0]]);
  const states = new Map(); // block key -> palette index
  const blocks = grid && grid.blocks ? grid.blocks : new Map();
  for (const [key, block] of blocks) {
    const s = stateString(block);
    let idx = index.get(s);
    if (idx === undefined) { idx = palette.length; palette.push(s); index.set(s, idx); }
    states.set(key, idx);
  }
  return { palette, index, states };
}

/** Split "minecraft:x[a=b,c=d]" back into {name, props} for the Litematica palette. */
function splitState(s) {
  const br = s.indexOf('[');
  if (br < 0) return { name: s, props: null };
  const name = s.slice(0, br);
  const props = {};
  const body = s.slice(br + 1, -1);
  if (body) for (const kv of body.split(',')) { const eq = kv.indexOf('='); props[kv.slice(0, eq)] = kv.slice(eq + 1); }
  return { name, props };
}

function bitsFor(paletteSize) {
  // max(2, ceil(log2(n)))
  if (paletteSize <= 2) return 2;
  return Math.max(2, 32 - Math.clz32(paletteSize - 1));
}

// ---------------------------------------------------------------------------
// Litematica (.litematic), Version 6 / SubVersion 1
// ---------------------------------------------------------------------------
export function encodeLitematic(grid, opts = {}) {
  const name = (opts.name && String(opts.name)) || 'Unnamed';
  const author = String(opts.author ?? '');
  const description = String(opts.description ?? '');
  const dataVersion = Number.isFinite(+opts.dataVersion) ? (+opts.dataVersion | 0) : 4440;

  const { min, sx, sy, sz } = gridBounds(grid);
  const volume = sx * sy * sz;
  const { palette, states } = buildPalette(grid);
  const bits = bitsFor(palette.length);

  // LitematicaBitArray: entries LSB-first from bit 0 of long[0], spanning long
  // boundaries freely. We pack into 32-bit words (lo, hi per long) to stay in
  // fast integer math; tagLongArray(Uint32Array) writes each (lo,hi) pair as a
  // big-endian 64-bit long. Since bits <= 32 an entry touches at most 2 words.
  const longCount = Math.ceil((volume * bits) / 64);
  const words = new Uint32Array(longCount * 2);
  for (const [key, idx] of states) {
    const [x, y, z] = parseKeyLocal(key);
    const lx = x - min.x, ly = y - min.y, lz = z - min.z;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= sx || ly >= sy || lz >= sz) continue; // outside declared bounds: skip defensively
    const i = (ly * sz + lz) * sx + lx;
    const startBit = i * bits;
    const wi = startBit >>> 5;
    const off = startBit & 31;
    words[wi] = (words[wi] | (idx << off)) >>> 0;
    if (off + bits > 32) words[wi + 1] = (words[wi + 1] | (idx >>> (32 - off))) >>> 0;
  }

  const paletteTags = palette.map((s) => {
    const { name: n, props } = splitState(s);
    const c = { Name: tagString(n) };
    if (props && Object.keys(props).length) {
      const p = {};
      for (const k of Object.keys(props)) p[k] = tagString(props[k]);
      c.Properties = tagCompound(p);
    }
    return tagCompound(c);
  });

  const now = BigInt(Date.now());
  const region = tagCompound({
    Position: tagCompound({ x: tagInt(0), y: tagInt(0), z: tagInt(0) }),
    Size: tagCompound({ x: tagInt(sx), y: tagInt(sy), z: tagInt(sz) }),
    BlockStatePalette: tagList(paletteTags, TAG.Compound),
    BlockStates: tagLongArray(words),
    Entities: tagList([]),
    TileEntities: tagList([]),
    PendingBlockTicks: tagList([]),
    PendingFluidTicks: tagList([]),
  });

  const root = tagCompound({
    Version: tagInt(6),
    SubVersion: tagInt(1),
    MinecraftDataVersion: tagInt(dataVersion),
    Metadata: tagCompound({
      Name: tagString(name),
      Author: tagString(author),
      Description: tagString(description),
      RegionCount: tagInt(1),
      TotalVolume: tagInt(volume),
      TotalBlocks: tagInt(states.size),
      TimeCreated: tagLong(now),
      TimeModified: tagLong(now),
      EnclosingSize: tagCompound({ x: tagInt(sx), y: tagInt(sy), z: tagInt(sz) }),
    }),
    Regions: tagCompound({ [name]: region }),
  });

  return writeNBT('', root);
}

// ---------------------------------------------------------------------------
// Sponge schematic v2 (.schem)
// ---------------------------------------------------------------------------
export function encodeSchem(grid, opts = {}) {
  const dataVersion = Number.isFinite(+opts.dataVersion) ? (+opts.dataVersion | 0) : 4440;
  const { min, sx, sy, sz } = gridBounds(grid);
  const volume = sx * sy * sz;
  const { palette, states } = buildPalette(grid);

  // Dense index array (0 = air), then unsigned LEB128 varint encode.
  const ids = new Uint32Array(volume);
  for (const [key, idx] of states) {
    const [x, y, z] = parseKeyLocal(key);
    const lx = x - min.x, ly = y - min.y, lz = z - min.z;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= sx || ly >= sy || lz >= sz) continue;
    ids[lx + lz * sx + ly * sx * sz] = idx;
  }
  const out = new Uint8Array(volume * 5);
  let p = 0;
  for (let i = 0; i < volume; i++) {
    let v = ids[i];
    while (v >= 0x80) { out[p++] = (v & 0x7f) | 0x80; v >>>= 7; }
    out[p++] = v;
  }
  const blockData = out.slice(0, p);

  const paletteCompound = {};
  palette.forEach((s, i) => { paletteCompound[s] = tagInt(i); });

  const root = tagCompound({
    Version: tagInt(2),
    DataVersion: tagInt(dataVersion),
    Width: tagShort(sx),
    Height: tagShort(sy),
    Length: tagShort(sz),
    Offset: tagIntArray([0, 0, 0]),
    PaletteMax: tagInt(palette.length),
    Palette: tagCompound(paletteCompound),
    BlockData: tagByteArray(blockData),
    BlockEntities: tagList([]),
    Metadata: tagCompound({}),
  });

  return writeNBT('Schematic', root);
}
