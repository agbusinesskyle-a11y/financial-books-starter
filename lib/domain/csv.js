// RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF.
// Returns an array of rows (arrays of strings); blank lines are dropped.
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (quoted) throw new Error('A quoted field is never closed.');
  row.push(field);
  if (row.some(f => f.trim() !== '')) rows.push(row);
  return rows;
}

// "1099 Tracking" -> "1099tracking": header matching that ignores case, spaces and punctuation.
export const headerKey = h => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
