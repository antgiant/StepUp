/**
 * A minimal zip writer (no compression, no zip64) that works in the browser and in Node. Backups are mostly PDFs and
 * photos, which do not compress, so "store" keeps it small, fast and dependency-free. Each entry is held as a Blob, so
 * the big ones are not copied while the archive is put together.
 */
export interface ZipEntry {
  /** Path inside the archive, with "/" separators. */
  name: string;
  data: Uint8Array | Blob;
  /** Defaults to now. */
  modified?: Date;
}

const LIMIT = 0xffff_ffff;
let table: Uint32Array | undefined;

/** CRC-32 of some bytes, as zip stores it. */
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffff_ffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Builds the archive. Throws when it would need zip64 (4 GB, or 65,535 files). */
export async function zipStore(entries: readonly ZipEntry[]): Promise<Blob> {
  if (entries.length > 0xfffe) throw new Error("Too many files for one zip.");
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  const enc = new TextEncoder();
  let offset = 0;
  for (const e of entries) {
    const bytes = e.data instanceof Blob ? new Uint8Array(await e.data.arrayBuffer()) : e.data;
    if (bytes.length > LIMIT || offset > LIMIT) throw new Error("This backup is too big for one zip (4 GB). Back up without documents, or in pieces.");
    const name = enc.encode(e.name.replace(/^\/+/, ""));
    const crc = crc32(bytes);
    const { time, date } = dosTime(e.modified ?? new Date());
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // names are UTF-8
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, bytes as BlobPart);

    const c = new DataView(new ArrayBuffer(46 + name.length));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, bytes.length, true);
    c.setUint32(24, bytes.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    new Uint8Array(c.buffer).set(name, 46);
    central.push(new Uint8Array(c.buffer));
    offset += 30 + name.length + bytes.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  if (offset + size > LIMIT) throw new Error("This backup is too big for one zip (4 GB). Back up without documents, or in pieces.");
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), end.buffer], { type: "application/zip" });
}
