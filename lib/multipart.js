// Minimal multipart/form-data parser for one upload form: the whole body is already in memory
// (the caller caps its size). Returns { fields: URLSearchParams, files: [{ field, filename, contentType, data }] }.
// Throws MultipartError on anything malformed.

export class MultipartError extends Error {}

export function boundaryOf(contentType) {
  const m = /^multipart\/form-data;.*\bboundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(String(contentType ?? ''));
  return m ? (m[1] ?? m[2]) : null;
}

function headerParams(value) {
  const out = {};
  for (const m of value.matchAll(/;\s*([\w*-]+)="((?:[^"\\]|\\.)*)"|;\s*([\w*-]+)=([^;\s]+)/g)) {
    if (m[1]) out[m[1].toLowerCase()] = m[2].replace(/\\(.)/g, '$1');
    else out[m[3].toLowerCase()] = m[4];
  }
  return out;
}

export function parseMultipart(body, boundary, { maxParts = 20 } = {}) {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = new URLSearchParams();
  const files = [];
  let pos = body.indexOf(delimiter);
  if (pos !== 0) throw new MultipartError('Malformed upload.');
  for (let parts = 0; ; parts++) {
    pos += delimiter.length;
    if (body.subarray(pos, pos + 2).toString() === '--') return { fields, files };
    if (body.subarray(pos, pos + 2).toString() !== '\r\n') throw new MultipartError('Malformed upload.');
    if (parts >= maxParts) throw new MultipartError('Too many form parts.');
    pos += 2;
    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0 || headerEnd - pos > 4096) throw new MultipartError('Malformed upload.');
    const headers = {};
    for (const line of body.subarray(pos, headerEnd).toString('utf8').split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delimiter]), headerEnd + 4);
    if (next < 0) throw new MultipartError('Malformed upload.');
    const data = body.subarray(headerEnd + 4, next);
    const disposition = headers['content-disposition'] ?? '';
    if (!/^form-data\b/i.test(disposition)) throw new MultipartError('Malformed upload.');
    const params = headerParams(disposition);
    if (!params.name) throw new MultipartError('Malformed upload.');
    if ('filename' in params) {
      if (params.filename) files.push({ field: params.name, filename: params.filename, contentType: headers['content-type'] ?? null, data: Buffer.from(data) });
    } else {
      fields.append(params.name, data.toString('utf8'));
    }
    pos = next + 2;
  }
}
