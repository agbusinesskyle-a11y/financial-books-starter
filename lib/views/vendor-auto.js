import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField, postButton } from './forms.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { UNITS, describeRule } from '../domain/schedule.js';
import { PAYMENT_METHODS } from '../domain/checks.js';
import { vendorLineTables } from './vendor-txns.js';
import { accountLabel } from './accounts.js';
import { INFO_FIELDS } from '../data/vendor-info.js';
import { THRESHOLD_CENTS } from '../data/ten99.js';
import { formatAddress } from '../domain/vendors.js';

const TYPE_NAMES = { bill: 'Bill', expense: 'Expense', check: 'Check' };
const MODE_NAMES = { scheduled: 'Scheduled', reminder: 'Reminder', unscheduled: 'Unscheduled' };

// ---- the vendor's Recurring tab ----

export function vendorRecurringList({ vendor: v, csrf, templates }) {
  return html`<div class="page-actions"><p class="muted">Rent, utilities, subscriptions: bills, expenses or checks created on a schedule.</p>
  <span class="spacer"></span><a class="button primary" href="/vendors/${v.vendor_id}/recurring/new">New recurring transaction</a></div>
${templates.length ? html`<table class="grid">
  <thead><tr><th>Name</th><th>Type</th><th>How it runs</th><th>Next</th><th class="num">Amount</th><th class="actions">Action</th></tr></thead>
  <tbody>${templates.map(t => html`<tr class="${t.active ? '' : 'inactive'}">
    <td><a href="/vrecurring/${t.template_id}">${t.name}</a>${t.active ? '' : html` <span class="tag">Paused</span>`}</td>
    <td>${TYPE_NAMES[t.txn_type]}</td>
    <td>${MODE_NAMES[t.mode]}${t.mode !== 'unscheduled' ? html`<br><span class="muted">${describeRule({ unit: t.interval_unit, count: t.interval_count, start: t.start_date, end: t.end_date })}</span>` : ''}</td>
    <td>${t.next_run_date ? formatShortDate(t.next_run_date) : '—'}</td>
    <td class="num">${formatCents(t.total_cents)}</td>
    <td class="actions"><a href="/vtxns/new?template=${t.template_id}">Use</a> ·
      ${postButton({ action: `/vrecurring/${t.template_id}/${t.active ? 'pause' : 'resume'}`, csrf, label: t.active ? 'Pause' : 'Resume' })} ·
      ${postButton({ action: `/vrecurring/${t.template_id}/delete`, csrf, label: 'Delete', confirm: `Delete the template “${t.name}”? Transactions it made stay.` })}</td>
  </tr>`)}</tbody></table>` : html`<p class="muted">No recurring transactions for ${v.display_name}.</p>`}`;
}

export function vendorTemplateForm({ entityName, csrf, vendor, templateId = null, categories, items, jobs, payFrom, terms, v, error = null }) {
  const action = templateId ? `/vrecurring/${templateId}` : `/vendors/${vendor.vendor_id}/recurring`;
  return layout({
    title: templateId ? 'Edit recurring transaction' : 'New recurring transaction', entityName, csrf, wide: true,
    body: html`<div class="crumbs"><a href="/vendors/${vendor.vendor_id}?tab=recurring">‹ ${vendor.display_name}</a></div>
<form method="post" action="${action}" class="card editor" data-vendor-editor>
  ${csrfField(csrf)}
  <div class="card-head"><h1>${templateId ? `Edit “${v.name}”` : 'New recurring transaction'}</h1><p class="big-total">Amount <strong data-vtotal>$0.00</strong></p></div>
  ${errorBanner(error)}
  <div class="form-grid">
    ${field('Template name', 'name', v.name, { required: true })}
    ${selectField('Type', 'txnType', Object.entries(TYPE_NAMES), v.txnType)}
    ${selectField('How it runs', 'mode', [['scheduled', 'Scheduled: create it automatically'], ['reminder', 'Reminder: remind me to create it'], ['unscheduled', 'Unscheduled: I’ll use it by hand']], v.mode, { attrs: 'data-mode' })}
    ${selectField('Paid from (expenses and checks)', 'accountId', payFrom.map(a => [a.account_id, accountLabel(a)]), v.accountId, { blank: '—' })}
    ${selectField('Terms (bills)', 'termsId', terms.map(t => [t.terms_id, t.name]), v.termsId, { blank: 'Vendor default' })}
  </div>
  <div class="form-grid" data-schedule>
    ${field('Every', 'count', v.count, { attrs: 'inputmode="numeric"' })}
    ${selectField('Unit', 'unit', UNITS.map(([k]) => [k, `${k}(s)`]), v.unit)}
    ${field('Start date', 'startDate', v.startDate, { type: 'date' })}
    ${field('End date (optional)', 'endDate', v.endDate, { type: 'date' })}
  </div>
  ${vendorLineTables({ categories, items, jobs, v })}
  <label class="field wide"><span>Memo</span><input name="memo" value="${v.memo}"></label>
  <div class="form-actions"><a href="/vendors/${vendor.vendor_id}?tab=recurring">Cancel</a><button class="primary">Save template</button></div>
</form>`,
  });
}

