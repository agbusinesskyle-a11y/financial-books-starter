// lib/views/tax-worksheet.js
// The T3 return pages (spec §8, phone first): the worksheet /tax/:entity/:year (form pages with every line's exact amount and status, the
// checks and the waiting-on list, drill-down from a line to its accounts and from an account to its transactions, working revisions and
// drift) and its workpapers — typed items (/manual), adjustments and proposals (/adjustments), cash timing reviews and closing entries
// (/cash), cost of goods sold (/cogs). Amounts are BigInt cents shown with dollars(); every decision form carries the version it was shown.
import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField, postButton, checkbox } from './forms.js';
import { dollars } from '../tax/measure.js';
import { catalogFor } from '../tax/catalog/index.js';
import { parseSlotKey } from '../tax/providers.js';
import { measurementsOf, valueKey } from '../tax/engine/formulas.js';
import { REVIEW_KINDS } from '../tax/cash.js';
import { CLASSES } from '../tax/classify.js';
import { PURPOSES, M1_CLASSES } from '../tax/adjustments.js';
import { MOVEMENT_CLASSES, METHODS, TREATMENTS } from '../tax/cogs.js';
import { K1_ANSWER, MAX_STATEMENT_ROWS } from '../tax/manual.js';

const hidden = (name, value) => html`<input type="hidden" name="${name}" value="${value ?? ''}">`;
const money = c => (c === null || c === undefined ? html`<span class="muted">not known</span>` : dollars(c));
// Exact cents as a form value ("-1234.50"), never through Number.
const plain = c => { if (c === null || c === undefined) return ''; const v = BigInt(c), n = v < 0n, a = n ? -v : v; return `${n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };
const TABS = [['', 'Worksheet'], ['manual', 'Typed items'], ['adjustments', 'Adjustments'], ['cash', 'Cash and closings'], ['cogs', 'Cost of goods sold'], ['mapping', 'Mapping']];
const tabs = (base, current) => html`<nav class="crumbs">${TABS.map(([p, label], i) => html`${i ? ' · ' : ''}${p === current ? html`<strong>${label}</strong>` : html`<a href="${p ? `${base}/${p}` : base}">${label}</a>`}`)}</nav>`;
const draft = html`<p class="muted"><strong>Draft.</strong> Computed now from the books, the mapping and the workpapers; nothing here is final (marking a return final arrives with stage T4).</p>`;
const SCHEDULES = {
  form_1065: [['Page 1: income and deductions', 'f1065.p1.'], ['Schedule K', 'f1065.k.'], ['Analysis of net income', 'f1065.anal.'], ['Schedule L: balance sheet per books', 'f1065.L.'], ['Schedule M-1', 'f1065.m1.'], ['Form 1125-A: cost of goods sold', 'f1125a.main.']],
  form_1120s: [['Page 1: income and deductions', 'f1120s.p1.'], ['Schedule K', 'f1120s.k.'], ['Schedule L: balance sheet per books', 'f1120s.L.'], ['Schedule M-1', 'f1120s.m1.'], ['Form 1125-A: cost of goods sold', 'f1125a.main.']],
};
const shortLine = id => id.split('.').slice(2).join('.');
const page = ({ entityName, csrf, flash, company, year, current, error, body }) => layout({ title: `Tax return: ${company.name} ${year}`, entityName, csrf, flash, wide: true,
  body: html`${tabs(`/tax/${company.entityId}/${year}`, current)}<h1>${company.name} ${year}</h1>${errorBanner(error)}${body}` });

// The worksheet.
export function taxWorksheetPage({ entityName, csrf, flash, company, year, r, line = null, revisions = [], drift = null, canEdit, error = null }) {
  const base = `/tax/${company.entityId}/${year}`;
  if (!r || r.refused) return page({ entityName, csrf, flash, company, year, current: '', error, body: html`<section class="card"><h2>Not computed</h2><p>${r?.refused ?? 'No tax period for that year.'}</p></section>` });
  const catalog = catalogFor(r.ret.return_type, r.ret.form_edition);
  const byKey = new Map(r.fields.map(f => [f.key, f]));
  const errors = r.checks.filter(c => c.level === 'error'), warnings = r.checks.filter(c => c.level !== 'error');
  const WHERE = { manual_open: 'manual', k1_inflows: 'manual', proposal_open: 'adjustments', timing_open: 'cash', closing_candidate: 'cash', cogs: 'cogs', coverage: 'mapping', incomplete: 'mapping' };
  // A value the engine did not emit is "not computed", never 0.00: only a known zero it supplied shows as zero.
  const cell = f => (!f ? html`<span class="tag">not computed</span>` : f.status === 'complete' ? dollars(f.cents) : html`<span class="tag">not known</span>`);
  const lineRow = (l, keys) => {
    const fs = keys.map(k => byKey.get(k)), any = fs.find(Boolean);
    const reasons = [...new Set(fs.filter(Boolean).flatMap(f => f.reasons))].slice(0, 2);
    return html`<tr><td data-label="Line">${any ? html`<a href="${base}?line=${encodeURIComponent(any.key)}#drill">${shortLine(l.id)}</a>` : shortLine(l.id)}</td><td data-label="Description">${l.label}${reasons.map(x => html`<div class="muted small">${x}</div>`)}</td>
      ${fs.map((f, i) => html`<td class="num" data-label="${keys.length > 1 ? (i ? 'End of year' : 'Beginning') : 'Amount'}">${cell(f)}</td>`)}</tr>`;
  };
  const schedule = ([title, prefix]) => {
    const lines = catalog.lines.filter(l => l.id.startsWith(prefix) && ['amount', 'statement', 'code'].includes(l.type) && !l.instanceDims.some(d => !['activity', 'interest'].includes(d)));
    if (prefix === 'f1125a.main.') {
      const acts = [...new Set(r.fields.filter(f => f.fieldId.startsWith(prefix) && f.dims.activity).map(f => f.dims.activity))];
      if (!acts.length) return '';
      return acts.map(a => html`<section class="card"><h2>${title} — ${r.cogs.get(Number(a.slice(4)))?.name ?? a}</h2><div class="table-scroll"><table class="grid"><thead><tr><th>Line</th><th>Description</th><th class="num">Amount</th></tr></thead>
        <tbody>${lines.map(l => lineRow(l, [`${l.id}|activity=${a}|activity`]))}</tbody></table></div></section>`);
    }
    // A line kept per owner (officer compensation, guaranteed payments, loans to or from owners) shows one row per instance on the return.
    const rowsOf = l => {
      if (!l.instanceDims.length) return [lineRow(l, measurementsOf(l).map(m => `${l.id}|${m}`))];
      const insts = [...new Set(r.fields.filter(f => f.fieldId === l.id).map(f => JSON.stringify(f.dims)))].map(d => JSON.parse(d));
      const named = d => Object.values(d).map(v => (v === 'i:t4' ? 'the owners — stage T4' : v === 'i:pending' ? 'an owner whose interest is not selected yet' : v === 'act:pending' ? 'an activity not selected yet' : v)).join(', ');
      return insts.map(d => lineRow({ ...l, label: `${l.label} (${named(d)})` }, measurementsOf(l).map(m => valueKey(l.id, d, m))));
    };
    const balance = prefix.endsWith('.L.');
    return html`<section class="card"><h2>${title}</h2><div class="table-scroll"><table class="grid"><thead><tr><th>Line</th><th>Description</th>${balance ? html`<th class="num">Beginning</th><th class="num">End of year</th>` : html`<th class="num">Amount</th>`}</tr></thead>
      <tbody>${lines.flatMap(rowsOf)}</tbody></table></div></section>`;
  };
  const drill = () => {
    const f = byKey.get(line);
    if (!f) return html`<section class="card" id="drill"><p class="muted">That line has no amount on this return.</p></section>`;
    const l = catalog.byId.get(f.fieldId), { measurement } = parseSlotKey(line);
    const slots = r.slots.filter(sl => { try { const p = parseSlotKey(sl.key); return p.fieldId === f.fieldId && p.measurement === measurement && Object.entries(f.dims).every(([k, v]) => p.dims[k] === v); } catch { return false; } });
    // An account's transactions behind the amount: the period's for an activity, everything to the day before the period for a beginning balance.
    const dayBefore = iso => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const report = id => `/reports/r/transaction_detail_by_account?run=1&period=custom&from=${measurement === 'activity' ? r.ret.period_start : ''}&to=${measurement === 'begin' ? dayBefore(r.ret.period_start) : r.ret.period_end}&basis=${r.ret.book_basis}&account=${id}`;
    return html`<section class="card" id="drill"><h2>${shortLine(f.fieldId)} ${l?.label ?? ''}</h2><p>${f.status === 'complete' ? dollars(f.cents) : 'Not known'}${f.reasons.length ? html` — ${f.reasons.join(' ')}` : ''}</p>
      ${l?.kind === 'computed' ? html`<p class="muted">Computed from other lines (${JSON.stringify(l.formula)}).</p>` : ''}
      ${slots.map(sl => html`<h3>${sl.provider ? `From ${sl.provider.replace('_', ' ')}` : 'No provider'}${sl.cents !== null ? `: ${dollars(sl.cents)}` : ''}</h3>
        ${sl.members.length ? html`<div class="table-scroll"><table class="grid"><thead><tr><th>Account</th><th>Measurement</th><th>Role</th><th class="num">Book amount (debit +)</th></tr></thead><tbody>
          ${sl.members.map(m => html`<tr><td data-label="Account">${m.accountId ? html`<a href="${report(m.accountId)}">${m.accountName ?? m.accountId}</a>` : '—'}</td><td data-label="Measurement">${m.measurement}</td><td data-label="Role">${m.role ?? ''}</td><td class="num" data-label="Book amount">${money(m.ledgerCents)}</td></tr>`)}
        </tbody></table></div>` : ''}
        ${[...sl.extras, ...sl.cashItems].map(x => html`<div class="muted small">${x.label}: ${money(x.ledgerCents)} (debit +)</div>`)}`)}
      ${r.deltas.filter(d => d.slotKey === line || parseSlotKey(d.slotKey).fieldId === f.fieldId).map(d => html`<div class="muted small">Adjustment: ${d.label} ${money(d.cents)} (${d.m1Class})</div>`)}
      ${f.rows ? html`<h3>Statement</h3><ul>${f.rows.map(x => html`<li>${x.label}: ${money(x.cents)}</li>`)}</ul>` : ''}</section>`;
  };
  const b = r.bridge;
  return page({ entityName, csrf, flash, company, year, current: '', error, body: html`${draft}
    <p class="muted">${r.ret.return_type === 'form_1065' ? 'Form 1065' : 'Form 1120-S'} for ${r.ret.period_start} – ${r.ret.period_end}: ${r.ret.tax_method} method, books on the ${r.ret.book_basis} basis. Amounts are exact; a line that is not known is never shown as zero.</p>
    <section class="card"><h2>Checks</h2>
      ${errors.length ? html`<p>${errors.length} item${errors.length === 1 ? '' : 's'} to resolve before this return could be final:</p><ul>${errors.slice(0, 60).map(c => html`<li>${c.message}${WHERE[c.code] ? html` <a href="${base}/${WHERE[c.code]}">Open</a>` : ''}</li>`)}</ul>${errors.length > 60 ? html`<p class="muted">and ${errors.length - 60} more.</p>` : ''}` : html`<p>No errors.</p>`}
      ${warnings.map(c => html`<p class="muted small">${c.message}</p>`)}
    </section>
    <section class="card"><h2>Schedule M-1 bridge</h2><p>Net income per books ${money(b.bookNetIncome)}; the return’s income (${shortLine(b.endpoint)}) ${money(b.endpointCents)}; Schedule M-1 ${money(b.m1Cents)}; ${b.residual === null ? 'not reconciled yet' : b.residual === '0' ? 'reconciled' : html`<strong>unexplained difference ${dollars(b.residual)}</strong>`}.</p>
      ${b.rows.length ? html`<ul>${b.rows.map(x => html`<li>Line ${x.line}: ${x.label} ${dollars(x.cents)}</li>`)}</ul>` : ''}${b.unknown.map(x => html`<p class="muted small">${x}</p>`)}</section>
    ${line ? drill() : ''}
    ${SCHEDULES[r.ret.return_type].map(schedule)}
    <section class="card"><h2>Working revisions</h2>
      ${revisions.length ? html`<ul>${revisions.slice(0, 10).map(v => html`<li>Revision ${v.revision_no}, taken ${String(v.taken_at).slice(0, 19)} by ${v.taken_by}</li>`)}</ul>` : html`<p class="muted">None taken yet.</p>`}
      ${drift ? html`<p>Since revision ${drift.revisionNo}: ${drift.amount.length} line${drift.amount.length === 1 ? '' : 's'} changed${drift.provenance.length ? `; sources changed: ${drift.provenance.join(', ')}` : ''}${drift.structure.length ? `; structure changed: ${drift.structure.join(', ')}` : ''}${drift.engine ? '; the engine or catalog changed' : ''}.</p>
        ${drift.amount.slice(0, 20).map(d => html`<div class="muted small">${d.key}: ${money(d.was)} → ${money(d.now)}</div>`)}` : ''}
      ${canEdit ? postButton({ action: `${base}/revisions`, csrf, label: 'Take a working revision', cls: '' }) : ''}</section>` });
}

// Typed items. "Not applicable" for the items not entered is offered a batch at a time (each click answers at most REST_BATCH of them).
export const REST_BATCH = 25;
// unsaved: what the person submitted when a save was refused ({ itemKey, amount, rows: [{ label, amount }] }) — shown again in that item's form,
// so nothing typed is lost; the stored item is unchanged.
export function taxManualPage({ entityName, csrf, flash, company, year, r, canEdit, error = null, unsaved = null }) {
  const base = `/tax/${company.entityId}/${year}`;
  if (!r || r.refused) return taxWorksheetPage({ entityName, csrf, flash, company, year, r, canEdit, error });
  const itemOf = k => r.items.find(i => i.item_key === k) ?? null;
  const open = r.needs.filter(n => !itemOf(n.key) && n.key !== K1_ANSWER);
  const beside = key => r.slots.find(sl => sl.key === key)?.members.filter(m => m.role === 'comparison') ?? [];
  // A comparison's book amount is shown with money() (null-aware, Codex t3-r1 note 1): a stale or orphaned attribution has no amount, and the
  // account's mapping reasons say why; the typed amount beside it is unaffected.
  const mappingWhy = accountId => r.cov?.sources?.[0]?.accounts?.find(a => a.accountId === accountId)?.results?.activity?.reasons ?? [];
  const booksBeside = fb => html`${fb.map((m, i) => html`${i ? ', ' : ''}${m.accountName} ${money(m.ledgerCents)}${m.ledgerCents === null && mappingWhy(m.accountId).length ? html` (${mappingWhy(m.accountId).join(' ')})` : ''}`)}`;
  const k1 = itemOf(K1_ANSWER);
  // A statement line's form shows every row already entered, each editable (blank a row's name and amount to remove it), and blank rows to
  // add up to the limit (MAX_STATEMENT_ROWS: the form, the parser and the save hold the same one); the row count travels with the form, so
  // saving never drops a row the page did not show.
  const statementRows = (it, typed = null) => {
    const kept = typed ?? (it?.rows ?? []).map(x => ({ label: x.label, amount: plain(x.cents) }));
    const rows = [...kept, ...Array.from({ length: Math.max(0, Math.min(2, MAX_STATEMENT_ROWS - kept.length)) }, () => ({ label: '', amount: '' }))];
    return html`${hidden('row_count', rows.length)}${rows.map((x, i) => html`<div class="form-grid">${field(`Row ${i + 1} name`, `label_${i}`, x.label)}${field(`Row ${i + 1} amount`, `amount_${i}`, x.amount, { attrs: 'inputmode="decimal"' })}</div>`)}`;
  };
  const itemRow = n => {
    const it = itemOf(n.key), statement = n.line?.type === 'statement', fb = beside(n.key);
    return html`<tr><td data-label="Line">${shortLine(n.line.id)}</td><td data-label="Description">${n.line.label}${n.activity ? ` — ${n.activity}` : ''}${n.subsetOf ? html`<div class="muted small">The part of ${n.parentLabel} it is (never more than that line); not applicable means none.</div>` : ''}${fb.length ? html`<div class="muted small">Books beside it: ${booksBeside(fb)}</div>` : ''}</td>
      <td data-label="Now">${!it ? html`<span class="tag">not entered</span>` : it.status === 'not_applicable' ? 'Not applicable' : it.rows ? it.rows.map(x => `${x.label} ${dollars(x.cents)}`).join('; ') : dollars(it.amount)}</td>
      <td data-label="">${canEdit ? html`<form method="post" action="${base}/manual/save" class="editor">${csrfField(csrf)}${hidden('item_key', n.key)}
        ${statement ? statementRows(it, unsaved?.itemKey === n.key ? unsaved.rows.filter(x => x.label.trim() || x.amount.trim()) : null) : field('Amount', 'amount', unsaved?.itemKey === n.key ? unsaved.amount : plain(it?.amount), { attrs: 'inputmode="decimal"' })}
        ${field('Support (the workpaper or document; empty it to remove it)', 'workpaper', unsaved?.itemKey === n.key ? unsaved.workpaper ?? '' : it?.workpaper ?? '')}
        <button class="link" name="status" value="entered">Save</button> <button class="link" name="status" value="not_applicable">Not applicable</button></form>
        ${it ? postButton({ action: `${base}/manual/clear`, csrf, label: 'Clear', extra: { item_key: n.key } }) : ''}` : ''}</td></tr>`;
  };
  return page({ entityName, csrf, flash, company, year, current: 'manual', error, body: html`${draft}
    <p class="muted">Lines the books never supply. Each is entered (the amount as the line takes it: a deduction positive, a loss negative), or marked not applicable by you; until then it is unknown and everything computed from it waits.</p>
    <section class="card"><h2>K-1s received</h2><p>${k1 ? 'This return receives no K-1s.' : html`<span class="tag">not answered</span> Does this return receive K-1s from partnerships or S corporations?`}</p>
      ${canEdit && !k1 ? postButton({ action: `${base}/manual/save`, csrf, label: 'It receives none', cls: '', extra: { item_key: K1_ANSWER, status: 'not_applicable' } }) : ''}
      ${canEdit && k1 ? postButton({ action: `${base}/manual/clear`, csrf, label: 'Clear', extra: { item_key: K1_ANSWER } }) : ''}
      <p class="muted small">A return that receives K-1s waits for the K-1 records of stage T4.</p></section>
    ${(r.orphanItems ?? []).length ? html`<section class="card"><h2>Saved items that no longer apply</h2><p class="muted">Their lines are not known until each is cleared or its reference is eligible again.</p><ul>${r.orphanItems.map(it => html`<li>${it.item_key}: ${it.status === 'not_applicable' ? 'Not applicable' : it.rows ? it.rows.map(x => `${x.label} ${dollars(x.cents)}`).join('; ') : dollars(it.amount)} — ${it.reason}
      ${canEdit ? postButton({ action: `${base}/manual/clear`, csrf, label: 'Clear', extra: { item_key: it.item_key } }) : ''}</li>`)}</ul></section>` : ''}
    <section class="card"><h2>Typed items</h2><div class="table-scroll"><table class="grid"><thead><tr><th>Line</th><th>Description</th><th>Now</th><th></th></tr></thead>
      <tbody>${r.needs.filter(n => n.key !== K1_ANSWER).map(itemRow)}</tbody></table></div>
      ${canEdit && open.length ? html`<form method="post" action="${base}/manual/rest" class="editor">${csrfField(csrf)}${open.slice(0, REST_BATCH).map(n => hidden('key', n.key))}<div class="form-actions"><button>Mark ${open.length > REST_BATCH ? `the first ${REST_BATCH} of the ${open.length}` : `the ${open.length}`} item${open.length === 1 ? '' : 's'} not entered as not applicable</button></div></form>` : ''}</section>` });
}

// Adjustments and proposals.
export function taxAdjustmentsPage({ entityName, csrf, flash, company, year, r, groups = [], canEdit, error = null }) {
  const base = `/tax/${company.entityId}/${year}`;
  if (!r || r.refused) return taxWorksheetPage({ entityName, csrf, flash, company, year, r, canEdit, error });
  const ROWS = 3;
  return page({ entityName, csrf, flash, company, year, current: 'adjustments', error, body: html`${draft}
    <section class="card"><h2>Proposals</h2>${r.proposals.length ? html`<ul>${r.proposals.map(p => html`<li>${p.why} ${p.accountName}: ${p.lines.map(l => `${shortLine(parseSlotKey(l.slotKey).fieldId)} ${dollars(l.cents)}`).join(', ')}
      ${p.answer?.fresh ? html` — <strong>${p.answer.status}</strong>${p.answer.reason ? ` (${p.answer.reason})` : ''}` : canEdit ? html`<form method="post" action="${base}/adjustments/answer" class="inline">${csrfField(csrf)}${hidden('key', p.key)}${hidden('version', p.version)}
        <button class="link" name="decision" value="accept">Accept</button> <input name="reason" aria-label="Why not" placeholder="Why not"> <button class="link" name="decision" value="reject">Reject</button></form>` : html` <span class="tag">waiting</span>`}</li>`)}</ul>` : html`<p class="muted">No proposals.</p>`}
      ${(r.orphanAnswers ?? []).length ? html`<h3>Accepted proposals that no longer match their source</h3><p class="muted">Each still holds the lines it decided (they are not known) until it is withdrawn here. Where the account now feeds another line, the proposal computed there needs its own answer too; withdrawing retires this answer without rejecting the proposal.</p>
        <ul>${r.orphanAnswers.map(g => html`<li>${g.memo} — ${g.lines.map(l => `${shortLine(parseSlotKey(l.slotKey).fieldId)} ${dollars(l.cents)}`).join(', ')} <span class="tag">no longer matches</span>
          ${canEdit ? html`<form method="post" action="${base}/adjustments/withdraw" class="inline">${csrfField(csrf)}${hidden('group_id', g.group_id)}<input name="reason" aria-label="Why" placeholder="Why"><button class="link">Withdraw</button></form>` : ''}</li>`)}</ul>` : ''}</section>
    <section class="card"><h2>Adjustments</h2>${groups.filter(g => g.source === 'person').map(g => html`<div><strong>${g.purpose}</strong>: ${g.memo} (${g.status}${g.reason ? `: ${g.reason}` : ''}) — ${g.lines.map(l => `${l.slotKey} ${dollars(l.cents)} [${l.m1Class}]`).join('; ')}
      ${canEdit && g.status === 'accepted' ? html`<form method="post" action="${base}/adjustments/withdraw" class="inline">${csrfField(csrf)}${hidden('group_id', g.group_id)}<input name="reason" aria-label="Why" placeholder="Why"><button class="link">Withdraw</button></form>` : ''}</div>`)}
      ${canEdit ? html`<form method="post" action="${base}/adjustments/add" class="editor">${csrfField(csrf)}
        ${selectField('Purpose', 'purpose', PURPOSES, '')}${field('What it does', 'memo', '')}${field('Support (workpaper, document, rule)', 'evidence', '')}
        ${Array.from({ length: ROWS }, (_, i) => html`<fieldset class="form-grid"><legend>Line ${i + 1}</legend>${field('Slot (e.g. f1065.p1.21|activity)', `slot_${i}`, '')}${field('Change (the line’s own sign)', `amount_${i}`, '', { attrs: 'inputmode="decimal"' })}${selectField('Schedule M-1', `class_${i}`, M1_CLASSES, '')}</fieldset>`)}
        <div class="form-actions"><button class="primary">Add the adjustment</button></div></form>` : ''}</section>` });
}

// Cash timing reviews and closing entries.
export function taxCashPage({ entityName, csrf, flash, company, year, r, canEdit, error = null }) {
  const base = `/tax/${company.entityId}/${year}`;
  if (!r || r.refused) return taxWorksheetPage({ entityName, csrf, flash, company, year, r, canEdit, error });
  const cands = [...(r.cash?.candidates ?? []), ...(r.timing?.candidates ?? [])];
  // A decision's form carries the transaction AND the event version it was shown at (an application made since makes it stale).
  const review = c => html`<li>${c.date ?? ''} ${c.docNumber || `#${c.txnId}`}: ${dollars(c.cents)} — ${c.reason} ${c.state === 'decided' ? html`<strong>${REVIEW_KINDS[c.review.kind]}: ${c.review.decision}${c.review.recognize_on ? ` on ${c.review.recognize_on}` : ''}</strong>` : html`<span class="tag">${c.state === 'stale' ? `changed since decided${c.review ? ` (${REVIEW_KINDS[c.review.kind]}: ${c.review.decision})` : ''}` : 'waiting'}</span>`}
    ${c.review && canEdit ? postButton({ action: `${base}/cash/clear`, csrf, label: 'Clear', extra: { review_id: c.review.review_id } }) : ''}
    ${canEdit && c.eventVersion ? html`<form method="post" action="${base}/cash/review" class="editor">${csrfField(csrf)}${hidden('txn_id', c.txnId)}${hidden('txn_version', c.txnVersion)}${hidden('event_version', c.eventVersion)}
      ${selectField('It is', 'kind', c.kinds.map(k => [k, REVIEW_KINDS[k]]), c.review?.kind ?? c.kinds[0])}${selectField('Decision', 'decision', [['include', 'Include in this period'], ['exclude', 'Exclude from this period']], c.review?.decision ?? '', c.review ? {} : { blank: 'Choose' })}
      ${c.needsSlot ? html`${field('Destination slot (when included)', 'slot_key', c.review?.slot_key ?? '')}${field('Amount (when included: the whole amount shown)', 'amount', plain(c.cents), { attrs: 'inputmode="decimal"' })}` : ''}
      ${c.kinds.includes('receipt_date') ? field('Received on', 'recognize_on', c.review?.recognize_on ?? '', { type: 'date' }) : ''}${field('Note', 'reason', c.review?.reason ?? '')}<div class="form-actions"><button>Save the decision</button></div></form>` : ''}</li>`;
  // Selecting another event to review: a deposit to income for its receipt date (cash method); a bill unpaid at the period end — or any
  // transaction of the period by its number — for a related-party or economic-performance review (accrual method).
  const pick = () => {
    const opt = x => [`${x.txnId}:${x.txnVersion}:${x.eventVersion}`, `${x.date} ${x.docNumber || `#${x.txnId}`} ${dollars(x.cents)}`];
    if (r.ret.tax_method === 'cash') {
      const list = r.cash?.selectable?.receipts ?? [];
      return list.length ? html`<form method="post" action="${base}/cash/review" class="editor">${csrfField(csrf)}<h3>Review another deposit’s receipt date</h3>${selectField('Deposit to income', 'pick', list.map(opt), '')}${hidden('kind', 'receipt_date')}${hidden('decision', 'include')}
        ${field('Received on', 'recognize_on', '', { type: 'date' })}${field('Note (the receipt evidence)', 'reason', '')}<div class="form-actions"><button>Save the receipt date</button></div></form>` : '';
    }
    const list = r.timing?.selectable?.bills ?? [];
    return html`<form method="post" action="${base}/cash/review" class="editor">${csrfField(csrf)}<h3>Review another accrual</h3>
      ${list.length ? selectField('A bill unpaid at the period end', 'pick', list.map(opt), '', { blank: 'Choose a bill, or give a transaction number below' }) : ''}
      ${field('Or the transaction number (#)', 'txn_id', '', { attrs: 'inputmode="numeric"' })}
      ${selectField('It is', 'kind', [['related_party_accrual', REVIEW_KINDS.related_party_accrual], ['economic_performance', REVIEW_KINDS.economic_performance]], 'related_party_accrual')}
      ${selectField('Decision', 'decision', [['exclude', 'Not deductible this period'], ['include', 'Deductible this period']], 'exclude')}${field('Note', 'reason', '')}<div class="form-actions"><button>Save the decision</button></div></form>`;
  };
  const entry = c => html`<li>${c.date} journal entry ${c.docNumber || `#${c.txnId}`}${c.balanced ? '' : ' (its income, expense and equity lines do not balance on their own: choose the lines)'} — ${c.state === 'decided' ? html`<strong>${c.decision.class}</strong>` : html`<span class="tag">${c.state === 'stale' ? 'changed since classified' : 'waiting'}</span>`}
    ${canEdit ? html`<form method="post" action="${base}/cash/classify" class="editor">${csrfField(csrf)}${hidden('txn_id', c.txnId)}${hidden('txn_version', c.txnVersion)}
      <fieldset><legend>Lines of a closing</legend>${c.lines.map(l => html`<label class="check"><input type="checkbox" name="line" value="${l.lineNo}"${(c.decision ? c.decision.lines ?? [] : c.proposed).includes(l.lineNo) ? html` checked` : ''}> ${l.lineNo}: ${l.accountName} ${dollars(l.cents)}</label>`)}</fieldset>
      ${selectField('This entry is', 'class', CLASSES, c.decision?.class ?? 'closing')}${field('Note', 'reason', c.decision?.reason ?? '')}<div class="form-actions"><button>Save</button></div></form>
      ${c.decision ? postButton({ action: `${base}/cash/unclassify`, csrf, label: 'Clear', extra: { txn_id: c.txnId } }) : ''}` : ''}</li>`;
  return page({ entityName, csrf, flash, company, year, current: 'cash', error, body: html`${draft}
    <section class="card"><h2>Closing entries</h2><p class="muted">A journal entry that closes income or expense into equity is removed from the measurement with both its legs once you confirm it; until then the accounts it touches are not known.</p>
      ${r.candidates.length ? html`<ul>${r.candidates.map(entry)}</ul>` : html`<p class="muted">None in this period.</p>`}</section>
    <section class="card"><h2>${r.ret.tax_method === 'cash' ? 'Cash timing reviews' : 'Accrual timing reviews'}</h2>
      <p class="muted">${r.ret.tax_method === 'cash' ? 'The cash layer recognizes each payment, receipt and application once. The defaults stand in the draft; each decision below is needed before the return could be final.' : 'A book accrual is deductible only when the all-events test and economic performance are met: each accrual entry below needs a decision.'}</p>
      ${cands.length ? html`<ul>${cands.map(review)}</ul>` : html`<p class="muted">Nothing waiting.</p>`}
      ${canEdit ? pick() : ''}</section>` });
}

// Cost of goods sold workpapers.
export function taxCogsPage({ entityName, csrf, flash, company, year, r, activities = [], canEdit, error = null }) {
  const base = `/tax/${company.entityId}/${year}`;
  if (!r || r.refused) return taxWorksheetPage({ entityName, csrf, flash, company, year, r, canEdit, error });
  const amt = plain;
  // Every stored other cost (line 5) of a reviewed workpaper, editable, and blank rows to add — the same preservation as typed statements.
  const otherRows = w => {
    const kept = Array.isArray(w?.reviewed_lines?.['5']) ? w.reviewed_lines['5'].map(x => ({ label: x.label, amount: amt(x.cents) })) : [];
    const rows = [...kept, ...Array.from({ length: Math.max(0, Math.min(2, MAX_STATEMENT_ROWS - kept.length)) }, () => ({ label: '', amount: '' }))];
    return html`${hidden('other_count', rows.length)}${rows.map((x, i) => html`<div class="form-grid">${field(`Other cost ${i + 1} name`, `other_label_${i}`, x.label)}${field(`Other cost ${i + 1} amount`, `other_amount_${i}`, x.amount, { attrs: 'inputmode="decimal"' })}</div>`)}`;
  };
  const paper = e => {
    const w = e.workpaper;
    return html`<section class="card"><h2>${e.name}</h2>
      ${e.reasons.map(x => html`<p class="muted small">${x}</p>`)}
      <p>Purchases ${money(e.values['2'])}, labor ${money(e.values['3'])}, section 263A ${money(e.values['4'])}, other costs ${e.values['5'] ? dollars(e.values['5'].reduce((t, x) => t + x.cents, 0n)) : money(null)}; book cost of goods sold beside line 8: ${e.tieout.known ? dollars(e.tieout.cents) : 'not known'}.</p>
      ${e.movements.length ? html`<details><summary>${e.movements.length} inventory movements</summary><ul>${e.movements.map(m => m.gone ? html`<li>${m.accountName ?? m.accountId}, transaction ${m.txnId} line ${m.lineNo}: <span class="tag">classified as ${m.was}, ${m.notNeeded ? 'kept for a reconstruction (not used by this workpaper’s path)' : m.present ? 'not checkable until its account’s input is completely mapped' : 'no longer a posting of this period'}</span>
        ${canEdit ? postButton({ action: `${base}/cogs/unclassify`, csrf, label: 'Clear', extra: { account_id: m.accountId, txn_id: m.txnId, line_no: m.lineNo } }) : ''}</li>` : html`<li>${m.date} ${m.type ?? ''} ${m.docNumber || m.txnId}: ${dollars(m.cents)} — ${m.cls ?? html`<span class="tag">${m.stale ? `changed since classified as ${m.was}: classify again` : 'not classified'}</span>`}
        ${canEdit && m.overridden ? postButton({ action: `${base}/cogs/unclassify`, csrf, label: 'Clear the class', extra: { account_id: m.accountId, txn_id: m.txnId, line_no: m.lineNo } }) : ''}
        ${canEdit && m.lineNo ? html`<form method="post" action="${base}/cogs/movement" class="inline">${csrfField(csrf)}${hidden('account_id', m.accountId)}${hidden('txn_id', m.txnId)}${hidden('line_no', m.lineNo)}${hidden('txn_version', m.txnVersion)}
          <select name="class" aria-label="Movement">${(m.cls ?? m.saved?.class) ? '' : html`<option value="">Choose</option>`}${MOVEMENT_CLASSES.map(([k, l]) => html`<option value="${k}"${(m.cls ?? m.saved?.class) === k ? html` selected` : ''}>${l}</option>`)}</select> <input name="reason" aria-label="Note" placeholder="Note" value="${m.saved?.reason ?? ''}"><button class="link">Save</button></form>` : ''}</li>`)}</ul></details>` : ''}
      ${w ? html`<p class="muted small">${TREATMENTS.find(([k]) => k === w.treatment)?.[1] ?? w.treatment}; ${METHODS.find(([k]) => k === w.method)?.[1] ?? w.method}${w.lifo ? '; LIFO' : ''}${w.subnormal_writedown ? '; subnormal goods written down' : ''}${w.valuation_changed ? '; valuation changed' : ''}.</p>` : ''}
      ${canEdit ? html`<form method="post" action="${base}/cogs/save" class="editor">${csrfField(csrf)}${hidden('activity_id', e.activityId)}
        ${selectField('Worked out from', 'path', [['reconstruct', 'The books (purchases and costs routed here), with the inventory counts'], ['reviewed', 'Reviewed lines typed from a workpaper']], w?.path ?? 'reconstruct')}
        ${selectField('Inventory treatment', 'treatment', TREATMENTS, w?.treatment ?? '', { blank: 'Choose' })}
        ${selectField('Inventory method', 'method', METHODS, w?.method ?? 'cost')}
        <fieldset><legend>Form 1125-A line 9 (any of these: reviewed lines only)</legend>${checkbox('LIFO inventory method', 'lifo', w?.lifo)}${checkbox('Subnormal goods written down', 'subnormal', w?.subnormal_writedown)}${checkbox('A change in determining quantities, cost or valuations', 'valuation_changed', w?.valuation_changed)}</fieldset>
        ${field('Tax beginning inventory (line 1)', 'begin', amt(w?.begin_cents), { attrs: 'inputmode="decimal"' })}${field('Tax ending inventory (line 7)', 'end', amt(w?.end_cents), { attrs: 'inputmode="decimal"' })}
        <details><summary>Reviewed lines (when typed from a workpaper)</summary>${['1', '2', '3', '4', '7'].map(n => field(`Line ${n}`, `line_${n}`, amt(w?.reviewed_lines?.[n]), { attrs: 'inputmode="decimal"' }))}${otherRows(w)}</details>
        ${field('Source (the counts; the workpaper the reviewed lines come from; the treatment or method when "other")', 'note', w?.source_note ?? '')}<div class="form-actions"><button class="primary">Save the workpaper</button></div></form>` : ''}</section>`;
  };
  // Saved movement classes no workpaper lists (no reconstructed workpaper reaches them): shown with Clear, never dropped.
  const listed = new Set([...r.cogs.values()].flatMap(e => e.movements.filter(m => m.saved).map(m => m.saved.movementId)));
  const loose = (r.cogsClasses ?? []).filter(c => !c.matched && !listed.has(c.movementId));
  const started = new Set([...r.cogs.keys()]);
  const others = activities.filter(a => !started.has(Number(a.activity_id)));
  return page({ entityName, csrf, flash, company, year, current: 'cogs', error, body: html`${draft}
    <p class="muted">Form 1125-A for each activity. Book cost of goods sold is compared with line 8, never used as purchases; tax inventory is entered here, apart from the book balance sheet.</p>
    ${[...r.cogs.values()].map(paper)}
    ${loose.length ? html`<section class="card"><h2>Saved movement classes no workpaper shows</h2><ul>${loose.map(c => html`<li>Transaction ${c.txnId} line ${c.lineNo} (account ${c.accountId}): classified as ${c.class}
      ${canEdit ? postButton({ action: `${base}/cogs/unclassify`, csrf, label: 'Clear', extra: { account_id: c.accountId, txn_id: c.txnId, line_no: c.lineNo } }) : ''}</li>`)}</ul></section>` : ''}
    ${canEdit && others.length ? html`<section class="card"><h2>Start a workpaper</h2><form method="post" action="${base}/cogs/save" class="editor">${csrfField(csrf)}${selectField('Activity', 'activity_id', others.map(a => [a.activity_id, a.name]), '')}${hidden('path', 'reconstruct')}
      ${selectField('Inventory treatment', 'treatment', TREATMENTS, '', { blank: 'Choose' })}${selectField('Inventory method', 'method', METHODS, 'cost')}<div class="form-actions"><button>Start</button></div></form></section>` : ''}` });
}
