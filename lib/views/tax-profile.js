import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField, checkbox } from './forms.js';
import { RETURN_TYPE_LABELS, ACTIVITY_KINDS } from '../tax/periods.js';
import { OWNER_ROLES, fractionText } from '../tax/ownership.js';
import { ACTIVITY_KIND_LABELS, SCHEDULES } from '../tax/activities.js';

const later = what => html`<section class="card"><h2>${what}</h2><p class="muted">This part is available in a later stage.</p></section>`;

// /tax/:entity/profile (spec §8): ONE company's tax page (the owner's scoping, 2026-10-16) — its defaults, where a disregarded company is
// reported, the books its return includes, its owners and members, its own tax party, activities, periods and baselines. The org-wide
// party directory is /tax/parties (org admins); every company's return at once is /tax/all (org admins). Later-stage sections disabled.
//   ownParty      this company's own entity_in_org party, or null (its EIN marker and the conflict choice live here)
//   reporting     for a disregarded company: { period, hops: [{ entityId, name, returnType, year, allowed }], filing, blocked, partial, earlier } —
//                 its inclusion chain for its latest period up to the filing return (lib/tax/reporting.js); partial: { on: the filing hop,
//                 covered, uncovered } when that return covers only part of the period (Codex r7 R7-N2)
//   included      the books the latest period includes, any depth: [{ entityId, name, depth, allowed }] (allowed: every company on the path)
//   interests     ownership_interest rows, history included; rosters: { [return_id]: rosterFor(...) }; partyOptions: [[id, name]]
export function taxProfilePage({ entityName, csrf, flash, company, profile, ownParty = null, reporting = null, included = [], interests = [], rosters = {}, partyOptions = [], activities, periods,
  inclusions, baselines, companies, canEdit, canEditParties = false, canSetAccountantFlag = true, canVerifyInitial = false, v, error = null }) {
  const E = company.entityId;
  // Codex t1-r1 B8: a requested first year is a claim (openings unknown) until an admin verifies it with evidence (openings zero).
  const initialTag = p => p.initial_status === 'verified' ? html` <span class="tag">Initial (verified)</span>`
    : p.initial_status === 'requested' ? html` <span class="tag">Initial (requested)</span>` : '';
  const OPENINGS = { zero: 'Zero (verified first year)', baseline: 'From the predecessor baseline', unknown: 'Unknown' };
  const toVerify = periods.filter(p => p.initial_status === 'requested');
  // Codex t2-plan-r2 B9: an org admin settles an EIN conflict of THIS company's party here, choosing between the two candidates shown.
  const einChoice = p => (canEditParties && p.tax_id_conflict && Number(p.entity_id) === Number(E)
    ? ['company', 'party'].map(keep => html` <form method="post" action="/tax/${E}/parties/${p.party_id}/ein" class="inline">${csrfField(csrf)}<input type="hidden" name="evidence_id" value="${p.tax_id_conflict.evidenceId}"><input type="hidden" name="keep" value="${keep}"><button class="link">${keep === 'company' ? `Keep Settings → Company’s (•••• ${p.tax_id_conflict.companyLast4})` : `Keep this party’s (•••• ${p.tax_id_conflict.partyLast4})`}</button></form>`)
    : '');
  // Disregarded by its latest period (the facts that period resolved), else by its profile.
  const disregarded = (periods.length ? [...periods].sort((a, b) => String(b.period_end).localeCompare(String(a.period_end)))[0].return_type : profile.return_type) === 'disregarded';
  const companyLink = (id, name, allowed) => (allowed ? html`<a href="/tax/${id}/profile">${name}</a>` : html`${name} <span class="muted small">(you cannot open this company)</span>`);
  const roleLabel = r => OWNER_ROLES.find(([k]) => k === r)?.[1] ?? r;
  return layout({ title: `Tax setup: ${company.name}`, entityName, csrf, flash, wide: true, body: html`${canEditParties ? html`<div class="crumbs"><a href="/tax/all">‹ All returns</a></div>` : ''}
<h1>Tax setup: ${company.name}</h1>
${errorBanner(error)}
${disregarded && reporting ? html`<section class="card"><h2>Where this company is reported</h2>
  ${reporting.filing ? html`<p>Disregarded — reported on ${companyLink(reporting.filing.entityId, reporting.filing.name, reporting.filing.allowed)}’s ${RETURN_TYPE_LABELS[reporting.filing.returnType]} (${reporting.filing.year})${reporting.hops.length > 1 ? html`, through ${reporting.hops.slice(0, -1).map((h2, k) => html`${k ? ', then ' : ''}${companyLink(h2.entityId, h2.name, h2.allowed)}`)}` : ''}.</p>`
    : reporting.partial ? html`<p><span class="status warn">Partly reported for ${reporting.period.period_start} – ${reporting.period.period_end}:</span> ${reporting.partial.covered.start} – ${reporting.partial.covered.end} on ${companyLink(reporting.partial.on.entityId, reporting.partial.on.name, reporting.partial.on.allowed)}’s ${RETURN_TYPE_LABELS[reporting.partial.on.returnType]} (${reporting.partial.on.year})${reporting.hops.length > 1 ? html`, through ${reporting.hops.slice(0, -1).map((h2, k) => html`${k ? ', then ' : ''}${companyLink(h2.entityId, h2.name, h2.allowed)}`)}` : ''}; ${reporting.partial.uncovered.map((u, k) => html`${k ? ' and ' : ''}${u.start} – ${u.end}`)} not included in any return — those books are not reported until a return covers those dates.</p>`
    : reporting.blocked ? html`<p><span class="status warn">Not reported yet for ${reporting.period.period_start} – ${reporting.period.period_end}:</span> its books reach ${reporting.hops.map((h2, k) => html`${k ? ', then ' : ''}${companyLink(h2.entityId, h2.name, h2.allowed)}`)} for part of the year only, which cannot be combined yet.</p>`
    : html`<p><span class="status warn">Disregarded — not included in a return for ${reporting.period.period_start} – ${reporting.period.period_end}</span>${reporting.hops.length ? html` (its books reach ${reporting.hops.map((h2, k) => html`${k ? ', then ' : ''}${companyLink(h2.entityId, h2.name, h2.allowed)}`)}, which is not included anywhere for that period)` : ''}: include its books from the tax page of the company whose return reports it.</p>`}
  ${!reporting.filing && reporting.earlier ? html`<p class="muted small">Earlier: reported on ${companyLink(reporting.earlier.entityId, reporting.earlier.name, reporting.earlier.allowed)}’s ${RETURN_TYPE_LABELS[reporting.earlier.returnType]} (${reporting.earlier.year}).</p>` : ''}
  <p class="muted small">A disregarded company files no return of its own: its books are mapped on the including return. It keeps a period here only so its books can be included (and can include its own disregarded companies).</p>
</section>` : ''}
${included.length ? html`<section class="card"><h2>${disregarded ? 'Books this company includes (reported with its own)' : 'Books included in this return'}</h2>
  <ul>${included.map(i => html`<li>${companyLink(i.entityId, i.name, i.allowed)}${i.depth > 1 ? html` <span class="muted small">(through ${i.depth - 1} other included compan${i.depth === 2 ? 'y' : 'ies'})</span>` : ''}</li>`)}</ul>
</section>` : ''}
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
${profile.return_type === 'household_1040' ? '' : html`<section class="card"><h2>Owners and members</h2>
  <p class="muted small">Who holds this company, from when, with exact profit, loss and capital shares (like 1/3 or 25%). A share left blank is not known yet: it blocks what depends on it and is never read as zero. A change on a later date keeps the earlier interest as history. Capital accounts, basis, liabilities, allocations and K-1s are a later stage.</p>
  ${interests.length ? html`<div class="table-scroll"><table class="grid"><thead><tr><th>Owner</th><th>Role</th><th>From</th><th>To</th><th>Profit</th><th>Loss</th><th>Capital</th><th class="actions"></th></tr></thead>
  <tbody>${interests.map(o => html`<tr><td data-label="Owner">${o.party_name}</td><td data-label="Role">${roleLabel(o.role)}</td><td data-label="From">${o.effective_from}</td>
    <td data-label="To">${o.effective_to ?? html`<span class="muted">—</span>`}</td><td data-label="Profit">${fractionText(o.profit_num, o.profit_den)}</td><td data-label="Loss">${fractionText(o.loss_num, o.loss_den)}</td>
    <td data-label="Capital">${fractionText(o.capital_num, o.capital_den)}</td>
    <td class="actions" data-label="">${canEdit && !o.effective_to ? html`<form method="post" action="/tax/${E}/interests/${o.interest_id}/end" class="inline">${csrfField(csrf)}<input type="date" name="to" aria-label="Ends on" required> <button class="link">End</button></form>` : ''}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">No owners on file yet.</p>`}
  ${periods.filter(p => rosters[p.return_id]).map(p => html`<p class="small">${p.period_start} – ${p.period_end}: ${rosters[p.return_id].status === 'complete' ? 'owners complete for the year' : html`<span class="status warn">${rosters[p.return_id].problems.join(' ')}</span>`}</p>`)}
  ${canEdit ? html`<form method="post" action="/tax/${E}/interests" class="editor">${csrfField(csrf)}<div class="form-grid">
    ${selectField('Owner (from the party directory)', 'party_id', partyOptions, '', { blank: 'Choose…' })}
    ${selectField('Role', 'role', OWNER_ROLES, '', { blank: 'Choose…' })}
    ${field('From', 'from', '', { type: 'date', required: true })} ${field('To', 'to', '', { type: 'date' })}
    ${field('Profit share', 'profit', '', { hint: '1/2 or 50%; blank if not known' })} ${field('Loss share', 'loss', '')} ${field('Capital share', 'capital', '')}</div>
    <div class="form-actions"><button>Save owner</button></div></form>` : ''}
</section>`}
${ownParty ? html`<section class="card"><h2>This company’s tax party</h2>
  <p>${ownParty.name}: tax ID ${ownParty.has_tax_id ? `•••• ${ownParty.tax_id_last4}` : html`<span class="muted">none</span>`}${ownParty.tax_id_needs_review ? html` <span class="status warn">${ownParty.own_tax_id_state === 'conflict' ? 'EIN differs from Settings → Company' : 'EIN to reconcile'}</span>` : ''}${einChoice(ownParty)}</p>
  <p class="muted small">Its EIN is kept once, in Settings → Company.${canEditParties ? html` Every party of the organization is listed in the <a href="/tax/parties">party directory</a>.` : ''}</p>
</section>` : canEditParties ? html`<p class="small"><a href="/tax/parties">Party directory</a> (every company’s owners, payers and household members)</p>` : ''}
<section class="card"><h2>Activities</h2>
  <div class="table-scroll"><table class="grid"><thead><tr><th>Activity</th><th>Kind</th><th>Schedule</th><th>From</th><th>Disposed</th></tr></thead>
  <tbody>${activities.map(a => html`<tr><td data-label="Activity">${a.name}</td><td data-label="Kind">${ACTIVITY_KIND_LABELS[a.kind]}</td><td data-label="Schedule">${SCHEDULES.find(([k]) => k === a.schedule)?.[1]}</td><td data-label="From">${a.effective_from}</td><td data-label="Disposed">${a.disposed_on ?? html`<span class="muted">—</span>`}</td></tr>`)}</tbody></table></div>
  ${canEdit ? html`<form method="post" action="/tax/${E}/activities" class="editor">${csrfField(csrf)}<div class="form-grid">
    ${field('Name', 'name', '', { required: true })} ${selectField('Kind', 'kind', Object.entries(ACTIVITY_KIND_LABELS), 'trade')} ${selectField('Schedule', 'schedule', SCHEDULES, 'p1')}
    ${field('From', 'from', '', { type: 'date', required: true })} ${field('To', 'to', '', { type: 'date' })} ${field('Disposed on', 'disposed_on', '', { type: 'date' })}</div>
    <div class="form-actions"><button>Add activity</button></div></form>` : ''}
</section>
<section class="card"><h2>Periods</h2>
  <div class="table-scroll"><table class="grid"><thead><tr><th>Period</th><th>Return</th><th>Edition</th><th>Method</th><th>Status</th><th>Openings</th><th>Computes</th><th>Included books</th><th>Mapping</th></tr></thead>
  <tbody>${periods.map(p => html`<tr><td data-label="Period">${p.period_start} – ${p.period_end}${initialTag(p)}</td><td data-label="Return">${RETURN_TYPE_LABELS[p.return_type]}</td>
    <td data-label="Edition">${p.form_edition}</td><td data-label="Method">${p.tax_method} / books ${p.book_basis}</td><td data-label="Status">${p.status}</td>
    <td data-label="Openings">${p.opening_state === 'unknown' ? html`<span class="muted">${OPENINGS.unknown}</span>` : OPENINGS[p.opening_state]}</td>
    <td data-label="Computes">${p.computes ? 'Later stage' : html`<span class="muted">No catalog for ${p.form_edition} yet</span>`}</td>
    <td data-label="Included">${(inclusions[p.return_id] ?? []).length ? inclusions[p.return_id].map(i => companyLink(i.source_entity_id, i.source_name, companies.some(c => Number(c.entityId) === Number(i.source_entity_id)))) : html`<span class="muted">—</span>`}</td>
    <td data-label="Mapping">${p.return_type === 'disregarded' ? html`<span class="muted">On the including return</span>` : html`<a href="/tax/${E}/${String(p.period_end).slice(0, 4)}/mapping">Mapping</a>${['form_1065', 'form_1120s'].includes(p.return_type) ? html` · <a href="/tax/${E}/${String(p.period_end).slice(0, 4)}">Worksheet</a>` : ''}`}</td></tr>`)}</tbody></table></div>
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
${disregarded ? '' : html`<section class="card"><h2>Filed returns on record (baselines)</h2>
  ${baselines.length ? html`<div class="table-scroll"><table class="grid"><thead><tr><th>Source period</th><th>Kind</th><th>Facts</th><th>Review</th></tr></thead>
  <tbody>${baselines.map(b => html`<tr><td data-label="Period">${b.source_period_start} – ${b.source_period_end}</td><td data-label="Kind">${b.kind} v${b.payload_version}</td><td data-label="Facts">${b.fact_count}</td><td data-label="Review">${b.extraction_status}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">None yet. Filed returns are imported with <code>scripts/tax-baseline-import.mjs</code>; their numbers become openings only after review (a later stage).</p>`}
</section>
${later('Capital accounts and K-1s')}${later('Worksheet')}${later('Estimate and deadlines')}`}` });
}
