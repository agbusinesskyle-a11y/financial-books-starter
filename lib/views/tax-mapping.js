// lib/views/tax-mapping.js
// /tax/:entity/:year/mapping (spec §8, phone first): coverage, suggestions, the destination picker by section, measurement, splits,
// line attribution, activity / owner / K-1 pickers. Every amount is exact BigInt cents shown with dollars() (lib/tax/measure.js). Every
// form carries the versions of what it showed (partition base, binding set, transaction), so a changed source refuses the save (B5/B7).
import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField, checkbox, postButton } from './forms.js';
import { dollars } from '../tax/measure.js';
import { pickerOptions, describeTarget, measurementsFor, MEASUREMENT_LABELS } from '../tax/destinations.js';
import { baseVersion } from '../tax/partition.js';
import { STATUS_LABELS } from '../tax/coverage.js';
import { EMPTY_SET } from '../tax/bindings.js';

const ROWS = 4;
export const LINES_PER_PAGE = 100;
const hidden = (name, value) => html`<input type="hidden" name="${name}" value="${value}">`;
const shareText = b => (b.share_num_text ? `${b.share_num_text}/${b.share_den_text}` : b.amount_text ? dollars(b.amount_text) : '');
function whatSelect(name, groups) {
  return html`<label class="field"><span>Goes to</span><select name="${name}"><option value="">—</option>${groups.map(g => html`<optgroup label="${g.label}">${g.options.map(o => html`<option value="${o.value}">${o.label}</option>`)}</optgroup>`)}</select></label>`;
}