// ---- scheduled payment on a bill ----

export function scheduleBox({ txn: t, csrf, payFrom, today }) {
  if (t.type !== 'bill' || t.voided_at || t.open_cents === 0 || t.approval_status !== 'approved') return '';
  if (t.scheduled_pay_date) {
    return html`<p class="ledger-check warn">Payment of ${formatCents(t.open_cents)} scheduled for ${formatShortDate(t.scheduled_pay_date)} from ${t.scheduled_account_name}
      (${t.scheduled_method}). ${postButton({ action: `/vtxns/${t.txn_id}/unschedule`, csrf, label: 'Cancel the scheduled payment' })}</p>`;
  }
  return html`<details class="compose" id="schedule"><summary class="button">Schedule payment…</summary>
  <form method="post" action="/vtxns/${t.txn_id}/schedule" class="editor">${csrfField(csrf)}
    <p class="muted">On that date the payment of the open ${formatCents(t.open_cents)} is recorded automatically.</p>
    <div class="form-grid">
      ${field('Pay on', 'pay_date', t.due_date > today ? t.due_date : today, { type: 'date', required: true })}
      ${selectField('Pay from', 'account_id', payFrom.map(a => [a.account_id, accountLabel(a)]), '')}
      ${selectField('Method', 'method', PAYMENT_METHODS.map(m => [m, m]), 'ACH')}
    </div>
    <div class="form-actions"><button class="primary">Schedule</button></div>
  </form></details>`;
}

// ---- ask vendor for info ----

export function pendingRequestBanner({ vendor: v, request: r }) {
  if (!r) return '';
  if (r.status === 'submitted') {
    return html`<p class="ledger-check warn">${v.display_name} sent their details on ${formatShortDate(String(r.submitted_at.toISOString?.() ?? r.submitted_at).slice(0, 10))}.
      <a href="/vendors/${v.vendor_id}/info/${r.request_id}">Review and accept</a></p>`;
  }
  return html`<p class="ledger-check">Waiting for ${v.display_name} to fill in their details${r.sent_to ? ` (link sent to ${r.sent_to})` : ''}.
    The link works until ${formatShortDate(String(r.expires_at.toISOString?.() ?? r.expires_at).slice(0, 10))}.</p>`;
}

export function askSentPage({ entityName, csrf, vendor, link, status }) {
  return layout({
    title: 'Ask vendor for info', entityName, csrf,
    body: html`<div class="crumbs"><a href="/vendors/${vendor.vendor_id}">‹ ${vendor.display_name}</a></div>
<section class="card">
  <h1>Link for ${vendor.display_name}</h1>
  <p>${status === 'sent' ? html`Emailed to ${vendor.email}.` : status === 'logged' ? html`Recorded as sent to ${vendor.email}; email isn’t set up yet (Settings → Email), so copy the link below and send it yourself.`
    : status === 'failed' ? 'The email couldn’t be sent; copy the link below and send it another way.' : 'This vendor has no email address; copy the link below and text or email it.'}</p>
  <p class="copy-link"><input value="${link}" readonly aria-label="Link for the vendor" data-select-on-focus></p>
  <p class="muted">The link works once, for 14 days. Nothing the vendor sends changes their record until you review and accept it.</p>
  <p><a class="button" href="/vendors/${vendor.vendor_id}">Back to ${vendor.display_name}</a></p>
</section>`,
  });
}

