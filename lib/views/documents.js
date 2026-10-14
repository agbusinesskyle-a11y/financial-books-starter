import { html } from './html.js';
import { csrfField, errorBanner, postButton } from './forms.js';
import { formatShortDate } from '../domain/dates.js';
import { TYPE_LABELS } from '../domain/status.js';
import { formatDateTime } from './format.js';

export const formatSize = bytes => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const txnLabel = t => `${TYPE_LABELS[t.type ?? t.txn_type]} ${t.doc_number ?? t.payment_ref ?? ''}`.trim();

// `txnChoices`: this customer's recent transactions for "attach to"; `uploadError` re-shows a failed upload.
// Works for a customer or a vendor (pass `vendor` instead of `customer`).
export function documentsTab({ customer, vendor = null, csrf, documents, txnChoices, uploadError = null, timeZone }) {
  const owner = vendor
    ? { path: `/vendors/${vendor.vendor_id}`, name: vendor.display_name, noun: 'vendor', hint: 'Add W-9s, contracts, or receipts.' }
    : { path: `/customers/${customer.customer_id}`, name: customer.display_name, noun: 'customer', hint: 'Add contracts, delivery tickets, or photos.' };
  return html`<form method="post" action="${owner.path}/documents" enctype="multipart/form-data" class="editor upload">
  ${csrfField(csrf)}
  <h2>Add a document</h2>
  ${errorBanner(uploadError)}
  <div class="form-grid">
    <label class="field"><span>File (up to 10 MB) <span class="req">*</span></span><input type="file" name="file" required></label>
    <label class="field"><span>Attach to a transaction (optional)</span><select name="txn_id">
      <option value="">None, just the ${owner.noun}</option>
      ${txnChoices.map(t => html`<option value="${t.txn_id}">${formatShortDate(t.txn_date)} · ${txnLabel(t)}</option>`)}
    </select></label>
    <label class="field"><span>Note</span><input name="note" maxlength="300" placeholder="e.g. Signed delivery ticket"></label>
  </div>
  <div class="form-actions"><button class="primary">Upload</button></div>
</form>
<h2 class="section-title">Documents</h2>
${documents.length ? html`<table class="grid">
  <thead><tr><th>File</th><th>Attached to</th><th>Size</th><th>Added</th><th class="actions">Action</th></tr></thead>
  <tbody>${documents.map(d => html`<tr>
    <td><a href="/documents/${d.document_id}">${d.filename}</a>${d.note ? html`<br><span class="muted">${d.note}</span>` : ''}</td>
    <td>${d.txn_id ? html`<a href="/txns/${d.txn_id}">${txnLabel(d)}</a>` : html`<span class="muted">${vendor ? 'Vendor' : 'Customer'}</span>`}</td>
    <td>${formatSize(d.size_bytes)}</td>
    <td>${formatDateTime(d.uploaded_at, timeZone)}</td>
    <td class="actions"><a href="/documents/${d.document_id}">Download</a> ·
      ${postButton({ action: `/documents/${d.document_id}/delete`, csrf, label: 'Delete', confirm: `Delete “${d.filename}”? This can’t be undone.` })}</td>
  </tr>`)}</tbody>
</table>` : html`<p class="muted">No documents for ${owner.name} yet. ${owner.hint}</p>`}`;
}

// Short list on a transaction's page.
// `owner`: '/customers/12' or '/vendors/7' (where the Documents tab is).
export function txnDocuments(documents, owner) {
  const base = typeof owner === 'string' ? owner : `/customers/${owner}`;
  if (!documents.length) return html`<p class="muted section-title"><a href="${base}?tab=documents">Attach a document</a></p>`;
  return html`<h2 class="section-title">Documents</h2>
<ul class="doc-list">${documents.map(d => html`<li><a href="/documents/${d.document_id}">${d.filename}</a> <span class="muted">${formatSize(d.size_bytes)}</span></li>`)}</ul>`;
}
