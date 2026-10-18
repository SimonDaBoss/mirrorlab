/**
 * Minimal Apple binary property list (bplist00) reader/writer — the subset
 * AirPlay uses in RTSP bodies: dict, array, string (ASCII + UTF-16), data,
 * integer, real, boolean, date. Enough to parse SETUP/info requests and build
 * responses without a native dependency.
 */

export type Plist = PlistValue;
export type PlistValue = boolean | number | bigint | string | Uint8Array | PlistValue[] | { [k: string]: PlistValue } | null;

const MAGIC = Buffer.from("bplist00", "ascii");

export function isBinaryPlist(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(MAGIC);
}

// ---------------------------------------------------------------- parse

export function parseBplist(buf: Buffer): PlistValue {
  if (!isBinaryPlist(buf)) throw new Error("Not a bplist00");
  const trailer = buf.subarray(buf.length - 32);
  const offsetSize = trailer.readUInt8(6);
  const refSize = trailer.readUInt8(7);
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const offsetTableOffset = Number(trailer.readBigUInt64BE(24));

  const readSized = (base: number, size: number): number => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + buf.readUInt8(base + i);
    return v;
  };
  const offsets: number[] = [];
  for (let i = 0; i < numObjects; i++) offsets.push(readSized(offsetTableOffset + i * offsetSize, offsetSize));

  const parseObject = (index: number): PlistValue => {
    let off = offsets[index]!;
    const marker = buf.readUInt8(off);
    const type = marker >> 4;
    let info = marker & 0x0f;
    off++;
    const readCount = (): number => {
      if (info !== 0x0f) return info;
      const sizeMarker = buf.readUInt8(off++);
      const intLen = 1 << (sizeMarker & 0x0f);
      const c = readSized(off, intLen);
      off += intLen;
      return c;
    };
    switch (type) {
      case 0x0: // singletons
        return info === 0x08 ? false : info === 0x09 ? true : null;
      case 0x1: {
        // integer: 2^info bytes, big-endian
        const len = 1 << info;
        if (len <= 4) return readSized(off, len);
        const hi = readSized(off, len - 4);
        const lo = readSized(off + len - 4, 4);
        return BigInt(hi) * 4294967296n + BigInt(lo);
      }
      case 0x2: {
        const len = 1 << info;
        return len === 4 ? buf.readFloatBE(off) : buf.readDoubleBE(off);
      }
      case 0x3: // date (8-byte double, Apple epoch) → seconds since 2001
        return buf.readDoubleBE(off);
      case 0x4: {
        const count = readCount();
        return new Uint8Array(buf.subarray(off, off + count));
      }
      case 0x5: {
        const count = readCount();
        return buf.subarray(off, off + count).toString("ascii");
      }
      case 0x6: {
        const count = readCount();
        // UTF-16 big-endian: swap to little-endian for Node's decoder.
        return Buffer.from(buf.subarray(off, off + count * 2)).swap16().toString("utf16le");
      }
      case 0x8: {
        const len = (marker & 0x0f) + 1;
        return readSized(off, len); // UID, treat as int
      }
      case 0xa:
      case 0xc: {
        const count = readCount();
        const arr: PlistValue[] = [];
        for (let i = 0; i < count; i++) arr.push(parseObject(readSized(off + i * refSize, refSize)));
        return arr;
      }
      case 0xd: {
        const count = readCount();
        const keyRefsBase = off;
        const valRefsBase = off + count * refSize;
        const dict: { [k: string]: PlistValue } = {};
        for (let i = 0; i < count; i++) {
          const key = parseObject(readSized(keyRefsBase + i * refSize, refSize));
          dict[String(key)] = parseObject(readSized(valRefsBase + i * refSize, refSize));
        }
        return dict;
      }
      default:
        throw new Error(`Unsupported bplist marker 0x${marker.toString(16)}`);
    }
  };
  return parseObject(topObject);
}

// ---------------------------------------------------------------- serialize

