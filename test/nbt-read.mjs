// test/nbt-read.mjs — minimal NBT decoder used ONLY by tests.
// Decodes uncompressed big-endian NBT into { type, value } tags:
//   Compound -> value: Map<name, tag>   (preserves order)
//   List     -> value: { elemType, items: tag[] }
//   Long     -> value: BigInt
//   LongArray-> value: BigInt64Array; IntArray -> Int32Array; ByteArray -> Uint8Array
// readNBT(bytes) returns { name, tag, bytesRead }.

export const TAG = Object.freeze({
  End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6,
  ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12,
});

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }
  need(n) { if (this.pos + n > this.bytes.length) throw new Error(`NBT: unexpected EOF at ${this.pos} (need ${n})`); }
  u8()  { this.need(1); return this.bytes[this.pos++]; }
  i8()  { this.need(1); const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
  i16() { this.need(2); const v = this.view.getInt16(this.pos, false); this.pos += 2; return v; }
  u16() { this.need(2); const v = this.view.getUint16(this.pos, false); this.pos += 2; return v; }
  i32() { this.need(4); const v = this.view.getInt32(this.pos, false); this.pos += 4; return v; }
  i64() { this.need(8); const v = this.view.getBigInt64(this.pos, false); this.pos += 8; return v; }
  f32() { this.need(4); const v = this.view.getFloat32(this.pos, false); this.pos += 4; return v; }
  f64() { this.need(8); const v = this.view.getFloat64(this.pos, false); this.pos += 8; return v; }
  string() {
    const n = this.u16();
    this.need(n);
    const s = new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
}

function readPayload(r, type) {
  switch (type) {
    case TAG.Byte:   return { type, value: r.i8() };
    case TAG.Short:  return { type, value: r.i16() };
    case TAG.Int:    return { type, value: r.i32() };
    case TAG.Long:   return { type, value: r.i64() };
    case TAG.Float:  return { type, value: r.f32() };
    case TAG.Double: return { type, value: r.f64() };
    case TAG.String: return { type, value: r.string() };
    case TAG.ByteArray: {
      const n = r.i32(); if (n < 0) throw new Error('NBT: negative array length');
      r.need(n);
      const v = r.bytes.slice(r.pos, r.pos + n); r.pos += n;
      return { type, value: v };
    }
    case TAG.IntArray: {
      const n = r.i32(); if (n < 0) throw new Error('NBT: negative array length');
      const v = new Int32Array(n);
      for (let i = 0; i < n; i++) v[i] = r.i32();
      return { type, value: v };
    }
    case TAG.LongArray: {
      const n = r.i32(); if (n < 0) throw new Error('NBT: negative array length');
      const v = new BigInt64Array(n);
      for (let i = 0; i < n; i++) v[i] = r.i64();
      return { type, value: v };
    }
    case TAG.List: {
      const elemType = r.u8();
      const n = r.i32(); if (n < 0) throw new Error('NBT: negative list length');
      if (elemType === TAG.End && n > 0) throw new Error('NBT: non-empty list of TAG_End');
      const items = [];
      for (let i = 0; i < n; i++) items.push(readPayload(r, elemType));
      return { type, value: { elemType, items } };
    }
    case TAG.Compound: {
      const map = new Map();
      for (;;) {
        const t = r.u8();
        if (t === TAG.End) break;
        const name = r.string();
        if (map.has(name)) throw new Error(`NBT: duplicate key "${name}"`);
        map.set(name, readPayload(r, t));
      }
      return { type, value: map };
    }
    default:
      throw new Error(`NBT: unknown tag type ${type} at ${r.pos - 1}`);
  }
}

/** Decode a named root tag. Returns { name, tag, bytesRead }. */
export function readNBT(bytes) {
  const r = new Reader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const type = r.u8();
  if (type !== TAG.Compound) throw new Error(`NBT: root is not a compound (got ${type})`);
  const name = r.string();
  const tag = readPayload(r, type);
  return { name, tag, bytesRead: r.pos };
}

/** Walk a path of compound keys / list indices, e.g. get(root, 'Regions', 'house', 'Size', 'x'). Returns the tag or undefined. */
export function get(tag, ...path) {
  let cur = tag;
  for (const p of path) {
    if (!cur) return undefined;
    if (cur.type === TAG.Compound) cur = cur.value.get(p);
    else if (cur.type === TAG.List) cur = cur.value.items[p];
    else return undefined;
  }
  return cur;
}

/** Convenience: unwrap a tag at a path to its raw value (BigInt for longs). */
export function val(tag, ...path) {
  const t = get(tag, ...path);
  return t === undefined ? undefined : t.value;
}
