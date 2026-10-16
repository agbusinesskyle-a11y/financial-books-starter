import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField, checkbox } from './forms.js';
import { RETURN_TYPE_LABELS, ACTIVITY_KINDS } from '../tax/periods.js';
import { PARTY_KINDS } from '../tax/parties.js';
import { ACTIVITY_KIND_LABELS, SCHEDULES } from '../tax/activities.js';

const later = what => html`<section class="card"><h2>${what}</h2><p class="muted">This part is available in a later stage.</p></section>`;

// /tax/:entity/profile (spec §8): defaults, parties, activities, inclusion edges, periods and baselines. Later-stage sections visibly disabled.
export function taxProfilePage({ entityName, csrf, flash, company, profile, parties, activities, periods, inclusions, baselines, companies, canEdit, canEditParties = false, canSetAccountantFlag = true, canVerifyInitial = false, v, error = null }) {
  const E = company.entityId;
  // Codex t1-r1 B8: a requested first year is a claim (openings unknown) until an admin verifies it with evidence (openings zero).
  const initialTag = p => p.initial_status === 'verified' ? html` <span class="tag">Initial (verified)</span>`
    : p.initial_status === 'requested' ? html` <span class="tag">Initial (requested)</span>` : '';
  const OPENINGS = { zero: 'Zero (verified first year)', baseline: 'From the predecessor baseline', unknown: 'Unknown' };
  const toVerify = periods.filter(p => p.initial_status === 'requested');
  return layout({ title: `Tax setup: ${company.name}`, entityName, csrf, flash, wide: true, body: html`<div class="crumbs"><a href="/tax">‹ Tax</a></div>
<h1>Tax setup: ${company.name}</h1>
${errorBanner(error)}
<section class="card"><h2>Return and defaults</h2>
  <p class="muted small">These are the defaults for the next period. Changing the return type or a method is a reviewed change: give the reason.</p>
  <form method="post" action="/tax/${E}/profile" class="editor">${csrfField(csrf)}<div class="form-grid">
    ${selectField('Return filed', 'return_type', Object.entries(RETURN_TYPE_LABELS), v.returnType)}
    ${selectField('If disregarded, kind of activity', 'activity_kind', ACTIVITY_KINDS, v.activityKind, { blank: '—' })}
    ${selectField('Tax method', 'tax_method', [['cash', 'Cash'], ['accrual', 'Accrual']], v.taxMethod)}
    ${selectField('Books kept on', 'book_basis', [['accrual', 'Accrual'], ['cash', 'Cash']], v.bookBasis)}
    ${field('States (two-letter codes)', 'state_codes', v.stateCodes, { hint: 'For deadlines and hand-entry items; no state math yet.' })}
    ${field('Business code (NAICS)', 'business_code', v.businessCode, { attrs: 'inputmode="numeric"' })}
    ${field('Date started', 'date_started', v.dateStarted, { type: 'date' })}
    ${field('S election date', 's_election_date', v.sElectionDate, { type: 'date' })}
    ${field('Reason for change', 'reason', v.reason)}
    ${canSetAccountantFlag ? checkbox('The accountant (reports role) may edit tax mapping and adjustments', 'accountant_may_edit', v.accountantMayEdit) : ''}
  </div>${canEdit ? html`<div class="form-actions"><button class="primary">Save</button></div>` : ''}</form>
</section>
<section class="card"><h2>Parties</h2>
  <div class="table-scroll"><table class="grid"><thead><tr><th>Name</th><th>Kind</th><th>Tax ID</th></tr></thead>
  <tbody>${parties.map(p => html`<tr><td data-label="Name">${p.name}</td><td data-label="Kind">${PARTY_KINDS.find(([k]) => k === p.kind)?.[1] ?? p.kind}</td><td data-label="Tax ID">${p.has_tax_id ? `•••• ${p.tax_id_last4}` : html`<span class="muted">none</span>`}</td></tr>`)}</tbody></table></div>
  ${canEditParties ? html`<form method="post" action="/tax/${E}/parties" class="editor">${csrfField(csrf)}<div class="form-grid">
    ${selectField('Kind', 'kind', PARTY_KINDS, 'individual')} ${field('Name', 'name', '', { required: true })} ${field('Tax ID (SSN or EIN, stored encrypted)', 'tax_id', '')}
    ${selectField('Company (for one of our companies)', 'entity_id', companies.map(c => [c.entityId, c.name]), '', { blank: '—' })}</div>
    <div class="form-actions"><button>Add party</button></div></form>` : html`<p class="muted small">Parties are shared by every company; an admin who can open every company adds them.</p>`}
</section>
<section class="card"><h2>Activities</h2>
  <div class="table-scroll"><table class="grid"><thead><tr><th>Activity</th><th>Kind</th><th>Schedule</th><th>From</th><th>Disposed</th></tr></thead>
  <tbody>${activities.map(a => html`<tr><td data-label="Activity">${a.name}</td><td data-label="Kind">${ACTIVITY_KIND_LABELS[a.kind]}</td><td data-label="Schedule">${SCHEDULES.find(([k]) => k === a.schedule)?.[1]}</td><td data-label="From">${a.effective_from}</td><td data-label="Disposed">${a.disposed_on ?? html`<span class="muted">—</span>`}</td></tr>`)}</tbody></table></div>
  ${canEdit ? html`<form method="post" action="/tax/${E}/activities" class="editor">${csrfField(csrf)}<div class="form-grid">
    ${field('Name', 'name', '', { required: true })} ${selectField('Kind', 'kind', Object.entries(ACTIVITY_KIND_LABELS), 'trade')} ${selectField('Schedule', 'schedule', SCHEDULES, 'p1')}
    ${field('From', 'from', '', { type: 'date', required: true })} ${field('To', 'to', '', { type: 'date' })} ${field('Disposed on', 'disposed_on', '', { type: 'date' })}</div>
    <div class="form-actions"><button>Add activity</button></div></form>` : ''}
</section>
<section class="card"><h2>Periods</h2>
  <div class="table-scroll"><table class="grid"><thead><tr><th>Period</th><th>Return</th><th>Edition</th><th>Method</th><th>Status</th><th>Openings</th><th>Computes</th><th>Included books</th></tr></thead>
  <tbody>${periods.map(p => html`<tr><td data-label="Period">${p.period_start} – ${p.period_end}${initialTag(p)}</td><td data-label="Return">${RETURN_TYPE_LABELS[p.return_type]}</td>
    <td data-label="Edition">${p.form_edition}</td><td data-label="Method">${p.tax_method} / books ${p.book_basis}</td><td data-label="Status">${p.status}</td>
    <td data-label="Openings">${p.opening_state === 'unknown' ? html`<span class="muted">${OPENINGS.unknown}</span>` : OPENINGS[p.opening_state]}</td>
    <td data-label="Computes">${p.computes ? 'Later stage' : html`<span class="muted">No catalog for ${p.form_edition} yet</span>`}</td>
    <td data-label="Included">${(inclusions[p.return_id] ?? []).map(i => i.source_name).join(', ') || html`<span class="muted">—</span>`}</td></tr>`)}</tbody></table></div>
  ${toVerify.length ? html`<p class="muted small">An initial period is requested until it is verified: its openings stay unknown, not zero.</p>` : ''}
  ${canVerifyInitial ? toVerify.map(p => html`<form method="post" action="/tax/${E}/periods/${p.return_id}/initial" class="editor">${csrfField(csrf)}<div class="form-grid">
    ${field(`Evidence that ${p.period_start} – ${p.period_end} is the first year (formation documents, EIN letter)`, 'evidence', '', { required: true })}</div>
    <div class="form-actions"><button>Verify first year</button></div></form>`) : ''}
  ${canEdit ? html`<form method="post" action="/tax/${E}/periods" class="editor">${csrfField(csrf)}<div class="form-grid">
    ${field('Tax year', 'year', '', { attrs: 'inputmode="numeric"', required: true })} ${checkbox('Request initial period (first year; may start mid-year; openings unknown until an admin verifies it)', 'initial', false)} ${field('Starts (initial only)', 'period_start', '', { type: 'date' })}</div>
    <div class="form-actions"><button>Open period</button></div></form>
    <form method="post" action="/tax/${E}/inclusions" class="editor">${csrfField(csrf)}<div class="form-grid">
    ${selectField('Period', 'return_id', periods.map(p => [p.return_id, `${p.period_start} – ${p.period_end}`]), '', { blank: 'Choose…' })}
    ${selectField('Activity', 'activity_id', activities.map(a => [a.activity_id, a.name]), '', { blank: 'Choose…' })}
    ${selectField('Include the books of (a disregarded company)', 'source_entity_id', companies.filter(c => Number(c.entityId) !== Number(E)).map(c => [c.entityId, c.name]), '', { blank: 'Choose…' })}</div>
    <div class="form-actions"><button>Include books</button></div></form>` : ''}
</section>
<section class="card"><h2>Filed returns on record (baselines)</h2>
  ${baselines.length ? html`<div class="table-scroll"><table class="grid"><thead><tr><th>Source period</th><th>Kind</th><th>Facts</th><th>Review</th></tr></thead>
  <tbody>${baselines.map(b => html`<tr><td data-label="Period">${b.source_period_start} – ${b.source_period_end}</td><td data-label="Kind">${b.kind} v${b.payload_version}</td><td data-label="Facts">${b.fact_count}</td><td data-label="Review">${b.extraction_status}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">None yet. Filed returns are imported with <code>scripts/tax-baseline-import.mjs</code>; their numbers become openings only after review (a later stage).</p>`}
</section>
${later('Owners and capital')}${later('Mapping and worksheet')}${later('Estimate and deadlines')}` });
}
