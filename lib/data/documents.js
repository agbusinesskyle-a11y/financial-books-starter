import { createHash } from 'node:crypto';
import { withTransaction } from '../db.js';
import { ValidationError, lockEntity, logActivity } from './writes.js';
import { TYPE_LABELS } from '../domain/status.js';

const fail = message => { throw new ValidationError(message); };
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

// The type a download is served as comes from the extension, from this list only.
const TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  txt: 'text/plain', csv: 'text/csv', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export const downloadType = filename => TYPES[/\.([a-z0-9]{1,5})$/i.exec(filename)?.[1].toLowerCase()] ?? 'application/octet-stream';

// Keeps the last path segment, drops control and quote characters, trims to 200 characters.
export function cleanFilename(name) {
  const base = String(name ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim();
  if (!base || /^\.+$/.test(base)) return null;
  if (base.length <= 200) return base;
  const ext = /\.[A-Za-z0-9]{1,5}$/.exec(base)?.[0] ?? '';
  return base.slice(0, 200 - ext.length) + ext;
}

// Content-Disposition for a download, ASCII fallback plus RFC 5987 UTF-8 name.
export function attachmentHeader(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// A customer's or a vendor's documents (pass customerId or vendorId).
export async function listDocuments(pool, { orgId, customerId = null, vendorId = null }) {
  const { rows } = await pool.query(
    `SELECT d.document_id, d.filename, d.size_bytes, d.note, d.uploaded_at, d.uploaded_by, d.txn_id, t.type AS txn_type, t.doc_number, t.payment_ref
       FROM document d LEFT JOIN txn t ON t.org_id = d.org_id AND t.txn_id = d.txn_id
      WHERE d.org_id = $1 AND ${vendorId ? 'd.vendor_id' : 'd.customer_id'} = $2 ORDER BY d.uploaded_at DESC, d.document_id DESC`, [orgId, vendorId ?? customerId]);
  return rows;
}

export async function listTxnDocuments(pool, { orgId, txnId }) {
  const { rows } = await pool.query(
    'SELECT document_id, filename, size_bytes, uploaded_at FROM document WHERE org_id = $1 AND txn_id = $2 ORDER BY uploaded_at DESC', [orgId, txnId]);
  return rows;
}

// Metadata only, scoped to the company; `withContent` adds the bytes.
export async function getDocument(pool, { orgId, entityId, documentId, withContent = false }) {
  const { rows } = await pool.query(
    `SELECT d.document_id, d.customer_id, d.vendor_id, d.txn_id, d.filename, d.size_bytes, d.sha256${withContent ? ', d.content' : ''}
       FROM document d LEFT JOIN customer c ON c.org_id = d.org_id AND c.customer_id = d.customer_id
       LEFT JOIN vendor v ON v.org_id = d.org_id AND v.vendor_id = d.vendor_id
      WHERE d.org_id = $1 AND coalesce(c.entity_id, v.entity_id) = $2 AND d.document_id = $3`, [orgId, entityId, documentId]);
  return rows[0] ?? null;
}

export async function addDocument(pool, { orgId, entityId, customerId = null, vendorId = null, txnId = null, file, note, actor }) {
  if (!file || !file.data?.length) fail('Choose a file to upload.');
  if (file.data.length > MAX_DOCUMENT_BYTES) fail('Files can be up to 10 MB.');
  const filename = cleanFilename(file.filename) ?? fail('That file name can’t be used. Rename the file and try again.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const who = vendorId ? 'vendor' : 'customer';
    const c = await tx.query(`SELECT 1 FROM ${who} WHERE org_id = $1 AND entity_id = $2 AND ${who}_id = $3`, [orgId, entityId, vendorId ?? customerId]);
    if (!c.rowCount) fail(vendorId ? 'Vendor not found.' : 'Customer not found.');
    let label = '';
    if (txnId) {
      const t = await tx.query(`SELECT type, doc_number, payment_ref FROM txn WHERE org_id = $1 AND txn_id = $2 AND ${who}_id = $3`, [orgId, txnId, vendorId ?? customerId]);
      if (!t.rowCount) fail(`Attach it to one of this ${who}’s transactions, or to none.`);
      label = ` to ${TYPE_LABELS[t.rows[0].type]} ${t.rows[0].doc_number ?? t.rows[0].payment_ref ?? ''}`.trimEnd();
    }
    const { rows: [d] } = await tx.query(
      `INSERT INTO document (org_id, customer_id, vendor_id, txn_id, filename, size_bytes, sha256, content, note, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING document_id`,
      [orgId, customerId, vendorId, txnId, filename, file.data.length, createHash('sha256').update(file.data).digest('hex'), file.data,
        String(note ?? '').trim().slice(0, 300) || null, actor]);
    await logActivity(tx, { orgId, customerId, vendorId, txnId, actor, kind: 'document_added', summary: `Document “${filename}” added${label}` });
    return d.document_id;
  });
}

export async function deleteDocument(pool, { orgId, entityId, documentId, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const d = await getDocument(tx, { orgId, entityId, documentId }) ?? fail('Document not found.');
    await tx.query('DELETE FROM document WHERE org_id = $1 AND document_id = $2', [orgId, documentId]);
    await logActivity(tx, { orgId, customerId: d.customer_id, vendorId: d.vendor_id, txnId: d.txn_id, actor, kind: 'document_deleted', summary: `Document “${d.filename}” deleted` });
    return d;
  });
}