// aiProposals / canAi are filled by the optional AI task (Task 14); without it they are empty and false.
export function taxMappingPage({ entityName, csrf, flash, company, year, cov, suggestions, focus, parties, activities, canEdit, filter, error = null, aiProposals = [], canAi = false, sureMax = null }) {
  const E = company.entityId, here = `/tax/${E}/${year}/mapping`, { ctx, totals, ret } = cov;
  const sure = canEdit ? suggestions.filter(s => s.sure) : [];
  // The public demo accepts at most sureMax per request: the form sends the first sureMax in page order and says so.
  const offered = sureMax !== null && sure.length > sureMax ? sure.slice(0, sureMax) : sure;
  const editHref = (src, acc) => `${here}?source=${src}&account=${acc}${filter === 'all' ? '&show=all' : ''}#edit`;
  const owners = parties.map(p => [p.party_id, p.name]), payers = parties.filter(p => ['entity_in_org', 'entity_outside'].includes(p.kind)).map(p => [p.party_id, p.name]);
  const acts = activities.map(x => [x.activity_id, x.name]);
  // The form names the decision by its key; the server recomputes the suggestion and accepts it only if the key still matches (B7).
  const acceptForm = g => html`<form method="post" action="${here}/accept" class="inline">${csrfField(csrf)}${hidden('source_entity_id', g.sourceEntityId)}${hidden('decision', g.decision)}<button class="link">Accept (and make it the company default)</button></form>`;
  const aiFor = (s, a) => aiProposals.filter(p => Number(p.source_entity_id) === s.entityId && Number(p.account_id) === a.accountId).map(p => html`<div class="muted small">AI proposes for the ${MEASUREMENT_LABELS[p.measurement].toLowerCase()}: ${describeTarget(ctx, p)} (${p.confidence})${p.evidence?.why ? ` — ${p.evidence.why}` : ''}
    ${canEdit ? html`${postButton({ action: `${here}/ai-accept`, csrf, label: 'Accept', extra: { suggestion_id: p.suggestion_id } })}<form method="post" action="${here}/ai-reject" class="inline">${csrfField(csrf)}${hidden('suggestion_id', p.suggestion_id)}<input name="reason" aria-label="Why not" placeholder="Why not"><button class="link">Reject</button></form>` : ''}</div>`);
  const reasonsOf = a => [...new Set(Object.values(a.results).flatMap(r => r.reasons).filter(x => x !== 'No binding'))].slice(0, 3);
  const accountRow = (s, a) => html`<tr>
    <td data-label="Account">${a.number ? `${a.number} ` : ''}${a.name}${a.active ? '' : html` <span class="muted">(inactive)</span>`}</td>
    <td data-label="Beginning" class="num">${a.pl ? html`<span class="muted">—</span>` : dollars(a.begin)}</td>
    <td data-label="Activity" class="num">${dollars(a.activity)}${a.grossDebit && a.grossCredit ? html`<br><span class="muted small">${dollars(a.grossDebit)} in · ${dollars(a.grossCredit)} out</span>` : ''}</td>
    <td data-label="Ending" class="num">${a.pl ? html`<span class="muted">—</span>` : dollars(a.end)}</td>
    <td data-label="Goes to">${a.bindings.map(b => html`<div>${MEASUREMENT_LABELS[b.measurement]}: ${describeTarget(ctx, b)}${shareText(b) ? ` (${shareText(b)})` : ''}${b.override ? html` <span class="muted small">changed for this period</span>` : ''}</div>`)}
      ${a.attributions.length ? html`<div class="muted small">${a.attributions.length} line${a.attributions.length === 1 ? '' : 's'} attributed</div>` : ''}
      ${suggestions.filter(g => g.sourceEntityId === s.entityId && g.accountId === a.accountId).map(g => html`<div class="muted small">Suggested for the ${MEASUREMENT_LABELS[g.measurement].toLowerCase()}: ${describeTarget(ctx, g)} (${g.source}, ${g.confidence}) ${canEdit ? acceptForm(g) : ''}</div>`)}
      ${aiFor(s, a)}</td>
    <td data-label="Status"><span class="tag">${STATUS_LABELS[a.status]}</span>${reasonsOf(a).map(x => html`<div class="muted small">${x}</div>`)}</td>
    <td class="actions" data-label=""><a href="${editHref(s.entityId, a.accountId)}">${canEdit ? 'Map' : 'Details'}</a></td></tr>`;
  const sourceCard = s => html`<section class="card"><h2>${s.name} <span class="muted small">${s.own ? 'own books' : s.stranded ? 'no longer included' : `included as ${s.activityName}${s.path.length > 1 ? ` (through ${s.path.length - 1} other included compan${s.path.length === 2 ? 'y' : 'ies'})` : ''}`}</span></h2>
    ${s.status === 'hidden' ? html`<p class="muted">You cannot open this company (or a company its books pass through), so its accounts are not shown or counted here. Even after someone who can open it maps them, this page stays blocked for you.</p>`
      : s.status === 'blocked' && s.stranded ? html`<p class="muted">${s.reason}</p>`
      : s.status === 'blocked' ? html`<p class="muted">These books reach this return through a period that does not cover the whole year (a company that started mid-year). Tax Books cannot combine part-year books yet, so this return waits.</p>`
      : html`${s.cashSensitive ? html`<p class="muted small">Cash-sensitive books: these mappings route the accounts; the amounts on the return are what the cash layer recognizes (next stage), not the book amounts below.</p>` : ''}
        ${!s.accounts.length ? html`<p class="muted">No account has a balance or activity in this period.</p>`
      : html`<div class="table-scroll"><table class="grid"><thead><tr><th>Account</th><th class="num">Beginning</th><th class="num">Activity</th><th class="num">Ending</th><th>Goes to</th><th>Status</th><th class="actions"></th></tr></thead>
        <tbody>${s.accounts.filter(a => filter === 'all' || a.status !== 'complete').map(a => accountRow(s, a))}</tbody></table></div>`}`}</section>`;
  const editor = () => {
    const { source: s, account: a, lines, from } = focus;
    const groups = pickerOptions(ctx, a.type), ms = measurementsFor(a);
    const baseOf = m => a.results[m]?.base ?? baseVersion(a.versions[m], []), setOf = m => a.results[m]?.setFingerprint ?? EMPTY_SET;
    const rowFields = (i, legend) => html`<fieldset class="form-grid"><legend>${legend}</legend>${whatSelect(`what_${i}`, groups)}
      ${field('Share (split by share)', `share_${i}`, '')} ${field('Amount (split by amount)', `amount_${i}`, '', { attrs: 'inputmode="decimal"' })}
      ${s.own ? selectField('Activity', `activity_${i}`, acts, '', { blank: '—' }) : ''}
      ${selectField('Owner', `owner_${i}`, owners, '', { blank: '—' })} ${selectField('K-1 from', `k1_${i}`, payers, '', { blank: '—' })}
      ${field('Statement row label', `label_${i}`, '')}</fieldset>`;
    // Every treatment's own fields on a line too (B8): the owner, the K-1 payer, the activity, the statement-row label and the memo.
    const lineForm = l => html`<form method="post" action="${here}/line" class="editor">${csrfField(csrf)}${hidden('source_entity_id', s.entityId)}${hidden('account_id', a.accountId)}${hidden('txn_id', l.txnId)}${hidden('line_no', l.lineNo)}${hidden('txn_version', l.txnVersion)}
      <div class="form-grid">${whatSelect('what_0', groups)} ${selectField('Owner', 'owner_0', owners, '', { blank: '—' })} ${selectField('K-1 from', 'k1_0', payers, '', { blank: '—' })}
      ${s.own ? selectField('Activity', 'activity_0', acts, '', { blank: '—' }) : ''} ${field('Statement row label', 'label_0', '')} ${field('Memo (required for “not on the return”)', 'memo', '')}</div>
      <div class="form-actions"><button>Attribute</button></div></form>`;
    const lineKeyOf = (t, n) => `${t}/${n}`;
    const liveKeys = new Set((lines ?? []).map(l => lineKeyOf(l.txnId, l.lineNo)));
    const page = lines ? lines.slice(from, from + LINES_PER_PAGE) : [];
    const linesHref = n => `${here}?source=${s.entityId}&account=${a.accountId}&lines=1&from=${n}#edit`;
    return html`<section class="card" id="edit"><h2>${a.name}</h2>
    <p class="muted small">${s.name}${s.own ? '' : ` (included as ${s.activityName}: every amount joins that activity)`}. ${ms.map(m => `${MEASUREMENT_LABELS[m]} ${dollars(a[m])}`).join(' · ')}</p>
    ${a.bindings.length ? html`<ul>${a.bindings.map(b => html`<li>${MEASUREMENT_LABELS[b.measurement]}: ${describeTarget(ctx, b)}${shareText(b) ? ` (${shareText(b)})` : ''}${b.memo ? html` <span class="muted small">${b.memo}</span>` : ''}</li>`)}</ul>
      ${canEdit ? [...new Set(a.bindings.map(b => b.measurement))].map(m => postButton({ action: `${here}/clear`, csrf, label: `Clear the ${MEASUREMENT_LABELS[m].toLowerCase()} mapping`, extra: { source_entity_id: s.entityId, account_id: a.accountId, measurement: m, set: setOf(m) } })) : ''}`
      : html`<p class="muted">Not mapped yet.</p>`}
    ${canEdit ? html`<form method="post" action="${here}/bind" class="editor">${csrfField(csrf)}${hidden('source_entity_id', s.entityId)}${hidden('account_id', a.accountId)}${ms.map(m => html`${hidden(`version_${m}`, baseOf(m))}${hidden(`set_${m}`, setOf(m))}`)}
      <div class="form-grid">${selectField('Measurement', 'measurement', ms.map(m => [m, MEASUREMENT_LABELS[m]]), ms[0])}
      ${selectField('Split', 'split', [['whole', 'Whole amount'], ['shares', 'Split by share (1/3, 25%)'], ['amounts', 'Split by amount']], 'whole')}</div>
      ${[...Array(ROWS).keys()].map(i => rowFields(i, i === 0 ? 'Destination' : `Split row ${i + 1}`))}
      <div class="form-grid">${field('Memo (required for “not on the return”)', 'memo', '')}
      ${checkbox('Also make this the company default: later periods copy it (leave unticked to change this period only)', 'make_default', false)}</div>
      <div class="form-actions"><button class="primary">Save mapping</button></div></form>` : ''}
    ${a.attributions.length ? html`<h3>Attributed lines</h3><div class="table-scroll"><table class="grid"><thead><tr><th>Line</th><th class="num">Amount</th><th>Goes to</th><th>State</th><th class="actions"></th></tr></thead><tbody>
      ${a.attributions.map(x => html`<tr><td data-label="Line">${x.txn_id}/${x.line_no}</td><td data-label="Amount" class="num">${dollars(x.amount_text)}</td><td data-label="Goes to">${describeTarget(ctx, x)}</td>
        <td data-label="State">${!lines ? html`<span class="muted">—</span>` : liveKeys.has(lineKeyOf(x.txn_id, x.line_no)) ? 'In the books' : html`<strong>The line no longer posts to this account in the period</strong>`}</td>
        <td class="actions" data-label="">${canEdit ? postButton({ action: `${here}/unline`, csrf, label: 'Remove', extra: { source_entity_id: s.entityId, account_id: a.accountId, binding_line_id: x.binding_line_id } }) : ''}</td></tr>`)}
      </tbody></table></div>` : ''}
    ${lines ? html`<h3>Lines in this period</h3><p class="muted small">An attributed line goes to its own destination first; the account’s mapping takes the rest. Lines ${lines.length ? from + 1 : 0}–${Math.min(from + LINES_PER_PAGE, lines.length)} of ${lines.length}.</p>
      <div class="table-scroll"><table class="grid"><thead><tr><th>Date</th><th>Transaction</th><th class="num">Amount</th><th>Goes to</th></tr></thead><tbody>
      ${page.map(l => { const done = a.attributions.find(x => x.txn_id === l.txnId && x.line_no === l.lineNo);
        return html`<tr><td data-label="Date">${l.date}</td><td data-label="Transaction">${l.type.replaceAll('_', ' ')} ${l.docNumber ?? ''} ${l.memo ?? ''}</td><td data-label="Amount" class="num">${dollars(l.cents)}</td>
        <td data-label="Goes to">${done ? describeTarget(ctx, done) : l.lineNo === null ? html`<span class="muted">System line: stays with the account</span>` : canEdit ? lineForm(l) : html`<span class="muted">With the account</span>`}</td></tr>`; })}
      </tbody></table></div>
      <p>${from > 0 ? html`<a href="${linesHref(Math.max(0, from - LINES_PER_PAGE))}">‹ Earlier lines</a> ` : ''}${from + LINES_PER_PAGE < lines.length ? html`<a href="${linesHref(from + LINES_PER_PAGE)}">Later lines ›</a>` : ''}</p>`
      : s.cashSensitive ? html`<p class="muted small">Single lines are not routed here: on a cash-method return or cash-basis books the cash layer (next stage) routes the cash each line brings; map the account whole or by shares.</p>`
      : html`<p><a href="${linesHref(0)}">Attribute individual lines</a></p>`}
  </section>`;
  };
  return layout({ title: `Mapping: ${company.name} ${year}`, entityName, csrf, flash, wide: true, body: html`<div class="crumbs"><a href="/tax">‹ Tax</a> · <a href="/tax/${E}/profile">Tax setup</a></div>
<h1>Mapping: ${company.name} ${year}</h1>
${errorBanner(error)}
<p class="muted">Where each book account is routed on the return for ${ret.period_start} – ${ret.period_end} (${ret.tax_method} method; books on the ${ret.book_basis} basis). Amounts are the books as posted, to the cent. “Mapped” means routed — not a reviewed opening, a reconciled cash amount or a reviewed tax treatment.</p>
${cov.provisional ? html`<p class="muted"><strong>The ${ctx.formEdition} forms are not in the app yet.</strong> This period is mapped against the ${ctx.edition} lines and computes nothing until its own forms ship; every mapping is checked again then.</p>` : ''}
<section class="card"><h2>Coverage</h2>
  <p>${totals.accounts} accounts: ${totals.complete} mapped, ${totals.uncovered} need mapping, ${totals.unresolved} waiting on something, ${totals.stale} changed since mapped${totals.hidden ? `, ${totals.hidden} included ${totals.hidden === 1 ? 'company' : 'companies'} you cannot open` : ''}${totals.blocked ? `, ${totals.blocked} that cannot be combined yet` : ''}.</p>
  ${totals.blocking ? html`<p class="muted small">An unmapped or unresolved account is never counted as zero: the return waits until each one is mapped.</p>` : ''}
  <p>${filter === 'all' ? html`<a href="${here}">Show only what needs attention</a>` : html`<a href="${here}?show=all">Show every account</a>`}</p>
  ${canEdit ? postButton({ action: `${here}/copy-forward`, csrf, label: 'Copy the company defaults into this period', cls: '' }) : ''}
  ${sure.length ? html`<details><summary>${sure.length} sure suggestion${sure.length === 1 ? '' : 's'}</summary>
    <div class="table-scroll"><table class="grid"><thead><tr><th>Account</th><th>Measurement</th><th class="num">Amount</th><th>Goes to</th><th>Why</th></tr></thead><tbody>
    ${sure.map(s => html`<tr><td data-label="Account">${s.accountName}</td><td data-label="Measurement">${MEASUREMENT_LABELS[s.measurement]}</td><td data-label="Amount" class="num">${dollars(s.cents)}</td><td data-label="Goes to">${describeTarget(ctx, s)}</td><td data-label="Why">${s.source}, ${s.confidence}</td></tr>`)}
    </tbody></table></div>
    <p class="muted small">Each accepted suggestion also becomes the company default, copied into later periods.</p>
    <form method="post" action="${here}/accept-sure" class="editor">${csrfField(csrf)}${offered.map(s => hidden('sure', s.decision))}${offered.length < sure.length ? html`<p class="muted small">This demo accepts at most ${sureMax} at a time: the button accepts the first ${offered.length} listed; accept again for the rest.</p>` : ''}<div class="form-actions"><button class="primary">${offered.length < sure.length ? `Accept the first ${offered.length} sure` : `Accept all sure (${sure.length})`}</button></div></form></details>` : ''}
  ${canAi ? postButton({ action: `${here}/ai`, csrf, label: 'Ask the AI about up to 40 unmapped accounts', cls: '' }) : ''}
</section>
${cov.sources.map(sourceCard)}
${focus ? editor() : ''}` });
}
