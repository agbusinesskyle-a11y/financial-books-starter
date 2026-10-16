import { html } from './html.js';
import { csrfField, errorBanner, field, selectField, checkbox, postButton } from './forms.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { ACCOUNT_TYPES, GROUPS, RESERVED_TYPES } from '../domain/ledger.js';
import { TYPE_LABELS } from '../domain/status.js';
import { displaySettings } from '../domain/display.js';

const REGISTER_TYPES = { ...TYPE_LABELS, deposit: 'Deposit' };
// Settings → Accounting can hide account numbers; set per request or job like the date format (lib/domain/display.js).
export const setShowAccountNumbers = on => { displaySettings().showNumbers = on !== false; };
const accountLabel = a => (a.number && displaySettings().showNumbers !== false ? `${a.number} · ${a.name}` : a.name);
export { accountLabel };

export const accountToValues = a => ({ name: a.name, number: a.number ?? '', type: a.type, parentId: a.parent_id ? String(a.parent_id) : '',
  description: a.description ?? '', active: a.active });
export const accountFormValues = params => ({ name: params.get('name') ?? '', number: params.get('number') ?? '', type: params.get('type') ?? '',
  parentId: params.get('parentId') ?? '', description: params.get('description') ?? '', active: params.get('active') === '1' });
export const NEW_ACCOUNT = { name: '', number: '', type: 'expense', parentId: '', description: '', active: true };

function checkLine(check) {
  if (!check) return '';
  return html`<p class="${check.balanced && check.arMatches ? 'ledger-check good' : 'ledger-check bad'}" role="status">
  ${check.balanced ? html`Books balance: debits and credits are both ${formatCents(check.debits)}.` : html`Out of balance by ${formatCents(Math.abs(check.debits - check.credits))}.`}
  ${check.arMatches ? html`A/R matches what customers owe (${formatCents(check.arOpen)}).` : html`A/R (${formatCents(check.arLedger)}) doesn’t match what customers owe (${formatCents(check.arOpen)}).`}
</p>`;
}

export function chartOfAccountsBody({ accounts, check, showInactive = false }) {
  const shown = accounts.filter(a => showInactive || a.active);
  const tops = shown.filter(a => !a.parent_id || !shown.some(p => p.account_id === a.parent_id));
  const kids = id => shown.filter(a => a.parent_id === id);
  const row = (a, sub = false) => html`<tr class="${a.active ? '' : 'inactive'}">
    <td class="${sub ? 'sub-account' : ''}"><a href="/settings/accounts/${a.account_id}">${a.name}</a>${a.system_key ? html` <span class="tag">Built in</span>` : ''}</td>
    <td>${displaySettings().showNumbers !== false ? a.number ?? '' : ''}</td>
    <td>${a.type_label}</td>
    <td class="num">${formatCents(a.balance_cents)}</td>
    <td class="actions"><a href="/settings/accounts/${a.account_id}">Register</a> · <a href="/settings/accounts/${a.account_id}/edit">Edit</a></td>
  </tr>`;
  return html`<div class="page-actions"><p class="muted">Every transaction posts to these accounts. Balances are shown the way they normally run (assets and expenses as debits, the rest as credits).</p>
  <span class="spacer"></span><a class="button primary" href="/settings/accounts/new">New account</a></div>
${checkLine(check)}
<p><a href="/settings/accounts${showInactive ? '' : '?inactive=1'}">${showInactive ? 'Hide inactive accounts' : 'Show inactive accounts'}</a></p>
<table class="grid">
  <thead><tr><th>Name</th><th>Number</th><th>Type</th><th class="num">Balance</th><th class="actions">Action</th></tr></thead>
  ${GROUPS.map(([g, label]) => {
    const list = tops.filter(a => a.group === g);
    if (!list.length) return '';
    return html`<tbody><tr class="group-row"><th colspan="5">${label}</th></tr>
      ${list.map(a => html`${row(a)}${kids(a.account_id).map(k => row(k, true))}`)}</tbody>`;
  })}
</table>`;
}

