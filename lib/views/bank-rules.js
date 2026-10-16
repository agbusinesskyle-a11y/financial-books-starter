import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, postButton } from './forms.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { TEXT_OPS, AMOUNT_OPS, ruleAccounts } from '../bankfeed/rules.js';

// Banking → Rules (stage B4; rules v2, stage BR-5): the list, in the order they're tried, the rule form with Test, and
// import / export.

const FIELD_NAMES = { description: 'Description', bank_text: 'Bank text', amount: 'Amount' };
const conditionText = c => (c.field === 'amount'
  ? `Amount ${AMOUNT_OPS[c.op]} ${formatCents(c.value)}${c.op === 'between' ? ` and ${formatCents(c.value2)}` : ''}`
  : `${FIELD_NAMES[c.field] ?? 'Description'} ${TEXT_OPS[c.op]} “${c.value}”`);
const splitText = (splits, accountNames) => splits.map(s => `${accountNames.get(Number(s.accountId)) ?? 'Account'} ${s.percent !== undefined && s.percent !== null ? `${s.percent / 100}%` : formatCents(s.cents)}`).join(' · ');

export function rulesPage({ entityName, csrf, flash, rules, payeeNames, accountNames = new Map(), feedNames = new Map(), practice = false }) {
  return layout({ title: 'Bank rules', entityName, csrf, flash, body: html`<div class="crumbs"><a href="/banking">‹ Bank transactions</a></div>
  <div class="page-actions"><h1>Rules</h1><span class="spacer"></span>
    ${rules.length ? html`<a class="button" href="/banking/rules/export">Export</a>` : ''}<a class="button" href="/banking/rules/import">Import</a>
    <a class="button primary" href="/banking/rules/new">New rule</a></div>
  <p class="muted">Rules fill in bank items the same way every time. They’re tried in order (lowest number first); the first one that fits is used.
    A rule set to <strong>add automatically</strong> records items as they arrive — unless the books may already hold them, or a person undid them.${practice ? html` <strong>Practice copy:</strong> automatic rules only suggest here; they add automatically in the live books.` : ''}</p>
  ${rules.length ? html`<div class="table-scroll"><table class="grid">
    <thead><tr><th class="num">Order</th><th>Rule</th><th>When</th><th>Then</th><th>How</th><th class="actions"></th></tr></thead>
    <tbody>${rules.map(r => html`<tr class="${r.active ? '' : 'muted'}">
      <td class="num">${r.priority}</td>
      <td><a href="/banking/rules/${r.rule_id}">${r.name}</a>${r.active ? '' : html`<small class="muted">Off</small>`}</td>
      <td>Money ${r.money === 'out' ? 'out of' : 'into'} ${ruleAccounts(r).length ? ruleAccounts(r).map(id => feedNames.get(id) ?? 'an account').join(', ') : 'any account'}<small class="muted">${r.conditions.map(conditionText).join(r.match_all ? ' and ' : ' or ')}</small></td>
      <td>${r.splits?.length ? `Split: ${splitText(r.splits, accountNames)}` : r.account_name ?? ''}${r.payee ? html`<small class="muted">Payee: ${payeeNames.get(r.payee) ?? ''}</small>` : ''}${r.memo ? html`<small class="muted">Memo${r.memo_mode === 'append' ? ' (added to the bank description)' : ''}: ${r.memo}</small>` : ''}</td>
      <td>${r.mode === 'auto' ? html`<span class="tag ok">${practice ? 'Suggests here · adds automatically when live' : 'Adds automatically'}</span>${r.auto_added ? html`<small class="muted">${r.auto_added} added</small>` : ''}` : 'Suggests'}</td>
      <td class="actions">${postButton({ action: `/banking/rules/${r.rule_id}/delete`, csrf, label: 'Delete', confirm: `Delete the rule “${r.name}”? Items it already added stay.` })}</td>
    </tr>`)}</tbody></table></div>` : html`<div class="card"><p>No rules yet. Open a bank item and choose <strong>Make a rule from this item</strong>, or start a new one.</p></div>`}` });
}

