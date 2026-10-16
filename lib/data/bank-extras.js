import { createHash } from 'node:crypto';
import { withTransaction } from '../db.js';
import { ValidationError, lockEntity, logActivity } from './writes.js';
import { MAX_DOCUMENT_BYTES, cleanFilename } from './documents.js';

// Bank review v2, stage BR-7: files and notes on a bank line, kept by its ledgerline id (they stay when the line is
// dropped and pulled back in). A file is filed as a document on the transaction the line became, once there is one with a
// vendor or customer to file it under; until then it stays on the bank line.

const fail = message => { throw new ValidationError(message); };
const lineOf = async (tx, { orgId, entityId, itemId, lock = false }) => (await tx.query(
  `SELECT item_id, entity_id, ll_transaction_id FROM bank_feed_item WHERE org_id = $1 AND entity_id = $2 AND item_id = $3${lock ? ' FOR UPDATE' : ''}`,
  [orgId, entityId, Number(itemId) || 0])).rows[0] ?? fail('Bank item not found.');

export async function addBankAttachment(pool, { orgId, entityId, itemId, file, actor }) {
  if (!file || !file.data?.length) fail('Choose a file to attach.');
  if (file.data.length > MAX_DOCUMENT_BYTES) fail('Files can be up to 10 MB.');
  const filename = cleanFilename(file.filename) ?? fail('That file name can’t be used. Rename the file and try again.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const line = await lineOf(tx, { orgId, entityId, itemId, lock: true });
    const { rows: [a] } = await tx.query(`INSERT INTO bank_item_attachment (org_id, entity_id, ll_transaction_id, filename, size_bytes, sha256, content, uploaded_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING attachment_id`,
    [orgId, entityId, line.ll_transaction_id, filename, file.data.length, createHash('sha256').update(file.data).digest('hex'), file.data, actor]);
    await fileAttachments(tx, { orgId, item: line, actor });
    return Number(a.attachment_id);
  });
}

// The bank line's files (no content), each with the document it was filed as, if any.
export async function listBankAttachments(db, { orgId, entityId, item }) {
  const { rows } = await db.query(`SELECT a.attachment_id, a.filename, a.size_bytes, a.uploaded_by, a.uploaded_at, a.document_id, d.txn_id AS filed_txn
      FROM bank_item_attachment a LEFT JOIN document d ON d.document_id = a.document_id
     WHERE a.org_id = $1 AND a.entity_id = $2 AND a.ll_transaction_id = $3 ORDER BY a.uploaded_at, a.attachment_id`, [orgId, entityId, item.ll_transaction_id]);
  return rows;
}

export async function getBankAttachment(db, { orgId, entityId, itemId, attachmentId }) {
  const { rows: [a] } = await db.query(`SELECT a.attachment_id, a.filename, a.size_bytes, a.content FROM bank_item_attachment a
      JOIN bank_feed_item i ON i.entity_id = a.entity_id AND i.ll_transaction_id = a.ll_transaction_id
     WHERE a.org_id = $1 AND a.entity_id = $2 AND i.item_id = $3 AND a.attachment_id = $4`, [orgId, entityId, Number(itemId) || 0, Number(attachmentId) || 0]);
  return a ?? null;
}

// Removes the file from the bank line. A copy already filed on a transaction stays there (delete it from that document list).
export async function deleteBankAttachment(pool, { orgId, entityId, itemId, attachmentId }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const line = await lineOf(tx, { orgId, entityId, itemId });
    // A texted receipt's photo is the receipt's: rejecting the receipt takes it off (and off what it was filed on).
    const { rows: [f] } = await tx.query('SELECT receipt_id FROM bank_item_attachment WHERE org_id = $1 AND entity_id = $2 AND ll_transaction_id = $3 AND attachment_id = $4',
      [orgId, entityId, line.ll_transaction_id, Number(attachmentId) || 0]);
    if (!f) fail('File not found.');
    if (f.receipt_id) fail('This is a texted receipt’s photo. To take it off, reject the receipt on the Receipts page.');
    await tx.query('DELETE FROM bank_item_attachment WHERE org_id = $1 AND entity_id = $2 AND ll_transaction_id = $3 AND attachment_id = $4',
      [orgId, entityId, line.ll_transaction_id, Number(attachmentId) || 0]);
  });
}

