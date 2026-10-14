import { crc32, deflateRawSync, deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

// A minimal ZIP writer (deflate, no ZIP64). zipFiles builds a small archive in memory; streamZip writes one file at a time
// to a response — compression off the main thread, waiting whenever the client is slow — so a large "all attachments"
// download never holds every file in memory or stalls other requests. Names are made unique and kept to plain
// characters; folders are kept ("Customer/file.pdf"); anything that could climb out of the archive root is not.

const deflateAsync = promisify(deflateRaw);

class ZipBuilder {
  used = new Set();
  centrals = [];
  offset = 0;
  count = 0;

  // The local header, name and body of one file (and its central directory record, kept for the end).
  entry(rawName, data, packed, when) {
    let name = String(rawName).replace(/[\\:*?"<>|\x00-\x1f]+/g, '_').split('/').filter(p => p && p !== '.' && p !== '..').join('/').slice(0, 180) || 'file';
    for (let i = 2; this.used.has(name.toLowerCase()); i++) name = name.replace(/(\.[^.]*)?$/, ext => ` (${i})${ext}`);
    this.used.add(name.toLowerCase());
    const nameBuf = Buffer.from(name, 'utf8');
    const store = packed.length >= data.length;
    const body = store ? data : packed;
    const d = when ? new Date(when) : new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const crc = crc32(data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(store ? 0 : 8, 8);
    head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12); head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(store ? 0 : 8, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(this.offset, 42);
    this.centrals.push(central, nameBuf);
    this.offset += head.length + nameBuf.length + body.length;
    this.count++;
    return [head, nameBuf, body];
  }

  end() {
    const centralSize = this.centrals.reduce((s, b) => s + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.count, 8); end.writeUInt16LE(this.count, 10);
    end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(this.offset, 16);
    return Buffer.concat([...this.centrals, end]);
  }
}

// files = [{ name, data: Buffer, date? }] -> Buffer.
export function zipFiles(files) {
  const z = new ZipBuilder();
  const parts = [];
  for (const f of files) {
    const data = Buffer.from(f.data);
    parts.push(...z.entry(f.name, data, deflateRawSync(data), f.date));
  }
  return Buffer.concat([...parts, z.end()]);
}

// files: an (async) iterable of { name, data, date }, read one at a time; out: a writable (an HTTP response).
export async function streamZip(out, files) {
  const z = new ZipBuilder();
  const write = buf => new Promise((resolve, reject) => {
    if (out.destroyed) { reject(new Error('download cancelled')); return; }
    if (out.write(buf)) resolve();
    else {
      const done = () => { out.off('drain', done); out.off('close', gone); resolve(); };
      const gone = () => { out.off('drain', done); reject(new Error('download cancelled')); };
      out.once('drain', done);
      out.once('close', gone);
    }
  });
  for await (const f of files) {
    const data = Buffer.from(f.data);
    for (const part of z.entry(f.name, data, await deflateAsync(data), f.date)) await write(part);
  }
  await write(z.end());
  out.end();
}