export function ruleForm({ entityName, csrf, flash, rule = null, v, error = null, preview = null, feeds, categories, payees, classes, locations, accountNames = new Map(), practice = false }) {
  const conds = [...(v.conditions ?? []), { field: 'description', op: 'contains', value: '' }, { field: 'amount', op: 'more', value: '' }].slice(0, Math.max(3, (v.conditions ?? []).length + 1));
  const splits = [...(v.splits ?? []).filter(s => s.accountId || s.percent || s.amount), {}, {}, {}, {}].slice(0, Math.max(4, (v.splits ?? []).length));
  const opt = (value, label, current) => html`<option value="${value}"${String(current ?? '') === String(value) ? html` selected` : ''}>${label}</option>`;
  const catOptions = current => categories.map(([group, list]) => html`<optgroup label="${group}">${list.map(a => opt(a.account_id, a.name, current))}</optgroup>`);
  const accts = (v.llAccounts ?? []).map(String);
  return layout({ title: rule ? 'Edit rule' : 'New rule', entityName, csrf, flash, body: html`<div class="crumbs"><a href="/banking/rules">‹ Rules</a></div>
  <h1>${rule ? `Rule: ${rule.name}` : 'New rule'}</h1>
  <form method="post" action="${rule ? `/banking/rules/${rule.rule_id}` : '/banking/rules'}" class="card editor">${csrfField(csrf)}${errorBanner(error)}
    <div class="form-grid">
      <label class="field"><span>Rule name <span class="req">*</span></span><input name="name" value="${v.name ?? ''}" required></label>
      <label class="field"><span>Order</span><input name="priority" inputmode="numeric" value="${v.priority ?? 100}"><small class="muted">0–9999; lower numbers are tried first.</small></label>
    </div>
    <h2>Apply this to</h2>
    <div class="form-grid">
      <label class="field"><span>Money</span><select name="money">${opt('out', 'Money out', v.money)}${opt('in', 'Money in', v.money)}</select></label>
      <label class="field"><span>When</span><select name="matchAll">${opt('1', 'All conditions fit', v.matchAll === false ? '0' : '1')}${opt('0', 'Any condition fits', v.matchAll === false ? '0' : '1')}</select></label>
    </div>
    <fieldset class="rule-accounts"><legend>In</legend><p class="muted small">Tick the accounts it’s for; none ticked means all bank and card accounts.</p>
      ${feeds.map(f => html`<label class="check"><input type="checkbox" name="llAccounts" value="${f.id}"${accts.includes(String(f.id)) ? html` checked` : ''}> ${f.books_name}</label>`)}</fieldset>
    ${conds.map((c, i) => html`<div class="split-line rule-condition">
      <label class="field"><span>Condition ${i + 1}</span><select name="cond_field">${opt('description', 'Description', c.field)}${opt('bank_text', 'Bank text (as the bank sent it)', c.field)}${opt('amount', 'Amount', c.field)}</select></label>
      <label class="field"><span>Compare</span><select name="cond_op">
        <optgroup label="Text">${Object.entries(TEXT_OPS).map(([k, l]) => opt(k, l, c.op))}</optgroup>
        <optgroup label="Amount">${Object.entries(AMOUNT_OPS).map(([k, l]) => opt(k, l, c.op))}</optgroup></select></label>
      <label class="field"><span>Value</span><input name="cond_value" value="${c.field === 'amount' && typeof c.value === 'number' ? (c.value / 100).toFixed(2) : c.value ?? ''}">
        <input name="cond_value2" aria-label="And (for between)" placeholder="and… (between)" value="${typeof c.value2 === 'number' ? (c.value2 / 100).toFixed(2) : c.value2 ?? ''}"></label>
    </div>`)}
    <h2>Then</h2>
    <div class="form-grid">
      <label class="field"><span>Payee</span><select name="payee">${opt('', '(none)', v.payee)}${payees.map(p => opt(p.key, p.name, v.payee))}</select></label>
      <label class="field"><span>Category</span><select name="accountId">${opt('', 'Choose…', v.accountId)}${catOptions(v.accountId)}</select>
        <small class="muted">A bank, card or loan account records a transfer.</small></label>
      ${classes.length ? html`<label class="field"><span>Class</span><select name="classId">${opt('', '(none)', v.classId)}${classes.map(c => opt(c.class_id, c.name, v.classId))}</select></label>` : ''}
      ${locations.length ? html`<label class="field"><span>Location</span><select name="locationId">${opt('', '(none)', v.locationId)}${locations.map(l => opt(l.location_id, l.name, v.locationId))}</select></label>` : ''}
    </div>
    <details class="rule-split"${(v.splits ?? []).some(s => s.accountId) ? html` open` : ''}><summary>Or split it across categories</summary>
      <p class="muted small">Fixed amounts come off first; percentage lines share what’s left and must come to 100%. When split lines are filled, the category above isn’t used.</p>
      ${splits.map((s, i) => html`<div class="split-line rule-split-line">
        <label class="field"><span>Split ${i + 1}</span><select name="split_account">${opt('', '—', s.accountId)}${catOptions(s.accountId)}</select></label>
        <label class="field"><span>Percent</span><input name="split_percent" inputmode="decimal" value="${s.percent ?? ''}" placeholder="${i ? '' : '60'}"></label>
        <label class="field"><span>or Amount</span><input name="split_amount" inputmode="decimal" value="${s.amount ?? ''}" placeholder="${i ? '' : '25.00'}"></label>
        <label class="field"><span>Description</span><input name="split_description" value="${s.description ?? ''}"></label></div>`)}
    </details>
    <div class="form-grid">
      <label class="field"><span>Memo</span><input name="memo" value="${v.memo ?? ''}"></label>
      <label class="field"><span>Memo is</span><select name="memoMode">${opt('replace', 'Used instead of the bank description', v.memoMode)}${opt('append', 'Added after the bank description', v.memoMode)}</select></label>
      <label class="field"><span>How</span><select name="mode">${opt('suggest', 'Suggest — I review each item', v.mode)}${opt('auto', practice ? 'Add automatically (in the live books; suggests in this practice copy)' : 'Add automatically', v.mode)}</select></label>
    </div>
    <label class="check"><input type="checkbox" name="active" value="1"${v.active === false ? '' : html` checked`}> Rule is on</label>
    <div class="form-actions"><button class="primary">Save rule</button><button name="test" value="1">Test rule</button><a href="/banking/rules">Cancel</a></div>
  </form>
  ${preview ? html`<section class="card rule-preview" id="preview"><h2>What it would catch now</h2>
    ${preview.length ? html`<p class="muted small">${preview.length} bank item${preview.length === 1 ? '' : 's'} waiting for review fit this rule. Nothing has been saved or changed.</p>
      <div class="table-scroll"><table class="grid"><thead><tr><th>Date</th><th>Bank item</th><th class="num">Amount</th><th>It would record</th></tr></thead><tbody>
      ${preview.map(p => html`<tr><td>${formatShortDate(p.item.posted_date)}</td><td><a href="/banking/item/${p.item.item_id}">${p.item.description}</a><small class="muted">${p.item.books_name}</small></td>
        <td class="num">${formatCents(Math.abs(Number(p.item.amount_cents)))}</td>
        <td>${p.action.lines.map(l => `${accountNames.get(Number(l.accountId)) ?? 'Account'} ${formatCents(l.cents)}`).join(' · ') || 'Payee only'}${p.action.memo ? html`<small class="muted">Memo: ${p.action.memo}</small>` : ''}
          ${p.usedInstead ? html`<small class="warn">Rule “${p.usedInstead.name}” comes first, so it’s used instead</small>` : ''}
          ${p.hold === 'match' ? html`<small class="warn">Not recorded: it matches what’s already in the books</small>`
            : p.hold === 'duplicate' ? html`<small class="warn">Not recorded: something in the books may already be it — a person decides</small>`
            : p.hold === 'undone' ? html`<small class="warn">Not added automatically: a person undid it, so it waits for a person (who can accept the suggestion)</small>` : ''}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted">No bank item waiting for review fits this rule right now.</p>`}
  </section>` : ''}` });
}

// Import rules from an export (pasted or chosen as a file), and what happened to each.
export function rulesImportPage({ entityName, csrf, flash, results = null, error = null, data = '' }) {
  return layout({ title: 'Import rules', entityName, csrf, flash, body: html`<div class="crumbs"><a href="/banking/rules">‹ Rules</a></div>
  <h1>Import rules</h1>
  ${results ? html`<div class="card"><p>${results.filter(r => r.outcome === 'added').length} of ${results.length} rule${results.length === 1 ? '' : 's'} added.</p>
    <div class="table-scroll"><table class="grid"><thead><tr><th>Rule</th><th>Result</th></tr></thead><tbody>
    ${results.map(r => html`<tr><td>${r.name}</td><td>${r.outcome === 'added' ? html`<span class="tag ok">Added</span>` : html`<span class="tag warn">Skipped</span> ${r.reason}`}</td></tr>`)}</tbody></table></div>
    <p><a class="button primary" href="/banking/rules">Back to rules</a></p></div>`
  : html`<form method="post" action="/banking/rules/import" class="card editor">${csrfField(csrf)}${errorBanner(error)}
    <p class="muted">Paste a rules export (Rules → Export) from this or another company. Categories, payees, classes, locations and bank accounts are
      matched by name; a rule that names something this company doesn’t have, or whose name is already used, is skipped and listed.</p>
    <label class="field"><span>Choose the file</span><input type="file" accept="application/json,.json" data-read-into="rules-data"></label>
    <label class="field"><span>Or paste it</span><textarea id="rules-data" name="data" rows="12" required>${data}</textarea></label>
    <div class="form-actions"><button class="primary">Import</button><a href="/banking/rules">Cancel</a></div>
  </form>`}` });
}
