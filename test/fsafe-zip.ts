// A zip written by hand for the fsafe and importer tests: its central directory says whatever a test needs.

export interface Spec {
  name: string;
  /** The bytes as stored in the archive (already deflated for method 8). */
  data: Uint8Array;
  method?: 0 | 8;
  /** What the central directory says the entry unpacks to. */
  size: number;
}

/** A zip written by hand, so its central directory can say whatever a test needs, zip64 included. */
export function buildZip(specs: Spec[], { zip64 = false } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const name = Buffer.from(s.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(s.method ?? 8, 8);
    local.writeUInt32LE(zip64 ? 0xffffffff : s.data.length, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : s.size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, Buffer.from(s.data));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(zip64 ? 45 : 20, 4);
    central.writeUInt16LE(zip64 ? 45 : 20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(s.method ?? 8, 10);
    central.writeUInt32LE(zip64 ? 0xffffffff : s.data.length, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : s.size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(zip64 ? 28 : 0, 30);
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    centrals.push(central, name);
    if (zip64) {
      const extra = Buffer.alloc(28);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(s.size), 4);
      extra.writeBigUInt64LE(BigInt(s.data.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
      centrals.push(extra);
    }
    offset += 30 + name.length + s.data.length;
  }
  const directory = Buffer.concat(centrals);
  const tail: Buffer[] = [];
  if (zip64) {
    const end64 = Buffer.alloc(56);
    end64.writeUInt32LE(0x06064b50, 0);
    end64.writeBigUInt64LE(44n, 4);
    end64.writeUInt16LE(45, 12);
    end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(BigInt(specs.length), 24);
    end64.writeBigUInt64LE(BigInt(specs.length), 32);
    end64.writeBigUInt64LE(BigInt(directory.length), 40);
    end64.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(end64, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : specs.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : specs.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...locals, directory, ...tail, end]);
}
