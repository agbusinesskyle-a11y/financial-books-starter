import { html } from './html.js';
import { layout } from './layout.js';
import { postButton } from './forms.js';
import { formatDateTime } from './format.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { txnHref, txnTitle } from '../data/txn-extras.js';

// Forms, stage F2: QBO's More menu on a saved transaction, the transaction journal, and the audit history.

// items: [{ label, href } | { label, post, confirm?, danger?, extra? }] — links and small POST forms in one dropdown.
export function moreMenu({ csrf, items }) {
  const list = items.filter(Boolean);
  if (!list.length) return '';
  return html`<details class="more-menu"><summary class="button">More <span aria-hidden="true">▾</span></summary>
    <div class="more-menu-list" role="menu">${list.map(i => (i.href
      ? html`<a role="menuitem" href="${i.href}"${i.newTab ? html` target="_blank" rel="noopener"` : ''}>${i.label}</a>`
      : postButton({ action: i.post, csrf, label: i.label, cls: i.danger ? 'danger menuitem' : 'menuitem', confirm: i.confirm ?? null, extra: i.extra ?? {} })))}</div>
  </details>`;
}

// The More menu entries every saved transaction has (QBO: Transaction journal, Audit history).
// Stage B7: imported QuickBooks history is kept as it was (it can still be paid); corrections are new transactions.
export const IMPORTED_LOCKED = 'This came over from QuickBooks with the rest of the books, so it can’t be edited, voided or deleted. Record any correction as a new transaction.';
export const isImported = t => t?.source === 'qbo_import';
export const importedBanner = t => (isImported(t) ? html`<p class="ledger-check">Imported from QuickBooks${t.source_type ? ` (${t.source_type})` : ''}. ${IMPORTED_LOCKED}</p>` : '');

// A payment link the QuickBooks import rebuilt (its exports don't say which payment paid which invoice).
export const rebuiltNote = a => (a.link_source === 'qbo_import' ? html` <small class="muted" title="QuickBooks’ exports don’t say which payment paid which invoice; this link was rebuilt so the open amounts match QuickBooks.">rebuilt from QuickBooks</small>` : '');

export const commonMore = t => [{ label: 'Transaction journal', href: `/transactions/${t.txn_id}/journal` }, { label: 'Audit history', href: `/transactions/${t.txn_id}/history` }];

export function transactionJournalPage({ entityName, csrf, txn: t, journal, timeZone }) {
  return layout({ title: `Transaction journal: ${txnTitle(t)}`, entityName, csrf, body: html`<div class="crumbs"><a href="${txnHref(t)}">‹ ${txnTitle(t)}</a></div>
  <h1>Transaction journal</h1>
  <p class="muted">${txnTitle(t)}${t.party ? ` · ${t.party}` : ''} · ${formatShortDate(t.txn_date)}${t.voided_at ? ' · voided' : ''}</p>
  ${journal.rows.length ? html`<div class="table-scroll"><table class="grid">
    <thead><tr><th>Account</th><th>Name</th><th>Memo</th><th>Class</th><th>Location</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
    <tbody>${journal.rows.map(r => html`<tr><td>${r.number ? `${r.number} ` : ''}${r.account}</td><td>${r.name ?? ''}</td><td>${r.memo ?? ''}</td>
      <td>${r.class_name ?? ''}</td><td>${r.location_name ?? ''}</td>
      <td class="num">${r.amount_cents > 0 ? formatCents(Number(r.amount_cents)) : ''}</td><td class="num">${r.amount_cents < 0 ? formatCents(-Number(r.amount_cents)) : ''}</td></tr>`)}</tbody>
    <tfoot><tr><th colspan="5">Total</th><th class="num">${formatCents(journal.debits)}</th><th class="num">${formatCents(journal.credits)}</th></tr></tfoot>
  </table></div>` : html`<p class="muted">This transaction doesn’t post anything${t.type === 'estimate' || t.type === 'purchase_order' ? ` (a${t.type === 'estimate' ? 'n estimate' : ' purchase order'} isn’t in the books)` : t.voided_at ? ' (it’s voided)' : ''}.</p>`}` });
}

const value = (c, v) => (v === null || v === undefined || v === '' ? '—' : c.money ? formatCents(Number(v)) : typeof v === 'object' ? JSON.stringify(v) : String(v));
export function transactionHistoryPage({ entityName, csrf, txn: t, history, timeZone }) {
  const verb = { insert: 'Added', update: 'Changed', delete: 'Deleted' };
  return layout({ title: `Audit history: ${txnTitle(t)}`, entityName, csrf, body: html`<div class="crumbs"><a href="${txnHref(t)}">‹ ${txnTitle(t)}</a></div>
  <h1>Audit history</h1>
  <p class="muted">${txnTitle(t)}${t.party ? ` · ${t.party}` : ''} — every change, newest first.</p>
  ${history.length ? html`<ul class="history">${history.map(h => html`<li><strong>${verb[h.action] ?? h.action} ${h.thing === 'Transaction' ? '' : h.thing.toLowerCase()}</strong>
    <small class="muted">${formatDateTime(h.at, timeZone)} · ${h.actor}</small>
    ${h.amount ? html`<div>${formatCents(h.amount)}</div>` : ''}${h.filename ? html`<div>${h.filename}</div>` : ''}
    ${h.changes.length ? html`<ul class="changes">${h.changes.map(c => html`<li>${c.field}: ${value(c, c.from)} → ${value(c, c.to)}</li>`)}</ul>` : ''}</li>`)}</ul>`
  : html`<p class="muted">No changes recorded.</p>`}` });
}