export function infoReviewPage({ entityName, csrf, review, error = null }) {
  const { request: r, now, sent } = review;
  return layout({
    title: 'Review vendor details', entityName, csrf,
    body: html`<div class="crumbs"><a href="/vendors/${r.vendor_id}">‹ ${r.display_name}</a></div>
<form method="post" action="/vendors/${r.vendor_id}/info/${r.request_id}" class="card editor">
  ${csrfField(csrf)}
  <h1>Details from ${r.display_name}</h1>
  ${errorBanner(error)}
  ${!sent ? html`<p class="error-banner">The submission can’t be read on this server.</p>` : r.status !== 'submitted' ? html`<p class="muted">This submission was already ${r.status}.</p>` : html`
  <p class="muted">Tick what to copy onto the vendor record. Anything left unticked is ignored.</p>
  <table class="grid"><thead><tr><th>Accept</th><th>Field</th><th>On file now</th><th>Vendor sent</th></tr></thead>
    <tbody>${INFO_FIELDS.filter(([k]) => sent[k] !== undefined).map(([k, label]) => html`<tr>
      <td><input type="checkbox" name="accept" value="${k}" checked aria-label="Accept ${label}"></td><td>${label}</td>
      <td class="muted">${now[k] ?? '—'}</td><td><strong>${sent[k]}</strong></td></tr>`)}</tbody></table>
  <div class="form-actions"><button name="do" value="dismiss" data-confirm="Dismiss these details without changing the vendor?">Dismiss</button>
    <button class="primary" name="do" value="accept">Accept ticked</button></div>`}
</form>`,
  });
}

// The public page the vendor sees (no app chrome, no account).
export function publicInfoForm({ request: r, nonce, v = {}, error = null }) {
  return layout({
    title: `Your details for ${r.entity_name}`, entityName: r.entity_name, bare: true,
    body: html`<section class="card editor public-form">
  <h1>${r.entity_name} asked for your details</h1>
  <p class="muted">For ${r.vendor_name}. Fill in what you’d like ${r.entity_name} to have on file. This link works once.</p>
  ${errorBanner(error)}
  <form method="post" autocomplete="off">
    <input type="hidden" name="nonce" value="${nonce}">
    <h2>Business</h2>
    <div class="form-grid">
      ${field('Company name', 'company', v.company)}
      ${field('Name to print on checks', 'checkName', v.checkName)}
      ${field('Email for payments', 'email', v.email, { type: 'email' })}
      ${field('Phone', 'phone', v.phone, { type: 'tel' })}
    </div>
    <fieldset class="address"><legend>Mailing address</legend>
      ${field('Street address', 'line1', v.line1, { cls: 'wide' })}${field('Suite / unit', 'line2', v.line2, { cls: 'wide' })}
      ${field('City', 'city', v.city)}${field('State', 'state', v.state)}${field('ZIP code', 'postal', v.postal)}
    </fieldset>
    <h2>For tax forms (1099)</h2>
    <div class="form-grid">${field('EIN or SSN', 'taxId', '', { hint: '12-3456789 or 123-45-6789' })}</div>
    <h2>Bank account for direct deposit</h2>
    <div class="form-grid">
      ${field('Routing number', 'bankRouting', '', { attrs: 'inputmode="numeric"' })}
      ${field('Account number', 'bankAccount', '', { attrs: 'inputmode="numeric"' })}
      ${field('Account number again', 'bankAccount2', '', { attrs: 'inputmode="numeric"' })}
    </div>
    <p class="muted">Sent over an encrypted connection and stored encrypted. ${r.entity_name} sees only the last four digits.</p>
    <div class="form-actions"><button class="primary">Send my details</button></div>
  </form>
</section>`,
  });
}