// Files the bank line's files on the transaction it became: the first linked transaction with a vendor or customer (a
// document is filed under one). A file filed before (and left without a transaction by an Undo) is moved, not copied again.
// Called inside the caller's transaction whenever links are made.
export async function fileAttachments(tx, { orgId, item, actor }) {
  const { rows: files } = await tx.query(`SELECT a.attachment_id, a.filename, a.size_bytes, a.sha256, a.document_id, d.txn_id AS filed_txn FROM bank_item_attachment a
      LEFT JOIN document d ON d.document_id = a.document_id WHERE a.entity_id = $1 AND a.ll_transaction_id = $2
        -- a texted receipt's copy only while that receipt is given to this line (stage S3)
        AND (a.receipt_id IS NULL OR EXISTS (SELECT 1 FROM receipt r WHERE r.receipt_id = a.receipt_id AND r.status = 'added' AND r.item_id = $3))`, [item.entity_id, item.ll_transaction_id, item.item_id]);
  const waiting = files.filter(f => !f.document_id || !f.filed_txn);
  if (!waiting.length) return 0;
  const { rows: [t] } = await tx.query(`SELECT t.txn_id, t.vendor_id, t.customer_id FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id
      WHERE k.item_id = $1 AND (t.vendor_id IS NOT NULL OR t.customer_id IS NOT NULL) ORDER BY (k.how = 'matched'), t.txn_id LIMIT 1`, [item.item_id]);
  if (!t) return 0;
  for (const f of waiting) {
    if (f.document_id) {
      await tx.query('UPDATE document SET txn_id = $3, vendor_id = $4, customer_id = $5 WHERE org_id = $1 AND document_id = $2',
        [orgId, f.document_id, t.txn_id, t.vendor_id, t.vendor_id ? null : t.customer_id]);
    } else {
      const { rows: [d] } = await tx.query(`INSERT INTO document (org_id, customer_id, vendor_id, txn_id, filename, size_bytes, sha256, content, note, uploaded_by)
        SELECT $1, $2, $3, $4, filename, size_bytes, sha256, content, CASE WHEN receipt_id IS NULL THEN 'From the bank item' ELSE 'Texted receipt' END, uploaded_by FROM bank_item_attachment WHERE attachment_id = $5
        RETURNING document_id`, [orgId, t.vendor_id ? null : t.customer_id, t.vendor_id, t.txn_id, f.attachment_id]);
      await tx.query('UPDATE bank_item_attachment SET document_id = $2 WHERE attachment_id = $1', [f.attachment_id, d.document_id]);
    }
    await logActivity(tx, { orgId, customerId: t.vendor_id ? null : t.customer_id, vendorId: t.vendor_id, txnId: t.txn_id, actor,
      kind: 'document_added', summary: `Document “${f.filename}” added from a bank item` });
  }
  return waiting.length;
}

// Undo of a bank line: files it filed on transactions it only matched (they stay in the books) come off them, so a new review
// files them on whatever the line becomes. Transactions Undo deletes let go of their documents themselves.
export async function unfileAttachments(tx, { item, txnIds }) {
  if (!txnIds.length) return;
  await tx.query(`UPDATE document d SET txn_id = NULL FROM bank_item_attachment a
    WHERE a.document_id = d.document_id AND a.entity_id = $1 AND a.ll_transaction_id = $2 AND d.txn_id = ANY($3::bigint[])`,
  [item.entity_id, item.ll_transaction_id, txnIds.map(Number)]);
}

export async function addBankNote(pool, { orgId, entityId, itemId, note, actor }) {
  const text = String(note ?? '').trim().slice(0, 1000);
  if (!text) fail('Write the note first.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const line = await lineOf(tx, { orgId, entityId, itemId });
    const { rows: [n] } = await tx.query('INSERT INTO bank_item_note (org_id, entity_id, ll_transaction_id, note, actor) VALUES ($1, $2, $3, $4, $5) RETURNING note_id',
      [orgId, entityId, line.ll_transaction_id, text, actor]);
    return Number(n.note_id);
  });
}

export async function listBankNotes(db, { orgId, entityId, item }) {
  const { rows } = await db.query('SELECT note_id, note, actor, at FROM bank_item_note WHERE org_id = $1 AND entity_id = $2 AND ll_transaction_id = $3 ORDER BY at DESC, note_id DESC',
    [orgId, entityId, item.ll_transaction_id]);
  return rows;
}