export function buildBplist(root: PlistValue): Buffer {
  const objects: PlistValue[] = [];
  const indexOf = new Map<unknown, number>();
  const intern = (v: PlistValue): number => {
    const key = typeof v === "object" && v !== null ? Symbol() : v; // objects are not deduped
    if (typeof v !== "object" || v === null) {
      if (indexOf.has(key)) return indexOf.get(key)!;
    }
    const idx = objects.length;
    objects.push(v);
    if (typeof v !== "object" || v === null) indexOf.set(key, idx);
    return idx;
  };
  const collect = (v: PlistValue): number => {
    const idx = intern(v);
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
      for (const k of Object.keys(v)) collect(k);
      for (const k of Object.keys(v)) collect(v[k]!);
    }
    return idx;
  };
  collect(root);

  const refSize = objects.length < 256 ? 1 : objects.length < 65536 ? 2 : 4;
  const chunks: Buffer[] = [MAGIC];
  const offsets: number[] = [];
  let pos = MAGIC.length;
  const refOf = (v: PlistValue) => objects.indexOf(v);

  const writeRef = (b: Buffer, at: number, ref: number) => {
    if (refSize === 1) b.writeUInt8(ref, at);
    else if (refSize === 2) b.writeUInt16BE(ref, at);
    else b.writeUInt32BE(ref, at);
  };
  const countHeader = (type: number, count: number): Buffer => {
    if (count < 15) return Buffer.from([(type << 4) | count]);
    const head = Buffer.from([(type << 4) | 0x0f]);
    return Buffer.concat([head, intObject(count)]);
  };
  const intObject = (n: number): Buffer => {
    if (n < 0x100) return Buffer.from([0x10, n]);
    if (n < 0x10000) {
      const b = Buffer.alloc(3);
      b[0] = 0x11;
      b.writeUInt16BE(n, 1);
      return b;
    }
    const b = Buffer.alloc(5);
    b[0] = 0x12;
    b.writeUInt32BE(n, 1);
    return b;
  };

  for (const v of objects) {
    offsets.push(pos);
    let b: Buffer;
    if (v === null) b = Buffer.from([0x00]);
    else if (typeof v === "boolean") b = Buffer.from([v ? 0x09 : 0x08]);
    else if (typeof v === "bigint") {
      b = Buffer.alloc(9);
      b[0] = 0x13;
      b.writeBigUInt64BE(v & 0xffffffffffffffffn, 1);
    } else if (typeof v === "number") {
      if (Number.isInteger(v) && v >= 0 && v < 0x100000000) b = intObject(v);
      else {
        b = Buffer.alloc(9);
        b[0] = 0x23;
        b.writeDoubleBE(v, 1);
      }
    } else if (typeof v === "string") {
      const ascii = /^[\x00-\x7f]*$/.test(v);
      if (ascii) b = Buffer.concat([countHeader(0x5, v.length), Buffer.from(v, "ascii")]);
      else {
        const u16 = Buffer.from(v, "utf16le").swap16();
        b = Buffer.concat([countHeader(0x6, v.length), u16]);
      }
    } else if (v instanceof Uint8Array) {
      b = Buffer.concat([countHeader(0x4, v.length), Buffer.from(v)]);
    } else if (Array.isArray(v)) {
      const refs = Buffer.alloc(v.length * refSize);
      v.forEach((item, i) => writeRef(refs, i * refSize, refOf(item)));
      b = Buffer.concat([countHeader(0xa, v.length), refs]);
    } else {
      const keys = Object.keys(v);
      const refs = Buffer.alloc(keys.length * 2 * refSize);
      keys.forEach((k, i) => writeRef(refs, i * refSize, refOf(k)));
      keys.forEach((k, i) => writeRef(refs, (keys.length + i) * refSize, refOf(v[k]!)));
      b = Buffer.concat([countHeader(0xd, keys.length), refs]);
    }
    chunks.push(b);
    pos += b.length;
  }

  const offsetTableOffset = pos;
  const offsetSize = pos < 256 ? 1 : pos < 65536 ? 2 : 4;
  const offTable = Buffer.alloc(offsets.length * offsetSize);
  offsets.forEach((o, i) => {
    if (offsetSize === 1) offTable.writeUInt8(o, i);
    else if (offsetSize === 2) offTable.writeUInt16BE(o, i * 2);
    else offTable.writeUInt32BE(o, i * offsetSize);
  });
  chunks.push(offTable);

  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(offsetSize, 6);
  trailer.writeUInt8(refSize, 7);
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16); // top object
  trailer.writeBigUInt64BE(BigInt(offsetTableOffset), 24);
  chunks.push(trailer);
  return Buffer.concat(chunks);
}
