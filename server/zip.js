'use strict';
/* A store-only ZIP writer (no compression – photos are compressed already), streamed: each file is read, written and let go,
   so a download of every photo an account keeps never sits in memory. Pure JavaScript (zlib.crc32 is built into Node), no native
   module. Names are UTF-8 (flag bit 11). Past 4 GB the offsets go in ZIP64 records; each file is far smaller than 4 GB (photos are
   capped at 10 MB), so only the central directory ever needs them. */
const { crc32 } = require('zlib');

const MAX32 = 0xffffffff;
/* MS-DOS date and time, as ZIP keeps them (local time, two-second steps) */
function dos(d) {
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

/* entries: an (async) iterable of { name, when: Date, read: async () => Buffer | null } (null: left out);
   write(buf): resolves once there's room for more. opts.zip64 writes the ZIP64 records even when they aren't needed (tests). */
async function writeZip(entries, write, opts = {}) {
  const central = [];
  let at = 0, n = 0;
  const put = async b => { at += b.length; await write(b); };
  for await (const e of entries) {
    const data = await e.read();
    if (!data) continue;
    const name = Buffer.from(e.name, 'utf8'), { time, date } = dos(e.when || new Date()), crc = crc32(data);
    const big = opts.zip64 || at >= MAX32;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(big ? 45 : 20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(0, 8);
    head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    central.push({ name, time, date, crc, size: data.length, offset: at, big });
    await put(Buffer.concat([head, name]));
    await put(data);
    n++;
  }
  const cdStart = at;
  for (const c of central) {
    const extra = c.big ? Buffer.alloc(12) : Buffer.alloc(0);
    if (c.big) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(8, 2); extra.writeBigUInt64LE(BigInt(c.offset), 4); }
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(c.big ? 45 : 20, 4); h.writeUInt16LE(c.big ? 45 : 20, 6); h.writeUInt16LE(0x0800, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(c.time, 12); h.writeUInt16LE(c.date, 14); h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.size, 20); h.writeUInt32LE(c.size, 24); h.writeUInt16LE(c.name.length, 28); h.writeUInt16LE(extra.length, 30);
    /* comment length, disk, internal and external attributes: 0 */
    h.writeUInt32LE(c.big ? MAX32 : c.offset, 42);
    await put(Buffer.concat([h, c.name, extra]));
  }
  const cdSize = at - cdStart, z64 = opts.zip64 || cdStart >= MAX32 || at >= MAX32 || n >= 0xffff;
  if (z64) {
    const rec = Buffer.alloc(56), recAt = at;
    rec.writeUInt32LE(0x06064b50, 0); rec.writeBigUInt64LE(44n, 4); rec.writeUInt16LE(45, 12); rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(n), 24); rec.writeBigUInt64LE(BigInt(n), 32); rec.writeBigUInt64LE(BigInt(cdSize), 40); rec.writeBigUInt64LE(BigInt(cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(recAt), 8); loc.writeUInt32LE(1, 16);
    await put(Buffer.concat([rec, loc]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(z64 ? 0xffff : n, 8); end.writeUInt16LE(z64 ? 0xffff : n, 10);
  end.writeUInt32LE(z64 ? MAX32 : cdSize, 12); end.writeUInt32LE(z64 ? MAX32 : cdStart, 16);
  await put(end);
  return n;
}

module.exports = { writeZip };