export function accountFormBody({ csrf, account = null, parents, v, error = null }) {
  const system = Boolean(account?.system_key);
  const types = ACCOUNT_TYPES.filter(([k]) => system ? k === account.type : !RESERVED_TYPES.has(k)).map(([k, l]) => [k, l]);
  const action = account ? `/settings/accounts/${account.account_id}/edit` : '/settings/accounts';
  return html`<form method="post" action="${action}" class="editor">
  ${csrfField(csrf)}
  <div class="crumbs"><a href="/settings/accounts">‹ Chart of accounts</a></div>
  <h2>${account ? `Edit ${account.name}` : 'New account'}</h2>
  ${system ? html`<p class="muted">This account is built in. You can rename or renumber it; its type stays the same and it can’t be made inactive.</p>` : ''}
  ${errorBanner(error)}
  <div class="form-grid">
    ${field('Account name', 'name', v.name, { required: true })}
    ${field('Number', 'number', v.number, { hint: 'Optional. Accounts sort by number.' })}
    ${selectField('Type', 'type', types, v.type)}
    ${system ? '' : selectField('Sub-account of', 'parentId', parents.filter(p => p.account_id !== account?.account_id).map(p => [p.account_id, `${accountLabel(p)} (${p.type_label})`]), v.parentId, { blank: '— none (top level) —' })}
    ${field('Description', 'description', v.description, { cls: 'wide' })}
  </div>
  ${system ? '' : checkbox('Active', 'active', v.active)}
  <div class="form-actions"><a href="/settings/accounts">Cancel</a><button class="primary">Save</button></div>
</form>
${account && !system ? html`<div class="txn-actions section-title">${postButton({ action: `/settings/accounts/${account.account_id}/delete`, csrf, label: 'Delete account', cls: 'danger', confirm: `Delete “${account.name}”? Only unused accounts can be deleted.` })}</div>` : ''}`;
}

const refOf = r => r.doc_number ?? r.payment_ref ?? '';
const VENDOR_SIDE = new Set(['bill', 'bill_payment', 'expense', 'check', 'vendor_credit', 'purchase_order', 'item_receipt', 'inventory_adjustment', 'cc_credit']);
const LEDGER_TYPES = new Set(['journal_entry', 'transfer', 'cc_payment', 'fx_revaluation']);
export const linkOf = r => (r.type === 'deposit' ? `/deposits/${r.txn_id}` : LEDGER_TYPES.has(r.type) ? `/ledger/${r.txn_id}`
  : VENDOR_SIDE.has(r.type) ? `/vtxns/${r.txn_id}` : `/txns/${r.txn_id}`);

export function registerBody({ account: a, rows }) {
  return html`<div class="crumbs page-actions"><a href="/settings/accounts">‹ Chart of accounts</a><span class="spacer"></span>
  <a class="button" href="/settings/accounts/${a.account_id}/edit">Edit account</a></div>
<div class="card-head"><h2>${accountLabel(a)}</h2><span class="tag">${a.type_label}</span></div>
<dl class="details project-totals"><div><dt>Balance</dt><dd>${formatCents(a.balance_cents)}</dd></div></dl>
${rows.length ? html`<table class="grid">
  <thead><tr><th>Date</th><th>Type</th><th>No.</th><th>Customer / vendor</th><th>Memo</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead>
  <tbody>${rows.map(r => html`<tr>
    <td>${formatShortDate(r.txn_date)}</td>
    <td>${REGISTER_TYPES[r.type] ?? r.type}</td>
    <td><a href="${linkOf(r)}">${refOf(r) || 'View'}</a></td>
    <td>${r.customer_id ? html`<a href="/customers/${r.customer_id}">${r.customer_name}</a>` : r.vendor_id ? html`<a href="/vendors/${r.vendor_id}">${r.vendor_name}</a>` : ''}</td>
    <td class="memo">${r.memo ?? ''}</td>
    <td class="num">${formatCents(r.amount)}</td>
    <td class="num">${formatCents(r.balance)}</td>
  </tr>`)}</tbody>
</table>${rows.length >= 500 ? html`<p class="muted">Showing the latest 500 entries.</p>` : ''}` : html`<p class="muted">Nothing has posted to this account yet.</p>`}`;
}