export function publicMessage({ title, message }) {
  return layout({ title, bare: true, body: html`<section class="card message"><h1>${title}</h1><p>${message}</p></section>` });
}

// ---- 1099s ----

export function ten99Page({ entityName, csrf, flash = null, data, years, canTrack = false }) {
  const { year, tracked, untrackedOver, totals } = data;
  return layout({
    title: `1099s for ${year}`, entityName, csrf, flash, wide: true,
    body: html`<div class="crumbs page-actions"><a href="/vendors">‹ Vendors</a><span class="spacer"></span>
  <form method="get" action="/vendors/1099" class="inline"><select name="year" data-autosubmit aria-label="Tax year">${years.map(y => html`<option value="${y}"${y === year ? html` selected` : ''}>${y}</option>`)}</select><noscript><button>Show</button></noscript></form>
  <a class="button" href="/vendors/1099.csv?year=${year}">Export</a></div>
<h1>1099-NEC summary, ${year}</h1>
<p class="muted">Nonemployee compensation paid to vendors you track for 1099s: checks, ACH and cash out of bank accounts. Card payments are left out
  (the card company reports those). Vendors paid ${formatCents(THRESHOLD_CENTS)} or more need a 1099. This summary doesn’t file anything.</p>
<p class="${totals.missingTaxIds ? 'ledger-check bad' : 'ledger-check good'}">${totals.vendors} vendor${totals.vendors === 1 ? '' : 's'} need a 1099, ${formatCents(totals.paidCents)} in all.
  ${totals.missingTaxIds ? html`${totals.missingTaxIds} ${totals.missingTaxIds === 1 ? 'is' : 'are'} missing a tax ID.` : ''}</p>
<table class="grid">
  <thead><tr><th>Vendor</th><th>Address</th><th>Tax ID</th><th class="num">Payments</th><th class="num">Box 1 (NEC)</th><th class="num">Paid by card (left out)</th><th>1099?</th></tr></thead>
  <tbody>${tracked.map(r => html`<tr class="${r.over ? '' : 'inactive'}">
    <td><a href="/vendors/${r.vendor_id}">${r.display_name}</a></td><td>${formatAddress(r.billing_address) || html`<span class="status bad">Missing</span>`}</td>
    <td>${r.tax_id_last4 ? `•••${r.tax_id_last4}` : html`<span class="status ${r.over ? 'bad' : 'warn'}">Missing</span> <a href="/vendors/${r.vendor_id}/edit">Add</a>`}</td>
    <td class="num">${r.payments}</td><td class="num">${formatCents(r.paid_cents)}</td><td class="num">${r.card_cents ? formatCents(r.card_cents) : ''}</td>
    <td>${r.over ? html`<span class="status good">Yes</span>` : 'Under threshold'}</td></tr>`)}</tbody>
</table>
${untrackedOver.length ? html`<h2 class="section-title">Paid ${formatCents(THRESHOLD_CENTS)} or more but not tracked</h2>
<p class="muted">Check whether these vendors should get a 1099 (corporations and goods suppliers usually don’t). Tick the ones to track, or turn on
  “Track payments for 1099” on the vendor.</p>
${canTrack ? html`<form method="post" action="/vendors/1099/track"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="year" value="${year}">
<ul class="plain">${untrackedOver.map(r => html`<li><label class="check"><input type="checkbox" name="vendor" value="${r.vendor_id}"> <a href="/vendors/${r.vendor_id}">${r.display_name}</a>: ${formatCents(r.paid_cents)}</label></li>`)}</ul>
<div class="form-actions"><button class="primary">Track ticked for 1099</button></div></form>`
  : html`<ul>${untrackedOver.map(r => html`<li><a href="/vendors/${r.vendor_id}">${r.display_name}</a>: ${formatCents(r.paid_cents)}</li>`)}</ul>`}` : ''}`,
  });
}

